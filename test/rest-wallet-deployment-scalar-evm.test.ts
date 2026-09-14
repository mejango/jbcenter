import { secp256k1 } from "@noble/curves/secp256k1";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { keccak256, padHex, parseTransaction, serializeTransaction, toHex, type Hex, type TransactionSerializableEIP1559 } from "viem";
import type { RestRpc } from "../src/rest/core.js";
import { createWalletDeploymentChain } from "../src/rest/wallet/deploymentChain.js";
import { validateSignedWalletDeployment } from "../src/rest/wallet/deployment.js";
import { walletDeploymentRelayPolicy } from "../src/rest/wallet/deploymentPostgres.js";
import type { WalletDeploymentExecutionContext } from "../src/rest/wallet/deploymentDispatch.js";
import { startWalletDeploymentAnvil } from "./fixtures/wallet-deployment-anvil.js";

describe("actual Anvil transaction signature scalar representations", () => {
  let fixture: Awaited<ReturnType<typeof startWalletDeploymentAnvil>>, base: WalletDeploymentExecutionContext;
  const candidates = new Map<"r" | "s", Hex>();
  // Public default Anvil key. Alternative signatures vary only test entropy, never frozen fields.
  const privateKey = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  beforeAll(async () => {
    fixture = await startWalletDeploymentAnvil(); base = await fixture.signedContext();
    const tx = base.operation.template!.transaction;
    const unsigned: TransactionSerializableEIP1559 = { type: "eip1559", chainId: 8453, to: tx.to, data: tx.data, value: 0n,
      nonce: Number(tx.nonce), gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas), accessList: [] };
    const digest = keccak256(serializeTransaction(unsigned));
    // Select the required property explicitly. A random ordinary signature must never accidentally
    // turn this regression into a passing even-length test. At most512 local signatures, no RPC loop.
    for (let index = 0; index < 512 && candidates.size !== 2; index++) {
      const extraEntropy = new Uint8Array(32); new DataView(extraEntropy.buffer).setUint32(28, index);
      const signature = secp256k1.sign(digest.slice(2), privateKey, { lowS: true, extraEntropy });
      if (signature.recovery !== 0 && signature.recovery !== 1) continue;
      const raw = serializeTransaction(unsigned, { r: toHex(signature.r, { size: 32 }), s: toHex(signature.s, { size: 32 }), yParity: signature.recovery });
      for (const field of ["r", "s"] as const) if (!candidates.has(field) && signature[field].toString(16).length === 63) candidates.set(field, raw);
    }
    expect([...candidates.keys()].sort()).toEqual(["r", "s"]);
    for (const rawTransaction of candidates.values()) await validateSignedWalletDeployment({ enrollment: base.enrollment,
      approval: base.operation.approval, template: base.operation.template!, rawTransaction, policy: walletDeploymentRelayPolicy(fixture.configuration) });
  }, 30000);
  beforeEach(async () => { await fixture.reset(); });
  afterAll(async () => { await fixture?.close(); });

  async function broadcast(field: "r" | "s") {
    const context = structuredClone(base), rawTransaction = candidates.get(field)!, hash = keccak256(rawTransaction);
    context.operation.signed = { ...context.operation.signed!, rawTransaction, hash };
    context.operation.observation = null; context.operation.observationSavedAt = null; context.operation.highestObservedHead = null;
    expect(await fixture.rpc("eth_sendRawTransaction", [rawTransaction])).toBe(hash);
    let receipt: { status: Hex } | null = null;
    for (let i = 0; i < 100; i++) {
      receipt = await fixture.rpc("eth_getTransactionReceipt", [hash]); if (receipt) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(receipt?.status).toBe("0x1");
    const actual = await fixture.rpc<Record<"r" | "s", Hex>>("eth_getTransactionByHash", [hash]);
    expect(actual[field].length).toBe(65); // Prefix plus63 actual quantity digits from the node.
    expect(BigInt(actual[field])).toBe(BigInt(parseTransaction(rawTransaction)[field]!));
    return { context, actual };
  }
  async function observe(context: WalletDeploymentExecutionContext, override?: (value: Record<string, unknown>) => Record<string, unknown>) {
    const rpc: RestRpc = { async request(chain, method, params, signal) {
      const result = await fixture.readOnlyRpc.request(chain, method, params, signal);
      return method === "eth_getTransactionByHash" && result && override ? override(result as Record<string, unknown>) : result;
    } };
    return createWalletDeploymentChain({ rpc, configuration: fixture.configuration, manifest: fixture.manifest, utility: fixture.utility }).observeSigned(context);
  }

  it.each(["r", "s"] as const)("recognizes a real mined transaction with an odd minimal %s scalar", async field => {
    const { context } = await broadcast(field), original = context.operation.signed!.rawTransaction;
    const observed = await observe(context);
    expect(observed.transaction.state).toBe("canonical-success"); expect(observed.wallet.state).toBe("verified");
    expect(observed.transactionHash).toBe(keccak256(original)); expect(context.operation.signed!.rawTransaction).toBe(original);
  });

  it.each(["r", "s"] as const)("accepts equivalent fixed32-byte %s padding without changing the signed envelope", async field => {
    const { context } = await broadcast(field), original = context.operation.signed!.rawTransaction;
    const observed = await observe(context, value => ({ ...value, r: padHex(value.r as Hex, { size: 32 }), s: padHex(value.s as Hex, { size: 32 }) }));
    expect(observed.transaction.state).toBe("canonical-success"); expect(observed.wallet.state).toBe("verified");
    expect(observed.transactionHash).toBe(keccak256(original)); expect(context.operation.signed!.rawTransaction).toBe(original);
  });

  const malformed: [string, unknown][] = [["empty", "0x"], ["zero quantity", "0x0"], ["zero fixed32", `0x${"00".repeat(32)}`],
    ["overlong", `0x1${"ab".repeat(32)}`], ["short noncanonical padding", "0x01"], ["nonhex", "0xgg"],
    ["missing prefix", "1"], ["number", 1], ["null", null], ["different valid quantity", "0x1"]];
  it.each((["r", "s"] as const).flatMap(field => malformed.map(([name, value]) => ({ field, name, value }))))
    ("keeps $field $name unknown despite an actual successful transaction", async ({ field, value }) => {
      const { context } = await broadcast(field), original = context.operation.signed!.rawTransaction;
      const observed = await observe(context, current => ({ ...current, r: padHex(current.r as Hex, { size: 32 }),
        s: padHex(current.s as Hex, { size: 32 }), [field]: value }));
      expect(observed.transaction.state).toBe("unknown"); expect(observed.wallet.state).toBe("unknown");
      expect(observed.transaction.receipt).toBeNull(); expect(context.operation.signed!.rawTransaction).toBe(original);
    });
});
