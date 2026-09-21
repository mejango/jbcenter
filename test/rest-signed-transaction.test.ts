import { describe, expect, it } from "vitest";
import { concatHex, fromRlp, keccak256, parseSignature, parseTransaction, recoverTransactionAddress, toRlp, type Hex, type TransactionSerialized } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RestCall } from "../src/rest/core.js";
import { validateSignedTransaction } from "../src/rest/transactions/signed.js";
import type { RelayPolicy } from "../src/rest/transactions/types.js";

// Public deterministic fixture only; never use this key for real funds.
const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);
const call: RestCall = { chainId: 8453, to: "0x2222222222222222222222222222222222222222", data: "0x1234", value: "0",
  label: "Canonical envelope fixture", dependsOn: [], decoded: null };
const policy: RelayPolicy = { allowedChainIds: [8453], maximumRawBytes: 131_072, maximumGas: 1_000_000n,
  maximumFeePerGas: 100_000_000_000n, maximumTransactionCost: 1_000_000_000_000_000_000n,
  planTtlMs: 300_000, maximumPlanTtlMs: 1_800_000, leaseMs: 15_000, rpcTimeoutMs: 10_000, confirmations: 2 };
const kinds = ["legacy", "eip2930", "eip1559"] as const;
type Kind = typeof kinds[number];
async function signed(type: Kind, zeroFee = false): Promise<Hex> {
  const base = { chainId: 8453, nonce: 1, gas: 100_000n, to: call.to, data: call.data, value: 0n };
  if (type === "legacy") return owner.signTransaction({ ...base, type, gasPrice: zeroFee ? 0n : 1_000_000_000n });
  if (type === "eip2930") return owner.signTransaction({ ...base, type, gasPrice: zeroFee ? 0n : 1_000_000_000n, accessList: [] });
  return owner.signTransaction({ ...base, type, maxFeePerGas: zeroFee ? 0n : 1_000_000_000n,
    maxPriorityFeePerGas: zeroFee ? 0n : 1n, accessList: [] });
}
function changeField(raw: Hex, type: Kind, field: "nonce" | "value" | "accessList", replacement: Hex): Hex {
  const indices = { legacy: { nonce: 0, value: 4, accessList: -1 },
    eip2930: { nonce: 1, value: 5, accessList: 7 }, eip1559: { nonce: 1, value: 6, accessList: 8 } };
  const fields = fromRlp(type === "legacy" ? raw : `0x${raw.slice(4)}`, "hex") as Hex[];
  fields[indices[type][field]] = replacement;
  return type === "legacy" ? toRlp(fields) : concatHex([raw.slice(0, 4) as Hex, toRlp(fields)]);
}

