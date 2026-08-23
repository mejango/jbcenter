import type { Address, Hex } from "viem";

export type JbcenterEnv = {
  Variables: {
    client: string;
    requestId: string;
  };
};

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type DeploymentCall = {
  chainId: number;
  to: Address;
  data: Hex;
};

export type LegacyIntentEnvelope = {
  version: 1;
  format: string;
  deploymentVersion: string;
  chainIds: number[];
  jb: { [key: string]: Json };
};

export type CommittedIntentEnvelope = {
  version: 2;
  format: string;
  deploymentVersion: string;
  chainIds: number[];
  deploymentCalls: DeploymentCall[];
  jb: { [key: string]: Json };
};

export type IntentEnvelope = LegacyIntentEnvelope | CommittedIntentEnvelope;

export type IntentMetadata = {
  name: string;
  description: string | null;
  tagline: string | null;
  tags: string[];
  logoUri: string | null;
  owner: Address | null;
};

export type Deployment = {
  chainId: number;
  projectId: string;
  transactionHash: Hex;
  createdAt: string;
};

export type Intent = IntentMetadata & {
  id: string;
  status: "undeployed" | "deployed";
  contentHash: Hex;
  envelope: IntentEnvelope;
  publisher: Address;
  signature: Hex;
  createdAt: string;
  deployments: Deployment[];
};

export type SearchItem = IntentMetadata & {
  source: "jbcenter";
  status: "undeployed";
  intentId: string;
  contentHash: Hex;
  format: string;
  deploymentVersion: string;
  chainIds: number[];
  publisher: Address;
  createdAt: string;
};

export type SearchPage = {
  items: SearchItem[];
  totalCount: number;
  nextCursor: string | null;
};
