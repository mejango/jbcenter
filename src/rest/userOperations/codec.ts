import {
  concat,
  encodeAbiParameters,
  isAddress,
  keccak256,
  padHex,
  sha256,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { RestError } from "../core.js";
import type {
  PackedUserOperationV07,
  UserOperationGasEstimate,
  UserOperationGasPolicy,
  UserOperationV07,
} from "./types.js";

export const USER_OPERATION_LIMITS = Object.freeze({
  responseBytes: 1_048_576,
  operationBytes: 262_144,
  calldataBytes: 65_536,
  signatureBytes: 16_384,
  paymasterBytes: 8192,
  factoryBytes: 32_768,
  rpcCalls: 96,
});
export function uoError(code: string, message: string, status = 422): never {
  throw new RestError(status, code, message);
}
export function uoObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function uoQuantity(value: unknown, label: string, bits = 256): bigint {
  if (
    typeof value !== "string" ||
    !/^0x(0|[1-9a-f][0-9a-f]{0,63})$/.test(value) ||
    BigInt(value) >= 1n << BigInt(bits)
  )
    uoError("INVALID_USER_OPERATION", `Invalid canonical ${label}.`, 400);
  return BigInt(value);
}
export function uoBytes(
  value: unknown,
  label: string,
  maximum: number = USER_OPERATION_LIMITS.calldataBytes,
): Hex {
  if (
    typeof value !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) ||
    (value.length - 2) / 2 > maximum
  )
    uoError("INVALID_USER_OPERATION", `Invalid bounded ${label}.`, 400);
  return value.toLowerCase() as Hex;
}
export function uoAddress(value: unknown, label: string): Address {
  if (
    typeof value !== "string" ||
    !isAddress(value) ||
    /^0x0{40}$/i.test(value)
  )
    uoError("INVALID_USER_OPERATION", `Invalid ${label}.`, 400);
  return value.toLowerCase() as Address;
}
export function uoHash(value: unknown, label: string): Hex {
  const result = uoBytes(value, label, 32);
  if (result.length !== 66)
    uoError("INVALID_USER_OPERATION", `Invalid ${label}.`, 400);
  return result;
}
export function uoCanonical(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(uoCanonical).join(",")}]`;
  if (uoObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${uoCanonical(value[key])}`)
      .join(",")}}`;
  return uoError(
    "INVALID_USER_OPERATION",
    "Only bounded lossless JSON is accepted.",
    400,
  );
}
const required = [
  "sender",
  "nonce",
  "callData",
  "callGasLimit",
  "verificationGasLimit",
  "preVerificationGas",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "signature",
] as const;
const optional = [
  "factory",
  "factoryData",
  "paymaster",
  "paymasterVerificationGasLimit",
  "paymasterPostOpGasLimit",
  "paymasterData",
];
export function normalizeUserOperation(value: unknown): UserOperationV07 {
  if (
    !uoObject(value) ||
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => ![...required, ...optional].includes(key))
  )
    uoError(
      "INVALID_USER_OPERATION",
      "Provide only the complete unpacked EntryPoint v0.7 fields.",
      400,
    );
  const result: UserOperationV07 = {
    sender: uoAddress(value.sender, "sender"),
    nonce: toHex(uoQuantity(value.nonce, "nonce")),
    callData: uoBytes(value.callData, "account calldata"),
    callGasLimit: toHex(uoQuantity(value.callGasLimit, "call gas", 128)),
    verificationGasLimit: toHex(
      uoQuantity(value.verificationGasLimit, "verification gas", 128),
    ),
    preVerificationGas: toHex(
      uoQuantity(value.preVerificationGas, "pre-verification gas"),
    ),
    maxFeePerGas: toHex(uoQuantity(value.maxFeePerGas, "maximum fee", 128)),
    maxPriorityFeePerGas: toHex(
      uoQuantity(value.maxPriorityFeePerGas, "priority fee", 128),
    ),
    signature: uoBytes(
      value.signature,
      "account signature",
      USER_OPERATION_LIMITS.signatureBytes,
    ),
  };
  if (BigInt(result.maxPriorityFeePerGas) > BigInt(result.maxFeePerGas))
    uoError("INVALID_USER_OPERATION", "Priority fee exceeds maximum fee.", 400);
  if ("factory" in value || "factoryData" in value) {
    result.factory = uoAddress(value.factory, "factory");
    if (
      result.factory === "0x0000000000000000000000000000000000007702" ||
      result.factory === "0x7702000000000000000000000000000000000000"
    )
      uoError(
        "USER_OPERATION_VERSION_UNSUPPORTED",
        "EIP-7702 authorization is not an EntryPoint v0.7 factory.",
        400,
      );
    result.factoryData = uoBytes(
      value.factoryData,
      "factory calldata",
      USER_OPERATION_LIMITS.factoryBytes,
    );
  }
  if (optional.slice(2).some((key) => key in value)) {
    result.paymaster = uoAddress(value.paymaster, "paymaster");
    result.paymasterData = uoBytes(
      value.paymasterData,
      "paymaster data",
      USER_OPERATION_LIMITS.paymasterBytes,
    );
    result.paymasterVerificationGasLimit = toHex(
      uoQuantity(
        value.paymasterVerificationGasLimit,
        "paymaster verification gas",
        128,
      ),
    );
    result.paymasterPostOpGasLimit = toHex(
      uoQuantity(value.paymasterPostOpGasLimit, "paymaster post-op gas", 128),
    );
  }
  if (
    new TextEncoder().encode(uoCanonical(result)).byteLength >
    USER_OPERATION_LIMITS.operationBytes
  )
    uoError(
      "USER_OPERATION_TOO_LARGE",
      "The user operation exceeds its byte limit.",
      413,
    );
  return result;
}
export function packUserOperation(
  value: UserOperationV07,
): PackedUserOperationV07 {
  const op = normalizeUserOperation(value);
  return {
    sender: op.sender,
    nonce: BigInt(op.nonce),
    initCode: op.factory ? concat([op.factory, op.factoryData!]) : "0x",
    callData: op.callData,
    accountGasLimits: concat([
      padHex(op.verificationGasLimit, { size: 16 }),
      padHex(op.callGasLimit, { size: 16 }),
    ]),
    preVerificationGas: BigInt(op.preVerificationGas),
    gasFees: concat([
      padHex(op.maxPriorityFeePerGas, { size: 16 }),
      padHex(op.maxFeePerGas, { size: 16 }),
    ]),
    paymasterAndData: op.paymaster
      ? concat([
          op.paymaster,
          padHex(op.paymasterVerificationGasLimit!, { size: 16 }),
          padHex(op.paymasterPostOpGasLimit!, { size: 16 }),
          op.paymasterData!,
        ])
      : "0x",
    signature: op.signature,
  };
}
export function unpackUserOperation(
  packed: PackedUserOperationV07,
): UserOperationV07 {
  const gas = uoBytes(packed.accountGasLimits, "packed account gas", 32);
  const fees = uoBytes(packed.gasFees, "packed fees", 32);
  if (gas.length !== 66 || fees.length !== 66)
    uoError(
      "INVALID_USER_OPERATION",
      "Packed gas words must be 32 bytes.",
      400,
    );
  const init = uoBytes(
    packed.initCode,
    "init code",
    USER_OPERATION_LIMITS.factoryBytes + 20,
  );
  const paymaster = uoBytes(
    packed.paymasterAndData,
    "packed paymaster",
    USER_OPERATION_LIMITS.paymasterBytes + 52,
  );
  if (
    (init !== "0x" && init.length < 42) ||
    (paymaster !== "0x" && paymaster.length < 106)
  )
    uoError(
      "INVALID_USER_OPERATION",
      "Packed factory or paymaster fields are truncated.",
      400,
    );
  return normalizeUserOperation({
    sender: packed.sender,
    nonce: toHex(packed.nonce),
    callData: packed.callData,
    signature: packed.signature,
    callGasLimit: toHex(BigInt(`0x${gas.slice(34)}`)),
    verificationGasLimit: toHex(BigInt(gas.slice(0, 34))),
    preVerificationGas: toHex(packed.preVerificationGas),
    maxFeePerGas: toHex(BigInt(`0x${fees.slice(34)}`)),
    maxPriorityFeePerGas: toHex(BigInt(fees.slice(0, 34))),
    ...(init === "0x"
      ? {}
      : { factory: init.slice(0, 42), factoryData: `0x${init.slice(42)}` }),
    ...(paymaster === "0x"
      ? {}
      : {
          paymaster: paymaster.slice(0, 42),
          paymasterVerificationGasLimit: toHex(
            BigInt(`0x${paymaster.slice(42, 74)}`),
          ),
          paymasterPostOpGasLimit: toHex(
            BigInt(`0x${paymaster.slice(74, 106)}`),
          ),
          paymasterData: `0x${paymaster.slice(106)}`,
        }),
  });
}
export function getUserOperationHash(
  operation: UserOperationV07,
  entryPoint: Address,
  chainId: number,
): Hex {
  if (!Number.isSafeInteger(chainId) || chainId <= 0)
    uoError(
      "INVALID_USER_OPERATION_CHAIN",
      "Expected a configured chain.",
      400,
    );
  const op = packUserOperation(operation);
  const encoded = encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [
      op.sender,
      op.nonce,
      keccak256(op.initCode),
      keccak256(op.callData),
      op.accountGasLimits,
      op.preVerificationGas,
      op.gasFees,
      keccak256(op.paymasterAndData),
    ],
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [
        keccak256(encoded),
        uoAddress(entryPoint, "EntryPoint"),
        BigInt(chainId),
      ],
    ),
  );
}
export function userOperationCommitment(
  operation: UserOperationV07,
  entryPoint: Address,
  chainId: number,
): Hex {
  if (!Number.isSafeInteger(chainId) || chainId <= 0)
    uoError(
      "INVALID_USER_OPERATION_CHAIN",
      "Expected a configured chain.",
      400,
    );
  return sha256(
    stringToHex(
      uoCanonical({
        chainId,
        entryPoint: uoAddress(entryPoint, "EntryPoint"),
        operation: normalizeUserOperation(operation),
      }),
    ),
  );
}
export function withoutUserOperationSignature(
  operation: UserOperationV07,
): Omit<UserOperationV07, "signature"> {
  const { signature: _signature, ...unsigned } =
    normalizeUserOperation(operation);
  return unsigned;
}
export function applyUserOperationEstimate(
  operation: UserOperationV07,
  estimate: UserOperationGasEstimate,
): UserOperationV07 {
  return normalizeUserOperation({
    ...normalizeUserOperation(operation),
    ...estimate,
  });
}
/** v0.7 required-prefund formula; unlike v0.6 it has separate paymaster gas limits. */
export function userOperationMaximumCost(operation: UserOperationV07): bigint {
  const op = normalizeUserOperation(operation);
  return (
    (BigInt(op.callGasLimit) +
      BigInt(op.verificationGasLimit) +
      BigInt(op.preVerificationGas) +
      BigInt(op.paymasterVerificationGasLimit ?? "0x0") +
      BigInt(op.paymasterPostOpGasLimit ?? "0x0")) *
    BigInt(op.maxFeePerGas)
  );
}
export function assertUserOperationGasPolicy(
  operation: UserOperationV07,
  policy: UserOperationGasPolicy,
): void {
  const op = normalizeUserOperation(operation);
  const fields = [
    ["callGasLimit", "maximumCallGas"],
    ["verificationGasLimit", "maximumVerificationGas"],
    ["preVerificationGas", "maximumPreVerificationGas"],
    ["maxFeePerGas", "maximumFeePerGas"],
    ["maxPriorityFeePerGas", "maximumPriorityFeePerGas"],
    ["paymasterVerificationGasLimit", "maximumPaymasterVerificationGas"],
    ["paymasterPostOpGasLimit", "maximumPaymasterPostOpGas"],
  ] as const;
  for (const [field, maximum] of fields) {
    if (typeof policy[maximum] !== "bigint" || policy[maximum] < 0n)
      uoError(
        "INVALID_USER_OPERATION_POLICY",
        "The operator gas policy is invalid.",
        500,
      );
    if (BigInt(op[field] ?? "0x0") > policy[maximum])
      uoError(
        "USER_OPERATION_GAS_LIMIT",
        "The operation exceeds its reviewed gas or fee policy.",
      );
  }
  if (typeof policy.maximumCost !== "bigint" || policy.maximumCost <= 0n)
    uoError(
      "INVALID_USER_OPERATION_POLICY",
      "The operator maximum cost is invalid.",
      500,
    );
  if (
    userOperationMaximumCost(op) > policy.maximumCost ||
    (policy.requirePaymaster && !op.paymaster)
  )
    uoError(
      "USER_OPERATION_GAS_LIMIT",
      "The operation exceeds its cost limit or requires the reviewed paymaster.",
    );
}
