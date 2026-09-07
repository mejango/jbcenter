import { describe, expect, it, vi } from "vitest";
import { keccak256, stringToHex, toHex, type Hex } from "viem";
import { RestError } from "../src/rest/core.js";
import {
  uoCanonical,
  withoutUserOperationSignature,
} from "../src/rest/userOperations/codec.js";
import type { SessionGasEstimation } from "../src/rest/userOperations/estimation.js";
import type { UserOperationProvider } from "../src/rest/userOperations/provider.js";
import { finalizeUserOperationSponsorship } from "../src/rest/userOperations/sponsorship.js";
import type {
  PaymasterStub,
  UserOperationGasEstimate,
  UserOperationGasPolicy,
  UserOperationV07,
} from "../src/rest/userOperations/types.js";

const currentProfile = "pimlico-v7-current-flags" as const;
const expiresAt = 1_800_000_300_000;
const estimatedFields = [
  "callGasLimit",
  "verificationGasLimit",
  "preVerificationGas",
  "paymasterVerificationGasLimit",
  "paymasterPostOpGasLimit",
] as const;
const limits = [
  ["callGasLimit", "maximumCallGas"],
  ["verificationGasLimit", "maximumVerificationGas"],
  ["preVerificationGas", "maximumPreVerificationGas"],
  ["paymasterVerificationGasLimit", "maximumPaymasterVerificationGas"],
  ["paymasterPostOpGasLimit", "maximumPaymasterPostOpGas"],
  ["maxFeePerGas", "maximumFeePerGas"],
  ["maxPriorityFeePerGas", "maximumPriorityFeePerGas"],
] as const;

function operation(): UserOperationV07 {
  return {
    sender: "0x3333333333333333333333333333333333333333",
    nonce: "0x1",
    factory: "0x4444444444444444444444444444444444444444",
    factoryData: "0x1234",
    callData: "0xabcd",
    callGasLimit: toHex(100),
    verificationGasLimit: toHex(200),
    preVerificationGas: toHex(300),
    maxFeePerGas: "0x2",
    maxPriorityFeePerGas: "0x1",
    paymaster: "0x777777777777aec03fd955926dbf81597e66834c",
    paymasterVerificationGasLimit: toHex(400),
    paymasterPostOpGasLimit: toHex(500),
    paymasterData: "0x00",
    signature: "0x",
  };
}

function gasPolicy(): UserOperationGasPolicy {
  return {
    id: "synthetic-sponsorship-gas",
    maximumCallGas: 1_000_000n,
    maximumVerificationGas: 1_000_000n,
    maximumPreVerificationGas: 1_000_000n,
    maximumPaymasterVerificationGas: 1_000_000n,
    maximumPaymasterPostOpGas: 1_000_000n,
    maximumFeePerGas: 100n,
    maximumPriorityFeePerGas: 100n,
    maximumCost: 1_000_000_000n,
    requirePaymaster: true,
  };
}

function coveredEstimate(op: UserOperationV07): UserOperationGasEstimate {
  return {
    callGasLimit: op.callGasLimit,
    verificationGasLimit: op.verificationGasLimit,
    preVerificationGas: op.preVerificationGas,
    paymasterVerificationGasLimit: op.paymasterVerificationGasLimit!,
    paymasterPostOpGasLimit: op.paymasterPostOpGasLimit!,
  };
}

/** Synthetic commitment, not a provider payload or a cryptographic signature. */
function quoteData(op: UserOperationV07): Hex {
  return keccak256(
    stringToHex(
      uoCanonical({
        ...withoutUserOperationSignature(op),
        paymasterData: "0x",
      }),
    ),
  );
}

