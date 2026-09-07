import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodePacked,
  isAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { RestError } from "../../core.js";
import type {
  LegacySession,
  ParameterRule,
  UniversalActionConfig,
} from "./types.js";

export const PARAM_RULE_COMPONENTS = [
  { name: "condition", type: "uint8" },
  { name: "offset", type: "uint64" },
  { name: "isLimited", type: "bool" },
  { name: "ref", type: "bytes32" },
  {
    name: "usage",
    type: "tuple",
    components: [
      { name: "limit", type: "uint256" },
      { name: "used", type: "uint256" },
    ],
  },
] as const;
export const UNIVERSAL_ACTION_ABI = [
  {
    type: "tuple",
    components: [
      { name: "valueLimitPerUse", type: "uint256" },
      {
        name: "paramRules",
        type: "tuple",
        components: [
          { name: "length", type: "uint256" },
          {
            name: "rules",
            type: "tuple[16]",
            components: PARAM_RULE_COMPONENTS,
          },
        ],
      },
    ],
  },
] as const;
function invalid(message: string): never {
  throw new RestError(400, "SMART_COMPILER_INVALID", message);
}
export function exactUint(value: unknown, bits = 256): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    return invalid(
      "Compiler amounts must be canonical decimal integer strings.",
    );
  const n = BigInt(value);
  if (n >= 1n << BigInt(bits))
    return invalid(`Compiler value exceeds uint${bits}.`);
  return n;
}
export function word(value: string | bigint): Hex {
  return toHex(
    typeof value === "bigint"
      ? value
      : isAddress(value)
        ? BigInt(value)
        : exactUint(value),
    { size: 32 },
  );
}
export function equalRule(
  offset: number,
  value: string | bigint,
): ParameterRule {
  return {
    condition: 0,
    offset: String(offset),
    isLimited: false,
    ref: word(value),
    usage: { limit: "0", used: "0" },
  };
}
export function amountRule(
  offset: number,
  perCall: string,
  total: string,
): ParameterRule {
  if (exactUint(perCall) === 0n || exactUint(perCall) > exactUint(total))
    invalid("Amount limits must be positive and ordered.");
  return {
    condition: 4,
    offset: String(offset),
    isLimited: true,
    ref: word(perCall),
    usage: { limit: total, used: "0" },
  };
}
export function encodeUniversalAction(
  valueLimitPerUse: string,
  rules: ParameterRule[],
): { initData: Hex; decoded: UniversalActionConfig } {
  if (rules.length < 1 || rules.length > 16)
    invalid("UniversalActionPolicy requires 1–16 rules.");
  const padded = [
    ...rules,
    ...Array.from({ length: 16 - rules.length }, () => equalRule(0, 0n)),
  ];
  const parsed = padded.map((rule) => {
    if (
      !Number.isInteger(rule.condition) ||
      rule.condition < 0 ||
      rule.condition > 6 ||
      !/^0x[0-9a-fA-F]{64}$/.test(rule.ref) ||
      typeof rule.isLimited !== "boolean" ||
      exactUint(rule.usage.used) !== 0n
    )
      invalid(
        "New policies must contain valid rules and zero consumed counters.",
      );
    return {
      ...rule,
      offset: exactUint(rule.offset, 64),
      usage: { limit: exactUint(rule.usage.limit), used: 0n },
    };
  });
  const initData = encodeAbiParameters(UNIVERSAL_ACTION_ABI, [
    {
      valueLimitPerUse: exactUint(valueLimitPerUse),
      paramRules: { length: BigInt(rules.length), rules: parsed as never },
    },
  ]);
  return { initData, decoded: decodeUniversalAction(initData) };
}
export function decodeUniversalAction(initData: Hex): UniversalActionConfig {
  let value;
  try {
    [value] = decodeAbiParameters(UNIVERSAL_ACTION_ABI, initData);
  } catch {
    return invalid("Malformed UniversalActionPolicy initialization bytes.");
  }
  if (
    encodeAbiParameters(UNIVERSAL_ACTION_ABI, [value]).toLowerCase() !==
      initData.toLowerCase() ||
    value.paramRules.length < 1n ||
    value.paramRules.length > 16n
  )
    invalid("Noncanonical UniversalActionPolicy initialization.");
  return {
    valueLimitPerUse: String(value.valueLimitPerUse),
    paramRules: {
      length: String(value.paramRules.length),
      rules: value.paramRules.rules.map((r) => ({
        condition: r.condition as ParameterRule["condition"],
        offset: String(r.offset),
        isLimited: r.isLimited,
        ref: r.ref,
        usage: { limit: String(r.usage.limit), used: String(r.usage.used) },
      })),
    },
  };
}
export function encodeTimeFrame(validAfter: number, validUntil: number): Hex {
  if (
    !Number.isSafeInteger(validAfter) ||
    !Number.isSafeInteger(validUntil) ||
    validAfter < 0 ||
    validUntil <= validAfter ||
    validUntil >= 2 ** 48
  )
    invalid("Use an exact bounded nonzero time frame.");
  return encodePacked(["uint48", "uint48"], [validUntil, validAfter]);
}
export const permissionIdOf = (
  session: Pick<
    LegacySession,
    "sessionValidator" | "sessionValidatorInitData" | "salt"
  >,
): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes" }, { type: "bytes32" }],
      [
        session.sessionValidator,
        session.sessionValidatorInitData,
        session.salt,
      ],
    ),
  );
export const actionIdOf = (target: Address, selector: Hex): Hex =>
  keccak256(encodePacked(["address", "bytes4"], [target, selector]));
export const userOpConfigId = (wallet: Address, permissionId: Hex): Hex =>
  keccak256(encodePacked(["address", "bytes32"], [wallet, permissionId]));
export const actionConfigId = (
  wallet: Address,
  permissionId: Hex,
  actionId: Hex,
): Hex =>
  keccak256(
    encodePacked(
      ["address", "bytes32"],
      [
        wallet,
        keccak256(
          encodePacked(["bytes32", "bytes32"], [permissionId, actionId]),
        ),
      ],
    ),
  );
