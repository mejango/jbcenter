import type { Pool } from "pg";
import {
  createProtocolOperations,
  type Config,
  type Services,
} from "@juicebox/mcp/host";
import type { Store } from "../store.js";
import type { RpcUpstreams } from "../rpc.js";
import { Metrics } from "../observability.js";
import { createRestApp } from "./app.js";
import { createRestAuth, PostgresAccountStore } from "./auth/index.js";
import { createContractOwnerVerifier } from "./contractOwner.js";
import { getContractCatalog } from "./contracts/catalog.js";
import { RestError, type RestRpc } from "./core.js";
import { restRequest } from "./context.js";
import { apiDocsCss, apiDocsPage, buildRestOpenApi } from "./docs/index.js";
import {
  createTransactionDispatchAuthorizer,
  createSponsorshipDispatchAuthorizer,
  createSessionPlanAuthorizer,
  createUserOperationRequestAuthorizer,
} from "./dispatchAuthority.js";
import { createIndexerReadService } from "./indexer/index.js";
import { createOmnichainService } from "./omnichain/index.js";
import { createProtocolReadService } from "./protocol/index.js";
import { createProtocolSemanticVerifier } from "./protocol/semantics.js";
import { createRestRpc } from "./rpc.js";
import { readRestAssets, type RestSite } from "./site.js";
import {
  RelayrSponsorshipService,
  PostgresSponsorshipStore,
} from "./sponsorship/index.js";
import {
  createSmartAccountService,
  createSessionPolicyReviewer,
  PostgresSmartAccountRegistry,
  CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS,
  type SmartAccountManifest,
  type SmartModuleInspector,
  type ReviewedSessionTarget,
  type ReviewedSessionAsset,
  type ReviewedSessionPaymaster,
  createInstalledSessionVerifier,
} from "./smartAccounts/index.js";
import { createSessionTargetResolver } from "./smartAccounts/targets.js";
import { createSafe7579Inspector } from "./smartAccounts/inspector.js";
import { PostgresSafe7579CheckpointStore } from "./smartAccounts/checkpoints.js";
import {
  readRestExecutionConfiguration,
  type RestExecutionConfiguration,
} from "./executionConfig.js";
import { PostgresSessionStore } from "./sessions/postgres.js";
import { SessionService } from "./sessions/service.js";
import { UserOperationProvider } from "./userOperations/provider.js";
import { UserOperationService } from "./userOperations/service.js";
import { PostgresUserOperationStore } from "./userOperations/postgres.js";
import { PostgresTransactionStore } from "./transactions/postgres.js";
import { TransactionService } from "./transactions/service.js";

