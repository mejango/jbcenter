import { beforeAll, describe, expect, it } from "vitest";
import { concatHex, fromRlp, hashTypedData, keccak256, toRlp, type Hex, type TransactionSerializableEIP1559 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletEnrollmentIntent, enrollmentDigest, prepareWalletEnrollmentCandidate, verifyWalletEnrollmentProof,
  walletEnrollmentDocument, type WalletEnrollment } from "../src/rest/wallet/enrollment.js";
import { prepareWalletDeploymentApproval, prepareWalletDeploymentTemplate, validateSignedWalletDeployment,
  verifyWalletDeploymentProof, walletDeploymentDocument, type WalletDeploymentApproval } from "../src/rest/wallet/deployment.js";
import type { RelayPolicy } from "../src/rest/transactions/types.js";
import { createRegistration, enrollmentBackupAccount, enrollmentManifest, signBackupProof, signGet } from "./fixtures/wallet-enrollment-crypto.js";

const now = 1_800_000_000_000;
const relay = privateKeyToAccount(`0x${"22".repeat(32)}`);
const policy: RelayPolicy = { planTtlMs: 60_000, maximumPlanTtlMs: 300_000, leaseMs: 15_000, rpcTimeoutMs: 1000,
  maximumRawBytes: 32_768, maximumGas: 2_000_000n, maximumFeePerGas: 10_000_000_000n,
  maximumTransactionCost: 20_000_000_000_000_000n, confirmations: 1, allowedChainIds: [8453] };
const fees = { sender: relay.address, nonce: "1", gas: "1500000", maxFeePerGas: "2000000000", maxPriorityFeePerGas: "1000000" };
let enrollment: WalletEnrollment;
let credential: ReturnType<typeof createRegistration>;
let registrationProof: ReturnType<typeof signGet>;

beforeAll(async () => {
  const intent = createWalletEnrollmentIntent({ manifest: enrollmentManifest, rpId: "juicebox.center", origin: "https://juicebox.center",
    recoveryOwner: enrollmentBackupAccount.address, expiresAt: now + 60_000 });
  const empty: WalletEnrollment = { intent, createdAt: now, state: "awaiting_registration", candidate: null,
    candidateDigest: null, creation: null, possession: null, receipt: null };
  credential = createRegistration({ challenge: `0x${Buffer.from(intent.registration.challenge, "base64url").toString("hex")}`,
    rpId: intent.rpId, origin: intent.origin, userHandle: intent.userHandle });
  const pending: WalletEnrollment = { ...empty, ...prepareWalletEnrollmentCandidate(empty, credential.response), state: "awaiting_possession" };
  const document = walletEnrollmentDocument(pending);
  registrationProof = signGet({ ...credential, challenge: hashTypedData(document), rpId: intent.rpId, origin: intent.origin });
  const proof = await verifyWalletEnrollmentProof(pending, { assertion: registrationProof, backupSignature: await signBackupProof(document) });
  // Unit-test stand-in for W3's atomic durable receipt; these tests exercise no database admission.
  enrollment = { ...pending, state: "verified", receipt: { id: intent.id, enrollmentId: intent.id,
    accountId: `eip155:8453:${pending.creation!.address.toLowerCase()}`, credentialId: credential.credentialId,
    initializerHash: pending.creation!.initializerHash, manifestCommitment: `0x${enrollmentDigest(intent.manifest)}`,
    manifestRevision: intent.manifest.revision, creationCommitment: `0x${enrollmentDigest(pending.creation)}`,
    verificationDigest: proof.verificationDigest, verifiedAt: now + 1 } };
});

function approval(times = { issuedAt: now + 2, expiresAt: now + 30_000 }) {
  return prepareWalletDeploymentApproval(enrollment, times);
}
function assertion(value: WalletDeploymentApproval, extra = {}) {
  return signGet({ ...credential, challenge: hashTypedData(walletDeploymentDocument(enrollment, value)),
    rpId: enrollment.intent.rpId, origin: enrollment.intent.origin, ...extra });
}
function prepared() {
  const value = approval();
  const template = prepareWalletDeploymentTemplate(enrollment, value, fees, policy);
  const tx = template.transaction;
  const transaction: TransactionSerializableEIP1559 = { ...tx, nonce: Number(tx.nonce), gas: BigInt(tx.gas), value: 0n,
    maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) };
  return { approval: value, template, transaction };
}

