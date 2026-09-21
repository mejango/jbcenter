import type { Address, Hex } from "viem";
import type { RestActor } from "../core.js";
import type { StoredPlan } from "./types.js";

/** Extension contract only. The direct signed-transaction service implements none of these methods. */
export interface SmartAccountTransportAdapter {
  readonly kind: "eip4337-user-operation";
  capabilities(chainId: number): Promise<{
    available: boolean;
    entryPoint?: Address;
    entryPointVersion?: "0.6" | "0.7" | "0.8";
    accountImplementations: Address[];
    sponsorship: {
      available: boolean;
      policyId?: string;
      paymasters: Address[];
    };
    onchainSessionAuthorization: boolean;
  }>;
  /** Must bind all owner approvals and any sponsor/session policy to exact execution bytes. */
  validate(input: {
    actor: RestActor;
    plan: StoredPlan;
    stepIndices: readonly number[];
    chainId: number;
    entryPoint: Address;
    userOperation: Readonly<Record<string, unknown>>;
    ownerApproval: { signature: Hex; commitment: Hex; expiresAt: number };
  }): Promise<{
    userOperationHash: Hex;
    sender: Address;
    nonce: string;
    commitment: Hex;
    expiresAt: number;
    sponsorPolicyId?: string;
    maximumOwnerCost: string;
  }>;
  /** A durable reservation and active-authority claim must precede transport dispatch. */
  dispatch(
    validatedUserOperationHash: Hex,
  ): Promise<{ userOperationHash: Hex }>;
}
