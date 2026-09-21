import { readFile } from "node:fs/promises";
import {
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import type { StoredSession } from "../sessions/types.js";
import {
  SESSION_GUARD_PROFILES,
  SESSION_GUARD_INIT_ABI,
  sessionGuardVersionForRuntime,
} from "../smartAccounts/compiler.js";
import { currentPimlicoGuardPackage } from "../smartAccounts/stack/current-pimlico/config.js";
import type { SessionGuardVersion } from "../smartAccounts/stack/current-pimlico/pins.js";
import {
  normalizeUserOperation,
  uoCanonical,
  uoError,
  userOperationMaximumCost,
} from "./codec.js";
import type { UserOperationGasPolicy, UserOperationV07 } from "./types.js";

export interface SessionGasEstimation {
  readonly maximumGas: bigint;
  fit(operation: UserOperationV07, beforeStub?: boolean): UserOperationV07;
  assert(operation: UserOperationV07): void;
}
type Override = Record<Address, { stateDiff: Record<Hex, Hex> }>;
const admitted = new WeakMap<
  SessionGasEstimation,
  {
    chainId: number;
    sender: Address;
    nonce: Hex;
    callData: Hex;
    maxFeePerGas: Hex;
    maxPriorityFeePerGas: Hex;
    overrides: Override;
  }
>();
const minimum = (...values: bigint[]) =>
  values.reduce((a, b) => (a < b ? a : b));
const layouts = new Map<SessionGuardVersion, Promise<bigint[]>>();
async function offsets(version: SessionGuardVersion): Promise<bigint[]> {
  const existing = layouts.get(version);
  if (existing) return existing;
  const layout = (async () => {
    const current = version === "current-v2" ? await currentPimlicoGuardPackage() : undefined;
    const [proof, artifact] = current ? [current.proof, current.artifact] : await Promise.all([
      readFile(
        new URL("./evidence/guard-storage.json", import.meta.url),
        "utf8",
      ).then(JSON.parse),
      readFile(
        new URL(
          "../smartAccounts/stack/artifacts/CenterSessionGuard.json",
          import.meta.url,
        ),
        "utf8",
      ).then(JSON.parse),
    ]);
    if (
      proof.schemaVersion !== 1 ||
      proof.runtimeCodeHash !== SESSION_GUARD_PROFILES[version].runtimeCodeHash ||
      artifact.runtimeCodeHash !== proof.runtimeCodeHash ||
      artifact.source.sha256 !== proof.sourceSha256 ||
      artifact.compiler?.version !== (version === "current-v2" ? proof.compiler?.version : proof.compilerVersion)
    )
      uoError(
        "SESSION_GAS_LAYOUT_UNVERIFIED",
        "Estimation requires the exact source-pinned guard compiler storage layout.",
        500,
      );
    const storage = proof.storageLayout.storage,
      types = proof.storageLayout.types;
    if (
      storage.length !== 1 ||
      storage[0].label !== "_states" ||
      storage[0].slot !== "0" ||
      storage[0].offset !== 0
    )
      uoError(
        "SESSION_GAS_LAYOUT_UNVERIFIED",
        "The guard storage root differs from its compiler proof.",
        500,
      );
    let type = types[storage[0].type];
    for (const key of ["t_bytes32", "t_address", "t_address"]) {
      if (type.encoding !== "mapping" || type.key !== key)
        uoError(
          "SESSION_GAS_LAYOUT_UNVERIFIED",
          "The guard mapping namespace differs from its compiler proof.",
          500,
        );
      type = types[type.value];
    }
    const config = type.members.find(
      (m: { label: string }) => m.label === "config",
    );
    if (!config || config.slot !== "0" || config.offset !== 0)
      uoError(
        "SESSION_GAS_LAYOUT_UNVERIFIED",
        "The guard config storage differs from its compiler proof.",
        500,
      );
    return [
      "maxGasPerOperation",
      "maxFeePerGas",
      "maxPriorityFeePerGas",
      "totalGasLimit",
      "totalSponsoredCostLimit",
    ].map((label) => {
      const member = types[config.type].members.find(
        (m: { label: string }) => m.label === label,
      );
      if (!member || member.offset !== 0 || member.type !== "t_uint256")
        uoError(
          "SESSION_GAS_LAYOUT_UNVERIFIED",
          "Only full-word compiler-proven gas ceiling fields may be overridden.",
          500,
        );
      return BigInt(member.slot);
    });
  })();
  layouts.set(version, layout);
  return layout;
}
/** No externally supplied overrides: only this opaque, source-checked preparation context is admitted. */
export function sessionGasEstimationOverrides(
  context: SessionGasEstimation,
  chainId: number,
  operation: UserOperationV07,
): Override {
  const expected = admitted.get(context),
    op = normalizeUserOperation(operation);
  if (
    !expected ||
    expected.chainId !== chainId ||
    expected.sender.toLowerCase() !== op.sender ||
    expected.nonce !== op.nonce ||
    expected.callData !== op.callData ||
    expected.maxFeePerGas !== op.maxFeePerGas ||
    expected.maxPriorityFeePerGas !== op.maxPriorityFeePerGas
  )
    uoError(
      "SESSION_GAS_ESTIMATION_CONTEXT",
      "The estimation context does not bind this exact account operation.",
    );
  context.assert(op);
  return structuredClone(expected.overrides);
}
/** Raises five ceilings only for an unsigned bundler simulation. Real guard code, counters, paymaster and action policies remain intact. */
export async function createSessionGasEstimation(
  record: StoredSession,
  policy: UserOperationGasPolicy,
  operation: UserOperationV07,
): Promise<SessionGasEstimation> {
  const configs = record.compiled.configurations.filter(
    (c) => c.kind === "gas-budget" && c.scope === "user-operation",
  );
  const guardVersion = configs.length === 1
    ? sessionGuardVersionForRuntime(configs[0]!.policy.runtimeCodeHash)
    : undefined;
  if (
    configs.length !== 1 ||
    !guardVersion ||
    !record.observation
  )
    uoError(
      "SESSION_GAS_POLICY_UNVERIFIED",
      "A current, source-verified installed gas guard is required.",
    );
  const config = configs[0]!,
    op = normalizeUserOperation(operation);
  const [
    paymaster,
    ,
    perOperation,
    maxFee,
    maxPriority,
    gasLimit,
    costLimit,
    callsLimit,
  ] = decodeAbiParameters(SESSION_GUARD_INIT_ABI, config.initData);
  if (
    encodeAbiParameters(
      SESSION_GUARD_INIT_ABI,
      decodeAbiParameters(SESSION_GUARD_INIT_ABI, config.initData),
    ) !== config.initData
  )
    uoError(
      "SESSION_GAS_POLICY_UNVERIFIED",
      "Gas policy initialization is not canonical.",
    );
  const remaining = (name: string, limit: bigint) => {
    const counters = record.observation!.installed.counters.filter(
      (c) =>
        c.name === name &&
        c.policy.toLowerCase() === config.policy.address.toLowerCase() &&
        c.configId === config.configId,
    );
    if (
      counters.length !== 1 ||
      counters[0]!.limit !== limit.toString() ||
      !/^(0|[1-9][0-9]{0,77})$/.test(counters[0]!.used) ||
      BigInt(counters[0]!.used) > limit
    )
      uoError(
        "SESSION_GAS_COUNTERS_UNVERIFIED",
        "The installed gas, cost and call counters must be independently verified.",
      );
    return limit - BigInt(counters[0]!.used);
  };
  const fee = BigInt(op.maxFeePerGas);
  if (
    fee === 0n ||
    fee > maxFee ||
    BigInt(op.maxPriorityFeePerGas) > maxPriority
  )
    uoError(
      "SESSION_GAS_FEE_LIMIT",
      "Current network fees exceed this session's owner-approved limits. Wait for lower fees or obtain a new explicitly approved policy.",
    );
  const maximumGas = minimum(
    perOperation,
    remaining("requestedGas", gasLimit),
    remaining("sponsoredCost", costLimit) / fee,
    policy.maximumCost / fee,
  );
  if (remaining("calls", callsLimit) === 0n || maximumGas < 3n)
    uoError(
      "SESSION_GAS_BUDGET_EXHAUSTED",
      "The session's remaining gas, sponsored cost or call budget cannot cover another operation.",
    );
  const context: SessionGasEstimation = {
    maximumGas,
    fit(value, beforeStub = false) {
      const current = normalizeUserOperation(value);
      const paymasterGas =
        BigInt(current.paymasterVerificationGasLimit ?? "0x0") +
        BigInt(current.paymasterPostOpGasLimit ?? "0x0");
      const budget = (beforeStub ? maximumGas / 2n : maximumGas) - paymasterGas;
      const ceilings = [
        policy.maximumCallGas,
        policy.maximumVerificationGas,
        policy.maximumPreVerificationGas,
      ];
      const sum = ceilings.reduce((a, b) => a + b, 0n);
      if (budget < 3n || sum <= 0n)
        uoError(
          "SESSION_GAS_BUDGET_TOO_SMALL",
          "The sponsor's validation gas leaves insufficient owner-approved gas for account execution. Review a larger explicit gas budget.",
        );
      const values = ceilings.map((cap) => minimum(cap, (budget * cap) / sum));
      if (values.some((v) => v === 0n))
        uoError(
          "SESSION_GAS_BUDGET_TOO_SMALL",
          "The approved gas budget cannot fit bounded preparation fields.",
        );
      return normalizeUserOperation({
        ...current,
        callGasLimit: toHex(values[0]!),
        verificationGasLimit: toHex(values[1]!),
        preVerificationGas: toHex(values[2]!),
      });
    },
    assert(value) {
      const current = normalizeUserOperation(value);
      if (BigInt(current.maxFeePerGas) === 0n)
        uoError(
          "SESSION_GAS_ESTIMATE_EXCEEDS_BUDGET",
          "Session operations require a positive approved gas fee.",
        );
      const gas =
        userOperationMaximumCost(current) / BigInt(current.maxFeePerGas);
      if (
        BigInt(current.maxFeePerGas) !== fee ||
        BigInt(current.maxPriorityFeePerGas) > maxPriority ||
        gas > maximumGas ||
        (current.paymaster &&
          current.paymaster.toLowerCase() !== paymaster.toLowerCase())
      )
        uoError(
          "SESSION_GAS_ESTIMATE_EXCEEDS_BUDGET",
          "The estimated operation exceeds the original owner-approved gas, cost or paymaster policy. No operation was signed or published.",
        );
    },
  };
  const root = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }],
      [config.configId, 0n],
    ),
  );
  const multiplexer = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [record.compiled.smartSessions.address, root],
    ),
  );
  const base = BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "bytes32" }],
        [record.compiled.wallet, multiplexer],
      ),
    ),
  );
  const slots = await offsets(guardVersion),
    stateDiff: Record<Hex, Hex> = {};
  for (let i = 0; i < slots.length; i++)
    stateDiff[toHex((base + slots[i]!) % (1n << 256n), { size: 32 })] = toHex(
      (1n << BigInt(i < 3 ? 128 : 256)) - 1n,
      { size: 32 },
    );
  admitted.set(context, {
    chainId: record.compiled.chainId,
    sender: op.sender,
    nonce: op.nonce,
    callData: op.callData,
    maxFeePerGas: op.maxFeePerGas,
    maxPriorityFeePerGas: op.maxPriorityFeePerGas,
    overrides: { [config.policy.address]: { stateDiff } },
  });
  return Object.freeze(context);
}