export async function createRestRuntime(options: {
  pool: Pool;
  store: Store;
  services: Services;
  config: Config;
  upstreams: RpcUpstreams;
  audience?: string;
  para?: RestSite["para"];
  rpcSiteLimitPerMinute?: number;
  smartAccountManifests?: readonly SmartAccountManifest[];
  smartAccountModuleInspectors?: readonly SmartModuleInspector[];
  smartAccountSessionTargets?: readonly ReviewedSessionTarget[];
  smartAccountAssets?: readonly ReviewedSessionAsset[];
  smartAccountPaymasters?: readonly ReviewedSessionPaymaster[];
  executionConfiguration?: RestExecutionConfiguration;
  rpc?: RestRpc;
  startMaintenance?: boolean;
  metrics?: Metrics;
}): Promise<{
  site: RestSite;
  transactions: TransactionService;
  stop(): Promise<void>;
}> {
  const contracts = await getContractCatalog();
  const execution =
    options.executionConfiguration ??
    (await readRestExecutionConfiguration({}));
  const shutdownSignal = new AbortController();
  const backendRpc =
    options.rpc ??
    createRestRpc({
      upstreams: options.upstreams,
      consume: async () => {
        const quota = await options.store.consumeRequest(
          "rpc:rest",
          20_000,
          60,
        );
        if (!quota.allowed)
          throw new RestError(
            429,
            "RATE_LIMITED",
            "The REST chain request budget is spent; retry later",
          );
        const site = await options.store.consumeRequest(
          "rpc:site",
          options.rpcSiteLimitPerMinute ?? 20_000,
          60,
        );
        if (!site.allowed)
          throw new RestError(
            429,
            "RATE_LIMITED",
            "The shared chain request budget is spent; retry later",
          );
      },
    });
  const rpc: RestRpc = {
    request: (chainId, method, params, signal) =>
      backendRpc.request(
        chainId,
        method,
        params,
        AbortSignal.any([
          shutdownSignal.signal,
          ...(signal ? [signal] : []),
          ...(restRequest() ? [restRequest()!.signal] : []),
        ]),
      ),
  };
  const accountStore = new PostgresAccountStore(options.pool);
  const verifyContractOwner = createContractOwnerVerifier(
    rpc,
    contracts.data.chains.map((chain) => chain.id),
  );
  const auth = createRestAuth({
    store: accountStore,
    audience: options.audience ?? options.config.publicOrigin,
    verifyContractOwner,
  });
  const operations = createProtocolOperations(options.services);
  const protocol = createProtocolReadService({ rpc, catalog: contracts });
  const indexer = createIndexerReadService({
    ...(options.config.bendystrawMainnetUrl
      ? { mainnetUrl: options.config.bendystrawMainnetUrl }
      : {}),
    ...(options.config.bendystrawTestnetUrl
      ? { testnetUrl: options.config.bendystrawTestnetUrl }
      : {}),
  });
  const omnichain = createOmnichainService({ operations, indexer });
  const transactionStore = new PostgresTransactionStore(options.pool);
  const semanticVerifier = createProtocolSemanticVerifier({
    plans: options.services.plans,
  });
  const authority = { audience: auth.audience, verifyContractOwner };
  const sponsorship = new RelayrSponsorshipService({
    rpc,
    catalog: contracts,
    transactionStore,
    store: new PostgresSponsorshipStore(options.pool),
    semanticVerifier,
    authorizeDispatch: createSponsorshipDispatchAuthorizer(authority),
    policy: { enabled: true },
  });
  let userOperations: UserOperationService | undefined;
  const transactions = new TransactionService({
    store: transactionStore,
    rpc,
    semanticVerifier,
    authorizeDispatch: createTransactionDispatchAuthorizer(authority),
    resolveSmartAccount: (actor, id) =>
      smartAccounts.current(actor.accountId, id),
    smartAccountExecution: {
      chainIds: execution.providers.map((provider) => provider.chainId),
      sessionChainIds: execution.stacks
        .filter(
          (stack) =>
            stack.compilerStack &&
            execution.providers.some(
              (provider) => provider.chainId === stack.manifest.chainId,
            ),
        )
        .map((stack) => stack.manifest.chainId),
    },
    externalObservers: [
      {
        kind: "relayr",
        observePlanStep: (plan, index, bindingId, request) =>
          sponsorship.observePlanStep(plan, index, bindingId, request),
      },
      {
        kind: "erc4337",
        observePlanStep: (plan, index, bindingId, request) => {
          if (!userOperations)
            throw new RestError(
              503,
              "USER_OPERATIONS_UNAVAILABLE",
              "The operation verifier is unavailable.",
            );
          return userOperations.observePlanStep(
            plan,
            index,
            bindingId,
            request,
          );
        },
      },
    ],
  });
  const sessionStore = new PostgresSessionStore(options.pool);
  const installedVerifier = createInstalledSessionVerifier({
    rpc,
    findCompiled: (chainId, wallet, permissionId) =>
      sessionStore.findCompiled(chainId, wallet, permissionId),
  });
  const activeManifests =
    options.smartAccountManifests ??
    execution.stacks.map((stack) => stack.manifest);
  // Adding a guard must not invalidate an existing owner-only binding or hide an
  // already-submitted operation. Retain exact source pins without advertising
  // older manifests as the default wallet-creation choices.
  const retainedManifests = options.smartAccountManifests
    ? []
    : [
        ...(await readRestExecutionConfiguration({})).stacks.map(
          (stack) => stack.manifest,
        ),
        ...CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS,
      ].filter(
        (manifest) =>
          !activeManifests.some((active) => active.id === manifest.id),
      );
  const manifests = [...activeManifests, ...retainedManifests];
  const moduleInspectors =
    options.smartAccountModuleInspectors ??
    (options.smartAccountManifests
      ? []
      : execution.stacks.length
        ? [
            createSafe7579Inspector({
              rpc,
              utility: execution.stacks[0]!.utility,
              inspectSessions: installedVerifier.inspectAllAt,
              checkpointStore: new PostgresSafe7579CheckpointStore(
                options.pool,
              ),
            }),
          ]
        : []);
  const smartAccounts = createSmartAccountService({
    rpc,
    audience: auth.audience,
    registry: new PostgresSmartAccountRegistry(options.pool),
    manifests: activeManifests,
    retainedManifests,
    moduleInspectors,
  });
  const sessionTargets = createSessionTargetResolver({
    catalog: contracts,
    protocol,
    rpc,
    ...(options.smartAccountSessionTargets
      ? { targets: options.smartAccountSessionTargets }
      : {}),
    ...(options.smartAccountAssets
      ? { assets: options.smartAccountAssets }
      : {}),
  });
  const sessionReviewer = createSessionPolicyReviewer({
    currentBinding: (accountId, id, signal) =>
      smartAccounts.current(accountId, id, signal),
    getGrant: async (accountId, grantId) =>
      (await accountStore.listBots(accountId)).find(
        (grant) => grant.id === grantId,
      ) ?? null,
    targets: [],
    resolveTargets: (binding, input, signal) =>
      sessionTargets.resolve(binding, input, signal),
    assets: sessionTargets.assets,
    paymasters: options.smartAccountPaymasters ?? execution.paymasters,
  });
  const sessions = new SessionService({
    store: sessionStore,
    rpc,
    reviewer: sessionReviewer,
    verifier: installedVerifier,
    transactions,
    currentBinding: (accountId, id, signal) =>
      smartAccounts.current(accountId, id, signal),
    currentBindingAt: (accountId, id, evidence, signal) =>
      smartAccounts.currentAt(accountId, id, evidence, signal),
    compilerFor: (binding) => {
      const stack = execution.stacks.find(
        (s) =>
          s.manifest.id === binding.manifestId &&
          s.manifest.revision === binding.state.manifestRevision,
      );
      if (!stack)
        throw new RestError(
          503,
          "SESSION_STACK_UNAVAILABLE",
          "The binding has no configured source-verified session compiler.",
        );
      return stack.createCompiler();
    },
    authorizeOwnerPlan: createSessionPlanAuthorizer(authority),
    configuredChainIds: execution.stacks
      .filter(
        (stack) =>
          stack.compilerStack &&
          execution.providers.some(
            (provider) => provider.chainId === stack.manifest.chainId,
          ),
      )
      .map((stack) => stack.manifest.chainId),
  });
  const manifestFor = (id: string, revision: string) => {
    const manifest = manifests.find(
      (m) => m.id === id && m.revision === revision,
    );
    if (!manifest)
      throw new RestError(
        503,
        "SMART_MANIFEST_UNAVAILABLE",
        "The exact reviewed deployment manifest is unavailable.",
      );
    return manifest;
  };
  userOperations = new UserOperationService({
    rpc,
    provider: new UserOperationProvider(execution.providers),
    policies: execution.policies,
    store: new PostgresUserOperationStore(options.pool),
    transactionStore,
    transactions,
    sessions,
    currentBinding: (accountId, id, signal) =>
      smartAccounts.current(accountId, id, signal),
    currentBindingAt: (accountId, id, evidence, signal) =>
      smartAccounts.currentAt(accountId, id, evidence, signal),
    manifestFor: (binding) =>
      manifestFor(binding.manifestId, binding.state.manifestRevision),
    manifestForPlan: (plan) => {
      const manifest = manifests.find(
        (m) =>
          m.chainId === plan.smartAccount?.chainId &&
          m.revision === plan.smartAccount.manifestRevision,
      );
      if (!manifest)
        throw new RestError(
          503,
          "SMART_MANIFEST_UNAVAILABLE",
          "The plan's exact reviewed account manifest is unavailable.",
        );
      return manifest;
    },
    verifyHistoricalAccount: async (plan, evidence, signal) => {
      const manifest = manifests.find(
        (m) =>
          m.chainId === plan.smartAccount?.chainId &&
          m.revision === plan.smartAccount.manifestRevision,
      );
      if (!manifest)
        throw new RestError(
          503,
          "SMART_MANIFEST_UNAVAILABLE",
          "The historical account manifest is unavailable.",
        );
      const state = await smartAccounts.inspect(
        { manifestId: manifest.id, address: plan.draft.account },
        signal,
        evidence,
      );
      if (state.stateHash !== plan.smartAccount!.stateHash)
        throw new RestError(
          409,
          "SMART_ACCOUNT_CHANGED",
          "The historical owner/module layout differs from the approved plan.",
        );
    },
    authorizeRequest: createUserOperationRequestAuthorizer(authority),
    semanticVerifier,
  });
  const openapi = buildRestOpenApi({
    contracts,
    indexer,
    operations,
    publicOrigin: auth.audience,
  });
  const app = createRestApp({
    auth,
    quota: options.store,
    contracts,
    protocol,
    indexer,
    operations,
    transactions,
    sponsorship,
    smartAccounts,
    sessionReviewer,
    sessions,
    userOperations,
    omnichain,
    openapi,
  });
  const assets = await readRestAssets();
  const metrics = options.metrics ?? new Metrics();
  if (options.startMaintenance !== false) metrics.startRestRecovery();
  let stopped = false;
  let maintenance: Promise<void> | undefined;
  const run = () => {
    if (stopped || maintenance) return;
    maintenance = (async () => {
      await metrics.observeRestRecovery("nonce_cleanup", async () => {
        await accountStore.cleanupExpiredNonces(Math.floor(Date.now() / 1000), 1000);
        return { failures: 0 };
      });
      if (!stopped) await metrics.observeRestRecovery("transactions", async () => {
        const result = await transactions.recoverPending({ limit: 5 });
        return { oldestPendingAt: result.oldestPendingAt, failures: result.reconciled.filter((item) =>
          item !== null && typeof item === "object" && "status" in item &&
          item.status === "reconciliation-unavailable").length };
      });
      if (!stopped) await metrics.observeRestRecovery("user_operations", async () => {
        const result = await userOperations!.recoverPending(5);
        return { oldestPendingAt: result.oldestPendingAt,
          failures: result.items.filter((item) => item.state === "verification-unavailable").length };
      });
    })()
      .catch(() => {
        // Do not log signed bytes, profile contents, or provider credentials.
        console.error(
          JSON.stringify({
            level: "error",
            service: "rest",
            code: "MAINTENANCE_UNAVAILABLE",
          }),
        );
      })
      .finally(() => {
        maintenance = undefined;
      });
  };
  const timer =
    options.startMaintenance === false ? undefined : setInterval(run, 30_000);
  timer?.unref();
  return {
    site: {
      ...(options.para ? { para: options.para } : {}),
      app,
      audience: auth.audience,
      docsHtml: apiDocsPage(openapi),
      docsCss: apiDocsCss,
      ...assets,
    },
    transactions,
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      shutdownSignal.abort();
      if (maintenance) await maintenance;
    },
  };
}