describe("fresh deployment approval", () => {
  it("uses a new purpose-bound document, fresh nonce and unchanged deterministic wallet", () => {
    const a = approval(), b = approval();
    expect(hashTypedData(walletDeploymentDocument(enrollment, a))).not.toBe(hashTypedData(walletEnrollmentDocument(enrollment)));
    expect(hashTypedData(walletDeploymentDocument(enrollment, a))).not.toBe(hashTypedData(walletDeploymentDocument(enrollment, b)));
    expect(a.ceremony.purpose).toBe("deploy");
    expect(a.ceremony.accountId).toBe(enrollment.receipt!.accountId);
    expect(enrollmentDigest(JSON.parse(JSON.stringify(a)))).toBe(enrollmentDigest(a));
  });
  it("rejects the genuine registration possession proof for fresh deployment", () => {
    expect(() => verifyWalletDeploymentProof(enrollment, approval(), registrationProof, now + 3)).toThrow();
  });
  it("accepts a genuine fresh assertion after enrollment expiry without changing wallet identity", () => {
    const a = approval({ issuedAt: now + 120_000, expiresAt: now + 150_000 });
    const result = verifyWalletDeploymentProof(enrollment, a, assertion(a), now + 120_001);
    expect(result.verificationDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(prepareWalletDeploymentTemplate(enrollment, a, fees, policy).predictedSafe).toBe(enrollment.creation!.address);
    // Pure verification returns stable semantic identity; the future store consumes it once.
    expect(verifyWalletDeploymentProof(enrollment, a, assertion(a), now + 120_002)).toEqual(result);
  });
  it.each([
    [now + 30_000, "expired"], [now + 1, "before issuance"], [Number.NaN, "invalid clock"],
  ])("rejects admission clock %s (%s)", (clock) => {
    const a = approval();
    expect(() => verifyWalletDeploymentProof(enrollment, a, assertion(a), clock)).toThrow();
  });
  it.each([
    { issuedAt: now, expiresAt: now + 1 }, { issuedAt: now + 2, expiresAt: now + 2 },
    { issuedAt: now + 2, expiresAt: now + 300_003 }, { issuedAt: now + 0.5, expiresAt: now + 3 },
  ])("rejects invalid approval lifetime %j", times => expect(() => approval(times)).toThrow());
  it.each(["awaiting_registration", "awaiting_possession"] as const)("rejects unverified state %s", state => {
    expect(() => prepareWalletDeploymentApproval({ ...enrollment, state }, { issuedAt: now + 2, expiresAt: now + 3 })).toThrow();
  });
  it.each([
    ["receipt", (r: WalletEnrollment) => { r.receipt!.verificationDigest = "00".repeat(32); }],
    ["receipt account", (r: WalletEnrollment) => { r.receipt!.accountId = `eip155:8453:${relay.address.toLowerCase()}`; }],
    ["key", (r: WalletEnrollment) => { r.candidate!.publicKey.x = `0x${"01".repeat(32)}`; }],
    ["recovery owner", (r: WalletEnrollment) => { r.intent.recoveryOwner = relay.address; }],
    ["salt", (r: WalletEnrollment) => { r.intent.saltNonce = "1"; }],
    ["manifest", (r: WalletEnrollment) => { r.intent.manifest.revision = `0x${"ab".repeat(32)}`; }],
    ["factory", (r: WalletEnrollment) => { r.creation!.transaction.to = relay.address; }],
    ["calldata", (r: WalletEnrollment) => { r.creation!.transaction.data = "0x1234"; }],
  ] as const)("rejects altered verified enrollment %s", (_, mutate) => {
    const a = approval(), changed = structuredClone(enrollment); mutate(changed);
    expect(() => walletDeploymentDocument(changed, a)).toThrow();
  });
  it.each([
    ["nonce", (a: WalletDeploymentApproval) => { a.nonce = `0x${"ab".repeat(32)}`; }],
    ["purpose", (a: WalletDeploymentApproval) => { a.ceremony.purpose = "registration"; }],
    ["expiry", (a: WalletDeploymentApproval) => { a.expiresAt++; }],
    ["id", (a: WalletDeploymentApproval) => { a.ceremony.id = enrollment.intent.id; }],
    ["context", (a: WalletDeploymentApproval) => { a.enrollmentCommitment = `0x${"ab".repeat(32)}`; }],
  ] as const)("rejects altered approval %s", (_, mutate) => {
    const a = approval(); mutate(a); expect(() => walletDeploymentDocument(enrollment, a)).toThrow();
  });
  it.each([
    { origin: "https://other.juicebox.center" }, { rpId: "other.juicebox.center" },
    { userHandle: Buffer.alloc(32, 1).toString("base64url") }, { credentialId: Buffer.alloc(32, 2).toString("base64url") },
    { backupEligible: false, backedUp: false },
  ])("rejects genuine assertion with wrong browser/credential context %j", extra => {
    const a = approval(); expect(() => verifyWalletDeploymentProof(enrollment, a, assertion(a, extra), now + 3)).toThrow();
  });
  it("rejects proof from an older deployment approval", () => {
    const a = approval(), b = approval();
    expect(() => verifyWalletDeploymentProof(enrollment, b, assertion(a), now + 3)).toThrow();
  });
  it("verifies against a bounded context snapshot before reading caller-owned proof bytes", () => {
    const a = approval(), record = structuredClone(enrollment), proof = assertion(a);
    const expected = verifyWalletDeploymentProof(record, a, proof, now + 3);
    const callerProof = { ...proof, get credentialId() {
      record.candidate!.publicKey.x = `0x${"ab".repeat(32)}`;
      return proof.credentialId;
    } };
    expect(verifyWalletDeploymentProof(record, a, callerProof, now + 3)).toEqual(expected);
  });
});

describe("immutable direct SafeFactory EIP1559 template", () => {
  it("accepts the exact canonical signed bytes and keeps execution costs separate from total Base fees", async () => {
    const p = prepared(), rawTransaction = await relay.signTransaction(p.transaction);
    const result = await validateSignedWalletDeployment({ ...p, enrollment, rawTransaction, policy });
    expect(result).toMatchObject({ rawTransaction, hash: keccak256(rawTransaction), nonce: fees.nonce,
      maximumExecutionCost: (BigInt(fees.gas) * BigInt(fees.maxFeePerGas)).toString() });
    expect(p.template.transaction).toMatchObject({ ...enrollment.creation!.transaction, value: "0", type: "eip1559", accessList: [] });
  });
  it.each([
    ["nonce", { nonce: "01" }], ["unsafe nonce", { nonce: "9007199254740992" }], ["zero gas", { gas: "0" }],
    ["gas policy", { gas: "2000001" }], ["zero fee", { maxFeePerGas: "0" }],
    ["fee policy", { maxFeePerGas: "10000000001" }], ["zero priority", { maxPriorityFeePerGas: "0" }],
    ["priority greater than cap", { maxPriorityFeePerGas: "2000000001" }], ["excess digits", { gas: "1".repeat(79) }],
    ["extra caller field", { value: "1" }],
  ])("rejects invalid frozen fees: %s", (_, changes) => {
    expect(() => prepareWalletDeploymentTemplate(enrollment, approval(), { ...fees, ...changes }, policy)).toThrow();
  });
  it.each([
    { allowedChainIds: [1] }, { maximumRawBytes: 0 }, { maximumGas: 0n },
    { maximumTransactionCost: 1n },
  ])("rejects unavailable or exceeded policy %#", changes => {
    expect(() => prepareWalletDeploymentTemplate(enrollment, approval(), fees, { ...policy, ...changes })).toThrow();
  });
  it.each([
    ["nonce", { nonce: 2 }], ["gas", { gas: 1_500_001n }], ["fee cap", { maxFeePerGas: 2_000_000_001n }],
    ["priority", { maxPriorityFeePerGas: 1_000_001n }], ["value", { value: 1n }], ["chain", { chainId: 1 }],
    ["destination", { to: relay.address }], ["calldata", { data: "0x1234" as Hex }],
    ["access list", { accessList: [{ address: relay.address, storageKeys: [] }] }],
  ] as const)("rejects correctly signed changed transaction %s", async (_, changes) => {
    const p = prepared(), rawTransaction = await relay.signTransaction({ ...p.transaction, ...changes });
    await expect(validateSignedWalletDeployment({ ...p, enrollment, rawTransaction, policy })).rejects.toThrow();
  });
  it("rejects a different signer", async () => {
    const p = prepared(), rawTransaction = await enrollmentBackupAccount.signTransaction(p.transaction);
    await expect(validateSignedWalletDeployment({ ...p, enrollment, rawTransaction, policy })).rejects.toThrow();
  });
  it.each(["legacy", "eip2930"] as const)("rejects equivalent %s transaction", async type => {
    const p = prepared();
    const rawTransaction = await relay.signTransaction({ type, chainId: 8453, nonce: 1, to: p.transaction.to,
      data: p.transaction.data, value: 0n, gas: p.transaction.gas, gasPrice: 2_000_000_000n });
    await expect(validateSignedWalletDeployment({ ...p, enrollment, rawTransaction, policy })).rejects.toThrow();
  });
  it.each([
    [1, "0x0001", "leading-zero nonce"], [6, "0x00", "noncanonical zero value"], [8, "0x", "string access list"],
  ] as const)("rejects malformed RLP field %s %s (%s) even though recovery accepts it", async (index, value, _reason) => {
    const p = prepared(), raw = await relay.signTransaction(p.transaction);
    const fields = fromRlp(`0x${raw.slice(4)}`, "hex") as (Hex | Hex[])[];
    fields[index] = value;
    const rawTransaction = concatHex(["0x02", toRlp(fields)]);
    await expect(validateSignedWalletDeployment({ ...p, enrollment, rawTransaction, policy })).rejects.toThrow();
  });
  it("rejects a tampered template even when its changed transaction is signed", async () => {
    const p = prepared(); p.template.transaction.to = relay.address;
    const rawTransaction = await relay.signTransaction({ ...p.transaction, to: relay.address });
    await expect(validateSignedWalletDeployment({ ...p, enrollment, rawTransaction, policy })).rejects.toThrow();
  });
  it("rejects template swap between fresh approvals for the same wallet", async () => {
    const p = prepared(), rawTransaction = await relay.signTransaction(p.transaction);
    await expect(validateSignedWalletDeployment({ ...p, approval: approval(), enrollment, rawTransaction, policy })).rejects.toThrow();
  });
  it("rejects excessive raw bytes before parsing", async () => {
    const p = prepared(), rawTransaction = `0x02${"ff".repeat(policy.maximumRawBytes)}` as Hex;
    await expect(validateSignedWalletDeployment({ ...p, enrollment, rawTransaction, policy })).rejects.toThrow();
  });
});