function fixture(options: {
  estimate?: (
    op: UserOperationV07,
    index: number,
  ) => UserOperationGasEstimate;
  quote?: (op: UserOperationV07, index: number) => UserOperationV07;
  validUntil?: readonly number[];
} = {}) {
  const quoteInputs: UserOperationV07[] = [];
  const quoted: UserOperationV07[] = [];
  const estimateInputs: UserOperationV07[] = [];
  const provider = {
    sponsor: vi.fn<UserOperationProvider["sponsor"]>(async (_chain, value) => {
      const index = quoteInputs.length;
      quoteInputs.push(structuredClone(value));
      const op = options.quote?.(structuredClone(value), index) ?? { ...value };
      op.paymasterData = quoteData(op);
      quoted.push(structuredClone(op));
      return {
        operation: op,
        isFinal: true,
        proof: {
          policyId: "synthetic-sponsor",
          commitment: op.paymasterData,
          validAfter: 1_800_000_000,
          validUntil: options.validUntil?.[index] ?? expiresAt / 1000,
          gasOnly: true,
        },
      } satisfies PaymasterStub;
    }),
    estimate: vi.fn<UserOperationProvider["estimate"]>(async (_chain, value) => {
      const index = estimateInputs.length;
      estimateInputs.push(structuredClone(value));
      return options.estimate?.(value, index) ?? coveredEstimate(value);
    }),
  };
  const dummySignature = vi.fn((expiry: number): Hex =>
    toHex(BigInt(expiry), { size: 77 }),
  );
  const input = {
    chainId: 1,
    operation: Object.freeze(operation()),
    gasPolicy: gasPolicy(),
    profile: currentProfile,
    expiresAt,
    dummySignature,
    provider,
  };
  return { input, provider, quoteInputs, quoted, estimateInputs, dummySignature };
}

function sessionBudget(maximumGas: bigint): SessionGasEstimation {
  return {
    maximumGas,
    fit: vi.fn((op: UserOperationV07) => op),
    assert: vi.fn((op: UserOperationV07) => {
      const total = estimatedFields.reduce(
        (sum, field) => sum + BigInt(op[field] ?? "0x0"),
        0n,
      );
      if (total > maximumGas)
        throw new RestError(
          422,
          "SESSION_GAS_ESTIMATE_EXCEEDS_BUDGET",
          "Synthetic owner-approved gas budget exceeded.",
        );
    }),
  };
}

