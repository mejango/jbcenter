import type { Address, Hex } from "viem";

export type JbcenterEnv = {
  Variables: {
    client: string;
    requestId: string;
    /** The public error code of a failed response, for the request log. */
    errorCode?: string;
    /** A bounded, data-free error message for the request log line. */
    errorDetail?: string;
    /** Time spent authenticating the signed request, for the request log line. */
    authMs?: number;
  };
};

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type DeploymentCall = {
  chainId: number;
  to: Address;
  data: Hex;
};

export type IntentEnvelope = {
  format: string;
  deploymentVersion: string;
  chainIds: number[];
  deploymentCalls: DeploymentCall[];
  jb: { [key: string]: Json };
};

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

export type IntentDeployStatus = "queued" | "sent" | "confirmed" | "failed";

export type IntentDeploy = {
  chainId: number;
  status: IntentDeployStatus;
  transactionHash: Hex | null;
  bundleUuid: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
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
  deploys: IntentDeploy[];
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
