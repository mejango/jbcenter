import { size, sliceHex } from "viem";
import { RestError } from "../core.js";
import { decodeSafe7579PasskeyOwnerSignature, safe7579PasskeyOwnerSigningPayload, verifySafeOwnerSignatures, type SafeContractSignatureVerifier } from "../smartAccounts/passkeySignatures.js";
import type { SmartAccountBinding, SmartAccountManifest } from "../smartAccounts/types.js";
import type { UserOperationChain } from "./chain.js";
import { PASSKEY_MAX_CONTRACT_SIGNATURE_BYTES, PASSKEY_MAX_SIGNATURE_BYTES } from "./passkeyEstimation.js";
import type { UserOperationV07 } from "./types.js";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Version selection requires the same canonically inspected state and server-owned manifest.
 * A manifest flag never turns legacy cached EOA evidence into passkey authority.
 */
export function userOperationPasskeyProfile(binding: SmartAccountBinding, manifest: SmartAccountManifest) {
  const profile = binding.state.ownerProfile;
  if (!profile && !manifest.ownerProfile) return undefined;
  if (profile?.version !== "center-passkey-v1" || manifest.ownerProfile?.version !== profile.version ||
      binding.wallet.chainId !== 8453 || binding.state.chainId !== 8453 || manifest.chainId !== 8453 ||
      binding.state.evidence.chainId !== 8453 || binding.state.threshold !== 1 || binding.state.owners.length !== 2 ||
      profile.signer.kind !== "contract" || profile.recoveryOwner.kind !== "ecdsa" ||
      same(profile.signer.address, profile.recoveryOwner.address) ||
      !binding.state.owners.some((owner) => same(owner, profile.signer.address)) ||
      !binding.state.owners.some((owner) => same(owner, profile.recoveryOwner.address)))
    throw new RestError(409, "USER_OPERATION_OWNER_PROFILE_CHANGED", "The current owner state must match the exact reviewed passkey profile.");
  return profile;
}

/** Verify Safe's legacy bytes selector, not its unrelated bytes32 selector. Every RPC uses
 * the same inspected canonical block, the existing bounded RPC budget/deadline, and a gas cap.
 * The later EntryPoint preflight and binding check remain mandatory before any nonce claim.
 */
export async function verifyPasskeyUserOperation(input: {
  operation: UserOperationV07; binding: SmartAccountBinding; manifest: SmartAccountManifest;
  chain: UserOperationChain; validAfter: string; validUntil: string;
  verifyContractSignature: SafeContractSignatureVerifier;
}) {
  const { binding, manifest, chain, operation } = input;
  const profile = userOperationPasskeyProfile(binding, manifest);
  if (!profile || !manifest.entryPoint) throw new RestError(409, "USER_OPERATION_OWNER_PROFILE_CHANGED", "A current passkey owner profile is required.");
  if (size(operation.signature) > PASSKEY_MAX_SIGNATURE_BYTES)
    throw new RestError(400, "USER_OPERATION_PASSKEY_SIGNATURE_LIMIT", "The signature exceeds the maximum shape covered by its approved gas estimate.");
  const entries = decodeSafe7579PasskeyOwnerSignature({ signature: operation.signature,
    validAfter: input.validAfter, validUntil: input.validUntil, threshold: binding.state.threshold });
  if (entries.some((entry) => entry.kind === "contract" && size(entry.signature) > PASSKEY_MAX_CONTRACT_SIGNATURE_BYTES))
    throw new RestError(400, "USER_OPERATION_PASSKEY_SIGNATURE_LIMIT", "The passkey body exceeds its approved gas estimate.");
  const payload = safe7579PasskeyOwnerSigningPayload({ operation, chainId: binding.wallet.chainId,
    entryPoint: manifest.entryPoint.address, safe7579: manifest.safe7579.address,
    validAfter: input.validAfter, validUntil: input.validUntil });
  const evidence = binding.state.evidence;
  await verifySafeOwnerSignatures({ ...payload, signatures: sliceHex(operation.signature, 12),
    owners: [profile.signer, profile.recoveryOwner], threshold: binding.state.threshold,
    verifyContractSignature: input.verifyContractSignature,
  });
  await chain.canonical(evidence);
}