describe("shared signed relay accepts canonical bytes only", () => {
  it.each(kinds)("preserves exact canonical %s bytes and recovered identity", async type => {
    const raw = await signed(type), result = await validateSignedTransaction(raw, call, owner.address, policy);
    expect(result.rawTransaction).toBe(raw); expect(result.hash).toBe(keccak256(raw));
    expect(result.sender.toLowerCase()).toBe(owner.address.toLowerCase());
    expect(result.type).toBe(type); expect(result.nonce).toBe("1");
  });

  it.each(kinds)("accepts canonical zero fee quantities in %s without inventing a positive fee", async type => {
    const raw = await signed(type, true), result = await validateSignedTransaction(raw, call, owner.address, policy);
    expect(result.rawTransaction).toBe(raw); expect(result.maximumFeePerGas).toBe("0"); expect(result.maximumCost).toBe("0");
    if (type === "eip1559") expect(result.priorityFeePerGas).toBe(0n); else expect(result.gasPrice).toBe(0n);
  });

  it("accepts a canonical zero priority fee with a positive maximum fee", async () => {
    const raw = await owner.signTransaction({ type: "eip1559", chainId: 8453, nonce: 1, gas: 100_000n,
      to: call.to, data: call.data, value: 0n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 0n, accessList: [] });
    expect(parseTransaction(raw).maxPriorityFeePerGas).toBeUndefined();
    const result = await validateSignedTransaction(raw, call, owner.address, policy);
    expect(result.priorityFeePerGas).toBe(0n); expect(result.maximumFeePerGas).toBe("1000000000");
  });

  for (const type of kinds) {
    it.each(["nonce", "value"] as const)(`rejects a noncanonical ${type} %s even when recovery returns the expected signer`, async field => {
      const original = await signed(type), malformed = changeField(original, type, field, field === "nonce" ? "0x0001" : "0x00");
      expect(malformed).not.toBe(original);
      expect((await recoverTransactionAddress({ serializedTransaction: malformed as TransactionSerialized })).toLowerCase()).toBe(owner.address.toLowerCase());
      await expect(validateSignedTransaction(malformed, call, owner.address, policy)).rejects.toMatchObject({ code: "INVALID_SIGNED_TRANSACTION" });
    });
  }

  it.each(["eip2930", "eip1559"] as const)("rejects %s empty access list encoded as a byte string", async type => {
    const malformed = changeField(await signed(type), type, "accessList", "0x");
    expect((await recoverTransactionAddress({ serializedTransaction: malformed as TransactionSerialized })).toLowerCase()).toBe(owner.address.toLowerCase());
    await expect(validateSignedTransaction(malformed, call, owner.address, policy)).rejects.toMatchObject({ code: "INVALID_SIGNED_TRANSACTION" });
  });

  it.each(["eip2930", "eip1559"] as const)("rejects a genuinely signed %s nested storage-key list", async type => {
    type RlpNode = Hex | RlpNode[];
    const original = await signed(type), prefix = original.slice(0, 4) as Hex;
    const unsigned = (fromRlp(`0x${original.slice(4)}`, "hex") as RlpNode[]).slice(0, -3);
    unsigned[type === "eip2930" ? 7 : 8] = [[call.to, [Array<Hex>(66).fill("0x01")]]];
    const signature = parseSignature(await owner.sign({ hash: keccak256(concatHex([prefix, toRlp(unsigned)])) }));
    const scalar = (value: Hex): Hex => `0x${value.slice(2).replace(/^(00)+/, "")}`;
    const malformed = concatHex([prefix, toRlp([...unsigned, signature.yParity === 0 ? "0x" : "0x01", scalar(signature.r), scalar(signature.s)])]);
    expect((await recoverTransactionAddress({ serializedTransaction: malformed as TransactionSerialized })).toLowerCase()).toBe(owner.address.toLowerCase());
    await expect(validateSignedTransaction(malformed, call, owner.address, policy))
      .rejects.toMatchObject({ code: "INVALID_SIGNED_TRANSACTION", status: 400 });
  });

  it.each(["eip2930", "eip1559"] as const)("preserves valid %s access-list keys including leading zero bytes", async type => {
    const accessList = [{ address: call.to, storageKeys: [`0x${"00".repeat(32)}`, `0x${"00".repeat(31)}01`] as Hex[] }];
    const base = { chainId: 8453, nonce: 1, gas: 100_000n, to: call.to, data: call.data, value: 0n, accessList };
    const raw = type === "eip2930" ? await owner.signTransaction({ ...base, type, gasPrice: 1n })
      : await owner.signTransaction({ ...base, type, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n });
    const result = await validateSignedTransaction(raw, call, owner.address, policy);
    expect(result.accessList).toEqual(accessList); expect(result.rawTransaction).toBe(raw);
  });

  for (const scalar of ["r", "s"] as const) {
    it.each(["empty", "list"] as const)(`rejects a legacy ${scalar} %s with a controlled signature error`, async encoding => {
      const fields = fromRlp(await signed("legacy"), "hex") as Array<Hex | Hex[]>;
      fields[scalar === "r" ? 7 : 8] = encoding === "empty" ? "0x" : ["0x01", "0x02"];
      await expect(validateSignedTransaction(toRlp(fields), call, owner.address, policy))
        .rejects.toMatchObject({ code: "INVALID_TRANSACTION_SIGNATURE", status: 400 });
    });
  }

  it("keeps valid hexadecimal letter casing unchanged while comparing byte canonicality", async () => {
    const lower = await signed("eip1559"), raw = `0x${lower.slice(2).toUpperCase()}` as Hex;
    const result = await validateSignedTransaction(raw, call, owner.address, policy);
    expect(result.rawTransaction).toBe(raw); expect(result.hash).toBe(keccak256(lower));
  });
});
