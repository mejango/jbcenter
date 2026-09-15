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

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const issuer = "https://wallet.juicebox.center", rpId = "wallet.juicebox.center";
suite("hosted Base signup composition against real PostgreSQL and a Base-shaped chain", () => {
  const schema = `rest_wallet_base_signup_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, fixture: Awaited<ReturnType<typeof startWalletBaseAnvil>>;
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 5 });
    for (const name of [...new Set([...walletLoginTestMigrations, "016_rest_wallet_deployments.sql", "018_rest_wallet_deployment_observations.sql",
      "021_rest_wallet_deployment_dispatch.sql", "026_wallet_deployment_settlement.sql", "027_wallet_signup.sql", "034_wallet_deployment_base.sql"])].sort())
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
      await signup.proveEnrollment(flowToken, { assertion: signGet({ ...credential, challenge: hashTypedData(document), rpId, origin: issuer }),
        backupSignature: await signBackupProof(document) });
      const record = (await enrollments.get(initial.intent.id))!;
      const review = await signup.prepareDeployment(flowToken), operation = (await deployments.get(review.id))!;
      expect((await signup.approveDeployment(flowToken, { approvalId: operation.id,
        assertion: signGet({ ...credential, challenge: hashTypedData(walletDeploymentDocument(record, operation.approval)), rpId, origin: issuer }) })).phase).toBe("deploying");
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
  }, 120_000);
});
