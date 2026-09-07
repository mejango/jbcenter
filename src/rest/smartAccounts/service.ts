import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  isAddress,
  keccak256,
  parseAbi,
  recoverAddress,
  stringToHex,
  zeroAddress,
  type Address,
  type Abi,
  type Hex,
} from "viem";
import { RestError } from "../core.js";
import { parseAccountId } from "../auth/signatures.js";
import type { RestPrincipal } from "../auth/store.js";
import { exactObject } from "../protocol/abi.js";
import { rpcHex } from "../protocol/code.js";
import { SMART_ACCOUNT_RESEARCH } from "./observations.js";
import type {
  SmartAccountBinding,
  SmartAccountDependencies,
  SmartAccountManifest,
  SmartAccountState,
  SmartSnapshot,
} from "./types.js";

const safeAbi = parseAbi([
  "function VERSION() view returns (string)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getModulesPaginated(address start,uint256 pageSize) view returns (address[] array,address next)",
]);
const sentinel = "0x0000000000000000000000000000000000000001" as const;
const slot0 = `0x${"00".repeat(32)}` as Hex;
const fallbackSlot = keccak256(stringToHex("fallback_manager.handler.address"));
const guardSlot = keccak256(stringToHex("guard_manager.guard.address"));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const bytes32 = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
export function stable(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value))
    return String(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  throw new RestError(
    400,
    "SMART_ACCOUNT_INPUT_INVALID",
    "Expected canonical bounded JSON.",
  );
}
export const fingerprint = (value: unknown) =>
  keccak256(stringToHex(stable(value)));
