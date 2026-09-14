// Genuine W3 enrollment and signed setup consent, with explicitly synthetic canonical readiness.
// This DB-boundary fixture does not assert live-chain provenance or consumer browser behavior.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { expect } from "vitest";
import { hashTypedData, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletEnrollmentIntent, walletEnrollmentDocument, type WalletEnrollment } from "../../src/rest/wallet/enrollment.js";
import { PostgresWalletEnrollmentStore } from "../../src/rest/wallet/enrollmentPostgres.js";
import { createWalletAuthorityIdentity, walletAuthorityContextDigest, walletAuthorityExpectedAnchor,
  type WalletAuthorityContext, type WalletAuthorityObservation } from "../../src/rest/wallet/authority.js";
import { PostgresWalletAuthorityStore } from "../../src/rest/wallet/authorityPostgres.js";
import { bindSmartAccountInTransaction } from "../../src/rest/smartAccounts/postgres.js";
import { fingerprint } from "../../src/rest/smartAccounts/service.js";
import { passkeyOnboardingDocument, passkeyOnboardingProofDocument, passkeyOnboardingSigningPayload,
  validatePasskeyOnboardingInput, verifyPasskeyOnboardingSignatures, type PasskeyOnboardingInput } from "../../src/rest/smartAccounts/passkeyOnboarding.js";
import { encodeSafe7579MessageSignature } from "../../src/rest/smartAccounts/passkeySignatures.js";
import type { SmartAccountBinding, SmartAccountState } from "../../src/rest/smartAccounts/types.js";
import { createRegistration, enrollmentBackupAccount, enrollmentManifest, signBackupProof, signGet } from "./wallet-enrollment-crypto.js";
import { PostgresWalletLoginStore } from "../../src/rest/wallet/loginPostgres.js";

export const walletLoginFixtureOrigin = "https://wallet.juicebox.center";
export const walletLoginFixtureRpId = "wallet.juicebox.center";
export const walletLoginTestMigrations = ["004_rest_accounts.sql", "007_rest_smart_accounts.sql", "012_rest_smart_account_onboarding.sql",
  "013_rest_wallet_ceremonies.sql", "014_rest_passkey_onboarding.sql", "015_rest_wallet_enrollment.sql",
  "017_rest_wallet_policy.sql", "019_rest_wallet_app_grants.sql", "020_rest_wallet_authority.sql", "022_wallet_login.sql"];
