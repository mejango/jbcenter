import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, parseTransaction, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RELAYR_NATIVE_TOKEN, RELAYR_PAYMENT_ADDRESS, RELAYR_PAYMENT_SELECTOR } from "../src/rest/sponsorship/constants.js";
import { RELAYR_PAYMENT_RUNTIME } from "./fixtures/relayr-payment.js";
import { PostgresWalletEnrollmentStore } from "../src/rest/wallet/enrollmentPostgres.js";
import { PostgresWalletAuthorityStore } from "../src/rest/wallet/authorityPostgres.js";
import { createWalletNetworks } from "../src/rest/wallet/networks.js";
import { PostgresWalletNetworksStore } from "../src/rest/wallet/networksPostgres.js";
import { completeWalletLoginFixture, walletLoginTestMigrations } from "./fixtures/wallet-login-setup.js";
import { signGet } from "./fixtures/wallet-enrollment-crypto.js";

const connectionString = process.env.TEST_DATABASE_URL;
const describeIf = connectionString ? describe : describe.skip;
describeIf("wallet networks against real PostgreSQL", () => {
  const schema = `rest_wallet_networks_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 });
    for (const name of walletLoginTestMigrations)
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), "utf8"));
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });

  it("quotes, approves with one passkey prompt, pays from Center's payer and records each chain as it shows the account", async () => {
    const fixture = await completeWalletLoginFixture(pool), session = fixture.session, creation = fixture.record.creation!;
    const bundleUuid = "a0a555ff-4444-4111-aaaa-333333333333", deadline = Math.floor(Date.now() / 1000) + 900, amount = "2000000000000003"; // under the mainnet cap
    const calldata = (`${RELAYR_PAYMENT_SELECTOR}${bundleUuid.replaceAll("-", "")}${"0".repeat(32)}${deadline.toString(16).padStart(64, "0")}`) as Hex;
    const calls: { chainId: number; method: string; params: readonly unknown[] }[] = [], sent: Hex[] = [], deployed = new Set<number>();
    const walletAddress = creation.address.toLowerCase(), uuids = (n: number) => Array.from({ length: n }, (_, i) => `b1b1b1b1-0000-4000-8000-00000000000${i}`);
    const provider = { requests: [] as unknown[], async createIndependent(entries: unknown) { provider.requests.push(entries);
        return { bundle_uuid: bundleUuid, tx_uuids: uuids((entries as unknown[]).length),
          payment_info: [{ chain: 8453, target: RELAYR_PAYMENT_ADDRESS, token: RELAYR_NATIVE_TOKEN, amount, calldata, payment_deadline: String(deadline) }] }; },
      // Relayr lists the transactions in its own order, not the request order; the first status read binds them.
      async status(uuid: string) { const entries = provider.requests[0] as { chain: number; target: string; data: string; value: string }[], ids = uuids(entries.length);
        return { bundle_uuid: uuid, payment_received: true, transactions: [...entries].reverse().map((entry, i) => ({
          tx_uuid: ids[entries.length - 1 - i], request: { chain: entry.chain, target: entry.target, data: entry.data, value: entry.value },
          status: { state: deployed.has(entry.chain) ? "Included" : "Pending", data: deployed.has(entry.chain) ? { hash: keccak256(toHex(entry.chain)) } : {} } })) }; } };
    const rpc = { async request(chainId: number, method: string, params: readonly unknown[]) {
      calls.push({ chainId, method, params });
      const target = String(params[0]).toLowerCase();
      if (method === "eth_getCode") {
        if (target === RELAYR_PAYMENT_ADDRESS.toLowerCase()) return RELAYR_PAYMENT_RUNTIME;
        if (target === walletAddress) return deployed.has(chainId) ? "0x6001" : "0x";
        return `0x60${target.slice(2, 10)}`; // the creation stack: the same bytes on every chain
      }
      if (method === "eth_call") return `0x${"00".repeat(12)}${walletAddress.slice(2)}`; // the factory would create this account
      if (method === "eth_estimateGas") return "0x186a0";
      if (method === "eth_getBlockByNumber") return { baseFeePerGas: "0x3b9aca00", number: "0x10", hash: `0x${"11".repeat(32)}`, timestamp: toHex(Math.floor(Date.now() / 1000)) };
      if (method === "eth_getTransactionCount") return params[1] === "latest" && sent.length ? "0x6" : "0x5";
      if (method === "eth_getBalance") return toHex(10n ** 18n);
      if (method === "eth_getTransactionByHash") return sent.some(raw => keccak256(raw) === params[0]) ? { hash: params[0] } : null;
      if (method === "eth_getTransactionReceipt") return sent.some(raw => keccak256(raw) === params[0]) ? { status: "0x1", transactionHash: params[0] } : null;
      if (method === "eth_sendRawTransaction") { sent.push(params[0] as Hex); return keccak256(params[0] as Hex); }
      throw new Error(`unexpected ${method}`); } };
    const payer = privateKeyToAccount(`0x${"55".repeat(32)}`);
    const networks = createWalletNetworks({ enrollments: new PostgresWalletEnrollmentStore(pool), authority: new PostgresWalletAuthorityStore(pool),
      store: new PostgresWalletNetworksStore(pool), provider, rpc, payer: { address: payer.address, signTransaction: tx => payer.signTransaction(tx) } });

    const before = await networks.list(session);
    expect(before.networks).toEqual([{ chainId: 8453, name: "Base", state: "deployed", txHash: null }]);
    expect(before.offered.map(item => item.chainId)).toEqual([10, 42161, 11155111, 11155420, 421614, 84532]);
    await expect(networks.quote(session, { chainIds: [10, 84532] })).rejects.toMatchObject({ code: "WALLET_NETWORKS_INVALID" });
    await expect(networks.quote(session, { chainIds: [1] })).rejects.toMatchObject({ code: "WALLET_NETWORKS_INVALID" });

    const quoted = await networks.quote(session, { chainIds: [42161, 10] });
    expect(provider.requests[0]).toEqual([10, 42161].map(chain => ({ chain, target: creation.transaction.to, data: creation.transaction.data, value: "0" })));
    expect(quoted.bundle).toMatchObject({ state: "quoted", chainIds: [10, 42161], centerPays: true, payment: { chainId: 8453, value: amount } });
    expect(quoted.challenge).toMatch(/^0x[0-9a-f]{64}$/);
    // The Base creation stack is read once per quote, not once per destination.
    const homeReads = calls.filter(call => call.chainId === 8453 && call.method === "eth_getCode").map(call => String(call.params[0]).toLowerCase());
    expect(new Set(homeReads).size).toBe(homeReads.length);
    expect(calls.some(call => call.chainId === 42161 && call.method === "eth_call")).toBe(true);
    expect(quoted.view.networks.map(item => `${item.chainId}:${item.state}`)).toEqual(["8453:deployed", "10:quoted", "42161:quoted"]);

    const rpId = session.rpId, origin = fixture.record.intent.origin;
    await expect(networks.approve(session, { bundleId: quoted.bundle!.id, assertion: signGet({ ...fixture.credential, challenge: keccak256("0x99"), rpId, origin }) }))
      .rejects.toMatchObject({ status: 403, code: "WALLET_NETWORKS_PROOF_INVALID" });
    const approved = await networks.approve(session, { bundleId: quoted.bundle!.id, assertion: signGet({ ...fixture.credential, challenge: quoted.challenge!, rpId, origin }) });
    expect(approved.bundle.state).toBe("paid"); expect(approved.replayed).toBe(false);
    expect(sent).toHaveLength(1);
    const tx = parseTransaction(sent[0]!);
    expect(tx).toMatchObject({ chainId: 8453, to: RELAYR_PAYMENT_ADDRESS.toLowerCase(), data: calldata, value: BigInt(amount), nonce: 5, gas: 150000n });
    expect(calls.some(call => call.chainId === 10 && call.method === "eth_call")).toBe(true); // the destination was simulated before quoting
    expect(calls.some(call => call.chainId === 8453 && call.method === "eth_estimateGas")).toBe(true); // and the payment before signing
    expect(approved.view.networks.map(item => `${item.chainId}:${item.state}`)).toEqual(["8453:deployed", "10:pending", "42161:pending"]);
    const replay = await networks.approve(session, { bundleId: quoted.bundle!.id, assertion: signGet({ ...fixture.credential, challenge: quoted.challenge!, rpId, origin }) });
    expect(replay.replayed).toBe(true); expect(sent).toHaveLength(1);
    // A quote for a chain already funded is refused; the account pays nothing twice.
    await expect(networks.quote(session, { chainIds: [10] })).rejects.toMatchObject({ code: "WALLET_NETWORKS_STATE" });

    deployed.add(10);
    const partial = await networks.status(session);
    expect(partial.networks.map(item => `${item.chainId}:${item.state}`)).toEqual(["8453:deployed", "10:deployed", "42161:pending"]);
    expect(partial.networks[1]!.txHash).toBe(keccak256(toHex(10)));
    expect(partial.pending).toHaveLength(1);
    deployed.add(42161);
    const done = await networks.status(session);
    expect(done.networks.map(item => `${item.chainId}:${item.state}`)).toEqual(["8453:deployed", "10:deployed", "42161:deployed"]);
    expect(done.pending).toEqual([]);
    expect(done.offered.map(item => item.chainId)).toEqual([11155111, 11155420, 421614, 84532]);
    // A quote above what Center covers is refused before anything is stored.
    provider.requests.length = 0; sent.length = 0;
    const costly = { ...provider, async createIndependent(entries: unknown) { const q = await provider.createIndependent(entries); return { ...q, payment_info: [{ ...(q.payment_info[0] as object), chain: 84532, amount: (10n ** 17n).toString() }] }; } };
    const pricey = createWalletNetworks({ enrollments: new PostgresWalletEnrollmentStore(pool), authority: new PostgresWalletAuthorityStore(pool),
      store: new PostgresWalletNetworksStore(pool), provider: costly, rpc, payer: { address: payer.address, signTransaction: tx => payer.signTransaction(tx) } });
    await expect(pricey.quote(session, { chainIds: [84532] })).rejects.toMatchObject({ code: "WALLET_NETWORKS_QUOTE_UNSUPPORTED" });
    expect((await pricey.list(session)).offered.map(item => item.chainId)).toContain(84532);
  });
});
