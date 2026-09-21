import { describe, expect, it, vi } from "vitest";
import { concatHex, hashTypedData, keccak256, toHex, zeroAddress, zeroHash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  passkeyOnboardingDocument, passkeyOnboardingProofDocument, passkeyOnboardingSigningPayload,
  validatePasskeyOnboardingInput, verifyPasskeyOnboardingSignatures, type PasskeyOnboardingInput,
} from "../src/rest/smartAccounts/passkeyOnboarding.js";
import { encodeSafe7579MessageSignature, encodeSafe7579PasskeyOwnerSignature } from "../src/rest/smartAccounts/passkeySignatures.js";
import type { SmartAccountState } from "../src/rest/smartAccounts/types.js";

const recovery = privateKeyToAccount(toHex(1, { size: 32 }));
const browser = privateKeyToAccount(toHex(2, { size: 32 }));
const other = privateKeyToAccount(toHex(3, { size: 32 }));
const wallet = "0x8000000000000000000000000000000000000000";
const signer = "0x9000000000000000000000000000000000000000";
const time = 1_800_000_000, audience = "https://wallet.juicebox.center";
const nonce = toHex(1, { size: 32 }), initializerHash = toHex(2, { size: 32 });
const input: PasskeyOnboardingInput = {
  profile: "center-passkey-v1", address: wallet, manifestId: "passkey-base-fixture", nonce,
  issuedAt: time, expiresAt: time + 300,
  grant: { id: "550e8400-e29b-41d4-a716-446655440000", botAddress: browser.address,
    scopes: ["read", "plan", "relay"], expiresAt: time + 3600, label: "Beep checkout" },
};
function state(): SmartAccountState {
  return {
    chainId: 8453, address: wallet, manifestId: input.manifestId, manifestRevision: toHex(3, { size: 32 }),
    owners: [signer, recovery.address], threshold: 1, safeNonce: "0", stateHash: toHex(4, { size: 32 }),
    evidence: { chainId: 8453, blockHash: zeroHash, blockNumber: "1", timestamp: String(time), source: "onchain" },
    codeHashes: [], executionVerified: false, moduleConfigurationVerified: true,
    modules: { stateHash: toHex(5, { size: 32 }), complete: true, arbitrarySigningDisabled: true,
      wildcardExecutionDisabled: true, details: { sessions: { permissionIds: [] }, provenance: { initializerHash } } },
    ownerProfile: { version: "center-passkey-v1", signer: { address: signer, kind: "contract",
      x: toHex(6, { size: 32 }), y: toHex(7, { size: 32 }), verifiers: toHex(8, { size: 22 }), runtimeCodeHash: toHex(9, { size: 32 }) },
      recoveryOwner: { address: recovery.address, kind: "ecdsa" } },
  };
}
function document(value = input, current = state()) { return passkeyOnboardingDocument(audience, value, current); }
async function signed(current = state()) {
  const typedData = document(input, current), payload = passkeyOnboardingSigningPayload(typedData);
  return { typedData, payload,
    signature: encodeSafe7579MessageSignature([{ kind: "ecdsa", owner: recovery.address, signature: await recovery.sign({ hash: payload.digest }) }]),
    proofSignature: await browser.signTypedData(passkeyOnboardingProofDocument(typedData)),
  };
}

