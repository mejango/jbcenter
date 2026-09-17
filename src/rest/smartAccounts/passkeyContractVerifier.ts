import { encodeFunctionData, parseAbi } from "viem";
import type { RestRpc } from "../core.js";
import { UserOperationChain } from "../userOperations/chain.js";
import type { SafeContractSignatureVerifier } from "./passkeySignatures.js";
import type { SmartAccountManifest, SmartAccountState } from "./types.js";

const ABI = parseAbi(["function isValidSignature(bytes data, bytes signature) view returns(bytes4)"]);
const MAGIC = `0x20c13b0b${"00".repeat(28)}`;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Safe v=0 verifies the signed preimage through the legacy bytes selector. Use only
 * server-owned, canonically inspected state. RPC count, timeout and call gas are bounded;
 * every dependency and result belongs to the same canonical block as the owner evidence.
 */
export function createPasskeyContractSignatureVerifier(input: {
  state: SmartAccountState; manifest: SmartAccountManifest; rpc: RestRpc;
  signal?: AbortSignal; now?: () => number;
}): SafeContractSignatureVerifier {
  const chain = new UserOperationChain(input.rpc, {
    ...(input.signal ? { signal: input.signal } : {}), ...(input.now ? { now: input.now } : {}),
  });
  return async ({ owner, signedData, signature }) => {
    const { state, manifest } = input, profile = state.ownerProfile;
    // Each refusal names its reason for the caller's log; none of them proves authority.
    if (profile?.version !== "center-passkey-v1" || manifest.ownerProfile?.version !== profile.version) throw new Error("profile-mismatch");
    if (state.chainId !== 8453 || state.evidence.chainId !== 8453 || manifest.chainId !== 8453) throw new Error("chain-mismatch");
    if (!same(owner, profile.signer.address) || !state.owners.some((address) => same(owner, address))) throw new Error("owner-mismatch");
    // The inspection that produced `state` proved each of these runtimes at the same block and
    // recorded them; a pin it did not record is read again at that block.
    const proven = (pin: { address: string; runtimeCodeHash: string }) =>
      state.codeHashes.some((entry) => same(entry.address, pin.address) && same(entry.runtimeCodeHash, pin.runtimeCodeHash));
    for (const pin of [profile.signer, manifest.ownerProfile.signerFactory,
      manifest.ownerProfile.signerSingleton, manifest.ownerProfile.p256Verifier])
      if (!proven(pin)) await chain.runtime(state.chainId, pin, state.evidence);
    const result = await chain.request(state.chainId, "eth_call", [{ to: owner,
      data: encodeFunctionData({ abi: ABI, functionName: "isValidSignature", args: [signedData, signature] }),
      gas: "0x1e8480",
    }, chain.tag(state.evidence)]);
    // Strict canonical ABI bytes4. Raw magic, bools, excess data or missing evidence fail closed.
    if (typeof result !== "string" || result.toLowerCase() !== MAGIC) throw new Error(`result:${String(result).slice(0, 10)}`);
    await chain.canonical(state.evidence);
    return true;
  };
}