describe("final user-operation sponsorship", () => {
  it("re-quotes raised fields with rounded headroom and returns the exact estimated quote", async () => {
    const f = fixture({
      estimate: (op, index) => index === 0 ? {
        callGasLimit: toHex(101),
        verificationGasLimit: toHex(199),
        preVerificationGas: toHex(301),
        paymasterVerificationGasLimit: toHex(399),
        paymasterPostOpGasLimit: toHex(501),
      } : coveredEstimate(op),
      validUntil: [1_800_000_200, 1_800_000_150],
    });
    const original = structuredClone(f.input.operation);
    const signal = new AbortController().signal;
    const sessionGas = sessionBudget(10_000n);
    const result = await finalizeUserOperationSponsorship({
      ...f.input, signal, sessionGas,
    });

    expect(f.provider.sponsor).toHaveBeenCalledTimes(2);
    expect(f.provider.estimate).toHaveBeenCalledTimes(2);
    expect(f.quoteInputs[1]).toMatchObject({
      callGasLimit: toHex(107),
      verificationGasLimit: toHex(200),
      preVerificationGas: toHex(317),
      paymasterVerificationGasLimit: toHex(400),
      paymasterPostOpGasLimit: toHex(527),
      maxFeePerGas: "0x2",
      maxPriorityFeePerGas: "0x1",
      signature: "0x",
    });
    expect(f.quoted[1]!.paymasterData).not.toBe(f.quoted[0]!.paymasterData);
    expect(result.operation).toEqual(f.quoted[1]);
    expect(result.operation.paymasterData).toBe(quoteData(result.operation));
    expect(result.operation.signature).toBe("0x");
    expect(result.expiresAt).toBe(1_800_000_150_000);
    expect(f.dummySignature.mock.calls).toEqual([
      [1_800_000_200_000], [1_800_000_150_000],
    ]);
    for (const [index, quoted] of f.quoted.entries()) {
      expect(f.estimateInputs[index]).toEqual({
        ...quoted,
        signature: f.dummySignature.mock.results[index]!.value,
      });
      expect(f.provider.sponsor.mock.calls[index]).toEqual([
        1, f.quoteInputs[index], signal,
      ]);
      expect(f.provider.estimate.mock.calls[index]).toEqual([
        1, f.estimateInputs[index], signal, sessionGas,
      ]);
    }
    expect(sessionGas.assert).toHaveBeenCalledWith(result.operation);
    expect(sessionGas.fit).not.toHaveBeenCalled();
    expect(f.input.operation).toEqual(original);
  });

  it("preserves an earlier expiry when a later quote extends its validity", async () => {
    const f = fixture({
      estimate: (op, index) => ({
        ...coveredEstimate(op),
        ...(index === 0 ? { callGasLimit: toHex(101) } : {}),
      }),
      validUntil: [1_800_000_100, 1_800_000_250],
    });
    const result = await finalizeUserOperationSponsorship(f.input);
    expect(result.expiresAt).toBe(1_800_000_100_000);
    expect(f.dummySignature.mock.calls).toEqual([
      [1_800_000_100_000], [1_800_000_100_000],
    ]);
  });

  it("does not reduce gas or add headroom after a quote already covers estimation", async () => {
    const f = fixture({ estimate: () => ({
      callGasLimit: "0x1",
      verificationGasLimit: "0x1",
      preVerificationGas: "0x1",
      paymasterVerificationGasLimit: "0x1",
      paymasterPostOpGasLimit: "0x1",
    }) });
    const result = await finalizeUserOperationSponsorship(f.input);
    expect(f.provider.sponsor).toHaveBeenCalledTimes(1);
    expect(result.operation).toEqual(f.quoted[0]);
    expect(coveredEstimate(result.operation)).toEqual(coveredEstimate(f.input.operation));
  });

  it("fails after three current-profile quotes when estimates keep increasing", async () => {
    const f = fixture({ estimate: (op) => ({
      ...coveredEstimate(op),
      callGasLimit: toHex(BigInt(op.callGasLimit) + 1n),
    }) });
    const original = structuredClone(f.input.operation);
    await expect(finalizeUserOperationSponsorship(f.input)).rejects.toMatchObject({
      code: "USER_OPERATION_SPONSOR_GAS_CHANGED",
    });
    expect(f.provider.sponsor).toHaveBeenCalledTimes(3);
    expect(f.provider.estimate).toHaveBeenCalledTimes(3);
    expect(f.quoteInputs.map((op) => BigInt(op.callGasLimit))).toEqual([100n, 107n, 114n]);
    expect(f.input.operation).toEqual(original);
  });

  it.each(limits)("rejects initial %s above the operator cap before requesting sponsorship", async (field, cap) => {
    const f = fixture();
    f.input.gasPolicy[cap] = BigInt(f.input.operation[field]!) - 1n;
    await expect(finalizeUserOperationSponsorship(f.input)).rejects.toMatchObject({
      code: "USER_OPERATION_GAS_LIMIT",
    });
    expect(f.provider.sponsor).not.toHaveBeenCalled();
    expect(f.provider.estimate).not.toHaveBeenCalled();
  });

  it("rejects an initial maximum cost above the operator cap before requesting sponsorship", async () => {
    const f = fixture();
    f.input.gasPolicy.maximumCost = 2_999n;
    await expect(finalizeUserOperationSponsorship(f.input)).rejects.toMatchObject({
      code: "USER_OPERATION_GAS_LIMIT",
    });
    expect(f.provider.sponsor).not.toHaveBeenCalled();
    expect(f.provider.estimate).not.toHaveBeenCalled();
  });

  it.each(limits)("rejects a sponsor that rewrites the quoted %s", async (field, cap) => {
    const f = fixture({ quote: (op) => ({
      ...op, [field]: toHex(BigInt(op[field]!) + 1n),
    }) });
    f.input.gasPolicy[cap] = BigInt(f.input.operation[field]!);
    await expect(finalizeUserOperationSponsorship(f.input)).rejects.toMatchObject({
      code: "USER_OPERATION_SPONSOR_FIELDS_CHANGED",
    });
    expect(f.provider.sponsor).toHaveBeenCalledTimes(1);
    expect(f.provider.estimate).not.toHaveBeenCalled();
  });

  it.each(limits)("checks the operator %s cap again before returning an estimated quote", async (field, cap) => {
    const f = fixture({ estimate: (op) => {
      f.input.gasPolicy[cap] = BigInt(op[field]!) - 1n;
      return coveredEstimate(op);
    } });
    await expect(finalizeUserOperationSponsorship(f.input)).rejects.toMatchObject({
      code: "USER_OPERATION_GAS_LIMIT",
    });
    expect(f.provider.sponsor).toHaveBeenCalledTimes(1);
    expect(f.provider.estimate).toHaveBeenCalledTimes(1);
  });

  it("checks the operator total-cost cap again before returning an estimated quote", async () => {
    const f = fixture({ estimate: (op) => {
      f.input.gasPolicy.maximumCost = 2_999n;
      return coveredEstimate(op);
    } });
    f.input.gasPolicy.maximumCost = 3_100n;
    await expect(finalizeUserOperationSponsorship(f.input)).rejects.toMatchObject({
      code: "USER_OPERATION_GAS_LIMIT",
    });
    expect(f.provider.sponsor).toHaveBeenCalledTimes(1);
    expect(f.provider.estimate).toHaveBeenCalledTimes(1);
  });

  it.each(limits.slice(0, 5))("rejects corrected %s including headroom before requesting another quote", async (field, cap) => {
    const f = fixture({ estimate: (op) => ({
      ...coveredEstimate(op), [field]: toHex(BigInt(op[field]!) + 1n),
    }) });
    f.input.gasPolicy[cap] = BigInt(f.input.operation[field]!) + 1n;
    await expect(finalizeUserOperationSponsorship(f.input)).rejects.toMatchObject({
      code: "USER_OPERATION_GAS_LIMIT",
    });
    expect(f.provider.sponsor).toHaveBeenCalledTimes(1);
    expect(f.provider.estimate).toHaveBeenCalledTimes(1);
  });

  it("rejects corrected gas above the operator cost cap before another quote", async () => {
    const f = fixture({ estimate: (op) => ({ ...coveredEstimate(op), callGasLimit: toHex(200) }) });
    f.input.gasPolicy.maximumCost = 3_100n;
    await expect(finalizeUserOperationSponsorship(f.input)).rejects.toMatchObject({
      code: "USER_OPERATION_GAS_LIMIT",
    });
    expect(f.provider.sponsor).toHaveBeenCalledTimes(1);
    expect(f.provider.estimate).toHaveBeenCalledTimes(1);
  });

  it("rejects an exhausted initial session budget before requesting sponsorship", async () => {
    const f = fixture();
    await expect(finalizeUserOperationSponsorship({
      ...f.input, sessionGas: sessionBudget(1_499n),
    })).rejects.toMatchObject({ code: "SESSION_GAS_ESTIMATE_EXCEEDS_BUDGET" });
    expect(f.provider.sponsor).not.toHaveBeenCalled();
    expect(f.provider.estimate).not.toHaveBeenCalled();
  });

  it("rejects corrected gas above the owner-approved session cap before another quote", async () => {
    const f = fixture({ estimate: (op) => ({ ...coveredEstimate(op), callGasLimit: toHex(200) }) });
    const sessionGas = sessionBudget(1_550n);
    await expect(finalizeUserOperationSponsorship({
      ...f.input, sessionGas,
    })).rejects.toMatchObject({ code: "SESSION_GAS_ESTIMATE_EXCEEDS_BUDGET" });
    expect(f.provider.sponsor).toHaveBeenCalledTimes(1);
    expect(f.provider.estimate).toHaveBeenCalledTimes(1);
    expect(sessionGas.fit).not.toHaveBeenCalled();
  });

  it("checks the owner-approved session cap again before returning an estimated quote", async () => {
    const f = fixture({ estimate: (op) => {
      sessionGas.assert = sessionBudget(1_499n).assert;
      return coveredEstimate(op);
    } });
    const sessionGas = sessionBudget(1_550n);
    await expect(finalizeUserOperationSponsorship({
      ...f.input, sessionGas,
    })).rejects.toMatchObject({ code: "SESSION_GAS_ESTIMATE_EXCEEDS_BUDGET" });
    expect(f.provider.sponsor).toHaveBeenCalledTimes(1);
    expect(f.provider.estimate).toHaveBeenCalledTimes(1);
  });

  it("rejects an already-signed input before contacting the provider", async () => {
    const f = fixture();
    await expect(finalizeUserOperationSponsorship({
      ...f.input, operation: { ...f.input.operation, signature: "0xaa" },
    })).rejects.toMatchObject({ code: "USER_OPERATION_ALREADY_SIGNED" });
    expect(f.provider.sponsor).not.toHaveBeenCalled();
    expect(f.provider.estimate).not.toHaveBeenCalled();
  });

  it("rejects a sponsor-injected account signature before final estimation", async () => {
    const f = fixture({ quote: (op) => ({ ...op, signature: "0xaa" }) });
    await expect(finalizeUserOperationSponsorship(f.input)).rejects.toMatchObject({
      code: "USER_OPERATION_ALREADY_SIGNED",
    });
    expect(f.provider.sponsor).toHaveBeenCalledTimes(1);
    expect(f.provider.estimate).not.toHaveBeenCalled();
  });

  it.each(["signature", "paymasterData", "maxFeePerGas", "factoryData", "unsupported"])(
    "rejects an estimate containing the unsupported field %s",
    async (field) => {
      const f = fixture({ estimate: (op) => ({ ...coveredEstimate(op), [field]: "0xaa" }) });
      await expect(finalizeUserOperationSponsorship(f.input)).rejects.toMatchObject({
        code: "INVALID_USER_OPERATION_ESTIMATE",
      });
      expect(f.provider.sponsor).toHaveBeenCalledTimes(1);
      expect(f.provider.estimate).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["pimlico-v7-legacy-mode", undefined] as const)(
    "keeps the %s profile to one quote and rejects underestimated final gas",
    async (profile) => {
      const f = fixture({ estimate: (op) => ({ ...coveredEstimate(op), callGasLimit: toHex(101) }) });
      const { profile: _current, ...input } = f.input;
      await expect(finalizeUserOperationSponsorship({
        ...input, ...(profile === undefined ? {} : { profile }),
      })).rejects.toMatchObject({ code: "USER_OPERATION_SPONSOR_GAS_CHANGED" });
      expect(f.provider.sponsor).toHaveBeenCalledTimes(1);
      expect(f.provider.estimate).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["pimlico-v7-legacy-mode", undefined] as const)(
    "returns an unchanged covered quote for the %s profile",
    async (profile) => {
      const f = fixture();
      const { profile: _current, ...input } = f.input;
      const result = await finalizeUserOperationSponsorship({
        ...input, ...(profile === undefined ? {} : { profile }),
      });
      expect(result.operation).toEqual(f.quoted[0]);
      expect(f.provider.sponsor).toHaveBeenCalledTimes(1);
      expect(f.provider.estimate).toHaveBeenCalledTimes(1);
    },
  );
});