describe("versioned deployed passkey wallet setup", () => {
  it("binds the stable Safe identity, exact reviewed profile and one-hour nonspending browser grant", async () => {
    const current = state(), proof = await signed(current);
    expect(proof.typedData).toMatchObject({ domain: { name: "Juicebox Center Account Setup", version: "2", verifyingContract: wallet },
      primaryType: "SetupAccount", message: { accountId: `eip155:8453:${wallet}`, profile: "center-passkey-v1",
        manifestId: input.manifestId, manifestRevision: current.manifestRevision, stateHash: current.stateHash,
        initializerHash, botAddress: browser.address, scopes: ["read", "plan", "relay"], grantExpiresAt: BigInt(time + 3600) } });
    expect(proof.payload.typedData.primaryType).toBe("SafeMessage");
    expect(proof.payload.typedData.message.message).toBe(hashTypedData(proof.typedData));
    expect(keccak256(proof.payload.signedData)).toBe(proof.payload.digest);
    const verifyContractSignature = vi.fn(async () => false);
    await expect(verifyPasskeyOnboardingSignatures(proof.typedData, current, proof.signature, proof.proofSignature, verifyContractSignature)).resolves.toEqual([recovery.address]);
    expect(verifyContractSignature).not.toHaveBeenCalled();
  });

  it("does not accept raw setup, login, SafeOp or browser-key signatures as current owner approval", async () => {
    const current = state(), proof = await signed(current);
    const ownerEntry = (signature: Hex) => [{ kind: "ecdsa" as const, owner: recovery.address, signature }];
    for (const signature of [
      encodeSafe7579MessageSignature(ownerEntry(await recovery.signTypedData(proof.typedData))),
      encodeSafe7579MessageSignature(ownerEntry(await recovery.signMessage({ message: "Sign in to Juicebox Center" }))),
      encodeSafe7579MessageSignature(ownerEntry(await browser.sign({ hash: proof.payload.digest }))),
      encodeSafe7579PasskeyOwnerSignature({ validAfter: String(time), validUntil: String(time + 300), signatures: ownerEntry(await recovery.sign({ hash: proof.payload.digest })) }),
    ]) await expect(verifyPasskeyOnboardingSignatures(proof.typedData, current, signature, proof.proofSignature, async () => false)).rejects.toBeInstanceOf(Error);
    for (const proofSignature of [await browser.signTypedData(proof.typedData), await recovery.signTypedData(passkeyOnboardingProofDocument(proof.typedData)),
      await other.signTypedData(passkeyOnboardingProofDocument(proof.typedData))])
      await expect(verifyPasskeyOnboardingSignatures(proof.typedData, current, proof.signature, proofSignature, async () => false)).rejects.toBeInstanceOf(Error);
  });

  it("requires the exact signed audience, nonce, times and every grant field", async () => {
    const current = state(), proof = await signed(current);
    const changes = [{ nonce: initializerHash }, { issuedAt: time - 1 }, { expiresAt: time + 299 },
      ...[{ id: "550e8400-e29b-41d4-a716-446655440001" }, { botAddress: other.address }, { expiresAt: time + 3599 }, { label: "Other app" }]
        .map((grant) => ({ grant: { ...input.grant, ...grant } }))];
    for (const change of changes)
      await expect(verifyPasskeyOnboardingSignatures(document({ ...input, ...change }, current), current, proof.signature, proof.proofSignature, async () => false)).rejects.toBeInstanceOf(Error);
    await expect(verifyPasskeyOnboardingSignatures(passkeyOnboardingDocument("https://other.example", input, current), current,
      proof.signature, proof.proofSignature, async () => false)).rejects.toBeInstanceOf(Error);
  });

  it("pins owner contract verification to the exact SafeMessage preimage and fails closed on unavailable evidence", async () => {
    const current = state(), proof = await signed(current), body = "0x1234";
    const signature = encodeSafe7579MessageSignature([{ kind: "contract", owner: signer, signature: body }]);
    const verifier = vi.fn(async () => true);
    await expect(verifyPasskeyOnboardingSignatures(proof.typedData, current, signature, proof.proofSignature, verifier)).resolves.toEqual([signer]);
    expect(verifier).toHaveBeenCalledExactlyOnceWith({ owner: signer, digest: proof.payload.digest, signedData: proof.payload.signedData, signature: body });
    for (const verify of [async () => false, async () => { throw new Error("RPC unavailable"); }])
      await expect(verifyPasskeyOnboardingSignatures(proof.typedData, current, signature, proof.proofSignature, verify)).rejects.toBeInstanceOf(Error);
    verifier.mockClear();
    await expect(verifyPasskeyOnboardingSignatures(proof.typedData, current, concatHex([signature, "0x00"]), proof.proofSignature, verifier)).rejects.toBeInstanceOf(Error);
    expect(verifier).not.toHaveBeenCalled();
  });

  it("preserves the Safe principal through recovery rotation and rejects the prior reviewed profile", async () => {
    const current = state(), proof = await signed(current), rotated = state();
    rotated.ownerProfile!.recoveryOwner.address = other.address;
    rotated.owners = [signer, other.address];
    rotated.stateHash = toHex(10, { size: 32 });
    const next = document(input, rotated);
    expect(next.message.accountId).toBe(proof.typedData.message.accountId);
    expect(next.message.ownerProfileHash).not.toBe(proof.typedData.message.ownerProfileHash);
    await expect(verifyPasskeyOnboardingSignatures(proof.typedData, rotated, proof.signature, proof.proofSignature, async () => false)).rejects.toMatchObject({ code: "SMART_ACCOUNT_CHANGED" });
    const nextPayload = passkeyOnboardingSigningPayload(next);
    const nextSignature = encodeSafe7579MessageSignature([{ kind: "ecdsa", owner: other.address, signature: await other.sign({ hash: nextPayload.digest }) }]);
    await expect(verifyPasskeyOnboardingSignatures(next, rotated, nextSignature, await browser.signTypedData(passkeyOnboardingProofDocument(next)), async () => false)).resolves.toEqual([other.address]);
  });

  it("requires a complete Base pilot profile and no installed spending sessions", () => {
    for (const mutate of [
      (s: SmartAccountState) => { delete s.ownerProfile; }, (s: SmartAccountState) => { s.chainId = 1; },
      (s: SmartAccountState) => { s.threshold = 2; }, (s: SmartAccountState) => { s.owners.push(other.address); },
      (s: SmartAccountState) => { s.owners = [signer, browser.address]; }, (s: SmartAccountState) => { s.moduleConfigurationVerified = false; },
      (s: SmartAccountState) => { s.modules = null; },
      (s: SmartAccountState) => { s.modules!.details = { sessions: { permissionIds: [nonce] }, provenance: { initializerHash } }; },
      (s: SmartAccountState) => { s.modules!.details = { provenance: { initializerHash } }; },
      (s: SmartAccountState) => { s.modules!.details = { sessions: { permissionIds: [] } }; },
    ]) { const current = state(); mutate(current); expect(() => document(input, current)).toThrow(); }
    for (const botAddress of [wallet, signer, recovery.address] as const) expect(() => document({ ...input, grant: { ...input.grant, botAddress } })).toThrow();
  });

  it("admits only the exact bounded setup schema and canonical nonspending scopes", async () => {
    expect(validatePasskeyOnboardingInput(input, time)).toEqual(input);
    const malformed = [
      { profile: "legacy-eoa" }, { owner: recovery.address }, { address: zeroAddress }, { nonce: zeroHash },
      { issuedAt: time + 31 }, { expiresAt: time }, { expiresAt: time + 301 }, { issuedAt: 1.5 },
      { grant: { ...input.grant, botAddress: wallet } }, { grant: { ...input.grant, expiresAt: time + 3601 } },
      { grant: { ...input.grant, expiresAt: input.expiresAt } }, { grant: { ...input.grant, scopes: ["read", "plan"] } },
      { grant: { ...input.grant, scopes: ["relay", "plan", "read"] } }, { grant: { ...input.grant, scopes: ["read", "plan", "relay", "spend"] } },
      { grant: { ...input.grant, label: "a\nb" } }, { grant: { ...input.grant, label: "é".repeat(61) } },
      { grant: { ...input.grant, spendingKey: browser.address } }, { rpcUrl: "https://attacker.example" },
    ];
    for (const change of malformed) expect(() => validatePasskeyOnboardingInput({ ...input, ...change }, time)).toThrow();
    const proof = await signed(), final = { ...input, manifestRevision: state().manifestRevision, initializerHash,
      stateHash: state().stateHash, signature: proof.signature, proofSignature: proof.proofSignature };
    expect(validatePasskeyOnboardingInput(final, time, true)).toEqual(input);
    expect(() => validatePasskeyOnboardingInput({ ...final, signature: "0x" }, time, true)).toThrow();
    expect(() => validatePasskeyOnboardingInput({ ...final, proofSignature: proof.signature }, time, true)).toThrow();
    expect(() => validatePasskeyOnboardingInput(final, input.expiresAt, true)).toThrow();
  });
});
