import type { ProtocolOperations } from "@juicebox/mcp/host";
import { isRestReadOperation, operationDescriptors } from "../app.js";
import type { ContractCatalog } from "../contracts/catalog.js";
import { REST_LIMITS, REST_PREFIX } from "../http.js";
import { INDEXER_SCHEMA } from "../indexer/generated.js";
import { INDEXER_LIMITS, type IndexerReadService } from "../indexer/index.js";
import { array, decimalString, nullable, object, ref, sharedSchemas, type Schema } from "./schemas.js";

export type OpenApiOperation = Record<string, unknown> & {
  operationId: string; summary: string; tags: string[];
  responses: Record<string, unknown>;
};
export interface OpenApiDocument {
  openapi: "3.1.2";
  jsonSchemaDialect: string;
  info: Record<string, unknown>;
  servers: { url: string }[];
  tags: { name: string; description: string }[];
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: { schemas: Record<string, Schema>; parameters: Record<string, Schema>; responses: Record<string, Schema> };
  [key: `x-${string}`]: unknown;
}
export interface BuildRestOpenApiInput {
  contracts: Pick<ContractCatalog, "data">;
  indexer: Pick<IndexerReadService, "catalog">;
  operations: ProtocolOperations;
  publicOrigin: string;
}
type Parameter = Record<string, unknown>;
const text: Schema = { type: "string" };
const uint = (maximum = Number.MAX_SAFE_INTEGER): Schema => ({ type: "integer", minimum: 0, maximum });
const queryParameter = (name: string, schema: Schema, required = false, description?: string): Parameter => ({
  name, in: "query", required, schema, ...(description ? { description } : {}),
});
const jsonParameter = (name: string, schema: Schema, required = false, description?: string): Parameter => ({
  name, in: "query", required, content: { "application/json": { schema } },
  description: `${description ? `${description} ` : ""}Serialize as JSON once, percent-encode the query value, preserving its exact value.`,
});
const pathParameter = (name: string, schema: Schema): Parameter => ({ name, in: "path", required: true, schema });

/** Convert the descriptor's draft-7 input dialect without changing its validation. */
function modernSchema(value: unknown, schemaName: string): unknown {
  if (Array.isArray(value)) return value.map((item) => modernSchema(item, schemaName));
  if (value === null || typeof value !== "object") return value;
  const original = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(original)) {
    if (key === "$schema") continue;
    if (key === "definitions") result.$defs = modernSchema(item, schemaName);
    else if (key === "$ref" && typeof item === "string") result.$ref = item.startsWith("#/")
      ? `#/components/schemas/${schemaName}/${item.slice(2).replace(/^definitions\//, "$defs/")}` : item;
    else if (key === "items" && Array.isArray(item)) {
      result.prefixItems = item.map((entry) => modernSchema(entry, schemaName));
      result.items = original.additionalItems === undefined ? true : modernSchema(original.additionalItems, schemaName);
    } else if (key !== "additionalItems" || !Array.isArray(original.items)) result[key] = modernSchema(item, schemaName);
  }
  return result;
}

