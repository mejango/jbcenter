import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashTypedData } from "viem";
import { walletEnrollmentDocument } from "../src/rest/wallet/enrollment.js";
import { PostgresWalletEnrollmentStore } from "../src/rest/wallet/enrollmentPostgres.js";
import { PostgresWalletSignupStore } from "../src/rest/wallet/signupPostgres.js";
import { PostgresWalletBackupStore, unwrapWalletBackup, wrapWalletBackup } from "../src/rest/wallet/backupPostgres.js";
import { openWalletBackup, sealWalletBackup } from "../src/rest/web/walletBackupPassword.js";
import { createWalletRecoverySecret, recoveryAccountFromPhrase } from "../src/rest/web/walletRecoveryKit.js";
import { createRegistration, enrollmentManifest, signGet } from "./fixtures/wallet-enrollment-crypto.js";
import { walletLoginTestMigrations } from "./fixtures/wallet-login-setup.js";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const origin = "https://wallet.juicebox.center", rpId = "wallet.juicebox.center", wrapKey = `0x${"42".repeat(32)}` as const;

suite("chosen-password backup envelopes in PostgreSQL", () => {
  const schema = `rest_wallet_backup_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, flows: PostgresWalletSignupStore, enrollments: PostgresWalletEnrollmentStore, backups: PostgresWalletBackupStore;
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 });
    for (const name of [...walletLoginTestMigrations, "027_wallet_signup.sql", "037_wallet_backup_envelopes.sql"].sort())
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), "utf8"));
    backups = new PostgresWalletBackupStore(pool, { wrapKey });
    enrollments = new PostgresWalletEnrollmentStore(pool);
    flows = new PostgresWalletSignupStore(pool, { rpId, origin, manifest: enrollmentManifest, backups });
  });
  afterAll(async () => { await pool?.end(); await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin?.end(); });

  it("wraps an envelope under the server key and refuses it under another key or context", async () => {
    const envelope = await sealWalletBackup("orange-tree-42", createWalletRecoverySecret());
    const wrapped = wrapWalletBackup(envelope, wrapKey, "enrollment-a");
    expect(wrapped.wrapped).not.toContain(envelope.ciphertext);
    expect(unwrapWalletBackup(wrapped, wrapKey, "enrollment-a")).toEqual(envelope);
    expect(() => unwrapWalletBackup(wrapped, `0x${"43".repeat(32)}`, "enrollment-a")).toThrow();
    expect(() => unwrapWalletBackup(wrapped, wrapKey, "enrollment-b")).toThrow();
  });

  it("stores the envelope with the signup and returns it by wallet address only once the wallet is verified, five reads an hour", async () => {
    const secret = createWalletRecoverySecret(), envelope = await sealWalletBackup("orange-tree-42", secret);
    const begun = await flows.begin({ recoveryOwner: secret.recoveryOwner, passkeyName: "Juicebox test", backup: envelope });
    const initial = (await enrollments.get(begun.flow.enrollmentId))!;
    const credential = createRegistration({ challenge: `0x${Buffer.from(initial.intent.registration.challenge, "base64url").toString("hex")}`,
      rpId, origin, userHandle: initial.intent.userHandle });
    const pending = await enrollments.acceptRegistration(initial.intent.id, credential.response);
    const walletAddress = pending.creation!.address;
    expect(await backups.read(walletAddress)).toBeNull();
    const document = walletEnrollmentDocument(pending);
    await enrollments.finalize(initial.intent.id, { assertion: signGet({ ...credential, challenge: hashTypedData(document), rpId, origin }),
      backupSignature: await recoveryAccountFromPhrase(secret.mnemonic).signTypedData(document) });
    const found = (await backups.read(walletAddress))!;
    expect(found).toMatchObject({ walletAddress: walletAddress.toLowerCase(), recoveryOwner: secret.recoveryOwner.toLowerCase(),
      initializerHash: pending.creation!.initializerHash, envelope });
    expect(await openWalletBackup("orange-tree-42", found.envelope, { recoveryOwner: found.recoveryOwner })).toEqual(secret);
    expect(await backups.read(walletAddress.toLowerCase())).not.toBeNull();
    for (let i = 0; i < 3; i++) expect(await backups.read(walletAddress)).not.toBeNull();
    await expect(backups.read(walletAddress)).rejects.toMatchObject({ status: 429 });
    expect(await backups.read(`0x${"11".repeat(20)}`)).toBeNull();
  });

  it("refuses a malformed envelope, and any envelope when no backup store is configured", async () => {
    const secret = createWalletRecoverySecret(), envelope = await sealWalletBackup("orange-tree-42", secret);
    await expect(flows.begin({ recoveryOwner: secret.recoveryOwner, passkeyName: "Juicebox test",
      backup: { ...envelope, ciphertext: "not base64url!" } })).rejects.toMatchObject({ status: 400 });
    await expect(flows.begin({ recoveryOwner: secret.recoveryOwner, passkeyName: "Juicebox test",
      backup: { ...envelope, kdf: { ...envelope.kdf, n: 1024 } } })).rejects.toMatchObject({ status: 400 });
    const plain = new PostgresWalletSignupStore(pool, { rpId, origin, manifest: enrollmentManifest });
    await expect(plain.begin({ recoveryOwner: secret.recoveryOwner, passkeyName: "Juicebox test", backup: envelope })).rejects.toMatchObject({ status: 400 });
  });
});
