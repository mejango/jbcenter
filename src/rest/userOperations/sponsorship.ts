import { toHex, type Hex } from "viem";
import {
  assertUserOperationGasPolicy,
  normalizeUserOperation,
  uoCanonical,
  uoError,
  uoObject,
  uoQuantity,
} from "./codec.js";
import type { SessionGasEstimation } from "./estimation.js";
import type { UserOperationProvider } from "./provider.js";
import type {
  UserOperationGasEstimate,
  UserOperationGasPolicy,
  UserOperationPaymasterPolicy,
  UserOperationV07,
} from "./types.js";

const gasFields = [
  "callGasLimit",
  "verificationGasLimit",
  "preVerificationGas",
  "paymasterVerificationGasLimit",
  "paymasterPostOpGasLimit",
] as const;

function unsigned(value: UserOperationV07): UserOperationV07 {
  const operation = normalizeUserOperation(value);
  if (operation.signature !== "0x")
    uoError(
      "USER_OPERATION_ALREADY_SIGNED",
      "Complete sponsorship before requesting the owner/session signature.",
      400,
    );
  return operation;
}

function checkedEstimate(value: UserOperationGasEstimate) {
  if (
    !uoObject(value) ||
    gasFields.slice(0, 3).some((field) => !Object.hasOwn(value, field)) ||
    Object.keys(value).some(
      (field) => !(gasFields as readonly string[]).includes(field),
    )
  )
    uoError(
      "INVALID_USER_OPERATION_ESTIMATE",
      "The bundler returned an unsupported gas estimate.",
      502,
    );
  return gasFields.flatMap((field) =>
    Object.hasOwn(value, field)
      ? [{
          field,
          amount: uoQuantity(
            value[field],
            `estimated ${field}`,
            field === "preVerificationGas" ? 256 : 128,
          ),
        }]
      : [],
  );
}

/** Requotes only unsigned preparation. Every returned sponsorship is estimated with its exact gas fields. */
export async function finalizeUserOperationSponsorship(input: {
  chainId: number;
  operation: UserOperationV07;
  gasPolicy: UserOperationGasPolicy;
  profile?: UserOperationPaymasterPolicy["profile"];
  expiresAt: number;
  dummySignature(expiresAt: number): Hex;
  provider: Pick<UserOperationProvider, "sponsor" | "estimate">;
  sessionGas?: SessionGasEstimation | undefined;
  signal?: AbortSignal | undefined;
}): Promise<{ operation: UserOperationV07; expiresAt: number }> {
  const maximumQuotes = input.profile === "pimlico-v7-current-flags" ? 3 : 1;
  const assertBudget = (operation: UserOperationV07) => {
    assertUserOperationGasPolicy(operation, input.gasPolicy);
    input.sessionGas?.assert(operation);
  };
  let operation = unsigned(input.operation);
  let expiresAt = input.expiresAt;
  for (let quoteIndex = 0; quoteIndex < maximumQuotes; quoteIndex++) {
    assertBudget(operation);
    const quote = await input.provider.sponsor(
      input.chainId,
      { ...operation },
      input.signal,
    );
    const funded = unsigned(quote.operation);
    // The sponsor may replace its data, but every other field must still match its request.
    if (
      uoCanonical({ ...funded, paymasterData: operation.paymasterData }) !==
      uoCanonical(operation)
    )
      uoError(
        "USER_OPERATION_SPONSOR_FIELDS_CHANGED",
        "Final sponsorship changed the operation fields being reviewed.",
        502,
      );
    assertBudget(funded);
    expiresAt = Math.min(expiresAt, quote.proof.validUntil * 1000);
    const estimated = checkedEstimate(await input.provider.estimate(
      input.chainId,
      { ...funded, signature: input.dummySignature(expiresAt) },
      input.signal,
      input.sessionGas,
    ));
    const raised = estimated.filter(
      ({ field, amount }) => amount > BigInt(funded[field] ?? "0x0"),
    );
    if (raised.length === 0) {
      assertBudget(funded);
      return { operation: funded, expiresAt };
    }
    if (quoteIndex + 1 === maximumQuotes)
      uoError(
        "USER_OPERATION_SPONSOR_GAS_CHANGED",
        "Final sponsorship requires more gas than the reviewed operation. Bounded preparation did not converge.",
        409,
      );
    // These gas fields invalidate the preceding paymaster signature. A fresh quote
    // must bind them, and its exact data must be estimated again before returning.
    operation = { ...funded };
    for (const { field, amount } of raised)
      operation[field] = toHex((amount * 105n + 99n) / 100n);
    operation = unsigned(operation);
    assertBudget(operation);
  }
  throw new Error("Unreachable sponsorship preparation state.");
}
