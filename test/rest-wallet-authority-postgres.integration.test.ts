import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashTypedData, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletEnrollmentIntent, enrollmentDigest, walletEnrollmentDocument, type WalletEnrollment } from "../src/rest/wallet/enrollment.js";
import { PostgresWalletEnrollmentStore } from "../src/rest/wallet/enrollmentPostgres.js";
import { createWalletAuthorityIdentity, walletAuthorityContextDigest, walletAuthorityExpectedAnchor,
  type WalletAuthorityContext, type WalletAuthorityObservation, type WalletAuthoritySnapshot } from "../src/rest/wallet/authority.js";
import { PostgresWalletAuthorityStore } from "../src/rest/wallet/authorityPostgres.js";
import { PostgresWalletAppGrantStore } from "../src/rest/wallet/appGrantsPostgres.js";
import { bindSmartAccountInTransaction } from "../src/rest/smartAccounts/postgres.js";
import { fingerprint } from "../src/rest/smartAccounts/service.js";
import { passkeyOnboardingDocument, passkeyOnboardingProofDocument, passkeyOnboardingSigningPayload,
  validatePasskeyOnboardingInput, verifyPasskeyOnboardingSignatures, type PasskeyOnboardingInput } from "../src/rest/smartAccounts/passkeyOnboarding.js";
import { encodeSafe7579MessageSignature } from "../src/rest/smartAccounts/passkeySignatures.js";
import type { SmartAccountBinding, SmartAccountState } from "../src/rest/smartAccounts/types.js";
import { createRegistration, enrollmentBackupAccount, enrollmentManifest, signBackupProof, signGet } from "./fixtures/wallet-enrollment-crypto.js";
import { parseWalletRegistration } from "../src/rest/wallet/registration.js";
import { predictPasskeySignerAddress } from "../src/rest/smartAccounts/passkeyCreation.js";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `rest_wallet_authority_${randomUUID().replaceAll("-", "")}`;
const audience = "https://wallet.juicebox.center";
// Public deterministic fixture key. These tests never install a production signer or provider.
const browser = privateKeyToAccount(`0x${"22".repeat(32)}`);
let admin: Pool, pool: Pool, enrollments: PostgresWalletEnrollmentStore, store: PostgresWalletAuthorityStore;
let migratedEpochOnly: { authority_epoch: string; session_epoch: string; revision: string; snapshot: null; ready_until_ms: null };
const children = new Set<ChildProcess>();
const word = (byte: string): Hex => `0x${byte.repeat(32)}`;

