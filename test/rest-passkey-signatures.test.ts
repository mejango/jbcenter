import { describe, expect, it, vi } from "vitest";
import { concatHex, getAddress, keccak256, sliceHex, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  decodeSafeOwnerSignatures, encodeSafeOwnerSignatures, verifySafeOwnerSignatures,
  decodeSafe7579MessageSignature, encodeSafe7579MessageSignature, safe7579MessageSigningPayload,
  decodeSafe7579PasskeyOwnerSignature, encodeSafe7579PasskeyOwnerSignature, safe7579PasskeyOwnerSigningPayload,
} from "../src/rest/smartAccounts/passkeySignatures.js";
import { encodeSafe7579OwnerSignature, safe7579OwnerSigningPayload } from "../src/rest/smartAccounts/accountExecution.js";

const owner = "0x1111111111111111111111111111111111111111" as Address;
const assertion = `0x${"ab".repeat(384)}` as Hex;
const packed = concatHex([
  toHex(BigInt(owner), { size: 32 }), toHex(65, { size: 32 }), "0x00",
  toHex(384, { size: 32 }), assertion,
]);
const secondOwner = "0x2222222222222222222222222222222222222222" as Address;
const eoa = privateKeyToAccount(toHex(1, { size: 32 }));
const message = safe7579MessageSigningPayload({ safe: secondOwner, chainId: 8453, requestDigest: toHex(42, { size: 32 }) });
function overwrite(data: Hex, offset: number, replacement: Hex): Hex {
  return `0x${data.slice(2, 2 + offset * 2)}${replacement.slice(2)}${data.slice(2 + offset * 2 + replacement.length - 2)}`;
}