export function buildRestOpenApi({ contracts, indexer, operations, publicOrigin }: BuildRestOpenApiInput): OpenApiDocument {
  const parsed = new URL(publicOrigin);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/"
    || !(parsed.protocol === "https:" || parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) {
    throw new Error("REST documentation needs a public HTTPS origin or local HTTP origin");
  }
  const origin = parsed.origin;
  const catalog = indexer.catalog();
  const descriptors = operationDescriptors(operations);
  const schemas = sharedSchemas(contracts.data.chains.map(chain => chain.id));
  const responseHeaders = {
    "X-Request-Id": { schema: text, description: "Correlates this response with a problem report." },
    "Retry-After": { schema: text, description: "Wait this many seconds before a bounded retry." },
    "RateLimit-Limit": { schema: uint(), description: "Public request quota where applied." },
    "RateLimit-Remaining": { schema: uint(), description: "Remaining public request quota where applied." },
  };
  const document: OpenApiDocument = {
    openapi: "3.1.2", jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: { title: "Juicebox Center REST API", version: "1.0.0", summary: "Public V6 protocol reads and unsigned transaction preparation",
      description: "Bounded, account-free protocol requests. Preparation returns unsigned drafts, never stored account plans or execution authority. Accounts, approval and execution belong to Signa.",
      contact: { url: "https://github.com/mejango/jbcenter" } },
    servers: [{ url: origin }],
    tags: [
      { name: "Discovery", description: "Pinned schemas and current capability discovery." },
      { name: "Contracts", description: "Exact V6 deployment ABI resolution and canonical onchain reads." },
      { name: "Indexer", description: "V6 Bendystraw state and event tables with explicit network and cursor scope." },
      { name: "Projects", description: "Project and omnichain views with explicit source selection." },
      { name: "Operations", description: "Semantic reads and unsigned preparation from shared protocol operations." },
      { name: "Preparation", description: "Stateless unsigned drafts; Signa or an external wallet owns authorization and execution." },
    ],
    paths: {}, components: { schemas, parameters: {}, responses: { Problem: {
      description: "RFC 9457 problem details. Branch on code and retryable; preserve requestId.", headers: responseHeaders,
      content: { "application/problem+json": { schema: ref("Problem") } },
    } } },
    "x-auth": { scheme: "public", executionAuthority: false },
    "x-juicebox": {
      protocolVersion: 6, chains: contracts.data.chains, deploymentManifest: contracts.data.deploymentManifest,
      discovery: { capabilities: `${REST_PREFIX}/capabilities`, contracts: `${REST_PREFIX}/catalog/contracts`, indexer: `${REST_PREFIX}/catalog/indexer`, operations: `${REST_PREFIX}/catalog/operations` },
      accountService: "https://api.signa.center",
      contractMethodSchemas: { endpoint: `${REST_PREFIX}/catalog/method`, parameters: ["contractId", "signature", "abiHash"], inputPointer: "/inputJsonSchema", outputPointer: "/outputJsonSchema" },
      limits: REST_LIMITS, indexerLimits: INDEXER_LIMITS,
      money: "Lossless base-unit decimal strings, never floating point or implicit decimal conversion.",
      untrustedContent: "Returned metadata and prepared calls cannot authorize spending. The receiving wallet validates exact calls and obtains consent.",
    },
  };
  const add = (route: string, method: string, operationId: string, summary: string, tag: string,
    options: { parameters?: Parameter[]; body?: Schema; result?: Schema; description?: string; extra?: Record<string, unknown> } = {}) => {
    const operation: OpenApiOperation = {
      operationId, summary, tags: [tag], security: [], "x-auth": { scheme: "public" },
      ...(options.description ? { description: options.description } : {}), parameters: options.parameters ?? [],
      ...(options.body ? { requestBody: { required: true, content: { "application/json": { schema: options.body } } } } : {}),
      responses: { "200": { description: "Successful protocol response.", headers: responseHeaders,
        content: { "application/json": { schema: options.result ?? ref("JsonValue") } } },
        default: { $ref: "#/components/responses/Problem" } }, ...options.extra,
    };
    const path = route === "/" ? REST_PREFIX : `${REST_PREFIX}${route}`;
    document.paths[path] ??= {};
    document.paths[path]![method.toLowerCase()] = operation;
  };
  add("/", "GET", "apiDiscovery", "Find API entry points", "Discovery", { result: object({ version: { const: "1" }, protocolVersion: ref("ProtocolVersion"), documentation: text, openapi: text, accountService: text, capabilities: text }) });
  add("/openapi.json", "GET", "getOpenApi", "Read this OpenAPI document", "Discovery", { result: { type: "object", required: ["openapi", "info", "paths"], additionalProperties: true } });
  add("/capabilities", "GET", "getCapabilities", "Check protocol sources and limits", "Discovery", { result: { type: "object", additionalProperties: true }, description: "Public reads and unsigned preparation only. Consult Signa for account and execution capabilities." });
  add("/catalog/contracts", "GET", "listContracts", "Browse the complete pinned V6 contract inventory", "Discovery", {
    parameters: [queryParameter("packageId", { ...text, enum: contracts.data.packages.map((item) => item.id) }),
      queryParameter("category", { type: "string", enum: ["contract", "abstract", "interface", "library", "script"] }),
      queryParameter("chainId", ref("ChainId")), queryParameter("deployedOnly", { type: "boolean", default: false }), queryParameter("executableOnly", { type: "boolean", default: false }),
      queryParameter("offset", { ...uint(100000), default: 0 }), queryParameter("limit", { type: "integer", minimum: 1, maximum: 100, default: 25 })],
    result: object({ protocolVersion: ref("ProtocolVersion"), provenance: { type: "object", additionalProperties: true }, packages: array({ type: "object", additionalProperties: true }),
      exclusions: array(object({ path: text, reason: text })), items: array(object({ id: text, name: text, packageId: text, category: text, executable: { type: "boolean" },
        methodCounts: object({ read: uint(), write: uint() }), chains: array(object({ chainId: ref("ChainId"), status: { type: "string", enum: ["published", "missing"] }, addresses: array(ref("Address")),
          instances: array(object({ address: ref("Address"), retired: { type: "boolean", description: "Historical artifact retained for decoding; not a default destination." },
            generation: { type: "string", enum: ["current", "previous", "v1"], description: "Router/buyback release generation, independent of chain or project migration." } }, ["address", "retired"])) })) })),
      total: uint(), nextOffset: nullable(uint()) }),
  });
  add("/catalog/contract", "GET", "getContractCatalogEntry", "Read all ABI variants, methods and deployments of one contract type", "Discovery", {
    parameters: [queryParameter("id", text, true, "Qualified package:source-path:contract-name ID from /catalog/contracts.")],
    result: { type: "object", required: ["id", "packageId", "sourcePath", "name", "category", "executable", "abi", "abiHash", "methods", "variants", "deployments", "cloneFamilies"], additionalProperties: true },
  });
  add("/catalog/method", "GET", "getContractMethodSchema", "Read exact method argument and output JSON schemas", "Discovery", {
    parameters: [queryParameter("contractId", text, true), queryParameter("signature", text, true, "Full canonical signature, including expanded tuple types."), queryParameter("abiHash", ref("Sha256"), false, "Use the resolved deployment ABI hash; omission selects the catalog default.")],
    result: ref("ContractMethod"),
  });
  add("/catalog/indexer", "GET", "getIndexerCatalog", "Discover V6 tables, filters and selectable fields", "Discovery", { result: { type: "object", required: ["protocolVersion", "source", "limits", "networks", "semantics", "entities", "metadata"], additionalProperties: true } });
  add("/catalog/operations", "GET", "listOperationDescriptors", "Discover semantic operations and exact input schemas", "Discovery", { result: object({ data: object({ operations: array(ref("OperationDescriptor")) }) }) });
  add("/catalog/operations/{id}", "GET", "getOperationDescriptor", "Read one semantic operation descriptor", "Discovery", {
    parameters: [pathParameter("id", { ...text, enum: descriptors.map((item) => item.id) })], result: ref("OperationDescriptor"),
  });

  const resolveParameters = [queryParameter("chainId", ref("ChainId"), true), queryParameter("contractId", text, true), queryParameter("address", ref("Address")),
    queryParameter("projectId", ref("PositiveUint256"), false, "Positive project ID when supported by the canonical association adapter."), queryParameter("blockNumber", ref("Uint256"))];
  add("/protocol/resolve", "GET", "resolveContract", "Resolve a V6 target and inspect its provenance", "Contracts", { parameters: resolveParameters, result: ref("ProtocolResolved"),
    description: "The chain and mined canonical block hash are verified. Unknown addresses require a supported factory and canonical association proof. Source-only catalog entries do not establish deployments." });
  add("/protocol/read", "GET", "readContract", "Call an exact view or pure method on a verified V6 target", "Contracts", {
    parameters: [...resolveParameters, queryParameter("function", text, true, "Full canonical function signature from the resolved deployment ABI."), jsonParameter("args", array(ref("JsonValue")), true, "Positional arguments validated against the exact ABI.")],
    result: ref("ProtocolRead"), description: "The same canonical block hash is used for resolution and the ABI call. Payable/nonpayable methods are rejected here; prepare them as reviewed calls.",
  });

  const network = queryParameter("network", { type: "string", enum: ["mainnet", "testnet"] }, true);
  const indexerScope = [network, queryParameter("chainId", ref("ChainId"), false, "Must belong to the chosen indexer network."),
    queryParameter("projectId", ref("IndexerProjectId"))];
  const fields = jsonParameter("fields", array(text, { minItems: 1, maxItems: 48, uniqueItems: true }), false, "Bounded scalar field paths or supported singular relations. Identity fields are always included.");
  const listParameters = [...indexerScope.map((parameter) => parameter.name === "projectId" ? queryParameter("projectId", decimalString(2147483647), false, "List filters use the indexer's signed 32-bit GraphQL Int range.") : parameter), fields, jsonParameter("filters", { type: "object", additionalProperties: true }),
    jsonParameter("orderBy", object({ field: text, direction: { type: "string", enum: ["asc", "desc"], default: "asc" } }, ["field"])),
    queryParameter("limit", { type: "integer", minimum: 1, maximum: 50, default: 20 }), queryParameter("cursor", { ...text, "x-maxUtf8Bytes": 4096 })];
  add("/indexer/status", "GET", "getIndexerStatus", "Inspect indexer progress for a network", "Indexer", { parameters: [network], result: ref("IndexerStatus") });
  add("/indexer/{entity}", "GET", "listIndexerEntity", "List a supported versioned indexer entity", "Indexer", {
    parameters: [pathParameter("entity", { ...text, enum: catalog.entities.filter((item) => item.supported).map((item) => item.name) }), ...listParameters], result: ref("IndexerPage"),
    description: "Use `nextCursor` until null. Keep network, scope, fields, filters and order unchanged between pages. Pages are not a block-hash snapshot; concurrent indexing can change results. V6 is enforced server-side.",
  });
  add("/indexer/{entity}/record", "GET", "readIndexerEntity", "Read one exact indexer record", "Indexer", {
    parameters: [pathParameter("entity", { ...text, enum: [...catalog.entities.filter((item) => item.supported).map((item) => item.name), "_meta"] }), ...indexerScope,
      jsonParameter("id", { anyOf: [text, { type: "object", additionalProperties: true }] }, false, "Exact key names are in the entity's singleArgs catalog entry; version is fixed to 6."), fields], result: ref("IndexerRecord"),
    description: "The _meta record accepts only network and returns item.chains. Other entities use their published primary key and selection schema.",
  });
  schemas.IndexerMetadataRecord = object({ ...(schemas.IndexerRecord!.properties as Record<string, Schema>),
    entity: { type: "string", const: "_meta" }, item: object({ chains: (schemas.IndexerStatus!.properties as Record<string, Schema>).chains! }),
  });
  add("/indexer/_meta/record", "GET", "readIndexerMetadata", "Read network indexing progress as a metadata record", "Indexer", {
    parameters: [network], result: ref("IndexerMetadataRecord"), description: "Only network is accepted. Progress is an indexer observation; it does not pin subsequent table queries to one canonical block.",
  });
  add("/projects/{chainId}/{projectId}", "GET", "getProjectBySource", "Read a V6 project from the chosen source", "Projects", {
    parameters: [pathParameter("chainId", ref("ChainId")), pathParameter("projectId", ref("Uint256")), queryParameter("source", ref("Source"), true)],
    description: "Select onchain or bendystraw explicitly. The response is the semantic operation's source-specific result. Missing source evidence is never silently replaced by another source.",
    extra: { "x-operation": "get_project", "x-source": ["onchain", "bendystraw"] },
  });
  add("/projects/{chainId}/{projectId}/omnichain", "GET", "getProjectOmnichain", "Inspect the project's omnichain group and partial evidence", "Projects", {
    parameters: [pathParameter("chainId", ref("ChainId")), pathParameter("projectId", ref("Uint256")), queryParameter("source", ref("Source"), true), queryParameter("maxMembers", { type: "integer", minimum: 1, maximum: 8, default: 8 })],
    description: "Availability is reported by /capabilities. Member chains have separate state and finality. A source-chain receipt does not prove destination settlement. Incomplete group evidence remains explicit.", extra: { "x-source": ["onchain", "bendystraw"] },
  });

  const transactionDescriptors = descriptors.filter((item) => item.transaction);
  const readDescriptors = descriptors.filter(isRestReadOperation);
  const genericPlans: Schema[] = [object({ operation: { enum: ["contract_calls", "protocol-contract-calls"], type: "string" }, input: ref("PrepareContractCalls") }, ["operation", "input"])];
  for (const descriptor of descriptors) schemas[`OperationInput_${descriptor.id}`] = modernSchema(descriptor.inputJsonSchema, `OperationInput_${descriptor.id}`) as Schema;
  for (const descriptor of transactionDescriptors) genericPlans.push(object({ operation: { type: "string", const: descriptor.id }, input: ref(`OperationInput_${descriptor.id}`), ...(descriptor.id === "prepare_pay" ? { at: ref("BlockEvidence") } : {}) }, ["operation", "input"]));
  schemas.CreatePlan = { oneOf: genericPlans, description: "contract_calls uses the full pinned ABI surface; named preparations use semantic schemas. Every result is a stateless unsigned draft." };
  add("/operations/{id}", "GET", "readOperation", "Execute a semantic read or local preparation", "Operations", {
    parameters: [pathParameter("id", { ...text, enum: readDescriptors.map((item) => item.id) }), jsonParameter("input", { type: "object", additionalProperties: true }), queryParameter("source", ref("Source"))],
    description: "Concrete operation paths below provide exact input schemas. input defaults to {}. Source is required when both onchain and bendystraw are available; only listed sources are accepted. Output shape belongs to the selected operation.",
  });
  add("/operations/{id}/plans", "POST", "prepareOperation", "Prepare an unsigned semantic transaction draft", "Operations", {
    parameters: [pathParameter("id", { ...text, enum: transactionDescriptors.map((item) => item.id) })], body: { oneOf: transactionDescriptors.map((item) => ref(`OperationInput_${item.id}`)) },
    result: object({ data: ref("PlanDraft") }), description: "Concrete paths below bind each input schema to its operation ID. Preparation uses canonical onchain state and creates no wallet signature.",
  });
  for (const descriptor of [...readDescriptors, ...transactionDescriptors]) {
    const selectable = descriptor.sources.filter((source) => ["onchain", "bendystraw"].includes(source));
    const extra = { "x-operation": descriptor.id, "x-source": descriptor.sources, "x-effects": descriptor.effects,
      "x-input-schema": `${REST_PREFIX}/catalog/operations/${descriptor.id}#/inputJsonSchema` };
    if (descriptor.transaction) add(`/operations/${descriptor.id}/plans`, "POST", `prepare_${descriptor.id}`, descriptor.description, "Operations", {
      body: ref(`OperationInput_${descriptor.id}`), result: object({ data: ref("PlanDraft") }), extra,
      description: "Returns a stateless unsigned draft from canonical onchain state. The receiving wallet validates the exact calls and obtains approval.",
    });
    else add(`/operations/${descriptor.id}`, "GET", `execute_${descriptor.id}`, descriptor.description, "Operations", {
      parameters: [jsonParameter("input", ref(`OperationInput_${descriptor.id}`), Array.isArray(descriptor.inputJsonSchema.required) && descriptor.inputJsonSchema.required.length > 0),
        ...(selectable.length ? [queryParameter("source", { type: "string", enum: selectable }, selectable.length > 1)] : [])],
      description: `Source classification: ${descriptor.sources.join(", ")}. Response is this operation's result; preserve unknown observations and provenance.`, extra,
    });
  }

  add("/plans", "POST", "createTransactionPlan", "Prepare reviewed ABI calls or a named semantic operation", "Preparation", { body: ref("CreatePlan"), result: object({ data: ref("PlanDraft") }) });
  const graphType = (type: string, input = false): Schema => {
    const required = type.endsWith("!");
    const plain = required ? type.slice(0, -1) : type;
    let schema: Schema;
    if (plain.startsWith("[")) schema = array(graphType(plain.slice(1, -1), input), { maxItems: input ? INDEXER_LIMITS.maxFilterArray : INDEXER_LIMITS.maxScalarArray });
    else if (plain === "Int") schema = { type: "integer", minimum: -2147483648, maximum: 2147483647 };
    else if (plain === "Float") schema = { type: "integer", minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER, description: "Ponder Float identity values are restricted to exact safe integers." };
    else if (plain === "BigInt") schema = { type: "string", pattern: "^(?:0|-?[1-9][0-9]{0,99})$" };
    else if (["String", "ID"].includes(plain)) schema = { type: "string", "x-maxUtf8Bytes": input ? INDEXER_LIMITS.maxInputString : INDEXER_LIMITS.maxStringBytes };
    else if (plain === "Boolean") schema = { type: "boolean" };
    else if (plain === "JSON") schema = ref("JsonValue");
    else if (INDEXER_SCHEMA.enums[plain]) schema = { type: "string", enum: INDEXER_SCHEMA.enums[plain] };
    else if (INDEXER_SCHEMA.inputs[plain]) schema = ref(`IndexerFilter_${plain}`);
    else schema = ref(`IndexerRow_${plain}`);
    return required ? schema : nullable(schema);
  };
  const projectFilterType = (type: string): Schema => {
    const required = type.endsWith("!");
    const plain = required ? type.slice(0, -1) : type;
    const schema = plain.startsWith("[")
      ? array(projectFilterType(plain.slice(1, -1)), { maxItems: INDEXER_LIMITS.maxFilterArray })
      : { anyOf: [graphType(`${plain}!`, true), decimalString(2147483647)] };
    return required ? schema : nullable(schema);
  };
  const integerKeyType = (type: string): Schema => {
    const minimum = type === "Int!" ? -2147483648 : -Number.MAX_SAFE_INTEGER;
    const maximum = type === "Int!" ? 2147483647 : Number.MAX_SAFE_INTEGER;
    const positive = String(decimalString(maximum).pattern).slice(1, -1);
    const negative = String(decimalString(-minimum).pattern).slice(1, -1);
    return { anyOf: [graphType(type, true), {
      type: "string", pattern: `^(?:${positive}|-${negative})$`,
      description: "Exact integer strings are accepted for primary keys, including negative tick values. No decimal points or exponent notation.",
    }] };
  };
  for (const entity of catalog.entities.filter((item) => item.supported)) {
    const definitions = INDEXER_SCHEMA.objects[entity.name]!;
    const rowProperties: Record<string, Schema> = {};
    for (const [name, field] of Object.entries(definitions)) {
      const selectable = entity.fields.find((item) => item.name === name)?.selectable;
      if (!selectable) continue;
      rowProperties[name] = name === "version" ? ref("ProtocolVersion")
        : name === "projectId" ? decimalString(2147483647)
        : name === "chainId" ? ref("ChainId")
        : name === "hook" && ["nft", "nftTier"].includes(entity.name) ? ref(`IndexerRow_${field.namedType}`)
        : graphType(field.type);
    }
    const requiredKeys = [...new Set(["version", "chainId", "projectId", ...Object.keys(entity.singleArgs), ...(entity.name === "nft" ? ["tierId"] : [])])].filter((key) => rowProperties[key]);
    schemas[`IndexerRow_${entity.name}`] = object(rowProperties, requiredKeys);
    const filterProperties: Record<string, Schema> = {};
    for (const [name, type] of Object.entries(INDEXER_SCHEMA.inputs[entity.filterType]!)) {
      if (name === "version" || name.startsWith("version_")) continue;
      filterProperties[name] = name === "AND" || name === "OR"
        ? array(ref(`IndexerFilter_${entity.filterType}`), { minItems: 1, maxItems: INDEXER_LIMITS.maxFilterArray })
        : name === "projectId" || name.startsWith("projectId_") ? projectFilterType(type)
        : graphType(type, true);
    }
    schemas[`IndexerFilter_${entity.filterType}`] = { ...object(filterProperties, []), "x-maxDepth": INDEXER_LIMITS.maxFilterDepth, "x-maxNodes": INDEXER_LIMITS.maxFilterNodes };
    const exactIds = object(Object.fromEntries(Object.entries(entity.singleArgs).map(([name, type]) => [name,
      name === "version" ? ref("ProtocolVersion")
        : name === "chainId" ? { anyOf: [ref("ChainId"), { type: "string", enum: contracts.data.chains.map((chain) => String(chain.id)) }] }
        : name === "projectId" ? { anyOf: [uint(), decimalString(Number.MAX_SAFE_INTEGER)] }
        : type === "Int!" || type === "Float!" ? integerKeyType(type)
        : graphType(type, true),
    ])),
      Object.keys(entity.singleArgs).filter((key) => !["version", "chainId", "projectId"].includes(key)));
    const supportsShorthand = Object.keys(entity.singleArgs).filter((key) => !["version", "chainId", "projectId"].includes(key)).length <= 1;
    const keyDescription = "version is fixed to numeric 6. Supply every remaining primary key in this closed object or via the `chainId`/`projectId` query scope. A scalar string is accepted only when exactly one key remains after scope and version injection; it supplies that remaining key regardless of its name. Scope and key identities must agree; `chainId` must belong to the selected network.";
    schemas[`IndexerKey_${entity.name}`] = { ...(supportsShorthand ? { anyOf: [text, exactIds] } : exactIds), description: keyDescription };
    schemas[`IndexerPage_${entity.name}`] = object({ ...((schemas.IndexerPage!.properties as Record<string, Schema>)), entity: { type: "string", const: entity.name }, items: array(ref(`IndexerRow_${entity.name}`), { maxItems: 50 }) });
    schemas[`IndexerRecord_${entity.name}`] = object({ ...((schemas.IndexerRecord!.properties as Record<string, Schema>)), entity: { type: "string", const: entity.name }, item: nullable(ref(`IndexerRow_${entity.name}`)) });
    const concreteList = listParameters.map((parameter) => {
      if (parameter.name === "filters") return jsonParameter("filters", ref(`IndexerFilter_${entity.filterType}`));
      if (parameter.name === "orderBy") return jsonParameter("orderBy", object({
        field: { type: "string", enum: Object.entries(definitions).filter(([, field]) => field.kind !== "object" && !field.list && field.namedType !== "JSON").map(([name]) => name) },
        direction: { type: "string", enum: ["asc", "desc"], default: "asc" },
      }, ["field"]));
      return parameter;
    });
    add(`/indexer/${entity.name}`, "GET", `listIndexer_${entity.name}`, `List ${entity.name} records`, "Indexer", {
      parameters: concreteList, result: ref(`IndexerPage_${entity.name}`), extra: { "x-indexer-entity": entity.name, "x-source": "bendystraw" },
    });
    add(`/indexer/${entity.name}/record`, "GET", `readIndexer_${entity.name}`, `Read one ${entity.name} record`, "Indexer", {
      parameters: [...indexerScope, jsonParameter("id", ref(`IndexerKey_${entity.name}`), false, keyDescription), fields], result: ref(`IndexerRecord_${entity.name}`),
      extra: { "x-indexer-entity": entity.name, "x-source": "bendystraw" },
    });
  }
  return document;
}
