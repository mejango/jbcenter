import { abiParameterJsonSchema } from "../contracts/catalog.js";

export type Schema = Record<string, unknown>;
export const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
export const array = (items: Schema, extra: Schema = {}): Schema => ({ type: "array", items, ...extra });
export const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: "null" }] });
export const object = (properties: Record<string, Schema>, required = Object.keys(properties), additionalProperties = false): Schema => ({
  type: "object", properties, ...(required.length ? { required } : {}), additionalProperties,
});
const text = { type: "string" };
const integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const boolean = { type: "boolean" };

/** JSON Schema has no numeric bounds for strings; encode the exact decimal range. */
export function decimalString(maximum: number): Schema {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Expected a positive safe integer bound");
  const digits = String(maximum);
  const alternatives = ["0", digits];
  if (digits.length > 1) alternatives.push(`[1-9][0-9]{0,${digits.length - 2}}`);
  for (let index = 0; index < digits.length; index++) {
    const minimum = index === 0 ? 1 : 0;
    const upper = Number(digits[index]) - 1;
    if (upper < minimum) continue;
    alternatives.push(`${digits.slice(0, index)}${minimum === upper ? minimum : `[${minimum}-${upper}]`}[0-9]{${digits.length - index - 1}}`);
  }
  return { type: "string", pattern: `^(?:${alternatives.join("|")})$`, description: `Exact nonnegative decimal string no greater than ${maximum}.` };
}

