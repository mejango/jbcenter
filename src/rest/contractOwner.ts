import { decodeFunctionResult, encodeFunctionData, type Hex } from "viem";
import type { ContractOwnerVerifier } from "./auth/index.js";
import type { RestRpc } from "./core.js";

const ABI = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ type: "bytes4" }],
  },
] as const;

/** Bounded EIP-1271 check on an already deployed owner account. Never deploys a wallet. */
export function createContractOwnerVerifier(
  rpc: RestRpc,
  chainIds: readonly number[],
): ContractOwnerVerifier {
  return async ({
    ownerAddress,
    authorityChainId,
    digest,
    signature,
    signal,
  }) => {
    if (!chainIds.includes(authorityChainId)) return false;
    const deadline = AbortSignal.any([
      AbortSignal.timeout(5_000),
      ...(signal ? [signal] : []),
    ]);
    try {
      const block = await rpc.request(
        authorityChainId,
        "eth_getBlockByNumber",
        ["latest", false],
        deadline,
      );
      const hash =
        block && typeof block === "object"
          ? (block as { hash?: unknown }).hash
          : undefined;
      if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash))
        return false;
      const tag = { blockHash: hash, requireCanonical: true };
      const code = await rpc.request(
        authorityChainId,
        "eth_getCode",
        [ownerAddress, tag],
        deadline,
      );
      if (typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code))
        return false;
      const result = await rpc.request(
        authorityChainId,
        "eth_call",
        [
          {
            to: ownerAddress,
            data: encodeFunctionData({
              abi: ABI,
              functionName: "isValidSignature",
              args: [digest, signature],
            }),
            gas: "0x7a120",
          },
          tag,
        ],
        deadline,
      );
      if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result))
        return false;
      return (
        decodeFunctionResult({
          abi: ABI,
          functionName: "isValidSignature",
          data: result as Hex,
        }) === "0x1626ba7e"
      );
    } catch {
      return false;
    }
  };
}
