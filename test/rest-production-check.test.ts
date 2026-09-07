import { describe, expect, it, vi } from "vitest";

const { prepareCheck } = await import(new URL("../scripts/rest/production-check.mjs", import.meta.url).href);
const wallet = "0x1111111111111111111111111111111111111111";
const target = "0xf92AC1aB5A00033E35a3975739124F61928C36B0";
const blockHash = `0x${"22".repeat(32)}`;

describe("read-only production check preparation", () => {
  it("prepares only a zero-value empty self-permission call after canonical reads", async () => {
    for (const chainId of [1, 10, 8453, 42161]) {
      const read = vi.fn().mockResolvedValue({ address: target, outputs: [{ value: "0" }], evidence: [{ chainId, blockHash, blockNumber: "100" }] });
      const prepare = vi.fn().mockResolvedValue({ calls: [] });
      const request = vi.fn().mockResolvedValue("0x6000");
      const result = await prepareCheck(chainId, wallet, { read, prepare }, { request });
      expect(request).toHaveBeenCalledExactlyOnceWith(chainId, "eth_getCode", [wallet, { blockHash, requireCanonical: true }], expect.any(AbortSignal));
      expect(result.input.calls).toEqual([{ chainId, contractId: "@bananapus/core-v6:src/JBPermissions.sol:JBPermissions", address: target, function: "setPermissionsFor(address,(address,uint64,uint8[]))", args: [wallet, { operator: wallet, projectId: "0", permissionIds: [] }], value: "0" }]);
      expect(prepare).toHaveBeenCalledExactlyOnceWith(result.input, expect.any(AbortSignal));
    }
  });

  it("does not prepare when permissions exist, canonical evidence is unavailable, or the wallet is undeployed", async () => {
    const prepare = vi.fn();
    const request = vi.fn().mockResolvedValue("0x");
    for (const value of ["1", "256", undefined]) {
      await expect(prepareCheck(8453, wallet, { read: async () => ({ outputs: [{ value }] }), prepare }, { request })).rejects.toThrow("Self permissions are not zero");
    }
    await expect(prepareCheck(8453, wallet, { read: async () => { throw new Error("canonical read unavailable"); }, prepare }, { request })).rejects.toThrow("canonical read unavailable");
    expect(request).not.toHaveBeenCalled();
    const read = async () => ({ address: target, outputs: [{ value: "0" }], evidence: [{ chainId: 8453, blockHash }] });
    await expect(prepareCheck(8453, wallet, { read, prepare }, { request })).rejects.toThrow("not deployed");
    request.mockRejectedValue(new Error("canonical wallet read unavailable"));
    await expect(prepareCheck(8453, wallet, { read, prepare }, { request })).rejects.toThrow("canonical wallet read unavailable");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects another chain or invalid wallet before any network access", async () => {
    const read = vi.fn();
    for (const [chainId, address] of [[137, wallet], [1, "0x0"], [1, `0x${"0".repeat(40)}`]]) {
      await expect(prepareCheck(chainId, address, { read }, {})).rejects.toThrow();
    }
    expect(read).not.toHaveBeenCalled();
  });
});