async function databaseNow(): Promise<number> {
  return Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now")).rows[0].now);
}
async function verifiedEnrollment() {
  const initial = await enrollments.begin(createWalletEnrollmentIntent({ manifest: enrollmentManifest,
    rpId: "wallet.juicebox.center", origin: audience, recoveryOwner: enrollmentBackupAccount.address,
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
  const artifact = JSON.parse(await readFile(new URL("../src/rest/smartAccounts/stack/passkey/artifacts/SafeWebAuthnSignerProxy.json", import.meta.url), "utf8")) as {
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
async function replaceSetupAuthorization(value: Awaited<ReturnType<typeof authorizedFixture>>) {
  const issuedAt = Math.floor(await databaseNow() / 1000), input: PasskeyOnboardingInput = {
    profile: "center-passkey-v1", address: value.state.address, manifestId: value.state.manifestId,
    nonce: keccak256(toHex(randomUUID())), issuedAt, expiresAt: issuedAt + 300,
    grant: { id: randomUUID(), botAddress: browser.address, scopes: ["read", "plan", "relay"], expiresAt: issuedAt + 3600, label: "Replacement test consent" } };
  validatePasskeyOnboardingInput(input, issuedAt);
  const document = passkeyOnboardingDocument(audience, input, value.state), payload = passkeyOnboardingSigningPayload(document);
  const signature = encodeSafe7579MessageSignature([{ kind: "ecdsa", owner: enrollmentBackupAccount.address,
    signature: await enrollmentBackupAccount.sign({ hash: payload.digest }) }]);
  expect(await verifyPasskeyOnboardingSignatures(document, value.state, signature,
    await browser.signTypedData(passkeyOnboardingProofDocument(document)), async () => { throw new Error("No contract provider exists in PG fixture"); }))
    .toEqual([enrollmentBackupAccount.address]);
  const replacement: SmartAccountBinding = { ...value.binding, authorization: { ...value.binding.authorization,
    digest: hashTypedData(document), nonce: input.nonce, expiresAt: input.expiresAt,
    setup: { ...value.binding.authorization.setup!, issuedAt, grantId: input.grant.id,
      grantExpiresAt: input.grant.expiresAt, label: input.grant.label } } };
  const client = await pool.connect();
  try {
    await client.query("BEGIN"); await client.query("SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE", [value.accountId]);
    await bindSmartAccountInTransaction(client, replacement, issuedAt); await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  return replacement;
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
async function unknownObservation(context: WalletAuthorityContext): Promise<WalletAuthorityObservation> {
  const expected = walletAuthorityExpectedAnchor(context);
  return { version: "center-wallet-authority-observation-v1", accountId: context.accountId,
    contextDigest: walletAuthorityContextDigest(context), observedAtMs: await databaseNow(), validUntilMs: null, head: null,
    priorAnchor: { status: expected ? "unavailable" : "none", expected, observed: null }, identity: null, eligibility: null, reason: "rpc-unavailable" };
}
async function conflictObservation(context: WalletAuthorityContext): Promise<WalletAuthorityObservation> {
  const observation = await canonicalObservation(context), expected = walletAuthorityExpectedAnchor(context);
  if (!expected) throw new Error("A conflict fixture needs an accepted anchor");
  return { ...observation, priorAnchor: { status: "replaced", expected,
    observed: { ...expected, blockHash: keccak256(toHex(`replacement-test-block-${expected.blockHash}`)) } },
    identity: null, eligibility: null, validUntilMs: null, reason: "canonical-anchor-replaced" };
}
async function initialized() {
  const value = await authorizedFixture(), context = await store.loadContext(value.accountId);
  const observation = await canonicalObservation(context), result = await store.reconcile(context, observation);
  return { ...value, context, observation, ...result };
}
async function waitForLock(waiter: number, blocker: number, table: string) {
  const deadline = Date.now() + 3000;
  do {
    const row = (await pool.query("SELECT wait_event_type,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1", [waiter])).rows[0];
    if (row?.wait_event_type === "Lock" && row.query.includes(table) && row.blockers.includes(blocker)) return;
    await pool.query("SELECT pg_sleep(0.01)");
  } while (Date.now() < deadline);
  throw new Error(`Authority worker did not reach a real ${table} lock wait`);
}
async function untilDatabaseTime(deadline: number) {
  await pool.query("SELECT pg_sleep(GREATEST(0,($1-extract(epoch FROM clock_timestamp())*1000)/1000)+0.03)", [deadline]);
}
function message(child: ChildProcess, kind: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Authority child did not emit ${kind}`)), 10000);
    const received = (value: any) => { if (value?.kind === kind) finish(undefined, value); };
    const exited = () => finish(new Error(`Authority child exited before ${kind}`));
    function finish(error?: Error, value?: unknown) {
      clearTimeout(timer); child.off("message", received); child.off("exit", exited);
      if (error) reject(error); else resolve(value);
    }
    child.on("message", received); child.on("exit", exited);
  });
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await exited; children.delete(child);
}
async function worker() {
  const child = fork(fileURLToPath(new URL("./fixtures/wallet-authority-process.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"], env: { ...process.env, WALLET_AUTHORITY_TEST_SCHEMA: schema }, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.add(child); child.stderr?.on("data", () => {});
  const ready = await message(child, "ready");
  return { child, backendPid: Number(ready.backendPid), request: async (body: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(`http://127.0.0.1:${ready.port}`, { method: "POST", body: JSON.stringify(body),
      headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.json() };
  } };
}

suite("PostgreSQL canonical wallet authority with genuine enrollment and explicit setup consent", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 });
    for (const name of ["004_rest_accounts.sql", "007_rest_smart_accounts.sql", "012_rest_smart_account_onboarding.sql",
      "013_rest_wallet_ceremonies.sql", "014_rest_passkey_onboarding.sql", "042_wallet_binding_consent.sql", "015_rest_wallet_enrollment.sql", "041_wallet_passkey_name.sql", "043_wallet_networks.sql", "044_wallet_devices.sql",
      "017_rest_wallet_policy.sql", "019_rest_wallet_app_grants.sql"])
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), "utf8"));
    enrollments = new PostgresWalletEnrollmentStore(pool);
    const legacy = await authorizedFixture();
    await pool.query("INSERT INTO rest_wallet_authority(account_id,authority_epoch,session_epoch,updated_at) VALUES($1,$2,$3,$4)",
      [legacy.accountId, "9007199254740993", "9007199254741007", Math.floor(await databaseNow() / 1000)]);
    for (const name of ["020_rest_wallet_authority.sql", "039_wallet_authority_window.sql"])
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), "utf8"));
    migratedEpochOnly = (await pool.query("SELECT authority_epoch,session_epoch,revision,snapshot,ready_until_ms FROM rest_wallet_authority WHERE account_id=$1", [legacy.accountId])).rows[0];
    store = new PostgresWalletAuthorityStore(pool);
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE rest_wallet_app_grants,rest_wallet_authority,rest_grant_ids,rest_bot_grants,rest_request_nonces,
      rest_smart_account_binding_nonces,rest_smart_account_bindings,rest_accounts,
      rest_wallet_credentials,rest_wallet_enrollments,rest_wallet_ceremonies CASCADE`);
  });
  afterEach(async () => { await Promise.all([...children].map(kill)); });
  afterAll(async () => {
    await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it("loads exact genuine enrollment, live setup binding and current mapping without initializing authority", async () => {
    const value = await authorizedFixture(), context = await store.loadContext(value.accountId);
    expect(context).toMatchObject({ version: "center-wallet-authority-context-v1", accountId: value.accountId,
      enrollment: value.record, binding: value.binding, prior: null, credential: { accountId: value.accountId,
        enrollmentId: value.record.intent.id, credentialId: value.credential.credentialId, rpId: value.record.intent.rpId,
        userHandle: value.credential.userHandle, publicKey: value.credential.publicKey, supersededAtMs: null } });
    expect(await store.get(value.accountId)).toBeNull();
    expect((await pool.query(`SELECT (SELECT count(*)::int FROM rest_wallet_authority) AS authority,
      (SELECT count(*)::int FROM rest_bot_grants) AS bots,(SELECT count(*)::int FROM rest_wallet_app_grants) AS apps`)).rows[0])
      .toEqual({ authority: 0, bots: 0, apps: 0 });
  });

  it("loads a device passkey beside the primary once the account is rebound with the device owner", async () => {
    const value = await authorizedFixture(), now = await databaseNow();
    // A second registration under the same account and user handle is a device: its own signer.
    const device = createRegistration({ challenge: word("55"), rpId: value.record.intent.rpId, origin: value.record.intent.origin, userHandle: value.record.intent.userHandle });
    const candidate = parseWalletRegistration(device.response, { challenge: word("55"), rpId: value.record.intent.rpId, origin: value.record.intent.origin, userHandle: value.record.intent.userHandle });
    const signerAddress = predictPasskeySignerAddress({ manifest: value.record.intent.manifest, publicKey: candidate.publicKey }).toLowerCase() as Hex;
    const receipt = { version: "center-wallet-device-v1", id: randomUUID(), accountId: value.accountId, enrollmentId: value.record.intent.id,
      rpId: value.record.intent.rpId, origin: value.record.intent.origin, credential: candidate, signerAddress, approvalDigest: word("56"),
      transactionHash: word("57"), anchor: { chainId: 8453, blockNumber: "101", blockHash: word("11"), timestamp: String(Math.floor(now / 1000)), source: "onchain" },
      bindingDigest: word("58"), verifiedAtMs: now, acceptedAtMs: now };
    await pool.query(`INSERT INTO rest_wallet_credentials(rp_id,credential_id,enrollment_id,account_id,user_handle,public_key_x,public_key_y,backup_eligible,verified_at,device_receipt)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [value.record.intent.rpId, candidate.credentialId, value.record.intent.id, value.accountId, candidate.userHandle,
      candidate.publicKey.x, candidate.publicKey.y, candidate.backupEligible, now, JSON.stringify(receipt)]);
    // A second primary is still refused; a second device is not.
    await expect(pool.query(`INSERT INTO rest_wallet_credentials(rp_id,credential_id,enrollment_id,account_id,user_handle,public_key_x,public_key_y,backup_eligible,verified_at)
      VALUES($1,'another',$2,$3,$4,$5,$6,true,$7)`, [value.record.intent.rpId, value.record.intent.id, value.accountId, candidate.userHandle, word("01"), word("02"), now])).rejects.toThrow();
    // Until the account is rebound with the device as an owner, the context is not a valid authority.
    await expect(store.loadContext(value.accountId)).rejects.toMatchObject({ code: "WALLET_AUTHORITY_INVALID" });
    const state: SmartAccountState = { ...value.state, owners: [signerAddress, ...value.state.owners], stateHash: word("34"),
      ownerProfile: { ...value.state.ownerProfile!, devices: [{ address: signerAddress, kind: "contract", x: candidate.publicKey.x, y: candidate.publicKey.y,
        verifiers: value.state.ownerProfile!.signer.verifiers, runtimeCodeHash: word("35") }] } };
    const binding: SmartAccountBinding = { ...value.binding, authorization: { digest: word("58"), nonce: keccak256(toHex(randomUUID())), expiresAt: Math.floor(now / 1000) + 300,
      method: "center-wallet-passkey-creation-v1" }, state };
    const client = await pool.connect();
    try {
      await client.query("BEGIN"); await client.query("SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE", [value.accountId]);
      await bindSmartAccountInTransaction(client, binding, Math.floor(now / 1000)); await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    const context = await store.loadContext(value.accountId);
    expect(context.credential.credentialId).toBe(value.credential.credentialId);
    expect(context.devices!.map(entry => entry.credentialId)).toEqual([candidate.credentialId]);
    expect(context.devices![0]!.device.signerAddress).toBe(signerAddress);
    // The identity commits to the device set.
    const identity = (state: SmartAccountState) => createWalletAuthorityIdentity({ ...context, binding: { ...context.binding, state } },
      { stateHash: state.stateHash, sessionAdministration: { epoch: "0", hash: word("33") }, creationTransaction: word("36") });
    const { devices: _devices, ...withoutDevices } = context;
    expect(identity(state).credentialCommitment).not.toBe(createWalletAuthorityIdentity({ ...withoutDevices, binding: value.binding },
      { stateHash: value.state.stateHash, sessionAdministration: { epoch: "0", hash: word("33") }, creationTransaction: word("36") }).credentialCommitment);
  });

  it("initializes absent authority at epochs one and one from a complete matching observation", async () => {
    const value = await initialized();
    expect(value.replayed).toBe(false);
    expect(value.snapshot).toMatchObject({ version: "center-wallet-authority-snapshot-v1", accountId: value.accountId,
      revision: "1", authorityEpoch: "1", sessionEpoch: "1", readiness: "verified", bootstrapRequired: false,
      identity: value.observation.identity, historicalVerifiedIdentity: value.observation.identity,
      acceptedAnchor: value.observation.head, highestObservedBlock: "100", activeFence: null, lastClosedFence: null,
      latestObservation: value.observation, validUntilMs: value.observation.validUntilMs });
    expect(value.snapshot.updatedAtMs).toBeGreaterThanOrEqual(value.observation.observedAtMs);
    expect(await store.get(value.accountId)).toEqual(value.snapshot);
    expect(await store.reconcile(value.context, value.observation)).toEqual({ snapshot: value.snapshot, replayed: true });
  });

  it("initializes exactly once across two actual one-connection processes", async () => {
    const value = await authorizedFixture(), context = await store.loadContext(value.accountId);
    const [a, b] = await Promise.all([worker(), worker()]), observation = await canonicalObservation(context);
    const request = { action: "reconcile", context, observation };
    const results = await Promise.all([a.request(request), b.request(request)]);
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect(results.map(result => result.body.replayed).sort()).toEqual([false, true]);
    expect(results[0].body.snapshot).toEqual(results[1].body.snapshot);
    expect(results[0].body.snapshot).toMatchObject({ revision: "1", authorityEpoch: "1", sessionEpoch: "1" });
    expect((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_authority")).rows[0].count).toBe(1);
  });

  it("migrates epoch-only rows unready and bootstraps both large epochs exactly once across processes", async () => {
    expect(migratedEpochOnly).toEqual({ authority_epoch: "9007199254740993", session_epoch: "9007199254741007",
      revision: "0", snapshot: null, ready_until_ms: null });
    const value = await authorizedFixture();
    await pool.query("INSERT INTO rest_wallet_authority(account_id,authority_epoch,session_epoch,updated_at) VALUES($1,$2,$3,$4)",
      [value.accountId, migratedEpochOnly.authority_epoch, migratedEpochOnly.session_epoch, Math.floor(await databaseNow() / 1000)]);
    const context = await store.loadContext(value.accountId);
    expect(context.prior).toMatchObject({ authorityEpoch: "9007199254740993", sessionEpoch: "9007199254741007",
      revision: "0", bootstrapRequired: true, readiness: "unknown", identity: null, validUntilMs: null });
    const [a, b] = await Promise.all([worker(), worker()]), observation = await canonicalObservation(context);
    const results = await Promise.all([a.request({ action: "reconcile", context, observation }), b.request({ action: "reconcile", context, observation })]);
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect(results.map(result => result.body.replayed).sort()).toEqual([false, true]);
    expect(results[0].body.snapshot).toEqual(results[1].body.snapshot);
    expect(results[0].body.snapshot).toMatchObject({ authorityEpoch: "9007199254740994", sessionEpoch: "9007199254741008",
      revision: "1", bootstrapRequired: false, readiness: "verified" });
  });

  it("rejects unknown initialization and overflow without creating or resetting epochs", async () => {
    const value = await authorizedFixture(), context = await store.loadContext(value.accountId);
    await expect(store.reconcile(context, await unknownObservation(context))).rejects.toMatchObject({ status: 409 });
    expect(await store.get(value.accountId)).toBeNull();
    await pool.query("INSERT INTO rest_wallet_authority(account_id,authority_epoch,session_epoch,updated_at) VALUES($1,$2,$3,$4)",
      [value.accountId, "9223372036854775807", "7", Math.floor(await databaseNow() / 1000)]);
    const bootstrap = await store.loadContext(value.accountId);
    await expect(store.reconcile(bootstrap, await unknownObservation(bootstrap))).rejects.toMatchObject({ status: 409 });
    await expect(store.reconcile(bootstrap, await canonicalObservation(bootstrap))).rejects.toMatchObject({ status: 409 });
    expect(await store.get(value.accountId)).toEqual(bootstrap.prior);
    expect((await pool.query("SELECT snapshot,ready_until_ms FROM rest_wallet_authority WHERE account_id=$1", [value.accountId])).rows[0])
      .toEqual({ snapshot: null, ready_until_ms: null });
  });

  it("refreshes unchanged identity without epoch churn and commits session-administration ABA once", async () => {
    const value = await initialized();
    let context = await store.loadContext(value.accountId), observation = await canonicalObservation(context);
    let result = await store.reconcile(context, observation);
    expect(result.snapshot).toMatchObject({ authorityEpoch: "1", sessionEpoch: "1", revision: "2", readiness: "verified" });
    expect(result.snapshot.identity).toEqual(value.snapshot.identity);
    context = await store.loadContext(value.accountId);
    observation = await canonicalObservation(context, { sessionAdministration: { epoch: "2", hash: word("44") } });
    result = await store.reconcile(context, observation);
    expect(result.snapshot.identity?.stateHash).toBe(value.snapshot.identity!.stateHash);
    expect(result.snapshot).toMatchObject({ authorityEpoch: "2", sessionEpoch: "2", revision: "3", readiness: "verified" });
    expect(await store.reconcile(context, observation)).toEqual({ snapshot: result.snapshot, replayed: true });
    const fresh = await store.loadContext(value.accountId);
    expect((await store.reconcile(fresh, await canonicalObservation(fresh, { sessionAdministration: { epoch: "2", hash: word("44") } }))).snapshot)
      .toMatchObject({ authorityEpoch: "2", sessionEpoch: "2", revision: "4" });
  });

  it("records proven changed identity once while retaining the historical verified identity", async () => {
    const value = await initialized(), context = await store.loadContext(value.accountId);
    const changed = await canonicalObservation(context, { stateHash: word("45"), eligibility: "changed" });
    const first = await store.reconcile(context, changed);
    expect(first.snapshot).toMatchObject({ authorityEpoch: "2", sessionEpoch: "2", readiness: "changed", validUntilMs: null,
      identity: changed.identity, historicalVerifiedIdentity: value.snapshot.identity });
    const fresh = await store.loadContext(value.accountId);
    expect((await store.reconcile(fresh, await canonicalObservation(fresh, { stateHash: word("45"), eligibility: "changed" }))).snapshot)
      .toMatchObject({ authorityEpoch: "2", sessionEpoch: "2", readiness: "changed", validUntilMs: null });
  });

  it("removes readiness for ordinary uncertainty and recovers the same identity under unchanged epochs", async () => {
    const value = await initialized();
    let context = await store.loadContext(value.accountId);
    const unknown = await store.reconcile(context, await unknownObservation(context));
    expect(unknown.snapshot).toMatchObject({ authorityEpoch: "1", sessionEpoch: "1", readiness: "unknown", validUntilMs: null,
      identity: value.snapshot.identity, historicalVerifiedIdentity: value.snapshot.identity, activeFence: null });
    context = await store.loadContext(value.accountId);
    expect((await store.reconcile(context, await canonicalObservation(context))).snapshot)
      .toMatchObject({ authorityEpoch: "1", sessionEpoch: "1", readiness: "verified", activeFence: null });
  });

  it("latches a proven conflict without full identity and requires fresh candidate-anchored recovery", async () => {
    const value = await initialized();
    let context = await store.loadContext(value.accountId), observation = await conflictObservation(context);
    const fenced = await store.reconcile(context, observation), trigger = fenced.snapshot.activeFence!;
    expect(fenced.snapshot).toMatchObject({ authorityEpoch: "2", sessionEpoch: "2", readiness: "fenced", validUntilMs: null,
      identity: value.snapshot.identity, activeFence: { abandonedAnchor: value.snapshot.acceptedAnchor, recoveryAnchor: null } });
    context = await store.loadContext(value.accountId);
    const repeated = await store.reconcile(context, await conflictObservation(context));
    expect(repeated.snapshot).toMatchObject({ authorityEpoch: "2", sessionEpoch: "2", readiness: "fenced",
      activeFence: { triggerDigest: trigger.triggerDigest } });
    context = await store.loadContext(value.accountId);
    const uncertain = await store.reconcile(context, await unknownObservation(context));
    expect(uncertain.snapshot).toMatchObject({ authorityEpoch: "2", sessionEpoch: "2", readiness: "fenced", activeFence: trigger });
    context = await store.loadContext(value.accountId); observation = await canonicalObservation(context);
    observation.priorAnchor = { status: "replaced", expected: trigger.abandonedAnchor, observed: trigger.replacementAnchor };
    const candidate = await store.reconcile(context, observation);
    expect(candidate.snapshot).toMatchObject({ authorityEpoch: "2", sessionEpoch: "2", readiness: "fenced",
      activeFence: { triggerDigest: trigger.triggerDigest, recoveryAnchor: observation.head } });
    context = await store.loadContext(value.accountId);
    const recovery = await canonicalObservation(context);
    expect(recovery.priorAnchor).toEqual({ status: "same", expected: observation.head, observed: observation.head });
    const recovered = await store.reconcile(context, recovery);
    expect(recovered.snapshot).toMatchObject({ authorityEpoch: "2", sessionEpoch: "2", readiness: "verified", activeFence: null,
      lastClosedFence: candidate.snapshot.activeFence });
    context = await store.loadContext(value.accountId);
    const later = await store.reconcile(context, await conflictObservation(context));
    expect(later.snapshot).toMatchObject({ authorityEpoch: "3", sessionEpoch: "3", readiness: "fenced",
      lastClosedFence: recovered.snapshot.lastClosedFence });
    expect(later.snapshot.activeFence?.triggerDigest).not.toBe(trigger.triggerDigest);
  });

  it("rejects a stale revision and a lagging complete head instead of restoring readiness", async () => {
    const value = await initialized(), captured = await store.loadContext(value.accountId), stale = await canonicalObservation(captured);
    const current = await store.reconcile(captured, await unknownObservation(captured));
    await expect(store.reconcile(captured, stale)).rejects.toMatchObject({ status: 409 });
    const fresh = await store.loadContext(value.accountId), lower = await canonicalObservation(fresh, { blockNumber: "99" });
    await expect(store.reconcile(fresh, lower)).rejects.toThrow();
    expect(await store.get(value.accountId)).toEqual(current.snapshot);
  });

  it("admits one distinct observation from a captured revision across two processes", async () => {
    const value = await initialized(), context = await store.loadContext(value.accountId), [a, b] = await Promise.all([worker(), worker()]);
    const first = await canonicalObservation(context), second = await unknownObservation(context);
    const results = await Promise.all([a.request({ action: "reconcile", context, observation: first }), b.request({ action: "reconcile", context, observation: second })]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const winner = results.find(result => result.status === 200)!.body.snapshot;
    expect(winner.revision).toBe("2"); expect(await store.get(value.accountId)).toEqual(winner);
  });

  it("rejects substituted context, current credential data and revoked setup without authority effects", async () => {
    const value = await authorizedFixture(), context = await store.loadContext(value.accountId), observation = await canonicalObservation(context);
    const forged = structuredClone(context); forged.binding.authorization.digest = word("77");
    await expect(store.reconcile(forged, observation)).rejects.toThrow();
    const other = await verifiedEnrollment();
    await pool.query("UPDATE rest_wallet_credentials SET public_key_x=$2,public_key_y=$3 WHERE account_id=$1",
      [value.accountId, other.credential.publicKey.x, other.credential.publicKey.y]);
    await expect(store.loadContext(value.accountId)).rejects.toThrow();
    await expect(store.reconcile(context, observation)).rejects.toThrow();
    await pool.query("UPDATE rest_wallet_credentials SET public_key_x=$2,public_key_y=$3 WHERE account_id=$1",
      [value.accountId, value.credential.publicKey.x, value.credential.publicKey.y]);
    await pool.query("UPDATE rest_smart_account_bindings SET revoked_at=$2 WHERE account_id=$1", [value.accountId, Math.floor(await databaseNow() / 1000)]);
    await expect(store.loadContext(value.accountId)).rejects.toThrow();
    await expect(store.reconcile(context, observation)).rejects.toThrow();
    expect(await store.get(value.accountId)).toBeNull();
  });

  it("rejects captured authority after genuinely signed live setup replacement and requires new bound epochs", async () => {
    const value = await initialized(), captured = await store.loadContext(value.accountId), stale = await canonicalObservation(captured);
    const replacement = await replaceSetupAuthorization(value);
    expect(replacement.id).toBe(value.binding.id); expect(replacement.authorization.digest).not.toBe(value.binding.authorization.digest);
    await expect(store.reconcile(captured, stale)).rejects.toMatchObject({ status: 409 });
    await expect(store.reconcile(value.context, value.observation)).rejects.toMatchObject({ status: 409 });
    expect(await store.get(value.accountId)).toEqual(value.snapshot);
    const current = await store.loadContext(value.accountId);
    expect(current.binding).toEqual(replacement);
    expect((await store.reconcile(current, await canonicalObservation(current))).snapshot).toMatchObject({
      authorityEpoch: "2", sessionEpoch: "2", readiness: "verified",
      identity: { bindingId: replacement.id, bindingAuthorizationDigest: replacement.authorization.digest } });
    expect((await pool.query("SELECT count(*)::int AS count FROM rest_bot_grants")).rows[0].count).toBe(0);
  });

  it.each(["after-account", "after-credential"])("rolls back readiness after a real lock wait at %s crosses the original deadline", async stage => {
    const value = await authorizedFixture(), context = await store.loadContext(value.accountId), child = await worker(), blocker = await pool.connect();
    const table = stage === "after-account" ? "rest_accounts" : "rest_wallet_credentials";
    try {
      await blocker.query("BEGIN");
      await blocker.query(`SELECT * FROM ${table} WHERE ${stage === "after-account" ? "id" : "account_id"}=$1 FOR UPDATE`, [value.accountId]);
      const blockerPid = Number((await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const observation = await canonicalObservation(context, { lifetimeMs: 2000 });
      const pending = child.request({ action: "reconcile", context, observation });
      await waitForLock(child.backendPid, blockerPid, table); await untilDatabaseTime(observation.validUntilMs!);
      await blocker.query("ROLLBACK"); expect((await pending).status).toBe(410);
      expect(await store.get(value.accountId)).toBeNull();
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  });

  it("rolls back a written authority initialization when post-write work crosses its deadline", async () => {
    const value = await authorizedFixture(), context = await store.loadContext(value.accountId), child = await worker();
    const observation = await canonicalObservation(context, { lifetimeMs: 1500 }), barrier = message(child.child, "barrier");
    const pending = child.request({ action: "reconcile", context, observation, barrier: "after-authority-write", continueBarrier: true });
    await barrier; await untilDatabaseTime(observation.validUntilMs!); child.child.send({ kind: "continue" });
    expect((await pending).status).toBe(410); expect(await store.get(value.accountId)).toBeNull();
  });

  it("rolls back a changed observation when post-write work crosses the canonical head-age deadline", async () => {
    const value = await authorizedFixture(), firstContext = await store.loadContext(value.accountId), child = await worker();
    const first = await canonicalObservation(firstContext);
    // These consecutive synthetic heads advance in time. Both are initially within the real
    // 300-second head-age bound; the changed result has no readiness deadline of its own.
    const initialHeadSeconds = Math.floor(first.observedAtMs / 1000) - 298;
    first.head!.timestamp = String(initialHeadSeconds); first.validUntilMs = (initialHeadSeconds + 300) * 1000;
    const original = await store.reconcile(firstContext, first), context = await store.loadContext(value.accountId);
    const observation = await canonicalObservation(context, { stateHash: word("46"), eligibility: "changed" });
    observation.head!.timestamp = String(initialHeadSeconds + 2);
    const headDeadline = Number(observation.head!.timestamp) * 1000 + 300000;
    expect(observation.validUntilMs).toBeNull(); expect(headDeadline).toBeGreaterThan(observation.observedAtMs);
    const barrier = message(child.child, "barrier");
    const pending = child.request({ action: "reconcile", context, observation, barrier: "after-authority-write", continueBarrier: true });
    await barrier; await untilDatabaseTime(headDeadline);
    expect(await databaseNow()).toBeLessThan(observation.observedAtMs + 30000);
    child.child.send({ kind: "continue" }); expect((await pending).status).toBe(410);
    expect(await store.get(value.accountId)).toEqual(original.snapshot);
  }, 15000);

  it("serializes account, enrollment, authority and credential locks with one connection", async () => {
    const value = await initialized(), context = await store.loadContext(value.accountId), child = await worker();
    const result = await child.request({ action: "reconcile", context, observation: await canonicalObservation(context), trace: true });
    expect(result.status).toBe(200); expect(result.body.lockTrace).toEqual([
      "after-account", "after-enrollment", "after-authority-lock", "after-credential", "after-authority-write", "after-commit" ]);
  });

  it("retains logout when it wins before an in-flight canonical refresh", async () => {
    const value = await initialized(), context = await store.loadContext(value.accountId), observation = await canonicalObservation(context);
    const [a, b] = await Promise.all([worker(), worker()]), barrier = message(a.child, "barrier");
    const logout = a.request({ action: "logout", input: { accountId: value.accountId, expectedAuthorityEpoch: "1", expectedSessionEpoch: "1", kind: "logout" },
      barrier: "after-authority-write", continueBarrier: true });
    await barrier;
    const refresh = b.request({ action: "reconcile", context, observation });
    await waitForLock(b.backendPid, a.backendPid, "rest_accounts"); a.child.send({ kind: "continue" });
    expect((await logout).status).toBe(200); expect((await refresh).status).toBe(409);
    expect(await store.get(value.accountId)).toMatchObject({ authorityEpoch: "1", sessionEpoch: "2", revision: "2",
      identity: value.snapshot.identity, validUntilMs: value.snapshot.validUntilMs });
  });

  it("retains logout when an unchanged-identity refresh commits first", async () => {
    const value = await initialized(), context = await store.loadContext(value.accountId), [a, b] = await Promise.all([worker(), worker()]);
    const observation = await canonicalObservation(context), barrier = message(a.child, "barrier");
    const refresh = a.request({ action: "reconcile", context, observation, barrier: "after-authority-write", continueBarrier: true });
    await barrier;
    const logout = b.request({ action: "logout", input: { accountId: value.accountId, expectedAuthorityEpoch: "1", expectedSessionEpoch: "1", kind: "logout" } });
    await waitForLock(b.backendPid, a.backendPid, "rest_accounts"); a.child.send({ kind: "continue" });
    expect((await refresh).status).toBe(200); expect((await logout).status).toBe(200);
    expect(await store.get(value.accountId)).toMatchObject({ authorityEpoch: "1", sessionEpoch: "2", revision: "3",
      identity: value.snapshot.identity, validUntilMs: observation.validUntilMs });
  });

  it("rejects an old exact observation retry after logout has advanced its durable result", async () => {
    const value = await initialized();
    await new PostgresWalletAppGrantStore(pool).advanceEpochs({ accountId: value.accountId,
      expectedAuthorityEpoch: "1", expectedSessionEpoch: "1", kind: "logout" });
    const loggedOut = await store.get(value.accountId);
    expect(loggedOut).toMatchObject({ authorityEpoch: "1", sessionEpoch: "2", revision: "2" });
    await expect(store.reconcile(value.context, value.observation)).rejects.toMatchObject({ status: 409 });
    expect(await store.get(value.accountId)).toEqual(loggedOut);
  });

  it("recovers an unchanged exact result after expiry without renewing authority", async () => {
    const value = await authorizedFixture(), context = await store.loadContext(value.accountId);
    const observation = await canonicalObservation(context, { lifetimeMs: 2000 }), first = await store.reconcile(context, observation);
    await untilDatabaseTime(observation.validUntilMs!);
    expect(await store.reconcile(context, observation)).toEqual({ snapshot: first.snapshot, replayed: true });
    expect(first.snapshot.validUntilMs).toBeLessThanOrEqual(await databaseNow());
    expect(await store.get(value.accountId)).toEqual(first.snapshot);
  });

  it.each(["after-authority-write", "after-commit"])("recovers exactly one fence transition after the %s process crash", async stage => {
    const value = await initialized(), context = await store.loadContext(value.accountId), [a, b] = await Promise.all([worker(), worker()]);
    const observation = await conflictObservation(context), barrier = message(a.child, "barrier");
    const lost = a.request({ action: "reconcile", context, observation, barrier: stage }).catch(() => null);
    await barrier; await kill(a.child); await lost;
    expect(await store.get(value.accountId)).toMatchObject({ authorityEpoch: stage === "after-commit" ? "2" : "1",
      sessionEpoch: stage === "after-commit" ? "2" : "1" });
    const recovered = await b.request({ action: "reconcile", context, observation });
    expect(recovered.status).toBe(200); expect(recovered.body.replayed).toBe(stage === "after-commit");
    expect(recovered.body.snapshot).toMatchObject({ authorityEpoch: "2", sessionEpoch: "2", revision: "2", readiness: "fenced",
      activeFence: { abandonedAnchor: value.snapshot.acceptedAnchor, replacementAnchor: observation.priorAnchor.observed } });
    expect(await store.get(value.accountId)).toEqual(recovered.body.snapshot);
  });

  it("prevents SQL epoch rollback, evidence deletion and independent deadline renewal", async () => {
    const value = await initialized();
    for (const sql of ["UPDATE rest_wallet_authority SET session_epoch=session_epoch-1",
      "DELETE FROM rest_wallet_authority", "UPDATE rest_wallet_authority SET ready_until_ms=ready_until_ms+1",
      "UPDATE rest_wallet_authority SET snapshot=snapshot-'accountId',revision=revision+1,observation_digest=repeat('1',64)",
      "UPDATE rest_wallet_authority SET snapshot=jsonb_set(snapshot,'{historicalVerifiedIdentity}','null'),revision=revision+1,observation_digest=repeat('1',64)"])
      await expect(pool.query(sql)).rejects.toMatchObject({ code: "23514" });
    expect(await store.get(value.accountId)).toEqual(value.snapshot);
  });

  it("rejects incoherent verified evidence, lowered watermarks and rewritten fence history at the SQL boundary", async () => {
    const value = await initialized(), results: { vector: string; code: string }[] = [];
    async function rejected(snapshot: WalletAuthoritySnapshot, vector: string, mutate: (candidate: WalletAuthoritySnapshot) => void) {
      const candidate = structuredClone(snapshot), now = await databaseNow(), client = await pool.connect();
      candidate.revision = (BigInt(candidate.revision) + 1n).toString(); candidate.updatedAtMs = now;
      candidate.latestObservation!.observedAtMs = now;
      mutate(candidate);
      try {
        await client.query("BEGIN");
        try {
          await client.query(`UPDATE rest_wallet_authority SET snapshot=$2::jsonb,revision=$3,
            observation_digest=$4,updated_at=GREATEST(updated_at,$5) WHERE account_id=$1`,
          [snapshot.accountId, JSON.stringify(candidate), candidate.revision,
            enrollmentDigest(candidate.latestObservation), Math.floor(now / 1000)]);
          results.push({ vector, code: "accepted" });
        } catch (error) { results.push({ vector, code: String((error as { code?: string }).code) }); }
      } finally { await client.query("ROLLBACK"); client.release(); }
    }
    await rejected(value.snapshot, "missing latest identity", v => { v.latestObservation!.identity = null; });
    await rejected(value.snapshot, "different latest identity", v => { v.latestObservation!.identity!.stateHash = word("71"); });
    await rejected(value.snapshot, "different latest head", v => { v.latestObservation!.head!.blockHash = word("72"); });
    await rejected(value.snapshot, "different verified history", v => { v.historicalVerifiedIdentity!.stateHash = word("73"); });
    await rejected(value.snapshot, "lowered watermark", v => { v.highestObservedBlock = "99"; });
    await rejected(value.snapshot, "cleared watermark", v => { v.highestObservedBlock = null; });
    let context = await store.loadContext(value.accountId);
    const unknown = await store.reconcile(context, await unknownObservation(context));
    await rejected(unknown.snapshot, "cleared accepted anchor", v => { v.acceptedAnchor = null; });
    context = await store.loadContext(value.accountId);
    const observation = await canonicalObservation(context);
    observation.priorAnchor = (await conflictObservation(context)).priorAnchor;
    const fenced = await store.reconcile(context, observation);
    await rejected(fenced.snapshot, "empty active fence", v => { v.activeFence = {} as WalletAuthoritySnapshot["activeFence"]; });
    await rejected(fenced.snapshot, "rewritten active trigger", v => { v.activeFence!.triggerDigest = word("74"); });
    context = await store.loadContext(value.accountId);
    const recovered = await store.reconcile(context, await canonicalObservation(context));
    expect(recovered.snapshot.lastClosedFence).not.toBeNull();
    await rejected(recovered.snapshot, "empty closed history", v => { v.lastClosedFence = {} as WalletAuthoritySnapshot["lastClosedFence"]; });
    expect(results).toEqual(results.map(result => ({ vector: result.vector, code: "23514" })));
    expect(await store.get(value.accountId)).toEqual(recovered.snapshot);
  });
});
