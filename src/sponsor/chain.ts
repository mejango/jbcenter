import { parseAbi, type Address, type Hex, type TransactionSerializableEIP1559, type TypedDataDefinition } from "viem";
import type { Intent } from "../types.js";

export { CREATE_TOPIC } from "../deploymentVerifier.js";

export const PROJECTS_ABI = parseAbi(["function creationFee() view returns (uint256)"]);

export type SponsorSigner = {
  address: Address;
  signTransaction(tx: TransactionSerializableEIP1559): Promise<Hex>;
  signTypedData(args: TypedDataDefinition): Promise<Hex>;
};

export type LaneReport = {
  sent(chainId: number, transactionHash: Hex, bundleUuid: string): Promise<void>;
  confirmed(chainId: number, transactionHash: Hex, projectId: string, spentWei: bigint): Promise<void>;
  failed(chainId: number, error: string): Promise<void>;
};

export type DeployLane = {
  deploy(intent: Intent, chainIds: number[], report: LaneReport): Promise<void>;
};
