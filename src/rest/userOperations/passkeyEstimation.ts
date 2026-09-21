import { encodeAbiParameters, toHex, type Address } from "viem";
import { encodeSafe7579PasskeyOwnerSignature } from "../smartAccounts/passkeySignatures.js";
import type { UserOperationProvider } from "./provider.js";
import { uoQuantity } from "./codec.js";

// The v1 browser profile permits 37 authenticator bytes and 2,048 client JSON bytes.
// Canonical ABI encoding is at most 2,240 bytes, plus Safe's 97-byte contract entry
// and its 12-byte validity prefix. Actual signatures must stay within this review.
export const PASSKEY_MAX_CONTRACT_SIGNATURE_BYTES = 2240;
export const PASSKEY_MAX_SIGNATURE_BYTES = 2349;

/** Public synthetic assertion scalars, matching the maximum-length compatibility fixture.
 * Both are in range, nonzero and execute FCL verification instead of its scalar shortcut.
 * They confer no authority for the prepared operation. A bundler unable to estimate this
 * rejecting path must fail preparation; these bytes are never a gas estimate or an approval.
 */
export function passkeyDummyContractSignature() {
  const prefix = '"origin":"https://wallet.juicebox.center","crossOrigin":false,"extra":"';
  return encodeAbiParameters(
    [{ type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }],
    [
      "0xf601a108a99c062e5d14465ee3e0b3ea707d11ee06b45234c38ea217477234711d00000000",
      `${prefix}${"x".repeat(1966 - prefix.length - 1)}"`,
      0x23da3aa2b019186239bff15b0e097da5f3c61d48c4bae3028540105ac15691een,
      0xcfc4a19ea181c8cb4e2a50e2b9e579cdb4574700d273740fc1d4d2d9bcd64037n,
    ],
  );
}

export function passkeyDummySignature(input: { signer: Address; validAfter: string; validUntil: string }) {
  return encodeSafe7579PasskeyOwnerSignature({ ...input,
    signatures: [{ kind: "contract", owner: input.signer, signature: passkeyDummyContractSignature() }],
  });
}

/** An unchanged provider estimate remains mandatory. The extra EVM calldata charge covers every
 * signature byte changing from zero (4 gas) to nonzero (16 gas), including its validity words.
 * It is applied to each independent estimate, never accumulated onto prior quote gas fields.
 * This does not bound rollup L1 data fees or FCL computation for every credential/digest.
 * The exact signed operation still needs provider gas evidence and canonical preflight.
 */
export function passkeyEstimateProvider(
  provider: Pick<UserOperationProvider, "estimate" | "sponsor">,
  maximumVerificationGas: bigint,
): Pick<UserOperationProvider, "estimate" | "sponsor"> {
  return {
    sponsor: (...args) => provider.sponsor(...args),
    estimate: async (...args) => {
      const estimate = await provider.estimate(...args);
      // The dummy signature does not exercise the real WebAuthn parse and P256 check, and the
      // bundler's estimate is the bare minimum for its own simulation; a production signature
      // starved the P256 call at that exact limit (AA24). Unused verification gas is refunded.
      const verification = uoQuantity(estimate.verificationGasLimit, "estimated verification gas");
      const roomy = verification + verification / 2n + 50_000n;
      return { ...estimate,
        verificationGasLimit: toHex(roomy > maximumVerificationGas ? maximumVerificationGas : roomy),
        preVerificationGas: toHex(
          uoQuantity(estimate.preVerificationGas, "estimated pre-verification gas") + 12n * BigInt(PASSKEY_MAX_SIGNATURE_BYTES),
        ) };
    },
  };
}