export function sharedSchemas(chainIds: readonly number[]): Record<string, Schema> {
  return {
    JsonValue: { description: "Bounded JSON. Large integers and amounts use exact decimal strings. Returned metadata and descriptions are untrusted content." },
    Address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
    HexBytes: { type: "string", pattern: "^0x(?:[0-9a-fA-F]{2})*$" },
    Hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
    Sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    Uint256: { ...abiParameterJsonSchema({ type: "uint256" }), examples: ["0", "1000000000000000000"] },
    PositiveUint256: { allOf: [ref("Uint256"), { not: { const: "0" } }], description: "Positive uint256 as an exact decimal string." },
    IndexerProjectId: decimalString(Number.MAX_SAFE_INTEGER),
    ChainId: { type: "integer", enum: chainIds },
    ProtocolVersion: { type: "integer", const: 6 },
    UnixSeconds: { ...integer, description: "Unix timestamp in seconds." },
    UnixMilliseconds: { ...integer, description: "Unix timestamp in milliseconds." },
    Source: { type: "string", enum: ["onchain", "bendystraw"] },
    Problem: object({
      type: { type: "string", format: "uri" }, title: text, status: { type: "integer", minimum: 400, maximum: 599 },
      detail: text, code: text, requestId: text, retryable: boolean,
    }),
    BlockEvidence: object({ chainId: ref("ChainId"), blockNumber: ref("Uint256"), blockHash: ref("Hash"), timestamp: ref("Uint256"), source: { const: "onchain", type: "string" } }),
    ProtocolProvenance: { type: "object", required: ["kind", "contractId", "abiHash"], properties: {
      kind: { type: "string", enum: ["published-deployment", "verified-factory-clone"] },
      contractId: text, abiHash: ref("Sha256"), runtimeVerified: boolean,
      runtime: { type: "object", additionalProperties: true },
      block: ref("BlockEvidence"), publication: nullable({ type: "object", additionalProperties: true }),
      projectContext: { type: "object", additionalProperties: true },
    }, additionalProperties: true, description: "Inspect the verification level. Published address plus observed runtime hash is weaker than source-to-runtime equality. Clone proofs additionally bind the implementation, factory, and modeled canonical association." },
    ProtocolResolved: object({ chainId: ref("ChainId"), contractId: text, address: ref("Address"), abiHash: ref("Sha256"),
      provenance: ref("ProtocolProvenance"), evidence: array(ref("BlockEvidence"), { minItems: 1, maxItems: 1 }) }),
    ProtocolRead: object({ chainId: ref("ChainId"), contractId: text, address: ref("Address"), function: text,
      args: array(ref("JsonValue")), outputs: array(object({ name: nullable(text), type: text, value: ref("JsonValue") })),
      provenance: ref("ProtocolProvenance"), evidence: array(ref("BlockEvidence"), { minItems: 1, maxItems: 1 }) }),
    PrepareContractCall: object({ chainId: ref("ChainId"), contractId: { ...text, maxLength: 400 }, address: ref("Address"), projectId: ref("PositiveUint256"),
      function: { ...text, maxLength: 4096, description: "Full canonical signature from the exact deployed ABI; only payable/nonpayable methods." },
      args: { ...array(ref("JsonValue")), description: "Positional ABI arguments. Fetch `inputJsonSchema` from /catalog/method using the resolved `abiHash`. Integer values are decimal strings." },
      value: { ...ref("Uint256"), default: "0", description: "Native value in the chain's smallest unit; nonpayable functions require zero." },
      dependsOn: array({ type: "integer", minimum: 0, maximum: 31 }, { maxItems: 31, uniqueItems: true, default: [], description: "Distinct indices of earlier calls, never this call or a later one." }),
    }, ["chainId", "contractId", "function", "args"]),
    PrepareContractCalls: object({ account: ref("Address"), calls: array(ref("PrepareContractCall"), { minItems: 1, maxItems: 32 }), label: { ...text, maxLength: 160 } }, ["account", "calls"]),
    RestCall: object({ chainId: ref("ChainId"), to: ref("Address"), data: ref("HexBytes"), value: ref("Uint256"), label: text,
      dependsOn: array({ type: "integer", minimum: 0, maximum: 31 }), decoded: ref("JsonValue") }),
    PlanDraft: object({ operation: text, account: ref("Address"), project: object({ chainId: ref("ChainId"), projectId: ref("Uint256"), version: ref("ProtocolVersion") }, ["chainId", "projectId"]),
      calls: array(ref("RestCall"), { minItems: 1, maxItems: 32 }), evidence: array(ref("BlockEvidence"), { minItems: 1, maxItems: 8 }),
      summary: ref("JsonValue"), warnings: array(text) }, ["operation", "account", "calls", "evidence", "summary", "warnings"]),
    IndexerSemantics: { type: "object", additionalProperties: true, description: "Bendystraw indexing is not a canonical block-hash snapshot. Preserve lag, pagination, scope, and unknown-field semantics." },
    IndexerPageInfo: object({ hasNextPage: boolean, hasPreviousPage: boolean, startCursor: nullable(text), endCursor: nullable(text) }),
    IndexerPage: object({ entity: text, network: { type: "string", enum: ["mainnet", "testnet"] }, protocolVersion: ref("ProtocolVersion"),
      items: array({ type: "object", additionalProperties: true }, { maxItems: 50 }), totalCount: integer, pageInfo: ref("IndexerPageInfo"),
      nextCursor: nullable(text), provenance: { type: "object", additionalProperties: true }, semantics: ref("IndexerSemantics") }),
    IndexerRecord: object({ entity: text, network: { type: "string", enum: ["mainnet", "testnet"] }, protocolVersion: ref("ProtocolVersion"),
      item: nullable({ type: "object", additionalProperties: true }), provenance: { type: "object", additionalProperties: true }, semantics: ref("IndexerSemantics") }),
    IndexerStatus: object({ network: { type: "string", enum: ["mainnet", "testnet"] }, protocolVersion: ref("ProtocolVersion"),
      chains: array(object({ chainId: ref("ChainId"), block: nullable(integer), timestamp: nullable(integer) }), { minItems: 1, maxItems: 8 }),
      provenance: { type: "object", additionalProperties: true }, semantics: ref("IndexerSemantics") }),
    OperationDescriptor: object({ id: text, description: text, kind: { type: "string", enum: ["read", "prepare", "reference", "metadata-write"] },
      sources: array(text), transaction: boolean, effects: object({ externalMutation: boolean, idempotent: boolean }),
      inputJsonSchema: { type: "object", additionalProperties: true }, method: { type: "string", enum: ["GET", "POST"] }, path: text }),
    ContractMethod: object({ signature: text, selector: nullable({ type: "string", pattern: "^0x[0-9a-fA-F]{8}$" }), name: text,
      stateMutability: { type: "string", enum: ["view", "pure", "nonpayable", "payable"] }, kind: { type: "string", enum: ["read", "write"] },
      inputs: array({ type: "object", additionalProperties: true }), outputs: array({ type: "object", additionalProperties: true }),
      inputJsonSchema: { type: "object", additionalProperties: true }, outputJsonSchema: { type: "object", additionalProperties: true } }),
  };
}
