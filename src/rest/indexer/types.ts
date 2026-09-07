import { RestError } from "../core.js";

export interface IndexerField {
  type: string;
  namedType: string;
  kind: "scalar" | "enum" | "object";
  list: boolean;
  nonNull: boolean;
  args: Record<string, string>;
}

export interface IndexerEntity {
  name: string;
  listField: string;
  singleArgs: Record<string, string>;
  filterType: string;
  supported: boolean;
  unsupportedReason?: string;
  classification: string;
}

export interface IndexerSchemaMetadata {
  provenance: Record<string, unknown>;
  entities: Record<string, IndexerEntity>;
  objects: Record<string, Record<string, IndexerField>>;
  inputs: Record<string, Record<string, string>>;
  enums: Record<string, string[]>;
}

export type IndexerNetwork = "mainnet" | "testnet";
export interface IndexerReadInput {
  network: IndexerNetwork;
  chainId?: number;
  projectId?: string;
  id?: string | Record<string, string | number>;
  filters?: Record<string, unknown>;
  fields?: string[];
  orderBy?: { field: string; direction?: "asc" | "desc" };
  limit?: number;
  cursor?: string;
}

export interface IndexerFetchOptions {
  method: "POST";
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, unknown> };
  signal: AbortSignal;
  maxBytes: number;
  timeoutMs: number;
}
export type IndexerFetchJson = (
  url: string,
  options: IndexerFetchOptions,
) => Promise<unknown>;
export interface IndexerServiceOptions {
  mainnetUrl?: string;
  testnetUrl?: string;
  /** Operator-owned credentials. Never accept these from request parameters. */
  headers?: Readonly<Record<string, string>>;
  networkHeaders?: Partial<
    Record<IndexerNetwork, Readonly<Record<string, string>>>
  >;
  fetchJson?: IndexerFetchJson;
}

export const INDEXER_LIMITS = Object.freeze({
  maxRows: 50,
  defaultRows: 20,
  maxFields: 48,
  maxSelectionNodes: 96,
  maxRelationDepth: 2,
  maxFilterDepth: 3,
  maxFilterNodes: 40,
  maxFilterArray: 20,
  maxStringBytes: 32_768,
  maxInputString: 2_048,
  maxCursorBytes: 4_096,
  maxResponseBytes: 2 * 1024 * 1024,
  maxJsonDepth: 12,
  maxJsonNodes: 16_384,
  maxScalarArray: 256,
  timeoutMs: 15_000,
});

/** Messages deliberately contain no upstream body, URL, GraphQL error text, or credential. */
export class IndexerError extends RestError {
  readonly retryable: boolean;
  constructor(
    code: string,
    message: string,
    status = 400,
    retryable = false,
  ) {
    super(status, code, message);
    this.name = "IndexerError";
    this.retryable = retryable;
  }
}
