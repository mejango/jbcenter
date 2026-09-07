import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  encodeFunctionResult,
  hashTypedData,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MemoryAccountStore } from "../src/rest/auth/memory.js";
import {
  PostgresAccountStore,
  assertRestActorActive,
} from "../src/rest/auth/postgres.js";
import { createRestAuth } from "../src/rest/auth/service.js";
import {
  accountIdFor,
  buildRequestTypedData,
  REST_AUTH_HEADERS as H,
  type RequestClaims,
  type SignedRequestInput,
} from "../src/rest/auth/signatures.js";
import type { AccountStore, BotGrant } from "../src/rest/auth/store.js";
import {
  RestError,
  type RestActor,
  type RestBlockEvidence,
  type RestRpc,
} from "../src/rest/core.js";
import { MemorySessionStore } from "../src/rest/sessions/memory.js";
import {
  PostgresSessionStore,
  assertUserOperationLifecyclePlan,
} from "../src/rest/sessions/postgres.js";
import {
  SessionService,
  type SessionServiceDependencies,
} from "../src/rest/sessions/service.js";
import {
  assertSessionPlanSupersedable,
  type SessionStore,
} from "../src/rest/sessions/store.js";
import type { StoredSession } from "../src/rest/sessions/types.js";
import {
  compiledSessionHash,
  LEGACY_COMPILER_RUNTIME_HASHES,
} from "../src/rest/smartAccounts/compiler.js";
import type {
  CompiledSession,
  InstalledSessionObservation,
} from "../src/rest/smartAccounts/compiler/types.js";
import { createSessionPolicyReviewer } from "../src/rest/smartAccounts/policy.js";
import { createConfiguredSmartAccountStack } from "../src/rest/smartAccounts/stack/config.js";
import { fingerprint } from "../src/rest/smartAccounts/service.js";
import type {
  SessionPolicyInput,
  SmartAccountBinding,
} from "../src/rest/smartAccounts/types.js";
import { MemoryTransactionStore } from "../src/rest/transactions/memory.js";
import { PostgresTransactionStore } from "../src/rest/transactions/postgres.js";
import { MemoryTransportReservations } from "../src/rest/transactions/transport-reservations.js";
import { TransactionService } from "../src/rest/transactions/service.js";
import type { StoredPlan } from "../src/rest/transactions/types.js";
import { binding as bindingFixture } from "./fixtures/user-operations.js";

const audience = "https://juicebox.center";
const abi = parseAbi([
  "function getNonce(bytes32 permissionId,address account) view returns(uint256)",
  "function getPermissionIDs(address account) view returns(bytes32[])",
  "function isPermissionEnabled(bytes32 permissionId,address account) view returns(bool)",
  "function onInstall(bytes data)",
]);
const address = (name: string) =>
  `0x${fingerprint(name).slice(-40)}` as Address;
const idempotency = () => {
  const key = randomUUID();
  return { key, requestHash: fingerprint(key) };
};
const connectionString = process.env.TEST_DATABASE_URL;
const schema = `session_service_${randomUUID().replaceAll("-", "")}`;
let admin: Pool | undefined, pool: Pool | undefined;

