import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  keccak256,
  parseAbi,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { RestError, type RestRpc } from "../core.js";
import { rpcHex } from "../protocol/code.js";
import type { SmartSnapshot } from "./types.js";
import { fingerprint } from "./service.js";
import { compiledSessionHash, SESSION_GUARD_INIT_ABI } from "./compiler.js";
import {
  actionIdOf,
  decodeUniversalAction,
  exactUint,
  permissionIdOf,
} from "./compiler/encoding.js";
import type {
  CompiledPolicyConfiguration,
  CompiledSession,
  InstalledSessionObservation,
  ParameterRule,
} from "./compiler/types.js";

export const INSTALLED_SESSION_ABI = parseAbi([
  "function getPermissionIDs(address account) view returns (bytes32[])",
  "function getNonce(bytes32 permissionId,address account) view returns (uint256)",
  "function isPermissionEnabled(bytes32 permissionId,address account) view returns (bool)",
  "function getSessionValidatorAndConfig(address account,bytes32 permissionId) view returns (address sessionValidator,bytes sessionValidatorData)",
  "function getUserOpPolicies(address account,bytes32 permissionId) view returns (address[])",
  "function getERC1271Policies(address account,bytes32 permissionId) view returns (address[])",
  "function getEnabledActions(address account,bytes32 permissionId) view returns (bytes32[])",
  "function getEnabledERC7739Content(address account,bytes32 permissionId) view returns ((bytes32 appDomainSeparator,bytes32[] contentNameHashes)[])",
  "function getActionPolicies(address account,bytes32 permissionId,bytes32 actionId) view returns (address[])",
]);
const POLICY_ABI = parseAbi([
  "function getTimeFrameConfig(bytes32 id,address multiplexer,address account) view returns (uint256)",
  "function getValueLimit(bytes32 id,address multiplexer,address account) view returns (uint256)",
  "function getUsed(bytes32 id,address multiplexer,address account) view returns (uint256)",
  "function getUsageLimit(bytes32 id,address multiplexer,address account) view returns (uint128)",
  "function getConfig(bytes32 id,address multiplexer,address account) view returns ((address paymaster,bytes32 paymasterCodeHash,uint256 maxGasPerOperation,uint256 maxFeePerGas,uint256 maxPriorityFeePerGas,uint256 totalGasLimit,uint256 totalSponsoredCostLimit,uint128 maximumCalls,uint32 maxPaymasterDataLength) config,uint256 gasUsed,uint256 costUsed,uint128 callsUsed)",
]);
function fail(message: string, status = 409): never {
  throw new RestError(status, "SMART_INSTALLED_POLICY_MISMATCH", message);
}
function normalized(value: unknown): unknown {
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value))
    return value.toLowerCase();
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalized(v)]),
    );
  return value;
}
const digest = (v: unknown) => fingerprint(normalized(v));
function exactList(
  actual: unknown,
  expected: readonly string[],
  label: string,
): void {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((a) => typeof a !== "string")
  )
    fail(`${label} differs from the exact installed policy.`);
  const normalizedActual = (actual as string[])
    .map((a) => a.toLowerCase())
    .sort();
  if (
    new Set(normalizedActual).size !== normalizedActual.length ||
    normalizedActual.join() !==
      expected
        .map((a) => a.toLowerCase())
        .sort()
        .join()
  )
    fail(`${label} contains missing, duplicate or unapproved entries.`);
}
export function mappingSlot(key: Hex | Address, slot: Hex | bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [toHex(BigInt(key), { size: 32 }), toHex(BigInt(slot), { size: 32 })],
    ),
  );
}
/** f24dddf layout: nonce0, policy1/2, action3/4, enabled5/6, ERC7739 7/8, signer9, permit10. */
export const legacyPaymasterPermissionSlot = (
  permissionId: Hex,
  wallet: Address,
): Hex => mappingSlot(wallet, mappingSlot(permissionId, 10n));