function fail(code: string, message: string, status = 422): never {
  throw new RestError(status, code, message);
}
function quantity(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) ||
    value.length > 66
  )
    return fail("SMART_RPC_INVALID", "RPC returned an invalid quantity.", 502);
  return BigInt(value);
}
const addressFromSlot = (value: unknown): Address => {
  if (!bytes32(value) || !/^0x0{24}/i.test(value))
    return fail(
      "SMART_ACCOUNT_STORAGE_INVALID",
      "Account storage did not contain a canonical address.",
    );
  return getAddress(`0x${value.slice(-40)}`);
};
export interface BindingChallengeInput {
  manifestId: string;
  address: Address;
  nonce: Hex;
  expiresAt: number;
}
export function createSmartAccountService(options: SmartAccountDependencies) {
  const now = options.now ?? Date.now;
  const audience = new URL(options.audience);
  if (
    audience.protocol !== "https:" &&
    !(
      audience.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(audience.hostname)
    )
  )
    fail(
      "SMART_ACCOUNT_CONFIG_INVALID",
      "Use a configured HTTPS service audience.",
      500,
    );
  const manifests = structuredClone(options.manifests);
  if (new Set(manifests.map((item) => item.id)).size !== manifests.length)
    fail(
      "SMART_ACCOUNT_CONFIG_INVALID",
      "Duplicate deployment manifest ID.",
      500,
    );
  function pins(manifest: SmartAccountManifest) {
    return [
      manifest.singleton,
      manifest.factory,
      manifest.safe7579,
      manifest.launchpad,
      ...(manifest.entryPoint ? [manifest.entryPoint] : []),
      manifest.smartSessions,
      ...manifest.policies,
    ];
  }
  for (const m of manifests) {
    if (
      !m.id ||
      !["ownership-only", "execution-candidate"].includes(m.mode) ||
      !Number.isSafeInteger(m.chainId) ||
      m.chainId < 1 ||
      !bytes32(m.revision) ||
      !bytes32(m.proxyRuntimeCodeHash) ||
      m.safeVersion !== "1.4.1" ||
      (m.entryPoint !== undefined && m.entryPoint.version !== "0.7") ||
      !m.moduleInspectorId ||
      m.policies.length > 16
    )
      fail(
        "SMART_ACCOUNT_CONFIG_INVALID",
        "Incomplete reviewed deployment manifest.",
        500,
      );
    for (const pin of pins(m))
      if (
        !isAddress(pin.address) ||
        same(pin.address, zeroAddress) ||
        !bytes32(pin.runtimeCodeHash) ||
        !/^https:\/\/github\.com\//.test(pin.source.repository) ||
        !/^[a-f0-9]{40}$/.test(pin.source.commit) ||
        !/^[a-f0-9]{64}$/.test(pin.source.artifactSha256)
      )
        fail(
          "SMART_ACCOUNT_CONFIG_INVALID",
          "Deployment pins require exact source and runtime identities.",
          500,
        );
  }
  function manifest(id: string) {
    return (
      manifests.find((item) => item.id === id) ??
      fail(
        "SMART_MANIFEST_UNAVAILABLE",
        "No reviewed smart-account deployment manifest is configured for this selection.",
      )
    );
  }
  function owner(principal: RestPrincipal) {
    const identity = parseAccountId(principal.account.id);
    if (
      !principal.isOwner ||
      principal.grantId !== null ||
      !same(identity.ownerAddress, principal.signer) ||
      !same(identity.ownerAddress, principal.account.ownerAddress)
    )
      fail(
        "SMART_OWNER_REQUIRED",
        "Only the authenticated API owner can link or revoke a smart account.",
        403,
      );
    return identity;
  }
  async function snapshot(
    chainId: number,
    signal?: AbortSignal,
  ): Promise<SmartSnapshot> {
    const deadline = AbortSignal.any([
      AbortSignal.timeout(10000),
      ...(signal ? [signal] : []),
    ]);
    if (
      quantity(
        await options.rpc.request(chainId, "eth_chainId", [], deadline),
      ) !== BigInt(chainId)
    )
      fail(
        "SMART_CHAIN_MISMATCH",
        "RPC chain identity does not match the requested account.",
      );
    const block = (await options.rpc.request(
      chainId,
      "eth_getBlockByNumber",
      ["latest", false],
      deadline,
    )) as Record<string, unknown>;
    if (!block || !bytes32(block.hash))
      fail("SMART_RPC_INVALID", "A mined canonical block is required.", 502);
    const evidence = {
      chainId,
      blockNumber: String(quantity(block.number)),
      blockHash: block.hash,
      timestamp: String(quantity(block.timestamp)),
      source: "onchain" as const,
    };
    const tag = { blockHash: block.hash, requireCanonical: true as const };
    return {
      evidence,
      tag,
      request: (method, params) =>
        options.rpc.request(chainId, method, [...params, tag], deadline),
    };
  }
  async function inspect(
    input: { manifestId: string; address: Address },
    signal?: AbortSignal,
  ): Promise<SmartAccountState> {
    exactObject(input, ["manifestId", "address"], "account");
    const m = manifest(input.manifestId);
    if (!isAddress(input.address) || same(input.address, zeroAddress))
      fail(
        "SMART_ACCOUNT_INPUT_INVALID",
        "Use a deployed smart account address.",
        400,
      );
    const account = getAddress(input.address),
      snap = await snapshot(m.chainId, signal);
    const codeHashes: SmartAccountState["codeHashes"] = [];
    async function requireCode(address: Address, expected: Hex) {
      const code = rpcHex(
        await snap.request("eth_getCode", [address]),
        "runtime code",
      );
      if (code === "0x" || keccak256(code) !== expected.toLowerCase())
        fail(
          "SMART_RUNTIME_MISMATCH",
          "Smart account or dependency runtime does not match its reviewed deployment pin.",
        );
      codeHashes.push({ address, runtimeCodeHash: keccak256(code) });
    }
    await requireCode(account, m.proxyRuntimeCodeHash);
    for (const pin of pins(m))
      await requireCode(pin.address, pin.runtimeCodeHash);
    const [singleton, fallback, guard] = await Promise.all(
      [slot0, fallbackSlot, guardSlot].map(async (slot) =>
        addressFromSlot(
          await snap.request("eth_getStorageAt", [account, slot]),
        ),
      ),
    );
    if (
      !same(singleton!, m.singleton.address) ||
      !same(fallback!, m.safe7579.address) ||
      !same(guard!, zeroAddress)
    )
      fail(
        "SMART_ACCOUNT_LAYOUT_UNSUPPORTED",
        "The Safe singleton, fallback handler or guard differs from the reviewed account layout.",
      );
    async function read(
      functionName: string,
      args: readonly unknown[] = [],
    ): Promise<unknown> {
      const data = encodeFunctionData({
        abi: safeAbi as Abi,
        functionName,
        args,
      });
      const result = rpcHex(
        await snap.request("eth_call", [{ to: account, data, gas: "0xf4240" }]),
        "Safe read",
      );
      return decodeFunctionResult({
        abi: safeAbi as Abi,
        functionName,
        data: result,
      });
    }
    const [version, ownersRaw, thresholdRaw, nonceRaw, moduleList] =
      await Promise.all([
        read("VERSION"),
        read("getOwners"),
        read("getThreshold"),
        read("nonce"),
        read("getModulesPaginated", [sentinel, 33n]),
      ]);
    if (
      version !== m.safeVersion ||
      !Array.isArray(ownersRaw) ||
      ownersRaw.length < 1 ||
      ownersRaw.length > 16 ||
      !ownersRaw.every(
        (entry) => typeof entry === "string" && isAddress(entry),
      ) ||
      typeof thresholdRaw !== "bigint" ||
      thresholdRaw < 1n ||
      thresholdRaw > BigInt(ownersRaw.length) ||
      typeof nonceRaw !== "bigint"
    )
      fail(
        "SMART_ACCOUNT_OWNERS_INVALID",
        "The Safe owner configuration is unsupported.",
      );
    const owners = ownersRaw.map((entry) => getAddress(entry as string));
    if (
      new Set(owners.map((entry) => entry.toLowerCase())).size !==
        owners.length ||
      owners.some((entry) => same(entry, zeroAddress))
    )
      fail("SMART_ACCOUNT_OWNERS_INVALID", "Invalid Safe owner set.");
    // V1 proves the current EOA-owner threshold directly. Contract/delegated owners need another reviewed verifier.
    for (const address of owners)
      if (
        rpcHex(await snap.request("eth_getCode", [address]), "owner code") !==
        "0x"
      )
        fail(
          "SMART_CONTRACT_OWNER_UNSUPPORTED",
          "Contract or delegated Safe owners require a separately reviewed owner-signature adapter.",
        );
    if (
      !Array.isArray(moduleList) ||
      !Array.isArray(moduleList[0]) ||
      moduleList[0].length !== 1 ||
      !same(String(moduleList[0][0]), m.safe7579.address) ||
      !same(String(moduleList[1]), sentinel)
    )
      fail(
        "SMART_SAFE_MODULES_UNSUPPORTED",
        "The Safe must enable only the pinned Safe7579 adapter; pagination must be complete.",
      );
    const inspector = options.moduleInspectors?.find(
      (item) => item.id === m.moduleInspectorId,
    );
    const modules = inspector
      ? await inspector.inspect({ account, manifest: m, snapshot: snap })
      : null;
    if (
      modules &&
      (!bytes32(modules.stateHash) ||
        modules.complete !== true ||
        modules.arbitrarySigningDisabled !== true ||
        modules.wildcardExecutionDisabled !== true ||
        Buffer.byteLength(stable(modules)) > 8192)
    )
      fail(
        "SMART_MODULE_PROOF_INVALID",
        "Complete bounded module and signing-policy evidence is required.",
      );
    const stateHash = fingerprint({
      address: account.toLowerCase(),
      manifestRevision: m.revision,
      owners: owners.map((a) => a.toLowerCase()).sort(),
      threshold: String(thresholdRaw),
      singleton,
      fallback,
      guard,
      modules: modules?.stateHash ?? null,
    });
    return {
      chainId: m.chainId,
      address: account,
      manifestId: m.id,
      manifestRevision: m.revision,
      owners,
      threshold: Number(thresholdRaw),
      safeNonce: String(nonceRaw),
      stateHash,
      evidence: snap.evidence,
      codeHashes,
      modules,
      moduleConfigurationVerified: modules !== null,
      executionVerified: false,
    };
  }
  async function challenge(
    principal: RestPrincipal,
    input: BindingChallengeInput,
    signal?: AbortSignal,
  ) {
    owner(principal);
    exactObject(
      input,
      ["manifestId", "address", "nonce", "expiresAt"],
      "binding",
    );
    if (
      !bytes32(input.nonce) ||
      BigInt(input.nonce) === 0n ||
      !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= Math.floor(now() / 1000) ||
      input.expiresAt > Math.floor(now() / 1000) + 900
    )
      fail(
        "SMART_BINDING_INVALID",
        "Use a random nonce and an owner binding expiry within fifteen minutes.",
        400,
      );
    if (same(input.address, principal.account.ownerAddress))
      fail(
        "SMART_WALLET_IDENTITY_REQUIRED",
        "The smart-account wallet must be distinct from the API owner EOA.",
      );
    const state = await inspect(
      { manifestId: input.manifestId, address: input.address },
      signal,
    );
    if (
      !state.owners.some((item) => same(item, principal.account.ownerAddress))
    )
      fail(
        "SMART_OWNER_NOT_MEMBER",
        "The API owner is not a current owner of this Safe.",
        403,
      );
    const typedData = {
      domain: {
        name: "Juicebox Center Smart Account",
        version: "1",
        chainId: state.chainId,
        verifyingContract: state.address,
        salt: keccak256(stringToHex(audience.toString())),
      },
      types: {
        BindSmartAccount: [
          { name: "accountId", type: "string" },
          { name: "owner", type: "address" },
          { name: "stateHash", type: "bytes32" },
          { name: "nonce", type: "bytes32" },
          { name: "expiresAt", type: "uint64" },
        ],
      },
      primaryType: "BindSmartAccount" as const,
      message: {
        accountId: principal.account.id,
        owner: principal.account.ownerAddress,
        stateHash: state.stateHash,
        nonce: input.nonce,
        expiresAt: BigInt(input.expiresAt),
      },
    };
    return { state, typedData, digest: hashTypedData(typedData) };
  }
  async function bind(
    principal: RestPrincipal,
    input: BindingChallengeInput & { stateHash: Hex; signature: Hex },
    signal?: AbortSignal,
  ): Promise<SmartAccountBinding> {
    exactObject(
      input,
      ["manifestId", "address", "nonce", "expiresAt", "stateHash", "signature"],
      "binding",
    );
    const fresh = await challenge(
      principal,
      {
        manifestId: input.manifestId,
        address: input.address,
        nonce: input.nonce,
        expiresAt: input.expiresAt,
      },
      signal,
    );
    if (fresh.state.stateHash !== input.stateHash)
      fail(
        "SMART_ACCOUNT_CHANGED",
        "The wallet owner/module configuration changed since review.",
        409,
      );
    if (
      typeof input.signature !== "string" ||
      !new RegExp(`^0x[0-9a-fA-F]{${fresh.state.threshold * 130}}$`).test(
        input.signature,
      )
    )
      fail(
        "SMART_OWNER_SIGNATURE_INVALID",
        "Supply exactly the current threshold of packed owner EIP-712 signatures.",
        403,
      );
    let previous = 0n;
    for (let i = 0; i < fresh.state.threshold; i++) {
      const part =
        `0x${input.signature.slice(2 + i * 130, 2 + (i + 1) * 130)}` as Hex;
      if (!["1b", "1c"].includes(part.slice(-2).toLowerCase()))
        fail(
          "SMART_OWNER_SIGNATURE_INVALID",
          "Only direct EIP-712 EOA-owner signatures are accepted; approved hashes and session signatures cannot bind accounts.",
          403,
        );
      let signer: Address;
      try {
        signer = await recoverAddress({
          hash: fresh.digest,
          signature: part,
        });
      } catch {
        fail(
          "SMART_OWNER_SIGNATURE_INVALID",
          "An owner signature is malformed or cannot be recovered.",
          403,
        );
      }
      if (
        BigInt(signer) <= previous ||
        !fresh.state.owners.some((entry) => same(entry, signer))
      )
        fail(
          "SMART_OWNER_SIGNATURE_INVALID",
          "Signatures must satisfy the current Safe owner threshold in address order.",
          403,
        );
      previous = BigInt(signer);
    }
    const record: SmartAccountBinding = {
      id: fingerprint({
        ownerAccountId: principal.account.id,
        wallet: fresh.state.address,
        chainId: fresh.state.chainId,
      }),
      ownerAccountId: principal.account.id,
      ownerAddress: principal.account.ownerAddress,
      wallet: { chainId: fresh.state.chainId, address: fresh.state.address },
      manifestId: input.manifestId,
      authorization: {
        digest: fresh.digest,
        nonce: input.nonce,
        expiresAt: input.expiresAt,
        method: "safe-current-owner-threshold",
      },
      state: fresh.state,
    };
    return options.registry.bind(record);
  }
  async function current(
    ownerAccountId: string,
    id: Hex,
    signal?: AbortSignal,
  ) {
    const record = await options.registry.get(ownerAccountId, id);
    if (!record)
      fail(
        "SMART_BINDING_NOT_FOUND",
        "The account binding is absent or revoked.",
        404,
      );
    const state = await inspect(
      { manifestId: record.manifestId, address: record.wallet.address },
      signal,
    );
    if (state.stateHash !== record.state.stateHash)
      fail(
        "SMART_ACCOUNT_CHANGED",
        "The owner or module configuration changed. Obtain a fresh owner account binding.",
        409,
      );
    return { ...record, state };
  }
  async function capabilities() {
    return {
      deploymentResearch: SMART_ACCOUNT_RESEARCH,
      accountOwnershipVerification: "safe-current-eoa-owner-threshold",
      sessionDurationsDays: [7, 30],
      walletCreation: false,
      userOperationPreparation: false,
      userOperationSimulation: false,
      userOperationRelay: false,
      deployments: manifests.map((m) => ({
        manifestId: m.id,
        mode: m.mode,
        chainId: m.chainId,
        revision: m.revision,
        moduleGeneration: m.smartSessions.generation,
        entryPointSourceVerified: m.entryPoint !== undefined,
        moduleInspectionConfigured:
          options.moduleInspectors?.some((i) => i.id === m.moduleInspectorId) ??
          false,
      })),
      requirements: [
        ...(manifests.length
          ? []
          : ["reviewed-per-chain-deployment-manifests"]),
        "version-specific-session-policy-compiler-and-installed-policy-verifier",
        ...(options.bundler ? [] : ["configured-erc4337-bundler"]),
        "account-gas-funding-or-reviewed-paymaster-policy",
      ],
      exclusions: [
        "eoa-fallback",
        "unreviewed-modules",
        "arbitrary-signing",
        "wildcard-execution",
        "contract-owner-threshold-adapter",
        "automatic-cross-chain-budget-reuse",
      ],
    };
  }
  async function list(principal: RestPrincipal) {
    if (!principal.scopes.includes("read"))
      fail(
        "SMART_READ_SCOPE_REQUIRED",
        "Reading wallet bindings requires read scope.",
        403,
      );
    const records = await options.registry.list(principal.account.id);
    return {
      items: records.map((record) => ({
        id: record.id,
        wallet: record.wallet,
        manifestId: record.manifestId,
        stateHash: record.state.stateHash,
        evidence: record.state.evidence,
        moduleConfigurationVerified: record.state.moduleConfigurationVerified,
        executionVerified: false,
        observation: "stored-binding-snapshot",
      })),
    };
  }
  async function revoke(principal: RestPrincipal, id: Hex) {
    owner(principal);
    if (!bytes32(id))
      fail("SMART_BINDING_INVALID", "Use the exact binding identifier.", 400);
    await options.registry.revoke(principal.account.id, id);
    return {
      id,
      status: "unlinked",
      onchainSessionRevoked: false,
      reason:
        "API wallet unlinking does not revoke any installed onchain session.",
    };
  }
  async function bundlerReadiness(manifestId: string, signal?: AbortSignal) {
    const m = manifest(manifestId);
    if (!m.entryPoint)
      return { ready: false, reason: "source-verified-entrypoint-required" };
    const entryPoint = m.entryPoint;
    if (!options.bundler)
      return { ready: false, reason: "configured-erc4337-bundler-required" };
    const [chain, entryPoints] = await Promise.all([
      options.bundler.request(m.chainId, "eth_chainId", [], signal),
      options.bundler.request(
        m.chainId,
        "eth_supportedEntryPoints",
        [],
        signal,
      ),
    ]);
    if (
      quantity(chain) !== BigInt(m.chainId) ||
      !Array.isArray(entryPoints) ||
      entryPoints.length > 32 ||
      !entryPoints.every(
        (entry) => typeof entry === "string" && isAddress(entry),
      ) ||
      !entryPoints.some((entry) => same(entry, entryPoint.address))
    )
      fail(
        "SMART_BUNDLER_MISMATCH",
        "Bundler chain or EntryPoint support differs from the reviewed deployment.",
      );
    return {
      ready: true,
      chainId: m.chainId,
      entryPoint: m.entryPoint.address,
      scope: "transport-discovery-only",
    };
  }
  return {
    inspect,
    challenge,
    bind,
    current,
    capabilities,
    bundlerReadiness,
    list,
    revoke,
  };
}
