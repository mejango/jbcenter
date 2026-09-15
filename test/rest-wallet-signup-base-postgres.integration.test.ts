// Acceptance: the production signup composition over the hosted Base producers, against real
// PostgreSQL and a Base-shaped local chain. One durable, exactly identified creation operation is
// admitted with a reservation, sent once, observed canonical, then settled with complete fees.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashTypedData, toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { PostgresWalletEnrollmentStore } from "../src/rest/wallet/enrollmentPostgres.js";
import { walletEnrollmentDocument } from "../src/rest/wallet/enrollment.js";
import { PostgresWalletDeploymentStore } from "../src/rest/wallet/deploymentPostgres.js";
import { walletDeploymentDocument } from "../src/rest/wallet/deployment.js";
import { createWalletDeploymentExecution } from "../src/rest/wallet/deploymentExecution.js";
import { createBaseWalletDeploymentSettlement, createBaseWalletDeploymentTransport } from "../src/rest/wallet/deploymentBase.js";
import { createSmartAccountService } from "../src/rest/smartAccounts/service.js";
import { PostgresSmartAccountRegistry } from "../src/rest/smartAccounts/postgres.js";
import { PostgresOnboardingStore } from "../src/rest/smartAccounts/onboardingPostgres.js";
import { createSafe7579Inspector } from "../src/rest/smartAccounts/inspector.js";
import { createInstalledSessionVerifier } from "../src/rest/smartAccounts/installed.js";
import { PostgresWalletAuthorityStore } from "../src/rest/wallet/authorityPostgres.js";
import { createWalletAuthorityChain } from "../src/rest/wallet/authorityChain.js";
import { createWalletAuthorityService } from "../src/rest/wallet/authorityService.js";
import { PostgresWalletSignupStore } from "../src/rest/wallet/signupPostgres.js";
import { createLocalWalletSignup } from "../src/rest/wallet/signup.js";
import { createRegistration, enrollmentBackupAccount, signBackupProof, signGet } from "./fixtures/wallet-enrollment-crypto.js";
import { walletLoginTestMigrations } from "./fixtures/wallet-login-setup.js";
import { startWalletBaseAnvil } from "./fixtures/wallet-base-anvil.js";
import { exerciseWalletRecoveryEvm } from "./fixtures/wallet-recovery-evm.js";
import { PostgresWalletLoginStore } from "../src/rest/wallet/loginPostgres.js";
import { encodeSafe7579MessageSignature } from "../src/rest/smartAccounts/passkeySignatures.js";
import { passkeyOnboardingProofDocument } from "../src/rest/smartAccounts/passkeyOnboarding.js";
import { verifyWalletAssertion } from "../src/rest/wallet/webauthn.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const issuer = "https://wallet.juicebox.center", rpId = "wallet.juicebox.center";
suite("hosted Base signup composition against real PostgreSQL and a Base-shaped chain", () => {
  const schema = `rest_wallet_signup_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, fixture: Awaited<ReturnType<typeof startWalletBaseAnvil>>;
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 5 });
    for (const name of [...new Set([...walletLoginTestMigrations, "016_rest_wallet_deployments.sql", "036_wallet_deployment_approval_v2.sql", "018_rest_wallet_deployment_observations.sql",
      "021_rest_wallet_deployment_dispatch.sql", "026_wallet_deployment_settlement.sql", "027_wallet_signup.sql", "028_wallet_recovery.sql",
      "029_wallet_recovery_mapping.sql", "033_wallet_unproved_recovery_expiry.sql", "030_wallet_recovery_flow.sql", "031_wallet_recovery_dispatch.sql",
      "034_wallet_deployment_base.sql", "035_wallet_recovery_base.sql"])].sort())
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), "utf8"));
    fixture = await startWalletBaseAnvil();
  }, 60_000);
  afterAll(async () => {
    await fixture?.close(); await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it("creates one wallet through a reserved admission, one send and a complete-fee settlement, then admits the next user", async () => {
    const enrollments = new PostgresWalletEnrollmentStore(pool), deployments = new PostgresWalletDeploymentStore(pool);
    const base = { url: fixture.endpoint, genesisHash: fixture.genesisHash };
    const settlement = createBaseWalletDeploymentSettlement({ ...base, utility: fixture.utility });
    await fixture.rpc("anvil_setBalance", [fixture.sender, toHex(BigInt(fixture.configuration.allocationWei))]);
    await deployments.configurePool(fixture.configuration);
    const initialFunding = await deployments.loadFundingContext(fixture.configuration.id);
    const initialized = await deployments.initializeAccounting(initialFunding, await settlement.observeFunding(initialFunding), "2");
    expect(initialized.accounting!.environment).toEqual({ kind: "base-mainnet", genesisHash: fixture.genesisHash });
    const execution = createWalletDeploymentExecution({ store: deployments, chain: fixture.chain(), dispatchLeaseMs: 500,
      signer: mnemonicToAccount("test test test test test test test test test test test junk"),
      experimentalTransport: createBaseWalletDeploymentTransport(base) });
    const smart = createSmartAccountService({ rpc: fixture.readOnlyRpc, manifests: [fixture.manifest], audience: "https://juicebox.center",
      registry: new PostgresSmartAccountRegistry(pool), onboarding: new PostgresOnboardingStore(pool),
      moduleInspectors: [createSafe7579Inspector({ rpc: fixture.readOnlyRpc, utility: fixture.utility,
        inspectSessions: createInstalledSessionVerifier({ rpc: fixture.readOnlyRpc }).inspectAllAt })] });
    const authority = createWalletAuthorityService({ store: new PostgresWalletAuthorityStore(pool),
      chain: createWalletAuthorityChain({ rpc: fixture.readOnlyRpc, manifest: fixture.manifest, utility: fixture.utility }) });
    const flows = new PostgresWalletSignupStore(pool, { rpId, origin: issuer, manifest: fixture.manifest });
    const events: string[] = [];
    const login = new PostgresWalletLoginStore(pool, { rpId, origin: issuer });
    let recoveryTarget: Pick<Parameters<typeof exerciseWalletRecoveryEvm>[0], "enrollment" | "originalKey" | "originalSessionToken"> | null = null;
    const signup = createLocalWalletSignup({ flows, enrollments, deployments, settlement, execution, smart, authority,
      registry: new PostgresSmartAccountRegistry(pool), chain: fixture.chain(), poolId: fixture.configuration.id,
      onEvent: event => events.push(`${event.stage}:${event.outcome}`) });
    for (let index = 0; index < 2; index++) {
      const begun = await signup.begin({ recoveryOwner: enrollmentBackupAccount.address, passkeyName: "Juicebox test" }), flowToken = begun.flowToken;
      const initial = (await enrollments.get(begun.view.enrollmentId))!;
      const credential = createRegistration({ challenge: `0x${Buffer.from(initial.intent.registration.challenge, "base64url").toString("hex")}`,
        rpId, origin: issuer, userHandle: initial.intent.userHandle });
      await signup.register(flowToken, credential.response);
      const pending = (await enrollments.get(initial.intent.id))!, document = walletEnrollmentDocument(pending);
      // Creation is reviewed straight after registration: one passkey assertion over the creation
      // document approves it and proves possession; the recovery owner signs the enrollment document.
      const review = await signup.prepareDeployment(flowToken), operation = (await deployments.get(review.id))!;
      const approvalAssertion = () => signGet({ ...credential, challenge: hashTypedData(walletDeploymentDocument(pending, operation.approval)), rpId, origin: issuer });
      await expect(signup.approveDeployment(flowToken, { approvalId: operation.id, assertion: approvalAssertion() })).rejects.toMatchObject({ status: 409 });
      await expect(signup.approveDeployment(flowToken, { approvalId: operation.id, assertion: approvalAssertion(),
        backupSignature: await enrollmentBackupAccount.signMessage({ message: "not the enrollment document" }) })).rejects.toMatchObject({ status: 403 });
      expect((await enrollments.get(initial.intent.id))!.state).toBe("awaiting_possession");
      expect((await signup.status(flowToken)).phase).toBe("awaiting_possession");
      // Base mines every two seconds: a new block lands between the approval's chain reads. The
      // creation preflight and the treasury funding read must still describe one head.
      let latestReads = 0;
      fixture.faults.after = async (method, params) => { if (method === "eth_getBlockByNumber" && params[0] === "latest" && ++latestReads === 1) await fixture.rpc("anvil_mine", ["0x1", "0x0"]); };
      try {
        expect((await signup.approveDeployment(flowToken, { approvalId: operation.id, assertion: approvalAssertion(),
          backupSignature: await signBackupProof(document) })).phase).toBe("deploying");
      } finally { fixture.faults.after = async () => undefined; }
      const record = (await enrollments.get(initial.intent.id))!;
      expect(record.state).toBe("verified");
      expect(latestReads).toBeGreaterThan(0);
      const claimed = (await deployments.get(operation.id))!;
      expect(claimed.template!.transaction.nonce).toBe(String(index + 2));
      await signup.tick();
      const dispatch = (await deployments.getDispatch(operation.id))!;
      expect(dispatch.status).toBe("accepted");
      expect(dispatch.admission).toMatchObject({ version: "center-wallet-deployment-base-admission-v1", baseTotalAffordability: "reserved" });
      expect(BigInt(dispatch.admission.reservation!.totalWei)).toBeGreaterThan(BigInt(claimed.signed?.maximumExecutionCost ?? (await deployments.get(operation.id))!.signed!.maximumExecutionCost));
      expect(fixture.sends()).toHaveLength(index + 1);
      await new Promise(resolve => setTimeout(resolve, Math.max(1, dispatch.leaseUntil - Date.now() + 15)));
      await signup.tick();
      expect((await deployments.get(operation.id))!.observation).toMatchObject({ transaction: { state: "canonical-success" }, wallet: { state: "verified" }, finality: { state: "unfinalized" } });
      expect((await signup.status(flowToken)).phase).toBe("awaiting_setup");
      expect(await deployments.getSettlement(operation.id)).toBeNull();
      // Setup and fresh login complete before treasury finality, as on the local pilot.
      const browser = privateKeyToAccount(generatePrivateKey());
      const setupReview = await signup.prepareSetup(flowToken, { browserPublicAddress: browser.address });
      const setup = (await flows.authenticate(flowToken))!.setup!.input, onboarding = await smart.passkeyOnboardingChallenge(setup);
      const setupAssertion = signGet({ ...credential, challenge: onboarding.signingPayload.digest, rpId, origin: issuer });
      const verified = verifyWalletAssertion(setupAssertion, { purpose: "session", challenge: onboarding.signingPayload.digest, rpId, origin: issuer,
        credential: { id: credential.credentialId, userHandle: credential.userHandle, publicKey: credential.publicKey, backupEligible: true }, requireUserHandle: true });
      expect((await signup.completeSetup(flowToken, { setupId: setupReview.id, browserProof: await browser.signTypedData(passkeyOnboardingProofDocument(onboarding.typedData)),
        signature: encodeSafe7579MessageSignature([{ kind: "contract", owner: onboarding.state.ownerProfile!.signer.address, signature: verified.contractSignature }]) })).phase).toBe("preparing_sign_in");
      expect((await authority.refreshAuthority(record.receipt!.accountId)).snapshot.readiness).toBe("verified");
      expect((await signup.status(flowToken)).phase).toBe("ready_to_sign_in");
      const begunLogin = await login.begin(), loggedIn = await login.complete({ loginId: begunLogin.login.id, flowToken: begunLogin.flowToken,
        assertion: signGet({ ...credential, challenge: begunLogin.login.challenge, rpId, origin: issuer }) });
      expect(loggedIn.session.accountId).toBe(record.receipt!.accountId);
      recoveryTarget = { enrollment: record, originalKey: credential, originalSessionToken: loggedIn.sessionToken };
      await fixture.rpc("anvil_mine", ["0x41", "0x0"]);
      await signup.tick();
      const settled = (await deployments.getSettlement(operation.id))!;
      expect(settled).toMatchObject({ nonce: String(index + 2), nextNonce: String(index + 3), sequence: index + 1 });
      expect(settled.evidence.fees.profile).toBe("base-fjord-jovian-receipt-v1");
      const fees = settled.evidence.fees as { executionWei: string; l1Wei: string; operatorWei: string; totalWei: string };
      expect(BigInt(fees.totalWei)).toBe(BigInt(fees.executionWei) + BigInt(fees.l1Wei) + BigInt(fees.operatorWei));
      expect(BigInt(fees.l1Wei)).toBeGreaterThan(0n); expect(BigInt(fees.operatorWei)).toBeGreaterThan(0n);
      const funding = await deployments.loadFundingContext(fixture.configuration.id);
      expect(funding.pool.activeOperationId).toBeNull();
      expect(funding.pool.accounting).toMatchObject({ spentWei: settled.spentWei, nextNonce: String(index + 3), fence: null });
      expect(fixture.sends()).toHaveLength(index + 1);
    }
    expect(events).toContain("deployment:settled");
    expect((await deployments.listUnresolved()).items).toEqual([]);
    expect(await fixture.rpc("eth_getTransactionCount", [fixture.sender, "latest"])).toBe("0x4");
    // Recovery to the same Safe through the hosted Base relay: lost accepted reply, restart before
    // activation, old credential rejected, lane settled with complete fees only after finality.
    await exerciseWalletRecoveryEvm({ pool, fixture, smart, authority, ...recoveryTarget!, audience: "https://juicebox.center", relay: "base" });
  }, 180_000);
});