export async function createWalletLoginSetup(pool: Pool, options: { lifetimeMs?: number; origin?: string; rpId?: string } = {}) {
  const audience = options.origin ?? walletLoginFixtureOrigin;
  const credentialRpId = options.rpId ?? new URL(audience).hostname;
  const browser = privateKeyToAccount(`0x${"22".repeat(32)}`);
  const enrollments = new PostgresWalletEnrollmentStore(pool), authority = new PostgresWalletAuthorityStore(pool);
  const word = (byte: string): Hex => `0x${byte.repeat(32)}`;
  async function databaseNow(): Promise<number> {
    return Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now")).rows[0].now);
  }
  async function verifiedEnrollment() {
    const initial = await enrollments.begin(createWalletEnrollmentIntent({ manifest: enrollmentManifest,
      rpId: credentialRpId, origin: audience, recoveryOwner: enrollmentBackupAccount.address,
      expiresAt: await databaseNow() + 120000 }));
    const credential = createRegistration({ challenge: `0x${Buffer.from(initial.intent.registration.challenge, "base64url").toString("hex")}`,
      rpId: initial.intent.rpId, origin: initial.intent.origin, userHandle: initial.intent.userHandle });
    const pending = await enrollments.acceptRegistration(initial.intent.id, credential.response), document = walletEnrollmentDocument(pending);
    const assertion = signGet({ ...credential, challenge: hashTypedData(document), rpId: pending.intent.rpId, origin: pending.intent.origin });
    const { record } = await enrollments.finalize(pending.intent.id, { assertion, backupSignature: await signBackupProof(document) });
    return { record, credential };
  }
  /** Explicitly synthetic observer state. The genuine setup signatures below prove consent to
   * this fixture context, not deployment or canonical Base provenance. */
  async function syntheticState(record: WalletEnrollment, now: number): Promise<SmartAccountState> {
    const creation = record.creation!, manifest = record.intent.manifest;
    const artifact = JSON.parse(await readFile(new URL("../../src/rest/smartAccounts/stack/passkey/artifacts/SafeWebAuthnSignerProxy.json", import.meta.url), "utf8")) as {
      deployedBytecode: Hex; immutableReferences: Record<string, { start: number; length: number }[]> };
    const runtime = Buffer.from(artifact.deployedBytecode.slice(2), "hex"), values: Record<string, bigint> = {
      "226": BigInt(manifest.ownerProfile!.signerSingleton.address), "229": BigInt(record.candidate!.publicKey.x),
      "232": BigInt(record.candidate!.publicKey.y), "236": BigInt(creation.bootstrap.verifiers) };
    for (const [key, references] of Object.entries(artifact.immutableReferences))
      for (const reference of references) {
        if (values[key] === undefined || reference.length !== 32) throw new Error("Unexpected signer fixture immutable layout");
        Buffer.from(toHex(values[key]!, { size: 32 }).slice(2), "hex").copy(runtime, reference.start);
      }
    return { chainId: 8453, address: creation.address, manifestId: manifest.id, manifestRevision: manifest.revision,
      owners: [creation.bootstrap.signerAddress, record.intent.recoveryOwner], threshold: 1, safeNonce: "0", stateHash: word("31"),
      evidence: { chainId: 8453, blockNumber: "100", blockHash: word("10"), timestamp: String(Math.floor(now / 1000)), source: "onchain" },
      codeHashes: [], executionVerified: false, moduleConfigurationVerified: true,
      modules: { stateHash: word("32"), complete: true, arbitrarySigningDisabled: true, wildcardExecutionDisabled: true,
        details: { sessions: { permissionIds: [] }, provenance: { initializerHash: creation.initializerHash },
          sessionAdministration: { epoch: "0", hash: word("33") } } },
      ownerProfile: { version: "center-passkey-v1", signer: { address: creation.bootstrap.signerAddress, kind: "contract",
        x: record.candidate!.publicKey.x, y: record.candidate!.publicKey.y, verifiers: creation.bootstrap.verifiers,
        runtimeCodeHash: keccak256(`0x${runtime.toString("hex")}`) },
        recoveryOwner: { address: record.intent.recoveryOwner, kind: "ecdsa" } } };
  }
  async function authorizedFixture() {
    const value = await verifiedEnrollment(), now = await databaseNow(), current = Math.floor(now / 1000);
    const state = await syntheticState(value.record, now), accountId = value.record.receipt!.accountId;
    const input: PasskeyOnboardingInput = { profile: "center-passkey-v1", address: state.address, manifestId: state.manifestId,
      nonce: keccak256(toHex(randomUUID())), issuedAt: current, expiresAt: current + 300,
      grant: { id: randomUUID(), botAddress: browser.address, scopes: ["read", "plan", "relay"], expiresAt: current + 3600, label: "Explicit test setup" } };
    validatePasskeyOnboardingInput(input, current);
    const document = passkeyOnboardingDocument(audience, input, state), payload = passkeyOnboardingSigningPayload(document);
    const signature = encodeSafe7579MessageSignature([{ kind: "ecdsa", owner: enrollmentBackupAccount.address,
      signature: await enrollmentBackupAccount.sign({ hash: payload.digest }) }]);
    const signers = await verifyPasskeyOnboardingSignatures(document, state, signature,
      await browser.signTypedData(passkeyOnboardingProofDocument(document)), async () => { throw new Error("No contract provider exists in PG fixture"); });
    expect(signers).toEqual([enrollmentBackupAccount.address]);
    const binding: SmartAccountBinding = { id: fingerprint({ ownerAccountId: accountId, wallet: state.address, chainId: state.chainId }),
      ownerAccountId: accountId, ownerAddress: state.address, wallet: { chainId: 8453, address: state.address }, manifestId: state.manifestId,
      authorization: { digest: hashTypedData(document), nonce: input.nonce, expiresAt: input.expiresAt,
        method: "safe-passkey-owner-threshold-and-api-grant", setup: { manifestRevision: state.manifestRevision,
          initializerHash: value.record.creation!.initializerHash, issuedAt: input.issuedAt, grantId: input.grant.id,
          botAddress: input.grant.botAddress, scopes: [...input.grant.scopes], grantExpiresAt: input.grant.expiresAt, label: input.grant.label } }, state };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO rest_accounts(id,owner_address,authority_chain_id,display_name,bio,avatar_uri,created_at,updated_at)
        VALUES($1,$2,8453,'','',NULL,$3,$3)`, [accountId, state.address.toLowerCase(), current]);
      await client.query("SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE", [accountId]);
      await bindSmartAccountInTransaction(client, binding, current); await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    return { ...value, state, accountId, binding };
  }
  /** Trusted producer seam exercised with synthetic evidence only. No caller-provided hash is
   * treated as real canonical proof; the configured producer has separate EVM qualification. */
  async function canonicalObservation(context: WalletAuthorityContext, changes: {
    lifetimeMs?: number; blockNumber?: string; blockHash?: Hex; stateHash?: Hex;
    sessionAdministration?: { epoch: string; hash: Hex }; eligibility?: "matched" | "changed";
  } = {}): Promise<WalletAuthorityObservation> {
    const observedAtMs = await databaseNow(), expected = walletAuthorityExpectedAnchor(context);
    const blockNumber = changes.blockNumber ?? (BigInt(context.prior?.highestObservedBlock ?? "99") + 1n).toString();
    const head = { chainId: 8453, blockNumber, blockHash: changes.blockHash ?? keccak256(toHex(`canonical-test-block-${blockNumber}`)),
      timestamp: String(Math.floor(observedAtMs / 1000)), source: "onchain" as const };
    return { version: "center-wallet-authority-observation-v1", accountId: context.accountId,
      contextDigest: walletAuthorityContextDigest(context), observedAtMs,
      validUntilMs: changes.eligibility === "changed" ? null : observedAtMs + (changes.lifetimeMs ?? 30000), head,
      priorAnchor: { status: expected ? "same" : "none", expected, observed: expected ? structuredClone(expected) : null },
      identity: createWalletAuthorityIdentity(context, { stateHash: changes.stateHash ?? context.binding.state.stateHash,
        sessionAdministration: changes.sessionAdministration ?? { epoch: "0", hash: word("33") }, creationTransaction: word("34") }),
      eligibility: changes.eligibility ?? "matched", reason: changes.eligibility === "changed" ? "owner-profile-changed" : null };
  }
  async function initialized(lifetimeMs: number) {
    const value = await authorizedFixture(), context = await authority.loadContext(value.accountId);
    const observation = await canonicalObservation(context, { lifetimeMs });
    await authority.reconcile(context, observation);
    return { ...value, context, observation };
  }
  return initialized(options.lifetimeMs ?? 30_000);
}

export async function completeWalletLoginFixture(pool: Pool, options: { lifetimeMs?: number; origin?: string; rpId?: string } = {}) {
  const value = await createWalletLoginSetup(pool, options);
  const origin = options.origin ?? walletLoginFixtureOrigin, rpId = options.rpId ?? new URL(origin).hostname;
  const store = new PostgresWalletLoginStore(pool, { rpId, origin });
  const begun = await store.begin();
  const input = { loginId: begun.login.id, flowToken: begun.flowToken,
    assertion: signGet({ ...value.credential, challenge: begun.login.challenge,
      rpId, origin }) };
  return { ...value, ...begun, input, ...await store.complete(input) };
}