type ChainSession = {
  enabled: boolean;
  enableNonce: string;
  calls: string;
  configurationHash: Hex;
};
async function setup(kind: "memory" | "postgres", planTtlMs = 60_000) {
  const now = () => Date.now();
  const ownerKey = privateKeyToAccount(fingerprint(`owner:${randomUUID()}`));
  const botKey = privateKeyToAccount(fingerprint(`bot:${randomUUID()}`));
  const accountId = accountIdFor(ownerKey.address, 1);
  const accounts: AccountStore =
    kind === "memory"
      ? new MemoryAccountStore()
      : new PostgresAccountStore(pool!);
  const auth = createRestAuth({
    store: accounts,
    audience,
    now: () => Math.floor(now() / 1000),
  });
  async function signed(
    wallet = ownerKey,
    grantId = "",
    requestTarget = "/api/v1/accounts/enroll",
    document: unknown = {},
  ) {
    const body = new TextEncoder().encode(JSON.stringify(document));
    const issuedAt = Math.floor(now() / 1000);
    const claims: RequestClaims = {
      accountId,
      signer: wallet.address,
      grantId,
      method: "POST",
      requestTarget,
      contentType: "application/json",
      bodyHash: keccak256(body),
      issuedAt,
      expiresAt: issuedAt + 120,
      nonce: fingerprint(randomUUID()),
      idempotencyKey: randomUUID(),
    };
    const signature = await wallet.signTypedData(
      buildRequestTypedData(audience, claims),
    );
    return {
      claims,
      input: {
        method: claims.method,
        requestTarget,
        contentType: claims.contentType,
        body,
        headers: new Headers({
          [H.account]: accountId,
          [H.signer]: wallet.address,
          [H.grant]: grantId,
          [H.issuedAt]: String(issuedAt),
          [H.expiresAt]: String(claims.expiresAt),
          [H.nonce]: claims.nonce,
          [H.signature]: signature,
          [H.idempotencyKey]: claims.idempotencyKey,
          "content-type": claims.contentType,
        }),
      } satisfies SignedRequestInput,
    };
  }
  const owner = await auth.enroll((await signed()).input);
  const grant: BotGrant = {
    id: randomUUID(),
    accountId,
    botAddress: botKey.address,
    scopes: ["read", "plan", "relay"],
    label: "Service integration fixture",
    createdAt: Math.floor(now() / 1000),
    expiresAt: Math.floor(now() / 1000) + 40 * 86400,
    revokedAt: null,
  };
  await accounts.registerBot(grant);
  const bot = await auth.authenticate(
    (await signed(botKey, grant.id, "/api/v1/sessions", {})).input,
    ["plan", "relay"],
  );
  const actor: RestActor = { accountId, principalId: owner.principalId };
  const botActor: RestActor = { accountId, principalId: bot.principalId };
  const stack = await createConfiguredSmartAccountStack({
    chainId: 1,
    sessionGuard: {
      address: address(`guard:${accountId}`),
      runtimeCodeHash: LEGACY_COMPILER_RUNTIME_HASHES.sessionGuard,
    },
  });
  const binding = bindingFixture(owner.account, now());
  binding.wallet.address = address(`safe:${accountId}`);
  binding.state.address = binding.wallet.address;
  binding.id = fingerprint({
    ownerAccountId: accountId,
    wallet: binding.wallet.address,
    chainId: 1,
  });
  binding.manifestId = stack.manifest.id;
  binding.state.manifestId = stack.manifest.id;
  binding.state.manifestRevision = stack.manifest.revision;
  let administration = {
    epoch: "0",
    hash: fingerprint(`administration:${accountId}:0`),
  } as {
    epoch: string;
    hash: Hex;
    lastInitialization?: { epoch: string; permissionIds: Hex[] };
  };
  binding.state.modules!.details = { sessionAdministration: administration };
  const blocks = new Map<string, RestBlockEvidence>();
  let block = 100n,
    linked = true,
    finalized = true,
    bindingChanged = false;
  const evidence = (): RestBlockEvidence => ({
    chainId: 1,
    blockNumber: block.toString(),
    blockHash: fingerprint(`${accountId}:${block}`),
    timestamp: String(Math.floor(now() / 1000)),
    source: "onchain",
  });
  function advance() {
    block++;
    binding.state.evidence = evidence();
    blocks.set(block.toString(), binding.state.evidence);
  }
  binding.state.evidence = evidence();
  blocks.set(block.toString(), binding.state.evidence);
  if (kind === "postgres")
    await pool!.query(
      `INSERT INTO rest_smart_account_bindings(account_id,id,chain_id,wallet_address,authorization_digest,created_at,updated_at,document)
     VALUES($1,$2,1,$3,$4,$5,$5,$6::jsonb)`,
      [
        accountId,
        binding.id,
        binding.wallet.address.toLowerCase(),
        binding.authorization.digest,
        now(),
        JSON.stringify(binding),
      ],
    );
  const currentBinding = vi.fn(
    async (
      requestedAccountId: string,
      bindingId: Hex,
    ): Promise<SmartAccountBinding> => {
      if (!linked)
        throw new RestError(
          404,
          "SMART_BINDING_NOT_FOUND",
          "The account was unlinked.",
        );
      if (bindingChanged)
        throw new RestError(
          409,
          "SMART_ACCOUNT_CHANGED",
          "The current Safe owner/module authority changed.",
        );
      if (requestedAccountId !== accountId || bindingId !== binding.id)
        throw new RestError(404, "SMART_BINDING_NOT_FOUND", "Wrong account.");
      return structuredClone(binding);
    },
  );
  const chain = new Map<string, ChainSession>();
  let permissionIdsOverride: Hex[] | undefined,
    permissionEnabledOverride: boolean | undefined;
  const chainState = (c: CompiledSession) =>
    chain.get(c.permissionId) ?? {
      enabled: false,
      enableNonce: c.activationEnableNonce,
      calls: "0",
      configurationHash: fingerprint(c.configurations),
    };
  const rpc = {
    request: vi.fn(
      async (chainId: number, method: string, params: readonly unknown[]) => {
        expect(chainId).toBe(1);
        if (method === "eth_getBlockByNumber") {
          const requested = params[0];
          if (requested === "finalized" && !finalized)
            return {
              number: "0x0",
              hash: fingerprint("genesis"),
              timestamp: "0x0",
            };
          const observed =
            requested === "finalized" || requested === "latest"
              ? binding.state.evidence
              : blocks.get(BigInt(String(requested)).toString());
          if (!observed)
            throw new Error(`Unexpected block ${String(requested)}`);
          return {
            number: toHex(BigInt(observed.blockNumber)),
            hash: observed.blockHash,
            timestamp: toHex(BigInt(observed.timestamp)),
          };
        }
        if (method === "eth_call") {
          expect(params[1]).toEqual({
            blockHash: binding.state.evidence.blockHash,
            requireCanonical: true,
          });
          const call = params[0] as { to: Address; data: Hex };
          expect(call.to.toLowerCase()).toBe(
            stack.compilerStack!.smartSessions.address.toLowerCase(),
          );
          const decoded = decodeFunctionData({ abi, data: call.data });
          if (decoded.functionName === "getPermissionIDs")
            return encodeFunctionResult({
              abi,
              functionName: "getPermissionIDs",
              result:
                permissionIdsOverride ??
                [...chain]
                  .filter(([, value]) => value.enabled)
                  .map(([id]) => id as Hex),
            });
          if (decoded.functionName === "isPermissionEnabled")
            return encodeFunctionResult({
              abi,
              functionName: "isPermissionEnabled",
              result:
                permissionEnabledOverride ??
                chain.get(decoded.args[0])?.enabled ??
                false,
            });
          if (decoded.functionName === "getNonce")
            return encodeFunctionResult({
              abi,
              functionName: "getNonce",
              result: BigInt(chain.get(decoded.args[0])?.enableNonce ?? "0"),
            });
        }
        throw new Error(`Unexpected RPC ${method}`);
      },
    ),
  } satisfies RestRpc;
  let verificationError: RestError | undefined;
  const observation = (c: CompiledSession): InstalledSessionObservation => {
    const state = chainState(c),
      gas = c.configurations.find(
        (configuration) => configuration.kind === "gas-budget",
      )!;
    return {
      permissionId: c.permissionId,
      compiledHash: c.compiledHash,
      account: c.wallet,
      chainId: c.chainId,
      enabled: state.enabled,
      enableNonce: state.enableNonce,
      configurationHash: state.configurationHash,
      evidence: structuredClone(binding.state.evidence),
      counters: [
        {
          policy: gas.policy.address,
          configId: gas.configId,
          name: "calls",
          used: state.calls,
          limit: "4",
        },
      ],
    };
  };
  const verifier = {
    verify: vi.fn(async (c: CompiledSession) => {
      if (verificationError) throw verificationError;
      if (
        [...chain].some(([id, value]) => id !== c.permissionId && value.enabled)
      )
        throw new RestError(
          409,
          "SMART_UNEXPECTED_SESSION",
          "Another session is active.",
        );
      return observation(c);
    }),
    verifyRevoked: vi.fn(async (c: CompiledSession, minimum: string) => {
      const observed = observation(c);
      if (observed.enabled || BigInt(observed.enableNonce) < BigInt(minimum))
        throw new RestError(409, "SMART_SESSION_STILL_ENABLED", "Not retired.");
      return { ...observed, counters: [] };
    }),
    verifyAt: vi.fn(
      async (c: CompiledSession, snapshot: { evidence: RestBlockEvidence }) => {
        if (verificationError) throw verificationError;
        if (
          [...chain].some(
            ([id, value]) => id !== c.permissionId && value.enabled,
          )
        )
          throw new RestError(
            409,
            "SMART_UNEXPECTED_SESSION",
            "Another session is active.",
          );
        if (!chainState(c).enabled)
          throw new RestError(
            409,
            "SMART_SESSION_NOT_INSTALLED",
            "Installed verification requires the enabled permission and actual policy state.",
          );
        return {
          ...observation(c),
          evidence: structuredClone(snapshot.evidence),
        };
      },
    ),
  };
  const transports = new MemoryTransportReservations(),
    planSnapshots = new Map<string, StoredPlan>();
  const transactionStore =
    kind === "memory"
      ? new MemoryTransactionStore(accounts, transports)
      : new PostgresTransactionStore(pool!);
  const store: SessionStore =
    kind === "memory"
      ? new MemorySessionStore(accounts, {
          now,
          assertBinding: () => {
            if (!linked)
              throw new RestError(409, "SESSION_BINDING_INACTIVE", "unlinked");
          },
          assertSupersedablePlan: (record, prior, checkedAt) => {
            const plan = planSnapshots.get(prior.planId);
            if (!plan || transports.list(plan.id).length)
              throw new RestError(
                409,
                "SESSION_PLAN_NOT_SUPERSEDABLE",
                "Prior owner plan is missing or already reserved.",
              );
            assertSessionPlanSupersedable(record, prior, plan, checkedAt);
          },
          grant: () => grant,
        })
      : new PostgresSessionStore(pool!);
  const target = address(`token:${accountId}`),
    paymaster = stack.paymaster!.address;
  const reviewer = createSessionPolicyReviewer({
    now,
    currentBinding,
    getGrant: async () =>
      (await accounts.listBots(accountId)).find(
        (value) => value.id === grant.id,
      ) ?? null,
    targets: [
      {
        chainId: 1,
        address: target,
        runtimeCodeHash: fingerprint("fixture-token-code"),
        kind: "erc20-exact-transfer",
        reviewId: "fixture-reviewed-token",
      },
    ],
    assets: [
      {
        chainId: 1,
        address: target,
        assetIdentity: "test-token",
        decimals: 18,
        reviewId: "fixture-reviewed-token",
      },
    ],
    paymasters: [
      {
        chainId: 1,
        address: paymaster,
        runtimeCodeHash: stack.paymaster!.runtimeCodeHash,
        reviewId: "pimlico-pinned-legacy-v7",
      },
    ],
  });
  const transactions = new TransactionService({
    store: transactionStore,
    rpc,
    now,
    policy: { planTtlMs },
    resolveSmartAccount: (requestedActor, id) =>
      currentBinding(requestedActor.accountId, id),
  });
  const consentProofs: {
    id: string;
    kind: string;
    compiledHash: Hex;
    digest: Hex;
  }[] = [];
  const authorizeOwnerPlan = vi.fn(
    async (
      requestedActor: RestActor,
      id: string,
      action: "activation" | "revocation",
      compiledHash: Hex,
    ) => {
      const request = await signed(
        ownerKey,
        "",
        `/api/v1/sessions/${id}/${action}`,
        { compiledHash },
      );
      const verifiedOwner = await auth.authenticate(
        request.input,
        ["plan"],
        true,
      );
      expect(requestedActor).toEqual({
        accountId,
        principalId: verifiedOwner.principalId,
      });
      const digest = hashTypedData(
        buildRequestTypedData(audience, request.claims),
      );
      consentProofs.push({ id, kind: action, compiledHash, digest });
      return {
        digest,
        issuedAt: request.claims.issuedAt,
        expiresAt: request.claims.expiresAt,
      };
    },
  );
  const dependencies: SessionServiceDependencies = {
    store,
    rpc,
    reviewer,
    compilerFor: () => stack.createCompiler(),
    verifier,
    currentBinding,
    currentBindingAt: async (requestedAccountId, id, requestedEvidence) => {
      const result = await currentBinding(requestedAccountId, id);
      expect(requestedEvidence).toEqual(result.state.evidence);
      return result;
    },
    transactions,
    authorizeOwnerPlan,
    now,
    configuredChainIds: [1],
  };
  const service = new SessionService(dependencies);
  const input = (generation = "1"): SessionPolicyInput => ({
    bindingId: binding.id,
    grantId: grant.id,
    generation,
    nonce: fingerprint(randomUUID()),
    validAfter: Math.floor(now() / 1000),
    durationDays: 7,
    maximumCalls: "4",
    gasBudget: {
      paymaster,
      maxGasPerOperation: "1000000",
      maxFeePerGas: "2",
      maxPriorityFeePerGas: "1",
      totalGasLimit: "4000000",
      totalSponsoredCostLimit: "8000000",
      maxPaymasterDataLength: 130,
    },
    allocations: [
      {
        id: "approved",
        total: "100",
        allocations: [{ id: "local", chainId: 1, asset: target, limit: "100" }],
      },
    ],
    actions: [
      {
        kind: "erc20-transfer",
        allocationId: "local",
        beneficiary: ownerKey.address,
        perCallLimit: "20",
        totalLimit: "100",
      },
    ],
  });
  async function prepare(generation = "1") {
    const idem = idempotency();
    return service.prepare(bot, input(generation), idem.key, idem.requestHash);
  }
  async function ownerPlan(
    record: StoredSession,
    action: "activation" | "revocation" = "activation",
    idem = idempotency(),
  ) {
    const result = await service.prepareOwnerPlan(
      owner,
      record.id,
      action,
      { compiledHash: record.compiled.compiledHash },
      idem.key,
      idem.requestHash,
    );
    planSnapshots.set(
      result.plan.id,
      (await transactionStore.get(actor, result.plan.id))!,
    );
    return result;
  }
  function observe(
    record: StoredSession,
    overrides: Partial<ChainSession> = {},
  ) {
    const prior = chainState(record.compiled);
    if (
      overrides.enabled !== undefined &&
      overrides.enabled !== prior.enabled
    ) {
      const epoch = (
        BigInt(administration.epoch) + (overrides.enabled ? 1n : 2n)
      ).toString();
      administration = {
        epoch,
        hash: fingerprint(`${accountId}:administration:${epoch}`),
        ...(overrides.enabled
          ? {
              lastInitialization: {
                epoch,
                permissionIds: [record.compiled.permissionId],
              },
            }
          : administration.lastInitialization
            ? { lastInitialization: administration.lastInitialization }
            : {}),
      };
      binding.state.modules!.details = {
        sessionAdministration: administration,
      };
    }
    advance();
    chain.set(record.compiled.permissionId, {
      ...chainState(record.compiled),
      ...overrides,
    });
  }
  async function activate() {
    const prepared = await prepare();
    const result = await ownerPlan(prepared);
    observe(result.session, { enabled: true });
    return service.get(owner, prepared.id);
  }
  async function unlink() {
    linked = false;
    if (kind === "postgres")
      await pool!.query(
        "UPDATE rest_smart_account_bindings SET revoked_at=$3 WHERE account_id=$1 AND id=$2",
        [accountId, binding.id, now()],
      );
  }
  async function assertLifecycle(planId: string) {
    const plan = (await transactionStore.get(actor, planId))!;
    if (kind === "memory")
      return accounts.withActiveActor(
        actor,
        ["relay"],
        Math.floor(now() / 1000),
        async () =>
          (store as MemorySessionStore).assertUserOperationLifecyclePlan(
            actor,
            plan,
            Math.floor(now() / 1000),
          ),
      );
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await assertRestActorActive(
        client,
        actor,
        ["relay"],
        Math.floor(now() / 1000),
      );
      await assertUserOperationLifecyclePlan(
        client,
        actor,
        plan,
        Math.floor(now() / 1000),
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return {
    service,
    store,
    accounts,
    auth,
    owner,
    bot,
    actor,
    botActor,
    grant,
    binding,
    rpc,
    verifier,
    input,
    prepare,
    ownerPlan,
    activate,
    observe,
    advance,
    unlink,
    transactionStore,
    transactions,
    authorizeOwnerPlan,
    consentProofs,
    assertLifecycle,
    setVerificationError: (error?: RestError) => {
      verificationError = error;
    },
    setFinalized: (value: boolean) => {
      finalized = value;
    },
    setPermissionIds: (value?: Hex[]) => {
      permissionIdsOverride = value;
    },
    setPermissionEnabled: (value?: boolean) => {
      permissionEnabledOverride = value;
    },
    changeBinding: () => {
      bindingChanged = true;
    },
    resetAdministration: (record: StoredSession) => {
      const epoch = (BigInt(administration.epoch) + 1n).toString();
      administration = {
        epoch,
        hash: fingerprint(`${accountId}:administration:${epoch}`),
        lastInitialization: {
          epoch,
          permissionIds: [record.compiled.permissionId],
        },
      };
      binding.state.modules!.details = {
        sessionAdministration: administration,
      };
      advance();
    },
  };
}

for (const kind of ["memory", "postgres"] as const) {
  const suite =
    kind === "postgres" && !connectionString ? describe.skip : describe;
  suite(`SessionService with ${kind} lifecycle storage`, () => {
    if (kind === "postgres") {
      beforeAll(async () => {
        admin = new Pool({ connectionString });
        await admin.query(`CREATE SCHEMA ${schema}`);
        pool = new Pool({
          connectionString,
          options: `-c search_path=${schema}`,
          max: 8,
        });
        for (const name of [
          "004_rest_accounts.sql",
          "005_rest_transactions.sql",
          "006_rest_sponsorship.sql",
          "007_rest_smart_accounts.sql",
          "008_rest_user_operations.sql",
          "009_rest_sessions.sql",
        ])
          await pool.query(
            await readFile(
              new URL(`../src/db/migrations/${name}`, import.meta.url),
              "utf8",
            ),
          );
      });
      afterAll(async () => {
        await pool?.end();
        if (admin) {
          await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
          await admin.end();
        }
      });
    }
    it("compiles a bot policy and binds cryptographic owner consent to the exact immutable setup plan", async () => {
      const h = await setup(kind),
        request = h.input(),
        idem = idempotency();
      const prepared = await h.service.prepare(
        h.bot,
        request,
        idem.key,
        idem.requestHash,
      );
      expect(prepared.state).toBe("prepared");
      expect(prepared.compiled.compiledHash).toBe(
        compiledSessionHash(prepared.compiled),
      );
      expect(prepared.compiled.sessionKey).toBe(h.bot.signer);
      const rpcCount = h.rpc.request.mock.calls.length;
      expect(
        (await h.service.prepare(h.bot, request, idem.key, idem.requestHash))
          .id,
      ).toBe(prepared.id);
      expect(h.rpc.request).toHaveBeenCalledTimes(rpcCount);
      const activation = await h.ownerPlan(prepared);
      expect(activation.session.state).toBe("installing");
      expect(activation.installationConfirmed).toBe(false);
      expect(activation.session.activation).toMatchObject({
        planId: activation.plan.id,
        planCommitment: activation.plan.commitment,
        compiledHash: prepared.compiled.compiledHash,
        digest: h.consentProofs[0]!.digest,
      });
      const plan = await h.transactionStore.get(h.actor, activation.plan.id);
      expect(plan!.draft.calls).toHaveLength(1);
      expect(
        decodeFunctionData({ abi, data: plan!.draft.calls[0]!.data })
          .functionName,
      ).toBe("onInstall");
      await expect(
        h.service.assertOwnerPlan(h.owner, plan!),
      ).resolves.toBeUndefined();
      await expect(h.assertLifecycle(plan!.id)).resolves.toBeUndefined();
      h.observe(prepared, { enabled: true });
      expect((await h.service.get(h.owner, prepared.id)).state).toBe("active");
      await expect(
        h.service.assertOwnerPlan(h.owner, plan!),
      ).rejects.toMatchObject({ code: "SESSION_PLAN_NOT_ADMITTED" });
      await expect(h.assertLifecycle(plan!.id)).rejects.toMatchObject({
        code: "SESSION_LIFECYCLE_PLAN_UNADMITTED",
      });
    });
    it("rejects bot owner-plans and changed compiled bytes before requesting consent", async () => {
      const h = await setup(kind),
        prepared = await h.prepare(),
        idem = idempotency();
      await expect(
        h.service.prepareOwnerPlan(
          h.bot,
          prepared.id,
          "activation",
          { compiledHash: prepared.compiled.compiledHash },
          idem.key,
          idem.requestHash,
        ),
      ).rejects.toMatchObject({ code: "SESSION_OWNER_REQUIRED" });
      await expect(
        h.service.prepareOwnerPlan(
          h.owner,
          prepared.id,
          "activation",
          { compiledHash: fingerprint("changed") },
          idem.key,
          idem.requestHash,
        ),
      ).rejects.toMatchObject({ code: "SESSION_REVIEW_CHANGED" });
      expect(h.authorizeOwnerPlan).not.toHaveBeenCalled();
    });
    it("reports installing before the owner transaction mines using canonical absence without synthetic counters", async () => {
      const h = await setup(kind),
        prepared = await h.prepare(),
        activation = await h.ownerPlan(prepared);
      const pending = await h.service.get(h.owner, prepared.id);
      expect(pending).toMatchObject({
        state: "installing",
        reservationsReleased: false,
        observation: {
          installed: {
            enabled: false,
            enableNonce: "0",
            counters: [],
            evidence: h.binding.state.evidence,
            administration: { epoch: "0" },
          },
        },
      });
      expect(pending.observation?.installed.configurationHash).not.toBe(
        fingerprint(prepared.compiled.configurations),
      );
      expect(h.verifier.verifyAt).not.toHaveBeenCalled();
      expect((await h.service.quota(h.bot, prepared.id)).counters).toEqual([]);
      await expect(
        h.assertLifecycle(activation.plan.id),
      ).resolves.toBeUndefined();
      await expect(
        h.service.executionBinding(h.bot, prepared.id),
      ).rejects.toMatchObject({ code: "SESSION_NOT_ACTIVE" });
      h.observe(prepared, { enabled: true });
      expect((await h.service.get(h.owner, prepared.id)).state).toBe("active");
      expect(h.verifier.verifyAt).toHaveBeenCalledOnce();
    });
    it("fails closed when the permission list and enabled getter disagree or exceed the supported layout", async () => {
      const h = await setup(kind),
        prepared = await h.prepare();
      await h.ownerPlan(prepared);
      h.setPermissionEnabled(true);
      await expect(h.service.get(h.owner, prepared.id)).rejects.toMatchObject({
        code: "SESSION_ABSENCE_UNVERIFIED",
      });
      expect((await h.store.get(h.actor, prepared.id))?.state).toBe("stale");
      h.setPermissionEnabled(false);
      h.setPermissionIds([
        fingerprint("unexpected-a"),
        fingerprint("unexpected-b"),
      ]);
      await expect(h.service.get(h.owner, prepared.id)).rejects.toMatchObject({
        code: "SESSION_PERMISSION_LAYOUT_CHANGED",
      });
      expect(h.verifier.verifyAt).not.toHaveBeenCalled();
    });
    it("returns the original activation plan after installation without reinitializing policies", async () => {
      const h = await setup(kind),
        prepared = await h.prepare(),
        idem = idempotency();
      const first = await h.ownerPlan(prepared, "activation", idem);
      h.observe(prepared, { enabled: true });
      await h.service.get(h.owner, prepared.id);
      const count = h.authorizeOwnerPlan.mock.calls.length;
      const retry = await h.ownerPlan(prepared, "activation", idem);
      expect(retry.plan.id).toBe(first.plan.id);
      expect(retry.installationConfirmed).toBe(true);
      expect(h.authorizeOwnerPlan).toHaveBeenCalledTimes(count);
    });
    it("supersedes an expired unsubmitted owner plan without changing the compiled permission or resetting counters", async () => {
      const h = await setup(kind, 1_500),
        prepared = await h.prepare(),
        first = await h.ownerPlan(prepared);
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, first.plan.expiresAt - Date.now()) + 40,
        ),
      );
      h.advance();
      const replacement = await h.ownerPlan(prepared);
      expect(replacement.plan.id).not.toBe(first.plan.id);
      expect(replacement.session.compiled).toEqual(prepared.compiled);
      expect(replacement.session.activation?.planId).toBe(replacement.plan.id);
      expect(replacement.session.observation).toBeUndefined();
      await expect(h.assertLifecycle(first.plan.id)).rejects.toMatchObject({
        code: "SESSION_LIFECYCLE_PLAN_UNADMITTED",
      });
      await expect(
        h.assertLifecycle(replacement.plan.id),
      ).resolves.toBeUndefined();
    });
    it("refreshes quota and binds execution to the current canonical observation rather than an available balance", async () => {
      const h = await setup(kind),
        active = await h.activate();
      h.observe(active, { calls: "2" });
      const quota = await h.service.quota(h.bot, active.id);
      expect(quota).toMatchObject({
        state: "active",
        executionAuthority: false,
        balanceSource: "onchain-only",
        atomicAcrossChains: false,
      });
      expect(quota.counters?.[0]).toMatchObject({ used: "2", limit: "4" });
      expect(quota).not.toHaveProperty("remainingBalance");
      const result = await h.service.executionBinding(
        h.bot,
        active.id,
        undefined,
        h.binding.state.evidence,
      );
      expect(result.binding.observationHash).toBe(
        result.record.observation?.proofHash,
      );
      expect(h.verifier.verifyAt).toHaveBeenCalled();
      await expect(
        h.service.executionBinding(h.owner, active.id),
      ).rejects.toMatchObject({ code: "SESSION_BOT_REQUIRED" });
      await h.unlink();
      await expect(
        h.service.executionBinding(
          h.bot,
          active.id,
          undefined,
          h.binding.state.evidence,
        ),
      ).rejects.toMatchObject({ code: "SMART_BINDING_NOT_FOUND" });
    });
    it("retains a counter-reset invalidation after verification recovers", async () => {
      const h = await setup(kind),
        active = await h.activate();
      h.observe(active, { calls: "2" });
      await h.service.get(h.owner, active.id);
      h.observe(active, { calls: "0" });
      expect(await h.service.get(h.owner, active.id)).toMatchObject({
        state: "stale",
        invalidation: { reason: "counter-reset" },
      });
      h.setVerificationError(
        new RestError(502, "UPSTREAM_UNAVAILABLE", "temporary"),
      );
      await expect(h.service.get(h.owner, active.id)).rejects.toMatchObject({
        code: "UPSTREAM_UNAVAILABLE",
      });
      h.setVerificationError();
      h.advance();
      expect(await h.service.get(h.owner, active.id)).toMatchObject({
        state: "stale",
        invalidation: { reason: "counter-reset" },
      });
      await expect(
        h.service.executionBinding(h.bot, active.id),
      ).rejects.toMatchObject({ code: "SESSION_NOT_ACTIVE" });
    });
    it("reconciles an owner-approved revocation after unlinking without reauthorizing session execution", async () => {
      const h = await setup(kind),
        active = await h.activate();
      const revoked = await h.ownerPlan(active, "revocation");
      expect(revoked.session.state).toBe("revoking");
      await h.unlink();
      h.observe(active, { enabled: false, enableNonce: "1" });
      expect(await h.service.get(h.owner, active.id)).toMatchObject({
        state: "revoked",
        reservationsReleased: true,
      });
      expect(h.verifier.verifyRevoked).toHaveBeenCalled();
    });
    it("keeps a disabled permission revoking until its enable nonce advances and retirement is finalized", async () => {
      const h = await setup(kind),
        active = await h.activate();
      await h.ownerPlan(active, "revocation");
      h.observe(active, { enabled: false });
      expect(await h.service.get(h.owner, active.id)).toMatchObject({
        state: "revoking",
        reservationsReleased: false,
        observation: {
          installed: { enabled: false, enableNonce: "0", counters: [] },
        },
      });
      await expect(
        h.service.executionBinding(h.bot, active.id),
      ).rejects.toMatchObject({ code: "SESSION_NOT_ACTIVE" });
      h.setFinalized(false);
      h.observe(active, { enableNonce: "1" });
      expect(await h.service.get(h.owner, active.id)).toMatchObject({
        state: "revoked",
        reservationsReleased: false,
      });
      h.setFinalized(true);
      expect(await h.service.get(h.owner, active.id)).toMatchObject({
        state: "revoked",
        reservationsReleased: true,
      });
    });
    it("requires a fresh owner binding before preparing a new revocation plan after unlinking", async () => {
      const h = await setup(kind),
        active = await h.activate();
      await h.unlink();
      await expect(h.ownerPlan(active, "revocation")).rejects.toMatchObject({
        code: "SMART_BINDING_NOT_FOUND",
      });
      expect(
        (await h.store.get(h.actor, active.id))?.revocation,
      ).toBeUndefined();
    });
    it("rejects lifecycle idempotency reuse across activation and revocation", async () => {
      const h = await setup(kind),
        prepared = await h.prepare(),
        idem = idempotency();
      const activation = await h.ownerPlan(prepared, "activation", idem);
      await expect(
        h.ownerPlan(activation.session, "revocation", idem),
      ).rejects.toMatchObject({ code: "SESSION_PLAN_CONFLICT" });
      expect(
        (await h.store.get(h.actor, prepared.id))?.revocation,
      ).toBeUndefined();
    });
    it("requires current Safe authority even when execution is pinned to a canonical block", async () => {
      const h = await setup(kind),
        active = await h.activate();
      h.changeBinding();
      await expect(
        h.service.executionBinding(
          h.bot,
          active.id,
          undefined,
          h.binding.state.evidence,
        ),
      ).rejects.toMatchObject({ code: "SMART_ACCOUNT_CHANGED" });
    });
    it("permanently invalidates an active generation when its administration epoch changes without lower counters", async () => {
      const h = await setup(kind),
        active = await h.activate();
      h.resetAdministration(active);
      expect(await h.service.get(h.owner, active.id)).toMatchObject({
        state: "stale",
        invalidation: { reason: "configuration-changed" },
      });
      h.advance();
      expect((await h.service.get(h.owner, active.id)).state).toBe("stale");
      await expect(
        h.service.executionBinding(h.bot, active.id),
      ).rejects.toMatchObject({ code: "SESSION_NOT_ACTIVE" });
    });
    it("rejects a second initialization before the first enabled observation even when counters remain zero", async () => {
      const h = await setup(kind),
        prepared = await h.prepare();
      await h.ownerPlan(prepared);
      h.resetAdministration(prepared);
      h.observe(prepared, { enabled: true });
      expect(await h.service.get(h.owner, prepared.id)).toMatchObject({
        state: "stale",
        invalidation: { reason: "configuration-changed" },
        preparedAdministration: { epoch: "0" },
        observation: { installed: { administration: { epoch: "2" } } },
      });
      await expect(
        h.service.executionBinding(h.bot, prepared.id),
      ).rejects.toMatchObject({ code: "SESSION_NOT_ACTIVE" });
    });
    it("refreshes a retired session after a newer generation becomes active without reserving the wallet again", async () => {
      const h = await setup(kind),
        old = await h.activate();
      await h.ownerPlan(old, "revocation");
      h.observe(old, { enabled: false, enableNonce: "1" });
      expect(await h.service.get(h.owner, old.id)).toMatchObject({
        state: "revoked",
        reservationsReleased: true,
      });
      const next = await h.prepare("2");
      await h.ownerPlan(next);
      h.observe(next, { enabled: true });
      expect((await h.service.get(h.owner, next.id)).state).toBe("active");
      expect(await h.service.get(h.owner, old.id)).toMatchObject({
        state: "revoked",
        reservationsReleased: true,
      });
      expect(
        (await h.store.get(h.actor, old.id))?.observation?.installed.counters,
      ).toEqual([]);
      expect((await h.service.executionBinding(h.bot, next.id)).record.id).toBe(
        next.id,
      );
    });
  });
}