export function createInstalledSessionVerifier(options: {
  rpc: RestRpc;
  /** Trusted durable lookup; an unknown enabled permission must never become certified. */
  findCompiled?: (
    chainId: number,
    account: Address,
    permissionId: Hex,
  ) => Promise<CompiledSession | undefined>;
}) {
  async function read(
    snapshot: SmartSnapshot,
    target: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
  ): Promise<unknown> {
    const data = encodeFunctionData({ abi, functionName, args });
    const result = rpcHex(
      await snapshot.request("eth_call", [{ to: target, data }]),
      "installed policy call",
      32768,
    );
    try {
      return decodeFunctionResult({ abi, functionName, data: result });
    } catch {
      return fail(
        "The installed contract returned malformed policy state.",
        502,
      );
    }
  }
  async function slot(
    snapshot: SmartSnapshot,
    target: Address,
    storageSlot: Hex,
  ): Promise<bigint> {
    const value = rpcHex(
      await snapshot.request("eth_getStorageAt", [target, storageSlot]),
      "installed storage",
      32,
    );
    if (value.length !== 66)
      fail("A canonical 32-byte storage value is required.", 502);
    return BigInt(value);
  }
  async function snapshot(
    chainId: number,
    signal?: AbortSignal,
  ): Promise<SmartSnapshot> {
    const deadline = AbortSignal.any([
      AbortSignal.timeout(30000),
      ...(signal ? [signal] : []),
    ]);
    const chain = await options.rpc.request(
      chainId,
      "eth_chainId",
      [],
      deadline,
    );
    if (
      typeof chain !== "string" ||
      !/^0x[0-9a-fA-F]+$/.test(chain) ||
      BigInt(chain) !== BigInt(chainId)
    )
      fail("The RPC chain differs from the compiled account.", 502);
    const block = (await options.rpc.request(
      chainId,
      "eth_getBlockByNumber",
      ["latest", false],
      deadline,
    )) as { number?: unknown; hash?: unknown; timestamp?: unknown };
    if (
      !block ||
      typeof block.hash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(block.hash) ||
      typeof block.number !== "string" ||
      !/^0x[0-9a-fA-F]+$/.test(block.number) ||
      typeof block.timestamp !== "string" ||
      !/^0x[0-9a-fA-F]+$/.test(block.timestamp)
    )
      fail("A mined canonical block is required.", 502);
    const tag = {
      blockHash: block.hash as Hex,
      requireCanonical: true as const,
    };
    return {
      evidence: {
        chainId,
        blockNumber: String(BigInt(block.number)),
        blockHash: tag.blockHash,
        timestamp: String(BigInt(block.timestamp)),
        source: "onchain",
      },
      tag,
      request: (method, params) =>
        options.rpc.request(chainId, method, [...params, tag], deadline),
    };
  }
  function checked(compiled: CompiledSession): void {
    if (
      compiled.stack !== "legacy-f24dddf-safe7579-f22a194" ||
      compiled.compiledHash !== compiledSessionHash(compiled) ||
      compiled.policyHash !== fingerprint(compiled.reviewedPolicy) ||
      permissionIdOf(compiled.session) !== compiled.permissionId ||
      !isAddressEqual(
        compiled.sessionValidator.address,
        compiled.session.sessionValidator,
      )
    )
      fail("The compiled session identity or payload was altered.");
  }
  async function observeConfiguration(
    compiled: CompiledSession,
    config: CompiledPolicyConfiguration,
    snap: SmartSnapshot,
  ) {
    const args = [
      config.configId,
      compiled.smartSessions.address,
      compiled.wallet,
    ] as const;
    const counters: InstalledSessionObservation["counters"] = [];
    const count = (name: string, used: bigint, limit: bigint) => {
      if (used < 0n || used > limit)
        fail("Installed counters exceed their configured limits.");
      counters.push({
        policy: config.policy.address,
        configId: config.configId,
        name,
        used: String(used),
        limit: String(limit),
      });
    };
    let observed: unknown;
    if (config.kind === "time-frame") {
      const value = (await read(
        snap,
        config.policy.address,
        POLICY_ABI,
        "getTimeFrameConfig",
        args,
      )) as bigint;
      if (value >> 96n !== 0n)
        fail("TimeFrame policy has noncanonical packed configuration.");
      observed = {
        validUntil: Number(value >> 48n),
        validAfter: Number(value & ((1n << 48n) - 1n)),
      };
    } else if (config.kind === "value-limit" || config.kind === "usage-limit") {
      const [limit, used] = (await Promise.all([
        read(
          snap,
          config.policy.address,
          POLICY_ABI,
          config.kind === "value-limit" ? "getValueLimit" : "getUsageLimit",
          args,
        ),
        read(snap, config.policy.address, POLICY_ABI, "getUsed", args),
      ])) as bigint[];
      observed =
        config.kind === "value-limit"
          ? { valueLimit: String(limit) }
          : { limit: String(limit) };
      count(
        config.kind === "value-limit" ? "nativeValue" : "operations",
        used!,
        limit!,
      );
    } else if (config.kind === "gas-budget") {
      const [state, gasUsed, costUsed, callsUsed] = (await read(
        snap,
        config.policy.address,
        POLICY_ABI,
        "getConfig",
        args,
      )) as [Record<string, unknown>, bigint, bigint, bigint];
      const decoded = normalized(state) as Record<string, unknown>;
      observed = {
        ...decoded,
        maxPaymasterDataLength: Number(decoded.maxPaymasterDataLength),
      };
      count("requestedGas", gasUsed, BigInt(String(decoded.totalGasLimit)));
      count(
        "sponsoredCost",
        costUsed,
        BigInt(String(decoded.totalSponsoredCostLimit)),
      );
      count("calls", callsUsed, BigInt(String(decoded.maximumCalls)));
      const paymasterCode = rpcHex(
        await snap.request("eth_getCode", [state.paymaster]),
        "paymaster runtime",
      );
      if (
        paymasterCode === "0x" ||
        keccak256(paymasterCode) !== state.paymasterCodeHash
      )
        fail("The mandatory paymaster runtime changed.");
    } else if (config.kind === "universal-action") {
      const expected = decodeUniversalAction(config.initData);
      const base = BigInt(
        mappingSlot(
          compiled.wallet,
          mappingSlot(
            compiled.smartSessions.address,
            mappingSlot(config.configId, 0n),
          ),
        ),
      );
      const length = Number(expected.paramRules.length);
      // 75279a6 UAP is mapping slot0; ActionConfig=value0,length1, then sixteen 4-slot rules.
      const words = await Promise.all(
        Array.from({ length: 2 + 4 * length }, (_, i) =>
          slot(
            snap,
            config.policy.address,
            toHex(base + BigInt(i), { size: 32 }),
          ),
        ),
      );
      if (words[1] !== BigInt(length))
        fail(
          "The installed UAP rule count differs from the compiled rule count.",
        );
      const rules: ParameterRule[] = [];
      for (let i = 0; i < length; i++) {
        const packed = words[2 + i * 4]!;
        if (packed >> 80n !== 0n || ((packed >> 72n) & 255n) > 1n)
          fail("An installed UAP rule has noncanonical packed fields.");
        const limited = ((packed >> 72n) & 255n) === 1n;
        const limit = words[4 + i * 4]!,
          used = words[5 + i * 4]!;
        if (limited) count(`parameter:${i}`, used, limit);
        else if (used !== 0n)
          fail("An unlimited rule has an unexpected consumed counter.");
        rules.push({
          condition: Number(packed & 255n) as ParameterRule["condition"],
          offset: String((packed >> 8n) & ((1n << 64n) - 1n)),
          isLimited: limited,
          ref: toHex(words[3 + i * 4]!, { size: 32 }),
          usage: { limit: String(limit), used: "0" },
        });
      }
      observed = {
        valueLimitPerUse: String(words[0]),
        paramRules: {
          length: String(length),
          rules: [...rules, ...expected.paramRules.rules.slice(length)],
        },
      };
    } else
      return fail(
        "No source-bound installed-state decoder exists for this policy.",
      );
    if (digest(observed) !== digest(config.decoded))
      fail(
        `The installed ${config.kind} configuration differs from owner-approved bytes.`,
      );
    return { observed, counters };
  }
  async function verifyAt(
    compiled: CompiledSession,
    snap: SmartSnapshot,
  ): Promise<InstalledSessionObservation> {
    checked(compiled);
    if (
      snap.evidence.chainId !== compiled.chainId ||
      snap.tag.blockHash !== snap.evidence.blockHash ||
      snap.tag.requireCanonical !== true
    )
      fail(
        "Installed policy verification requires the exact account chain and canonical block.",
      );
    const pins = [
      compiled.smartSessions,
      compiled.sessionValidator,
      ...compiled.configurations.map((c) => c.policy),
    ];
    const codePins = new Map(pins.map((p) => [p.address.toLowerCase(), p]));
    await Promise.all(
      [...codePins.values()].map(async (pin) => {
        const code = rpcHex(
          await snap.request("eth_getCode", [pin.address]),
          "policy runtime",
        );
        if (code === "0x" || keccak256(code) !== pin.runtimeCodeHash)
          fail(
            "An installed session dependency differs from its source-bound runtime.",
          );
      }),
    );
    const target = compiled.smartSessions.address,
      common = [compiled.wallet, compiled.permissionId];
    const [
      ids,
      enabled,
      enableNonce,
      signer,
      policies,
      signingPolicies,
      content,
      actions,
      permit,
    ] = await Promise.all([
      read(snap, target, INSTALLED_SESSION_ABI, "getPermissionIDs", [
        compiled.wallet,
      ]),
      read(snap, target, INSTALLED_SESSION_ABI, "isPermissionEnabled", [
        compiled.permissionId,
        compiled.wallet,
      ]),
      read(snap, target, INSTALLED_SESSION_ABI, "getNonce", [
        compiled.permissionId,
        compiled.wallet,
      ]),
      read(
        snap,
        target,
        INSTALLED_SESSION_ABI,
        "getSessionValidatorAndConfig",
        common,
      ),
      read(snap, target, INSTALLED_SESSION_ABI, "getUserOpPolicies", common),
      read(snap, target, INSTALLED_SESSION_ABI, "getERC1271Policies", common),
      read(
        snap,
        target,
        INSTALLED_SESSION_ABI,
        "getEnabledERC7739Content",
        common,
      ),
      read(snap, target, INSTALLED_SESSION_ABI, "getEnabledActions", common),
      slot(
        snap,
        target,
        legacyPaymasterPermissionSlot(compiled.permissionId, compiled.wallet),
      ),
    ]);
    exactList(ids, [compiled.permissionId], "Enabled session list");
    if (
      enabled !== true ||
      enableNonce !== BigInt(compiled.activationEnableNonce) ||
      permit !== 1n
    )
      fail(
        "The enabled session, enable nonce or paymaster permission changed.",
      );
    if (
      !Array.isArray(signer) ||
      !isAddressEqual(
        signer[0] as Address,
        compiled.session.sessionValidator,
      ) ||
      String(signer[1]).toLowerCase() !==
        compiled.session.sessionValidatorInitData.toLowerCase()
    )
      fail("The installed session key or validator changed.");
    exactList(
      policies,
      compiled.session.userOpPolicies.map((p) => p.policy),
      "UserOperation policies",
    );
    exactList(signingPolicies, [], "ERC1271 policies");
    if (!Array.isArray(content) || content.length !== 0)
      fail("Arbitrary signing content must remain disabled.");
    const actionIds = compiled.session.actions.map((a) =>
      actionIdOf(a.actionTarget, a.actionTargetSelector),
    );
    exactList(actions, actionIds, "Action list");
    for (let i = 0; i < actionIds.length; i++)
      exactList(
        await read(snap, target, INSTALLED_SESSION_ABI, "getActionPolicies", [
          ...common,
          actionIds[i],
        ]),
        compiled.session.actions[i]!.actionPolicies.map((p) => p.policy),
        "Action policies",
      );
    const observed = [];
    const counters: InstalledSessionObservation["counters"] = [];
    for (const config of compiled.configurations) {
      const state = await observeConfiguration(compiled, config, snap);
      observed.push({
        policy: config.policy.address,
        configId: config.configId,
        kind: config.kind,
        configuration: state.observed,
      });
      counters.push(...state.counters);
    }
    return {
      permissionId: compiled.permissionId,
      compiledHash: compiled.compiledHash,
      account: compiled.wallet,
      chainId: compiled.chainId,
      enabled: true,
      enableNonce: String(enableNonce),
      configurationHash: digest(observed),
      evidence: snap.evidence,
      counters,
    };
  }
  async function verifyRevoked(
    compiled: CompiledSession,
    minimumEnableNonce: string,
    signal?: AbortSignal,
  ): Promise<InstalledSessionObservation> {
    checked(compiled);
    const snap = await snapshot(compiled.chainId, signal);
    const moduleCode = rpcHex(
      await snap.request("eth_getCode", [compiled.smartSessions.address]),
      "revoked session runtime",
    );
    if (
      moduleCode === "0x" ||
      keccak256(moduleCode) !== compiled.smartSessions.runtimeCodeHash
    )
      fail(
        "The revocation target no longer has the reviewed SmartSession runtime.",
      );
    const [enabled, nonce, ids] = await Promise.all([
      read(
        snap,
        compiled.smartSessions.address,
        INSTALLED_SESSION_ABI,
        "isPermissionEnabled",
        [compiled.permissionId, compiled.wallet],
      ),
      read(
        snap,
        compiled.smartSessions.address,
        INSTALLED_SESSION_ABI,
        "getNonce",
        [compiled.permissionId, compiled.wallet],
      ),
      read(
        snap,
        compiled.smartSessions.address,
        INSTALLED_SESSION_ABI,
        "getPermissionIDs",
        [compiled.wallet],
      ),
    ]);
    if (
      enabled !== false ||
      typeof nonce !== "bigint" ||
      nonce < exactUint(minimumEnableNonce) ||
      nonce <= BigInt(compiled.activationEnableNonce)
    )
      fail(
        "Durable revocation requires disabled permission and advanced enable nonce.",
      );
    if (
      !Array.isArray(ids) ||
      ids.length > 1 ||
      ids.some(
        (id) =>
          typeof id !== "string" ||
          id.toLowerCase() === compiled.permissionId.toLowerCase(),
      )
    )
      fail(
        "The revoked permission remains enabled or the supported single-session layout changed.",
      );
    return {
      permissionId: compiled.permissionId,
      compiledHash: compiled.compiledHash,
      account: compiled.wallet,
      chainId: compiled.chainId,
      enabled: false,
      enableNonce: String(nonce),
      configurationHash: fingerprint({ revoked: true, nonce: String(nonce) }),
      evidence: snap.evidence,
      counters: [],
    };
  }
  async function inspectAllAt({
    account,
    manifest,
    snapshot: snap,
  }: {
    account: Address;
    manifest: { smartSessions: { address: Address }; chainId: number };
    snapshot: SmartSnapshot;
  }) {
    const ids = await read(
      snap,
      manifest.smartSessions.address,
      INSTALLED_SESSION_ABI,
      "getPermissionIDs",
      [account],
    );
    if (!Array.isArray(ids) || ids.length > 1)
      fail(
        "Only the single certified session or an empty validator is supported.",
      );
    const observations = [];
    for (const id of ids as Hex[]) {
      const compiled = await options.findCompiled?.(
        manifest.chainId,
        account,
        id,
      );
      if (
        !compiled ||
        !isAddressEqual(compiled.wallet, account) ||
        !isAddressEqual(
          compiled.smartSessions.address,
          manifest.smartSessions.address,
        )
      )
        fail("An unknown enabled session cannot be certified.");
      observations.push(await verifyAt(compiled, snap));
    }
    return {
      stateHash: fingerprint(
        observations.map((o) => ({
          permissionId: o.permissionId,
          configurationHash: o.configurationHash,
          enableNonce: o.enableNonce,
        })),
      ),
      permissionIds: ids as Hex[],
      arbitrarySigningDisabled: true as const,
      wildcardExecutionDisabled: true as const,
      gasBudgetEnforced: true as const,
    };
  }
  return {
    verify: async (compiled: CompiledSession, signal?: AbortSignal) =>
      verifyAt(compiled, await snapshot(compiled.chainId, signal)),
    verifyAt,
    verifyRevoked,
    inspectAllAt,
  };
}
