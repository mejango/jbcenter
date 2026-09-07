import type { Pool } from "pg";
import {
  createProtocolOperations,
  type Config,
  type Services,
} from "@juicebox/mcp/host";
import type { Store } from "../store.js";
import type { RpcUpstreams } from "../rpc.js";
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
} from "./smartAccounts/index.js";
import { PostgresTransactionStore } from "./transactions/postgres.js";
import { TransactionService } from "./transactions/service.js";

export async function createRestRuntime(options: {
  pool: Pool;
  store: Store;
  services: Services;
  config: Config;
  upstreams: RpcUpstreams;
  audience?: string;
  rpcSiteLimitPerMinute?: number;
  smartAccountManifests?: readonly SmartAccountManifest[];
  smartAccountModuleInspectors?: readonly SmartModuleInspector[];
  smartAccountSessionTargets?: readonly ReviewedSessionTarget[];
  smartAccountAssets?: readonly ReviewedSessionAsset[];
  rpc?: RestRpc;
  startMaintenance?: boolean;
}): Promise<{
  site: RestSite;
  transactions: TransactionService;
  stop(): Promise<void>;
}> {
  const contracts = await getContractCatalog();
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
  const transactions = new TransactionService({
    store: transactionStore,
    rpc,
    semanticVerifier,
    authorizeDispatch: createTransactionDispatchAuthorizer(authority),
    externalObserver: {
      kind: "relayr",
      observePlanStep: (plan, index, bindingId, request) =>
        sponsorship.observePlanStep(plan, index, bindingId, request),
    },
  });
  const smartAccounts = createSmartAccountService({
    rpc,
    audience: auth.audience,
    registry: new PostgresSmartAccountRegistry(options.pool),
    manifests:
      options.smartAccountManifests ?? CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS,
    moduleInspectors: options.smartAccountModuleInspectors ?? [],
  });
  const sessionReviewer = createSessionPolicyReviewer({
    currentBinding: (accountId, id, signal) =>
      smartAccounts.current(accountId, id, signal),
    getGrant: async (accountId, grantId) =>
      (await accountStore.listBots(accountId)).find(
        (grant) => grant.id === grantId,
      ) ?? null,
    targets: options.smartAccountSessionTargets ?? [],
    assets: options.smartAccountAssets ?? [],
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
    omnichain,
    openapi,
  });
  const assets = await readRestAssets();
  let stopped = false;
  let maintenance: Promise<void> | undefined;
  const run = () => {
    if (stopped || maintenance) return;
    maintenance = (async () => {
      await accountStore.cleanupExpiredNonces(
        Math.floor(Date.now() / 1000),
        1000,
      );
      if (!stopped) await transactions.recoverPending({ limit: 5 });
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