describe("versioned Safe passkey signature codec", () => {
  it("encodes the exact dynamic contract signature after the SafeOp validity prefix", () => {
    expect(encodeSafe7579PasskeyOwnerSignature({
      validAfter: "1", validUntil: "100",
      signatures: [{ kind: "contract", owner, signature: assertion }],
    })).toBe(concatHex([toHex(1, { size: 6 }), toHex(100, { size: 6 }), packed]));
  });

  it("keeps the legacy EOA profile closed to contract signatures", () => {
    expect(() => encodeSafe7579OwnerSignature({
      validAfter: "1", validUntil: "100", signatures: packed,
    })).toThrow("65-byte");
  });

  it("round trips the exact contract body without adding ABI padding", () => {
    expect(decodeSafeOwnerSignatures(packed, 1)).toEqual([{ kind: "contract", owner, signature: assertion }]);
    const odd = encodeSafeOwnerSignatures([{ kind: "contract", owner, signature: "0x1234" }]);
    expect((odd.length - 2) / 2).toBe(65 + 32 + 2);
    expect(decodeSafeOwnerSignatures(odd, 1)[0]?.signature).toBe("0x1234");
  });

  it("sorts owners and computes multiple contract tails from the entire static table", () => {
    const two = encodeSafeOwnerSignatures([
      { kind: "contract", owner: secondOwner, signature: "0xabcd" },
      { kind: "contract", owner, signature: "0x11" },
    ]);
    expect(BigInt(sliceHex(two, 32, 64))).toBe(130n);
    expect(BigInt(sliceHex(two, 97, 129))).toBe(163n);
    expect(decodeSafeOwnerSignatures(two, 2)).toEqual([
      { kind: "contract", owner, signature: "0x11" },
      { kind: "contract", owner: secondOwner, signature: "0xabcd" },
    ]);
  });

  it.each([
    ["offset into static entries", overwrite(packed, 32, toHex(0, { size: 32 }))],
    ["gap before contract data", overwrite(packed, 32, toHex(66, { size: 32 }))],
    ["unbounded offset", overwrite(packed, 32, `0x${"ff".repeat(32)}`)],
    ["empty contract signature", overwrite(packed, 65, toHex(0, { size: 32 }))],
    ["truncated contract data", sliceHex(packed, 0, (packed.length - 2) / 2 - 1)],
    ["length beyond envelope", overwrite(packed, 65, toHex(385, { size: 32 }))],
    ["unbounded length", overwrite(packed, 65, `0x${"ff".repeat(32)}`)],
    ["nonzero address padding", overwrite(packed, 0, "0x01")],
    ["zero owner", overwrite(packed, 0, toHex(0, { size: 32 }))],
    ["approved hash signature", overwrite(packed, 64, "0x01")],
    ["personal-sign signature", overwrite(packed, 64, "0x1f")],
    ["trailing bytes", concatHex([packed, "0x00"])],
    ["extra static signature", concatHex([packed, `0x${"00".repeat(65)}`])],
  ])("rejects %s", (_name, invalid) => {
    expect(() => decodeSafeOwnerSignatures(invalid as Hex, 1)).toThrow();
  });

  it.each([0, -1, 1.5, 17, NaN])("rejects invalid threshold %s", (threshold) => {
    expect(() => decodeSafeOwnerSignatures(packed, threshold)).toThrow();
  });

  it("rejects aliases between contract tails", () => {
    const two = encodeSafeOwnerSignatures([
      { kind: "contract", owner, signature: "0x11" },
      { kind: "contract", owner: secondOwner, signature: "0x22" },
    ]);
    expect(() => decodeSafeOwnerSignatures(overwrite(two, 97, toHex(130, { size: 32 })), 2)).toThrow("offsets");
  });

  it("rejects duplicate, oversized and empty owner encodings", () => {
    const entry = { kind: "contract" as const, owner, signature: assertion };
    expect(() => encodeSafeOwnerSignatures([entry, entry])).toThrow("distinct");
    expect(() => encodeSafeOwnerSignatures([])).toThrow("threshold");
    expect(() => encodeSafeOwnerSignatures([{ ...entry, signature: "0x" }])).toThrow("contract signature");
    expect(() => encodeSafeOwnerSignatures([{ ...entry, signature: `0x${"ff".repeat(4097)}` }])).toThrow("contract signature");
    expect(() => encodeSafeOwnerSignatures([entry, { ...entry, owner: secondOwner, signature: `0x${"ff".repeat(4096)}` },
      { ...entry, owner: eoa.address, signature: `0x${"ff".repeat(4096)}` }])).toThrow("packed owner signatures");
  });

  it("binds the exact reviewed validity and refuses Message/Op envelope substitution", () => {
    const entries = [{ kind: "contract" as const, owner, signature: assertion }];
    const signature = encodeSafe7579PasskeyOwnerSignature({ validAfter: "1", validUntil: "100", signatures: entries });
    expect(decodeSafe7579PasskeyOwnerSignature({ signature, validAfter: "1", validUntil: "100", threshold: 1 })).toEqual(entries);
    expect(() => decodeSafe7579PasskeyOwnerSignature({ signature, validAfter: "2", validUntil: "100", threshold: 1 })).toThrow("validity");
    const messageSignature = encodeSafe7579MessageSignature(entries);
    expect(decodeSafe7579MessageSignature(messageSignature, 1)).toEqual(entries);
    expect(() => decodeSafe7579MessageSignature(signature, 1)).toThrow();
    expect(() => decodeSafe7579PasskeyOwnerSignature({ signature: messageSignature, validAfter: "1", validUntil: "100", threshold: 1 })).toThrow();
    expect(() => decodeSafe7579MessageSignature(overwrite(messageSignature, 0, owner), 1)).toThrow("zero-validator");
    expect(() => encodeSafe7579PasskeyOwnerSignature({ validAfter: "1", validUntil: "1", signatures: entries })).toThrow("finite");
  });

  it("binds SafeMessage to the original request, Safe address and authority chain", () => {
    expect(keccak256(message.signedData)).toBe(message.digest);
    expect(message.digest).not.toBe(message.typedData.message.message);
    for (const input of [
      { safe: secondOwner, chainId: 8453, requestDigest: toHex(43, { size: 32 }) },
      { safe: owner, chainId: 8453, requestDigest: toHex(42, { size: 32 }) },
      { safe: secondOwner, chainId: 1, requestDigest: toHex(42, { size: 32 }) },
    ]) expect(safe7579MessageSigningPayload(input).digest).not.toBe(message.digest);
  });

  it("produces the identical SafeOp digest and its exact contract-owner preimage", () => {
    const input = {
      operation: {
        sender: secondOwner, nonce: "0x0" as Hex, callData: "0x1234" as Hex,
        callGasLimit: "0x186a0" as Hex, verificationGasLimit: "0x100000" as Hex,
        preVerificationGas: "0x186a0" as Hex, maxFeePerGas: "0x1" as Hex,
        maxPriorityFeePerGas: "0x1" as Hex, signature: "0x" as Hex,
      },
      chainId: 8453, safe7579: owner, entryPoint: eoa.address, validAfter: "0", validUntil: "100",
    };
    const payload = safe7579PasskeyOwnerSigningPayload(input);
    expect(payload.digest).toBe(safe7579OwnerSigningPayload(input).digest);
    expect(keccak256(payload.signedData)).toBe(payload.digest);
    expect(safe7579MessageSigningPayload({ safe: secondOwner, chainId: 8453, requestDigest: payload.digest }).digest).not.toBe(payload.digest);
  });

  it("verifies mixed current owners and supplies the exact preimage to the contract verifier", async () => {
    const eoaSignature = await eoa.sign({ hash: message.digest });
    const signatures = encodeSafeOwnerSignatures([
      { kind: "ecdsa", owner: eoa.address, signature: eoaSignature },
      { kind: "contract", owner, signature: assertion },
    ]);
    const verifyContractSignature = vi.fn(async () => true);
    expect(await verifySafeOwnerSignatures({ ...message, signatures, threshold: 2,
      owners: [{ address: owner, kind: "contract" }, { address: eoa.address, kind: "ecdsa" }], verifyContractSignature,
    })).toEqual([owner, eoa.address]);
    expect(verifyContractSignature).toHaveBeenCalledWith({ owner, digest: message.digest, signedData: message.signedData, signature: assertion });
  });

  it("verifies an EOA between two contract owners with unpadded tails", async () => {
    const upper = "0xffffffffffffffffffffffffffffffffffffffff" as Address;
    const eoaSignature = await eoa.sign({ hash: message.digest });
    const signatures = encodeSafeOwnerSignatures([
      { kind: "contract", owner: upper, signature: "0x112233" },
      { kind: "ecdsa", owner: eoa.address, signature: eoaSignature },
      { kind: "contract", owner, signature: "0x11" },
    ]);
    const owners = [{ address: owner, kind: "contract" as const }, { address: eoa.address, kind: "ecdsa" as const }, { address: upper, kind: "contract" as const }];
    expect(BigInt(sliceHex(signatures, 32, 64))).toBe(195n);
    expect(BigInt(sliceHex(signatures, 162, 194))).toBe(228n);
    expect(await verifySafeOwnerSignatures({ ...message, signatures, threshold: 3, owners, verifyContractSignature: async () => true }))
      .toEqual([owner, eoa.address, getAddress(upper)]);
  });

  it("cannot use a claimed EOA address to hide the actual recovered ordering", async () => {
    const eoaSignature = await eoa.sign({ hash: message.digest });
    // The claimed address sorts first, while the actual EOA sorts after the contract owner.
    const signatures = encodeSafeOwnerSignatures([
      { kind: "ecdsa", owner: "0x0000000000000000000000000000000000000001", signature: eoaSignature },
      { kind: "contract", owner, signature: assertion },
    ]);
    await expect(verifySafeOwnerSignatures({ ...message, signatures, threshold: 2,
      owners: [{ address: owner, kind: "contract" }, { address: eoa.address, kind: "ecdsa" }], verifyContractSignature: async () => true,
    })).rejects.toThrow("sorted distinct");
  });

  it("rejects stale authority, invalid contracts and unavailable verification evidence", async () => {
    const input = { ...message, signatures: packed, threshold: 1,
      owners: [{ address: owner, kind: "contract" as const }], verifyContractSignature: vi.fn(async () => true),
    };
    await expect(verifySafeOwnerSignatures({ ...input, owners: [{ address: secondOwner, kind: "contract" }] })).rejects.toThrow("current owner");
    expect(input.verifyContractSignature).not.toHaveBeenCalled();
    await expect(verifySafeOwnerSignatures({ ...input, verifyContractSignature: async () => false })).rejects.toThrow("could not be verified");
    await expect(verifySafeOwnerSignatures({ ...input, verifyContractSignature: async () => { throw Error("upstream timeout"); } })).rejects.toThrow("could not be verified");
    await expect(verifySafeOwnerSignatures({ ...input, signedData: "0x1234" })).rejects.toThrow("preimage");
    await expect(verifySafeOwnerSignatures({ ...input, owners: [...input.owners, ...input.owners] })).rejects.toThrow("distinct");
    await expect(verifySafeOwnerSignatures({ ...input, owners: [{ address: owner, kind: "ecdsa" }] })).rejects.toThrow("current owner");
  });

  it("rejects reordered/duplicate owners even when their individual contract signatures pass", async () => {
    const owners = [{ address: owner, kind: "contract" as const }, { address: secondOwner, kind: "contract" as const }];
    const signatures = encodeSafeOwnerSignatures(owners.map((entry) => ({ kind: entry.kind, owner: entry.address, signature: "0x11" as Hex })));
    const swapped = overwrite(overwrite(signatures, 0, toHex(BigInt(secondOwner), { size: 32 })), 65, toHex(BigInt(owner), { size: 32 }));
    const duplicate = overwrite(signatures, 65, toHex(BigInt(owner), { size: 32 }));
    for (const invalid of [swapped, duplicate]) await expect(verifySafeOwnerSignatures({
      ...message, signatures: invalid, threshold: 2, owners, verifyContractSignature: async () => true,
    })).rejects.toThrow("sorted distinct");
  });

  it.each(["0x00000000", "0x20c13b0b", 1, {}, null, undefined])("requires a verified boolean result, not truthy RPC data %s", async (result) => {
    await expect(verifySafeOwnerSignatures({ ...message, signatures: packed, threshold: 1,
      owners: [{ address: owner, kind: "contract" }], verifyContractSignature: async () => result as unknown as boolean,
    })).rejects.toThrow("could not be verified");
  });

  it("rejects a real EOA request signature when the owner must sign SafeMessage", async () => {
    const wrong = await eoa.sign({ hash: message.typedData.message.message });
    await expect(verifySafeOwnerSignatures({ ...message,
      signatures: encodeSafeOwnerSignatures([{ kind: "ecdsa", owner: eoa.address, signature: wrong }]),
      threshold: 1, owners: [{ address: eoa.address, kind: "ecdsa" }], verifyContractSignature: async () => true,
    })).rejects.toThrow("current owner");
    expect(() => encodeSafeOwnerSignatures([{ kind: "ecdsa", owner: eoa.address,
      signature: concatHex([toHex(1, { size: 32 }), `0x${"ff".repeat(32)}`, "0x1b"]),
    }])).toThrow("low-s");
  });
});
