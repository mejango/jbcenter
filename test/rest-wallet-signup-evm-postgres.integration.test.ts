// Joined service proof: real PostgreSQL, unforked Anvil, P256 owners and browser-key consent.
// Test-only treasury and synthetic genesis balances. This does not qualify production Base fees.
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashTypedData, toHex, type Hex } from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { PostgresWalletEnrollmentStore } from "../src/rest/wallet/enrollmentPostgres.js";
import { createWalletEnrollmentIntent, walletEnrollmentDocument } from "../src/rest/wallet/enrollment.js";
import { PostgresWalletDeploymentStore } from "../src/rest/wallet/deploymentPostgres.js";
import { prepareWalletDeploymentApproval, walletDeploymentDocument } from "../src/rest/wallet/deployment.js";
import { createWalletDeploymentExecution } from "../src/rest/wallet/deploymentExecution.js";
import { createLocalAnvilWalletDeploymentTransport } from "../src/rest/wallet/deploymentLocalAnvil.js";
import { createLocalAnvilWalletDeploymentSettlement } from "../src/rest/wallet/deploymentSettlementLocalAnvil.js";
import { createSmartAccountService } from "../src/rest/smartAccounts/service.js";
import { PostgresSmartAccountRegistry } from "../src/rest/smartAccounts/postgres.js";
import { PostgresOnboardingStore } from "../src/rest/smartAccounts/onboardingPostgres.js";
import { createSafe7579Inspector } from "../src/rest/smartAccounts/inspector.js";
import { createInstalledSessionVerifier } from "../src/rest/smartAccounts/installed.js";
import { passkeyOnboardingProofDocument, type PasskeyOnboardingInput } from "../src/rest/smartAccounts/passkeyOnboarding.js";
import { encodeSafe7579MessageSignature } from "../src/rest/smartAccounts/passkeySignatures.js";
import { verifyWalletAssertion } from "../src/rest/wallet/webauthn.js";
import { PostgresWalletAuthorityStore } from "../src/rest/wallet/authorityPostgres.js";
import { createWalletAuthorityChain } from "../src/rest/wallet/authorityChain.js";
import { createWalletAuthorityService } from "../src/rest/wallet/authorityService.js";
import { PostgresWalletLoginStore } from "../src/rest/wallet/loginPostgres.js";
import { createRegistration, enrollmentBackupAccount, signBackupProof, signGet } from "./fixtures/wallet-enrollment-crypto.js";
import { startWalletDeploymentAnvil } from "./fixtures/wallet-deployment-anvil.js";
import { walletLoginTestMigrations } from "./fixtures/wallet-login-setup.js";
import { PostgresWalletSignupStore } from "../src/rest/wallet/signupPostgres.js";
import { createLocalWalletSignup } from "../src/rest/wallet/signup.js";
import { exerciseSignupBrowser } from "./fixtures/wallet-signup-browser.js";
import { exerciseWalletRecoveryEvm } from "./fixtures/wallet-recovery-evm.js";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const issuer = "https://wallet.juicebox.center", rpId = "wallet.juicebox.center";
suite("joined wallet signup against real PostgreSQL and unforked EVM", () => {
  const schema = `rest_wallet_signup_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, fixture: Awaited<ReturnType<typeof startWalletDeploymentAnvil>>;
  const dbNow = async () => Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now")).rows[0].now);
  const count = async (table: string) => Number((await pool.query(`SELECT count(*)::text AS count FROM ${table}`)).rows[0].count);
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 5 });
    for (const name of [...new Set([...walletLoginTestMigrations, "016_rest_wallet_deployments.sql",
      "018_rest_wallet_deployment_observations.sql", "021_rest_wallet_deployment_dispatch.sql", "026_wallet_deployment_settlement.sql", "027_wallet_signup.sql",
      "028_wallet_recovery.sql", "029_wallet_recovery_mapping.sql"])].sort())
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), "utf8"));
    fixture = await startWalletDeploymentAnvil();
  }, 30_000);
  afterAll(async () => {
    await fixture?.close(); await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it("takes four users through signup and fresh login, including saved recovery kits, cancellation, lost replies and cookie recovery", async () => {
    const enrollments = new PostgresWalletEnrollmentStore(pool), deployments = new PostgresWalletDeploymentStore(pool);
    const settlement = createLocalAnvilWalletDeploymentSettlement(fixture);
    await fixture.rpc("anvil_setBalance", [fixture.sender, toHex(BigInt(fixture.configuration.allocationWei))]);
    await deployments.configurePool(fixture.configuration);
    const initialFunding = await deployments.loadFundingContext(fixture.configuration.id);
    await deployments.initializeAccounting(initialFunding, await settlement.observeFunding(initialFunding), "2");
    const execution = createWalletDeploymentExecution({ store: deployments, chain: fixture.chain(), dispatchLeaseMs: 500,
      signer: mnemonicToAccount("test test test test test test test test test test test junk"),
      experimentalTransport: createLocalAnvilWalletDeploymentTransport(fixture) });
    const smart = createSmartAccountService({ rpc: fixture.readOnlyRpc, manifests: [fixture.manifest], audience: "https://juicebox.center",
      registry: new PostgresSmartAccountRegistry(pool), onboarding: new PostgresOnboardingStore(pool),
      moduleInspectors: [createSafe7579Inspector({ rpc: fixture.readOnlyRpc, utility: fixture.utility,
        inspectSessions: createInstalledSessionVerifier({ rpc: fixture.readOnlyRpc }).inspectAllAt })] });
    const authority = createWalletAuthorityService({ store: new PostgresWalletAuthorityStore(pool),
      chain: createWalletAuthorityChain({ rpc: fixture.readOnlyRpc, manifest: fixture.manifest, utility: fixture.utility }) });
    const login = new PostgresWalletLoginStore(pool, { rpId, origin: issuer });
    const flows = new PostgresWalletSignupStore(pool, { rpId, origin: issuer, manifest: fixture.manifest });
    const signup = createLocalWalletSignup({ flows, enrollments, deployments, settlement, execution, smart, authority,
      registry: new PostgresSmartAccountRegistry(pool), chain: fixture.chain(), poolId: fixture.configuration.id });
    const accounts: string[] = [], receipts: string[] = [];
    let recoveryTarget: Pick<Parameters<typeof exerciseWalletRecoveryEvm>[0], 'enrollment' | 'originalKey' | 'originalSessionToken'> | null = null;
    for (let index = 0; index < 2; index++) {
      const begunFlow = await signup.begin({ recoveryOwner: enrollmentBackupAccount.address, passkeyName: "Juicebox test" });
      const flowToken = begunFlow.flowToken;
      const initial = (await enrollments.get(begunFlow.view.enrollmentId))!;
      const credential = createRegistration({ challenge: `0x${Buffer.from(initial.intent.registration.challenge, "base64url").toString("hex")}`,
        rpId, origin: issuer, userHandle: initial.intent.userHandle });
      expect((await signup.register(flowToken, credential.response)).phase).toBe("awaiting_possession");
      const pending = (await enrollments.get(initial.intent.id))!;
      expect(await new PostgresWalletEnrollmentStore(pool).acceptRegistration(initial.intent.id, credential.response)).toEqual(pending);
      const document = walletEnrollmentDocument(pending);
      const enrollmentProof = { assertion: signGet({ ...credential, challenge: hashTypedData(document), rpId, origin: issuer }),
        backupSignature: await signBackupProof(document) };
      expect((await signup.proveEnrollment(flowToken, enrollmentProof)).phase).toBe("awaiting_deployment_approval");
      const record = (await enrollments.get(initial.intent.id))!;
      expect((await new PostgresWalletEnrollmentStore(pool).finalize(initial.intent.id, enrollmentProof)).replayed).toBe(true);
      const accountId = record.receipt!.accountId; accounts.push(accountId);
      expect(await count("rest_accounts")).toBe(index);
      expect(await count("rest_bot_grants")).toBe(index);
      expect(await count("rest_wallet_logins")).toBe(index * 2);
      const premature = await login.begin();
      await expect(login.complete({ loginId: premature.login.id, flowToken: premature.flowToken,
        assertion: signGet({ ...credential, challenge: premature.login.challenge, rpId, origin: issuer }) })).rejects.toBeInstanceOf(Error);
      const deploymentReview = await signup.prepareDeployment(flowToken);
      const operation = (await deployments.get(deploymentReview.id))!, approval = operation.approval;
      expect((await signup.prepareDeployment(flowToken)).id).toBe(operation.id);
      const preflight = await fixture.chain().preflight(record, approval);
      expect(preflight.dispatchEligible).toBe(false); // Production Base still has no complete fee qualification.
      const approvalProof = { approvalId: operation.id,
        assertion: signGet({ ...credential, challenge: hashTypedData(walletDeploymentDocument(record, approval)), rpId, origin: issuer }) };
      expect((await signup.approveDeployment(flowToken, approvalProof)).phase).toBe("deploying");
      expect((await signup.approveDeployment(flowToken, approvalProof)).phase).toBe("deploying");
      await signup.tick();
      expect((await deployments.getDispatch(operation.id))!.status).toBe("accepted");
      const dispatch = (await deployments.getDispatch(operation.id))!;
      await new Promise(resolve => setTimeout(resolve, Math.max(1, dispatch.leaseUntil - Date.now() + 15)));
      await fixture.rpc("anvil_mine", ["0x41", "0x0"]);
      await signup.tick();
      const settled = { settlement: await deployments.getSettlement(operation.id) };
      expect(settled.settlement).toMatchObject({ nonce: String(index + 2), nextNonce: String(index + 3), sequence: index + 1 });
      receipts.push(settled.settlement!.evidence.transactionHash);
      // A restarted orchestrator reads the committed receipt; it must not create a new
      // observation and mislabel it as an exact replay of the original evidence.
      await signup.tick();
      expect(await deployments.getSettlement(operation.id)).toEqual(settled.settlement);
      expect(await count("rest_accounts")).toBe(index);

      expect((await signup.status(flowToken)).phase).toBe("awaiting_setup");
      const browser = privateKeyToAccount(generatePrivateKey());
      const setupReview = await signup.prepareSetup(flowToken, { browserPublicAddress: browser.address });
      const setup = (await flows.authenticate(flowToken))!.setup!.input;
      expect((await signup.prepareSetup(flowToken, { browserPublicAddress: browser.address })).id).toBe(setupReview.id);
      const review = await smart.passkeyOnboardingChallenge(setup);
      expect(review.state.evidence.source).toBe("onchain");
      expect(review.typedData.message.initializerHash).toBe(record.creation!.initializerHash);
      expect(review.typedData.message.accountId).toBe(accountId);
      const assertion = signGet({ ...credential, challenge: review.signingPayload.digest, rpId, origin: issuer });
      const verified = verifyWalletAssertion(assertion, { purpose: "session", challenge: review.signingPayload.digest, rpId, origin: issuer,
        credential: { id: credential.credentialId, userHandle: credential.userHandle, publicKey: credential.publicKey, backupEligible: true }, requireUserHandle: true });
      const complete = { ...setup, stateHash: review.state.stateHash, manifestRevision: review.state.manifestRevision,
        initializerHash: record.creation!.initializerHash,
        signature: encodeSafe7579MessageSignature([{ kind: "contract", owner: review.state.ownerProfile!.signer.address, signature: verified.contractSignature }]),
        proofSignature: await browser.signTypedData(passkeyOnboardingProofDocument(review.typedData)) };
      expect((await signup.completeSetup(flowToken, { setupId: setupReview.id, signature: complete.signature,
        browserProof: complete.proofSignature })).phase).toBe("ready_to_sign_in");
      const configured = await smart.finalizePasskeyOnboarding(complete);
      expect((await signup.completeSetup(flowToken, { setupId: setupReview.id, signature: complete.signature,
        browserProof: complete.proofSignature })).phase).toBe("ready_to_sign_in");
      expect(configured.account.id).toBe(accountId);
      expect(configured.binding.authorization.method).toBe("safe-passkey-owner-threshold-and-api-grant");
      expect(await count("rest_accounts")).toBe(index + 1); expect(await count("rest_bot_grants")).toBe(index + 1);
      expect((await authority.refreshAuthority(accountId)).snapshot.readiness).toBe("verified");
      const begun = await login.begin();
      await expect(login.complete({ loginId: begun.login.id, flowToken: begun.flowToken, assertion: enrollmentProof.assertion })).rejects.toBeInstanceOf(Error);
      const proof = { loginId: begun.login.id, flowToken: begun.flowToken,
        assertion: signGet({ ...credential, challenge: begun.login.challenge, rpId, origin: issuer }) };
      const loggedIn = await login.complete(proof);
      expect(loggedIn.session.accountId).toBe(accountId);
      expect((await new PostgresWalletLoginStore(pool, { rpId, origin: issuer }).complete(proof)).sessionToken).toBe(loggedIn.sessionToken);
      expect(await login.readSession(loggedIn.sessionToken)).toEqual(loggedIn.session);
      expect(await login.readSession(begun.flowToken)).toBeNull();
      expect(await count("rest_wallet_deployment_settlements")).toBe(index + 1);
      recoveryTarget = { enrollment: record, originalKey: credential, originalSessionToken: loggedIn.sessionToken };
    }
    expect(new Set(accounts).size).toBe(2); expect(new Set(receipts).size).toBe(2);
    expect((await deployments.listUnresolved()).items).toEqual([]);
    expect(await fixture.rpc<Hex>("eth_getTransactionCount", [fixture.sender, "latest"])).toBe("0x4");
    await exerciseWalletRecoveryEvm({ pool, fixture, smart, authority, ...recoveryTarget!, audience: 'https://juicebox.center' });
    await exerciseSignupBrowser({ pool, fixture, enrollments, deployments, settlement, execution, smart, authority,
      registry: new PostgresSmartAccountRegistry(pool), chain: fixture.chain(), poolId: fixture.configuration.id });
    await exerciseSignupBrowser({ pool, fixture, enrollments, deployments, settlement, execution, smart, authority,
      recoveryMode: 'kit', expectedNextNonce: '6',
      registry: new PostgresSmartAccountRegistry(pool), chain: fixture.chain(), poolId: fixture.configuration.id });
  }, 60_000);
});
