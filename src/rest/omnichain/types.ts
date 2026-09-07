import type { IndexerReadService } from "../indexer/index.js";

export interface OmnichainProject {
  chainId: number;
  projectId: string;
  version: 6;
}
export type OmnichainSource = "onchain" | "bendystraw";
export interface OmnichainOptions {
  source: OmnichainSource;
  maxMembers?: number;
}
export type OmnichainObservation<T> =
  | { status: "known"; value: T }
  | { status: "unknown"; error: { code: string; message: string } };
export interface OmnichainMember {
  project: OmnichainProject;
  linkage: string;
  state: OmnichainObservation<Record<string, unknown>>;
  bridgeEvidence?: OmnichainObservation<Record<string, unknown>[]>;
}
export interface OmnichainOperations {
  execute(
    operation: "get_project" | "get_bridges",
    input: { project: OmnichainProject },
    options: { source: "onchain"; signal?: AbortSignal },
  ): Promise<unknown>;
}
export interface OmnichainDependencies {
  operations: OmnichainOperations;
  indexer: Pick<IndexerReadService, "read" | "list">;
}
export const OMNICHAIN_LIMITS = Object.freeze({
  maxMembers: 8,
  bridgesPerMember: 32,
  terminalsPerMember: 32,
  contextsPerTerminal: 32,
  movementsPerMember: 10,
  maxResponseBytes: 2 * 1024 * 1024,
  timeoutMs: 60_000,
});
