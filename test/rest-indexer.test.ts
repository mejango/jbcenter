import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FieldNode, OperationDefinitionNode, SelectionSetNode } from "graphql";
import { INDEXER_SCHEMA } from "../src/rest/indexer/generated.js";
import { buildIndexerQuery, createIndexerReadService, INDEXER_LIMITS, IndexerError, type IndexerEntity, type IndexerFetchJson, type IndexerFetchOptions, type IndexerReadInput } from "../src/rest/indexer/index.js";

const require = createRequire(new URL("../mcp/package.json", import.meta.url));
const { buildSchema, getVariableValues, parse, validate } = require("graphql") as typeof import("graphql");
const schema = buildSchema(readFileSync(new URL("../mcp/tests/adapters/fixtures/bendystraw-v6.graphql", import.meta.url), "utf8"));
const ENTITIES = Object.values(INDEXER_SCHEMA.entities).filter((entity) => entity.supported);
const ADDRESS = "0x1234567890123456789012345678901234567890";
const OTHER_ADDRESS = "0x9876543210987654321098765432109876543210";
const MAINNET_URL = "https://indexer.example.invalid/operator-owned-path";
const TESTNET_URL = "https://testnet.example.invalid/operator-owned-path";
type Row = Record<string, unknown>;

function entityScope(entity: IndexerEntity): IndexerReadInput {
  const fields = INDEXER_SCHEMA.objects[entity.name]!;
  return { network: "mainnet", ...(fields.chainId ? { chainId: 8453 } : {}), ...(fields.projectId ? { projectId: "1" } : {}) };
}

function inputFor(entity: IndexerEntity, mode: "list" | "read"): IndexerReadInput {
  const input = entityScope(entity);
  if (mode === "read") {
    input.id = Object.fromEntries(Object.entries(entity.singleArgs).map(([key, type]) => {
      const value = key === "version" ? 6 : key === "chainId" ? 8453 : key === "projectId" ? 1
        : key === "hook" || key === "address" || key === "operator" || key === "account" ? ADDRESS
        : type === "BigInt!" ? "1" : type === "Float!" || type === "Int!" ? 1 : "fixture-id";
      return [key, value];
    }));
  }
  return input;
}

function validateQuery(query: { query: string; variables: Record<string, unknown> }) {
  const document = parse(query.query);
  expect(validate(schema, document).map((error) => error.message), query.query).toEqual([]);
  const operation = document.definitions.find((definition): definition is OperationDefinitionNode => definition.kind === "OperationDefinition")!;
  const variables = getVariableValues(schema, operation.variableDefinitions ?? [], query.variables);
  expect(variables.errors?.map((error) => error.message), JSON.stringify(query.variables)).toBeUndefined();
  return operation;
}

function scalarFixture(type: string, fieldName: string): unknown {
  const nullable = type.endsWith("!") ? type.slice(0, -1) : type;
  if (nullable.startsWith("[")) return [scalarFixture(nullable.slice(1, -1), fieldName)];
  if (fieldName === "version") return 6;
  if (fieldName === "chainId") return 8453;
  if (fieldName === "projectId") return 1;
  if (nullable === "BigInt") return "1";
  if (nullable === "Int" || nullable === "Float") return 1;
  if (nullable === "Boolean") return true;
  if (nullable === "JSON") return { name: "Fixture", nested: { retained: [true, null, "1"] } };
  if (INDEXER_SCHEMA.enums[nullable]) return INDEXER_SCHEMA.enums[nullable]![0];
  if (["address", "hook", "account", "operator", "owner"].includes(fieldName)) return ADDRESS;
  return "fixture-id";
}

/** Respond to the actual GraphQL AST, not the runtime's internal selection tree. */
function selectedRow(typeName: string, selection: SelectionSetNode, primaryKeys: Row = {}): Row {
  return Object.fromEntries(selection.selections.map((node) => {
    if (node.kind !== "Field") throw new Error("Unexpected generated selection kind.");
    const name = node.name.value;
    const field = INDEXER_SCHEMA.objects[typeName]![name]!;
    if (field.kind === "object") {
      if (!node.selectionSet) throw new Error("Object field missing selection set.");
      return [name, selectedRow(field.namedType, node.selectionSet,
        name === "hook" && typeof primaryKeys.hook === "string" ? { address: primaryKeys.hook } : {})];
    }
    return [name, Object.hasOwn(primaryKeys, name) ? primaryKeys[name] : scalarFixture(field.type, name)];
  }));
}

function fixtureEnvelope(options: IndexerFetchOptions): { envelope: { data: Row }; root: string; row: Row; page?: Row } {
  const operation = validateQuery(options.body);
  const rootField = operation.selectionSet.selections[0] as FieldNode;
  const root = rootField.name.value;
  const entity = ENTITIES.find((value) => value.name === root || value.listField === root);
  if (!entity) throw new Error(`Unexpected fixture root ${root}.`);
  const list = entity.listField === root;
  const selection = list ? (rootField.selectionSet!.selections.find((node) => node.kind === "Field" && node.name.value === "items") as FieldNode).selectionSet! : rootField.selectionSet!;
  const row = selectedRow(entity.name, selection, list ? {} : options.body.variables);
  if (!list) return { envelope: { data: { [root]: row } }, root, row };
  const page: Row = { items: [row], totalCount: 1, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: "cursor-1", endCursor: "cursor-1" } };
  return { envelope: { data: { [root]: page } }, root, row, page };
}

type Mutation = (fixture: ReturnType<typeof fixtureEnvelope>, options: IndexerFetchOptions) => unknown;
function fixtureService(mutate?: Mutation) {
  const fetchJson = vi.fn<IndexerFetchJson>(async (_url, options) => {
    const fixture = fixtureEnvelope(options);
    const changed = mutate?.(fixture, options);
    return changed === undefined ? fixture.envelope : changed;
  });
  return { fetchJson, service: createIndexerReadService({ mainnetUrl: MAINNET_URL, testnetUrl: TESTNET_URL, fetchJson }) };
}

function errorCode(action: () => unknown, code: string) {
  expect(action).toThrowError(expect.objectContaining({ code }));
}

afterEach(() => vi.restoreAllMocks());

describe("full pinned indexer schema compatibility", () => {
  for (const mode of ["list", "read"] as const) {
    it.each(ENTITIES)(`${mode} $name validates both GraphQL selections and variables and returns verified V6 rows`, async (entity) => {
      const input = inputFor(entity, mode);
      const query = buildIndexerQuery(entity.name, input, mode);
      validateQuery(query);
      const { service, fetchJson } = fixtureService();
      const result = mode === "list" ? await service.list(entity.name, input) : await service.read(entity.name, input);
      expect(result).toMatchObject({ entity: entity.name, network: "mainnet", protocolVersion: 6 });
      const row = "items" in result ? result.items[0]! : "item" in result ? result.item! : undefined;
      if (!row) throw new Error("Expected an entity row.");
      expect(row.version).toBe(6);
      if (INDEXER_SCHEMA.objects[entity.name]!.chainId) expect(row.chainId).toBe(8453);
      if (INDEXER_SCHEMA.objects[entity.name]!.projectId) expect(row.projectId).toBe("1");
      expect(fetchJson).toHaveBeenCalledOnce();
      if (mode === "list") expect(query.variables.where).toMatchObject({ AND: expect.arrayContaining([{ version: 6 }]) });
    });
  }

  it.each(ENTITIES)("selects every scalar column and every supported singular relation's scalar columns for $name", async (entity) => {
    const selectable: string[] = [];
    for (const [name, field] of Object.entries(INDEXER_SCHEMA.objects[entity.name]!)) {
      if (field.kind !== "object") selectable.push(name);
      else if (!field.list && !Object.keys(field.args).length && INDEXER_SCHEMA.entities[field.namedType]?.supported) {
        for (const [child, childField] of Object.entries(INDEXER_SCHEMA.objects[field.namedType]!)) {
          if (childField.kind !== "object") selectable.push(`${name}.${child}`);
        }
      }
    }
    expect(selectable.length).toBeGreaterThan(0);
    for (let start = 0; start < selectable.length; start += 16) {
      const fields = selectable.slice(start, start + 16);
      const input = { ...entityScope(entity), fields };
      validateQuery(buildIndexerQuery(entity.name, input));
      const { service } = fixtureService();
      const result = await service.list(entity.name, input);
      for (const path of fields) {
        const value = path.split(".").reduce<unknown>((row, field) => (row as Row)[field], result.items[0]);
        expect(value, `${entity.name}.${path}`).not.toBeUndefined();
      }
    }
  });

  it("validates every advertised filter operator with schema-correct scalar values", () => {
    for (const entity of ENTITIES) {
      for (const [name, type] of Object.entries(INDEXER_SCHEMA.inputs[entity.filterType]!)) {
        if (name === "AND" || name === "OR" || name === "version" || name.startsWith("version_")) continue;
        const input = { ...entityScope(entity), fields: ["version"], filters: { [name]: scalarFixture(type, name) } };
        validateQuery(buildIndexerQuery(entity.name, input));
      }
    }
  }, 30_000);
});

describe("V6 isolation and identity verification", () => {
  it.each(ENTITIES)("rejects a V4 row from $name even when its primary key has no version argument", async (entity) => {
    const { service } = fixtureService(({ row }) => { row.version = 4; });
    await expect(service.read(entity.name, inputFor(entity, "read"))).rejects.toMatchObject({ code: "INDEXER_VERSION_MISMATCH", status: 502 });
  });

  it.each(["project", "nft", "nftTier", "nftHook", "buybackPool", "payEvent", "loan"])("rejects a missing version on %s", async (name) => {
    const { service } = fixtureService(({ row }) => { delete row.version; });
    await expect(service.list(name, { network: "mainnet", fields: ["version"] })).rejects.toMatchObject({ code: "INDEXER_INVALID_RESPONSE" });
  });

  it.each([
    ["version", 4, "INDEXER_VERSION_MISMATCH"],
    ["chainId", 1, "INDEXER_SCOPE_MISMATCH"],
    ["projectId", 2, "INDEXER_SCOPE_MISMATCH"],
  ] as const)("rejects a selected project's foreign %s", async (field, value, code) => {
    const { service } = fixtureService(({ row }) => { (row.project as Row)[field] = value; });
    await expect(service.list("payEvent", { network: "mainnet", chainId: 8453, projectId: "1", fields: ["project.name"] })).rejects.toMatchObject({ code, status: 502 });
  });

  it.each([1, 11155111])("rejects root chain %s outside an explicit Base mainnet scope", async (chainId) => {
    const { service } = fixtureService(({ row }) => { row.chainId = chainId; });
    await expect(service.list("project", { network: "mainnet", chainId: 8453 })).rejects.toMatchObject({ code: "INDEXER_SCOPE_MISMATCH" });
  });

  it("validates relation chain and project identity even without explicit caller scope", async () => {
    for (const changed of [{ chainId: 1 }, { projectId: 2 }]) {
      const { service } = fixtureService(({ row }) => { Object.assign(row.project as Row, changed); });
      await expect(service.list("payEvent", { network: "mainnet", fields: ["project.name"] })).rejects.toMatchObject({ code: "INDEXER_SCOPE_MISMATCH" });
    }
  });

  it.each(["nft", "nftTier"])("requires %s hook identity as a real V6 relation", async (entity) => {
    for (const hook of [ADDRESS, null]) {
      const { service } = fixtureService(({ row }) => { row.hook = hook; });
      await expect(service.list(entity, { network: "mainnet", chainId: 8453, projectId: "1", fields: ["version"] })).rejects.toMatchObject({ status: 502 });
    }
    for (const changed of [{ version: 4 }, { chainId: 1 }, { projectId: 2 }, { address: "not-an-address" }]) {
      const { service } = fixtureService(({ row }) => { Object.assign(row.hook as Row, changed); });
      await expect(service.list(entity, { network: "mainnet", chainId: 8453, projectId: "1", fields: ["version"] })).rejects.toMatchObject({ status: 502 });
    }
  });

  it.each(["nft", "nftTier"])("matches %s hook addresses against composite read keys", async (name) => {
    const entity = INDEXER_SCHEMA.entities[name]!;
    const input = inputFor(entity, "read");
    const { service } = fixtureService(({ row }) => { (row.hook as Row).address = OTHER_ADDRESS; });
    await expect(service.read(name, input)).rejects.toMatchObject({ code: "INDEXER_IDENTITY_MISMATCH" });
  });

  it("accepts checksum casing differences when checking address primary keys", async () => {
    const address = "0xaBcDEf1234567890123456789012345678901234";
    const { service } = fixtureService(({ row }) => { row.address = address.toLowerCase(); });
    const result = await service.read("nftHook", { network: "mainnet", chainId: 8453, projectId: "1", id: { address, version: 6 } });
    expect("item" in result && result.item?.address).toBe(address.toLowerCase());
  });

  it.each([
    ["payEvent", "id", "different-id"],
    ["buybackPool", "poolId", "different-pool"],
    ["buybackPoolRange", "tickLower", 2],
    ["loan", "id", "2"],
    ["nft", "tokenId", "2"],
    ["suckerTransaction", "index", 2],
  ] as const)("rejects %s read responses whose %s key differs", async (entity, key, value) => {
    const { service } = fixtureService(({ row }) => { row[key] = value; });
    await expect(service.read(entity, inputFor(INDEXER_SCHEMA.entities[entity]!, "read"))).rejects.toMatchObject({ code: "INDEXER_IDENTITY_MISMATCH" });
  });

  it("returns an explicit null for an absent single row", async () => {
    const { service } = fixtureService(({ envelope, root }) => { envelope.data[root] = null; });
    await expect(service.read("project", { network: "mainnet", chainId: 8453, projectId: "1" })).resolves.toMatchObject({ item: null, protocolVersion: 6 });
  });

  it("keeps wallet and unsupported aggregate scopes visible but unavailable", () => {
    const { service } = fixtureService();
    expect(service.catalog().entities.find((entity) => entity.name === "wallet")).toMatchObject({ supported: false, classification: "cross-version-aggregate" });
    errorCode(() => buildIndexerQuery("wallet", { network: "mainnet" }), "INDEXER_UNSUPPORTED_ENTITY");
    for (const name of ["suckerGroup", "suckerGroupMoment"]) {
      errorCode(() => buildIndexerQuery(name, { network: "mainnet", chainId: 8453 }), "INDEXER_UNSUPPORTED_SCOPE");
      errorCode(() => buildIndexerQuery(name, { network: "mainnet", projectId: "1" }), "INDEXER_UNSUPPORTED_SCOPE");
    }
    errorCode(() => buildIndexerQuery("participant", { network: "mainnet", fields: ["wallet.address"] }), "INDEXER_UNSUPPORTED_RELATION");
  });

  it("checks a selected NFT tier's tier ID and hook against the NFT", async () => {
    for (const changed of [{ tierId: 2 }, { hook: { address: OTHER_ADDRESS, version: 6, chainId: 8453, projectId: 1 } }]) {
      const { service } = fixtureService(({ row }) => { Object.assign(row.tier as Row, changed); });
      await expect(service.list("nft", { network: "mainnet", fields: ["tier.price"] })).rejects.toMatchObject({ code: "INDEXER_IDENTITY_MISMATCH" });
    }
  });
});

describe("closed inputs and bounded GraphQL construction", () => {
  it("keeps untrusted values in variables and admits only catalog field names", () => {
    const value = '\") { _meta { status } } mutation { publish } #';
    const query = buildIndexerQuery("project", { network: "mainnet", fields: ["name"], filters: { name_contains: value }, cursor: value });
    validateQuery(query);
    expect(query.query).not.toContain(value);
    expect(query.variables).toMatchObject({ after: value, where: { AND: [{ version: 6 }, { chainId_in: [1, 10, 8453, 42161] }, { name_contains: value }] } });
    errorCode(() => buildIndexerQuery(`project${value}`, { network: "mainnet" }), "INDEXER_ENTITY_NOT_FOUND");
    errorCode(() => buildIndexerQuery("project", { network: "mainnet", fields: [value] }), "INDEXER_INVALID_FIELDS");
    errorCode(() => buildIndexerQuery("project", { network: "mainnet", filters: { [value]: "x" } }), "INDEXER_UNSUPPORTED_FILTER");
    errorCode(() => buildIndexerQuery("project", { network: "mainnet", orderBy: { field: value } }), "INDEXER_INVALID_ORDER");
  });

  it("rejects every version filter operator, including nested attempts to bypass V6", () => {
    const operators = Object.keys(INDEXER_SCHEMA.inputs.projectFilter!).filter((name) => name === "version" || name.startsWith("version_"));
    expect(operators.length).toBeGreaterThan(5);
    for (const operator of operators) {
      errorCode(() => buildIndexerQuery("project", { network: "mainnet", filters: { OR: [{ [operator]: operator.includes("_in") ? [4] : 4 }] } }), "INDEXER_VERSION_FIXED");
    }
    errorCode(() => buildIndexerQuery("project", { network: "mainnet", id: { version: 4, chainId: 8453, projectId: 1 } }, "read"), "INDEXER_VERSION_FIXED");
  });

  it("rejects wrong networks, unknown top-level properties, and prototype keys", () => {
    for (const input of [
      { network: "mainnet", url: MAINNET_URL },
      { network: "mainnet", headers: { authorization: "caller-owned" } },
      { network: "mainnet", query: "query { _meta { status } }" },
      { network: "mainnet", filters: null },
      JSON.parse('{"network":"mainnet","__proto__":{"network":"testnet"}}'),
      { network: "mainnet", filters: JSON.parse('{"constructor":{"prototype":{}}}') },
      new Date(),
    ]) errorCode(() => buildIndexerQuery("project", input as IndexerReadInput), "INDEXER_INVALID_INPUT");
    errorCode(() => buildIndexerQuery("project", { network: "both" } as unknown as IndexerReadInput), "INDEXER_INVALID_INPUT");
    errorCode(() => buildIndexerQuery("project", { network: "mainnet", chainId: 84532 }), "INDEXER_NETWORK_MISMATCH");
    errorCode(() => buildIndexerQuery("project", { network: "testnet", chainId: 8453 }), "INDEXER_NETWORK_MISMATCH");
  });

  it.each(["-1", "01", "1e3", "1.2", "9007199254740992", "2147483648", 1, null])("rejects unsafe or noncanonical project scope %s", (projectId) => {
    errorCode(() => buildIndexerQuery("project", { network: "mainnet", projectId } as IndexerReadInput), "INDEXER_UNSAFE_INTEGER");
  });

  it("does not round BigInt, Float key, Int filter, or project ID values", () => {
    for (const id of ["9007199254740992", "1.5", Number.MAX_SAFE_INTEGER + 1]) {
      errorCode(() => buildIndexerQuery("project", { network: "mainnet", id: { chainId: 8453, projectId: id } }, "read"), "INDEXER_UNSAFE_INTEGER");
    }
    for (const id of [1, "01", "-0", "1e18", "1.5"]) {
      errorCode(() => buildIndexerQuery("loan", { network: "mainnet", chainId: 8453, id: { id } }, "read"), "INDEXER_INVALID_INPUT");
    }
    for (const value of [Number.MAX_SAFE_INTEGER + 1, 2147483648, 1.5]) {
      errorCode(() => buildIndexerQuery("project", { network: "mainnet", filters: { createdAt_gt: value } }), "INDEXER_UNSAFE_INTEGER");
    }
    const query = buildIndexerQuery("project", { network: "mainnet", filters: { projectId_in: ["1", "2147483647"], balance_gt: "100000000000000000000000000000000000" } });
    validateQuery(query);
    expect(JSON.stringify(query.variables)).toContain("100000000000000000000000000000000000");
  });

  it("requires complete composite identities and separates read options from list options", () => {
    errorCode(() => buildIndexerQuery("nft", { network: "mainnet", chainId: 8453, id: "1" }, "read"), "INDEXER_COMPOSITE_KEY_REQUIRED");
    errorCode(() => buildIndexerQuery("project", { network: "mainnet", id: { chainId: 8453, projectId: 1, extra: "x" } }, "read"), "INDEXER_INVALID_INPUT");
    errorCode(() => buildIndexerQuery("project", { network: "mainnet", chainId: 8453, id: { chainId: 1, projectId: 1 } }, "read"), "INDEXER_SCOPE_MISMATCH");
    errorCode(() => buildIndexerQuery("project", { network: "mainnet", id: { chainId: 84532, projectId: 1 } }, "read"), "INDEXER_NETWORK_MISMATCH");
    errorCode(() => buildIndexerQuery("project", { network: "mainnet", id: "1" }), "INDEXER_INVALID_INPUT");
    for (const option of [{ filters: {} }, { orderBy: { field: "version" } }, { limit: 1 }, { cursor: "cursor" }]) {
      errorCode(() => buildIndexerQuery("project", { network: "mainnet", chainId: 8453, projectId: "1", ...option }, "read"), "INDEXER_INVALID_INPUT");
    }
    validateQuery(buildIndexerQuery("payEvent", { network: "mainnet", id: "event-id" }, "read"));
    validateQuery(buildIndexerQuery("project", { network: "mainnet", chainId: 8453, id: "1" }, "read"));
  });

  it("bounds page sizes, opaque cursor bytes, logical filters and filter arrays", () => {
    for (const limit of [0, -1, 51, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "20", null]) {
      errorCode(() => buildIndexerQuery("project", { network: "mainnet", limit } as IndexerReadInput), "INDEXER_INVALID_INPUT");
    }
    for (const limit of [1, 50]) validateQuery(buildIndexerQuery("project", { network: "mainnet", limit }));
    for (const cursor of ["", "bad\0cursor", "💧".repeat(1025), 1]) {
      errorCode(() => buildIndexerQuery("project", { network: "mainnet", cursor } as IndexerReadInput), "INDEXER_INVALID_CURSOR");
    }
    for (const filters of [{ AND: [] }, { OR: Array.from({ length: 21 }, () => ({ name: "x" })) }, { AND: {} }]) {
      errorCode(() => buildIndexerQuery("project", { network: "mainnet", filters }), "INDEXER_FILTER_TOO_COMPLEX");
    }
    errorCode(() => buildIndexerQuery("project", { network: "mainnet", filters: { name_in: Array.from({ length: 21 }, () => "x") } }), "INDEXER_INVALID_INPUT");
    let deep: Row = { name: "x" };
    for (let i = 0; i < 4; i++) deep = { AND: [deep] };
    errorCode(() => buildIndexerQuery("project", { network: "mainnet", filters: deep }), "INDEXER_FILTER_TOO_COMPLEX");
    const many = Object.fromEntries(Object.entries(INDEXER_SCHEMA.inputs.projectFilter!).filter(([name]) => !["AND", "OR"].includes(name) && !name.startsWith("version")).slice(0, 41).map(([name, type]) => [name, scalarFixture(type, name)]));
    errorCode(() => buildIndexerQuery("project", { network: "mainnet", filters: many }), "INDEXER_FILTER_TOO_COMPLEX");
  });

  it("bounds field paths and rejects collection, scalar-subfield, and unversioned relations", () => {
    for (const fields of [[], ["version", "version"], Array.from({ length: 49 }, (_, i) => `field${i}`), [1]]) {
      errorCode(() => buildIndexerQuery("project", { network: "mainnet", fields } as IndexerReadInput), "INDEXER_INVALID_FIELDS");
    }
    for (const fields of [["metadata.name"], ["project"], ["project..name"]]) {
      errorCode(() => buildIndexerQuery("payEvent", { network: "mainnet", fields }), "INDEXER_INVALID_FIELDS");
    }
    errorCode(() => buildIndexerQuery("project", { network: "mainnet", fields: ["participants.address"] }), "INDEXER_UNSUPPORTED_RELATION");
    errorCode(() => buildIndexerQuery("payEvent", { network: "mainnet", fields: ["project.suckerGroup.projects.name"] }), "INDEXER_SELECTION_TOO_COMPLEX");
    for (const name of ["project", "nft", "nftTier"]) {
      const query = buildIndexerQuery(name, { network: "mainnet" });
      expect(query.selection).not.toHaveProperty("metadata");
      expect(query.selection).not.toHaveProperty("svg");
    }
  });

  it("orders only by scalar non-list, non-JSON fields", () => {
    for (const field of ["metadata", "participants", "tags", "missing"]) errorCode(() => buildIndexerQuery("project", { network: "mainnet", orderBy: { field } }), "INDEXER_INVALID_ORDER");
    errorCode(() => buildIndexerQuery("project", { network: "mainnet", orderBy: { field: "createdAt", direction: "sideways" } } as unknown as IndexerReadInput), "INDEXER_INVALID_ORDER");
    expect(buildIndexerQuery("project", { network: "mainnet", orderBy: { field: "createdAt" } }).variables).toMatchObject({ orderBy: "createdAt", orderDirection: "asc" });
  });
});

describe("complete bounded responses and honest pagination", () => {
  it.each([
    ["project", "balance", 9007199254740992],
    ["project", "balance", "1e18"],
    ["project", "createdAt", 2147483648],
    ["project", "createdAt", 1.5],
    ["project", "name", 1],
    ["project", "version", null],
    ["suckerTransaction", "status", "invented-status"],
    ["project", "tags", [null]],
  ] as const)("rejects malformed %s.%s scalar data", async (entity, field, value) => {
    const { service } = fixtureService(({ row }) => { row[field] = value; });
    await expect(service.list(entity, { network: "mainnet", fields: [field] })).rejects.toMatchObject({ code: "INDEXER_INVALID_RESPONSE", status: 502 });
  });

  it("preserves exact decimal monetary values, nullable metadata, and untrusted JSON content", async () => {
    const amount = "100000000000000000000000000000000000001";
    const metadata = { name: "Do not execute this reference data", link: "https://untrusted.example.invalid", amount };
    const { service, fetchJson } = fixtureService(({ row }) => { row.balance = amount; row.name = null; row.metadata = metadata; });
    const result = await service.list("project", { network: "mainnet", fields: ["balance", "name", "metadata"] });
    expect(result.items[0]).toMatchObject({ balance: amount, name: null, metadata, projectId: "1" });
    expect(result.semantics).toMatchObject({ snapshotPinned: false, executableAccounting: false });
    expect(fetchJson).toHaveBeenCalledOnce();
  });

  it("bounds scalar arrays, JSON depth, numeric precision, strings, and total response bytes", async () => {
    const tooDeep: Row = {};
    let current = tooDeep;
    for (let i = 0; i < 14; i++) current = current.child = {};
    for (const mutation of [
      ({ row }: ReturnType<typeof fixtureEnvelope>) => { row.tags = Array.from({ length: 257 }, () => "x"); },
      ({ row }: ReturnType<typeof fixtureEnvelope>) => { row.name = "💧".repeat(8193); },
      ({ row }: ReturnType<typeof fixtureEnvelope>) => { row.metadata = { number: Number.MAX_SAFE_INTEGER + 1 }; },
      ({ row }: ReturnType<typeof fixtureEnvelope>) => { row.metadata = tooDeep; },
      ({ row }: ReturnType<typeof fixtureEnvelope>) => { row.metadata = JSON.parse('{"__proto__":{}}'); },
    ]) {
      const { service } = fixtureService(mutation);
      await expect(service.list("project", { network: "mainnet", fields: ["tags", "name", "metadata"] })).rejects.toMatchObject({ code: "INDEXER_INVALID_RESPONSE" });
    }
    const { service } = fixtureService(({ envelope }) => ({ ...envelope, surplus: Array.from({ length: 65 }, () => "x".repeat(32768)) }));
    await expect(service.list("project", { network: "mainnet" })).rejects.toMatchObject({ code: "INDEXER_RESPONSE_TOO_LARGE" });
  });

  it("rejects missing selected values and omits unselected data from successful responses", async () => {
    const missing = fixtureService(({ row }) => { delete row.name; });
    await expect(missing.service.list("project", { network: "mainnet", fields: ["name"] })).rejects.toMatchObject({ code: "INDEXER_INVALID_RESPONSE" });
    const extra = fixtureService(({ row }) => { row.unselected = "do not expose"; });
    const result = await extra.service.list("project", { network: "mainnet", fields: ["name"] });
    expect(result.items[0]).not.toHaveProperty("unselected");
  });

  it("accepts bounded advancing empty pages without pretending the traversal is complete", async () => {
    const { service } = fixtureService(({ page }) => {
      page!.items = [];
      page!.totalCount = 5;
      page!.pageInfo = { hasNextPage: true, hasPreviousPage: true, startCursor: null, endCursor: "cursor-2" };
    });
    const result = await service.list("project", { network: "mainnet", cursor: "cursor-1" });
    expect(result).toMatchObject({ items: [], totalCount: 5, nextCursor: "cursor-2" });
  });

  it("rejects stalled, absent, or oversized continuation cursors", async () => {
    for (const endCursor of ["cursor-1", null, "", "💧".repeat(1025)]) {
      const { service } = fixtureService(({ page }) => { page!.pageInfo = { hasNextPage: true, hasPreviousPage: true, startCursor: "cursor-1", endCursor }; });
      await expect(service.list("project", { network: "mainnet", cursor: "cursor-1" })).rejects.toMatchObject({ code: "INDEXER_INVALID_RESPONSE" });
    }
  });

  it("rejects oversized pages, inconsistent totals, and malformed pagination without fabricating zeros", async () => {
    for (const mutation of [
      ({ page, row }: ReturnType<typeof fixtureEnvelope>) => { page!.items = [row, row]; },
      ({ page }: ReturnType<typeof fixtureEnvelope>) => { page!.totalCount = 0; },
      ({ page }: ReturnType<typeof fixtureEnvelope>) => { page!.totalCount = null; },
      ({ page }: ReturnType<typeof fixtureEnvelope>) => { page!.totalCount = 2147483648; },
      ({ page }: ReturnType<typeof fixtureEnvelope>) => { delete page!.pageInfo; },
      ({ page }: ReturnType<typeof fixtureEnvelope>) => { page!.items = null; },
    ]) {
      const { service } = fixtureService(mutation);
      await expect(service.list("project", { network: "mainnet", limit: 1 })).rejects.toMatchObject({ code: "INDEXER_INVALID_RESPONSE" });
    }
  });

  it("rejects GraphQL partial data and sanitizes upstream errors", async () => {
    const secret = "https://private.example.invalid/credential-do-not-return";
    const { service } = fixtureService(({ envelope }) => ({ ...envelope, errors: [{ message: secret }] }));
    const failure = await service.list("project", { network: "mainnet" }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "INDEXER_GRAPHQL_ERROR", status: 502 });
    expect(String(failure)).not.toContain(secret);
    const failedTransport = createIndexerReadService({ mainnetUrl: MAINNET_URL, fetchJson: async () => { throw new Error(secret); } });
    const transportFailure = await failedTransport.list("project", { network: "mainnet" }).catch((error: unknown) => error);
    expect(transportFailure).toMatchObject({ code: "INDEXER_UNAVAILABLE", retryable: true });
    expect(String(transportFailure)).not.toContain(secret);
  });

  it("validates GraphQL error envelopes and requires the selected root", async () => {
    for (const errors of [null, "error", [null], [{ message: 1 }], Array.from({ length: 101 }, () => ({ message: "failure" }))]) {
      const { service } = fixtureService(({ envelope }) => ({ ...envelope, errors }));
      await expect(service.list("project", { network: "mainnet" })).rejects.toMatchObject({ code: "INDEXER_INVALID_RESPONSE" });
    }
    const absent = fixtureService(() => ({ data: {} }));
    await expect(absent.service.read("project", { network: "mainnet", chainId: 8453, projectId: "1" })).rejects.toMatchObject({ code: "INDEXER_INVALID_RESPONSE" });
    const noErrors = fixtureService(({ envelope }) => ({ ...envelope, errors: [] }));
    await expect(noErrors.service.list("project", { network: "mainnet" })).resolves.toMatchObject({ protocolVersion: 6 });
  });
});

describe("operator configuration, status, cancellation, and deadlines", () => {
  it("separates network configuration and snapshots operator headers", async () => {
    const headers = { authorization: "global-secret" };
    const networkHeaders = { mainnet: { authorization: "mainnet-secret" }, testnet: { authorization: "testnet-secret" } };
    const fetchJson = vi.fn<IndexerFetchJson>(async (_url, options) => {
      validateQuery(options.body);
      return { data: { _meta: { status: { configured: { id: _url === MAINNET_URL ? 8453 : 84532, block: { number: 123, timestamp: 456 } } } } } };
    });
    const service = createIndexerReadService({ mainnetUrl: MAINNET_URL, testnetUrl: TESTNET_URL, headers, networkHeaders, fetchJson });
    headers.authorization = "mutated";
    networkHeaders.mainnet.authorization = "mutated";
    await service.status({ network: "mainnet" });
    await service.status({ network: "testnet" });
    expect(fetchJson.mock.calls[0]?.[0]).toBe(MAINNET_URL);
    expect(fetchJson.mock.calls[1]?.[0]).toBe(TESTNET_URL);
    expect(fetchJson.mock.calls[0]?.[1].headers.authorization).toBe("mainnet-secret");
    expect(fetchJson.mock.calls[1]?.[1].headers.authorization).toBe("testnet-secret");
    for (const [, options] of fetchJson.mock.calls) {
      expect(Object.keys(options.body).sort()).toEqual(["query", "variables"]);
      expect(options).toMatchObject({ method: "POST", maxBytes: INDEXER_LIMITS.maxResponseBytes, timeoutMs: INDEXER_LIMITS.timeoutMs });
      expect(options.headers).toMatchObject({ accept: "application/json", "content-type": "application/json" });
    }
  });

  it("does not silently substitute a configured network for a missing one", async () => {
    const fetchJson = vi.fn<IndexerFetchJson>();
    const service = createIndexerReadService({ mainnetUrl: MAINNET_URL, fetchJson });
    expect(service.catalog().networks).toEqual({ mainnet: true, testnet: false });
    await expect(service.list("project", { network: "testnet" })).rejects.toMatchObject({ code: "INDEXER_NOT_CONFIGURED", status: 503 });
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("rejects endpoint user-info, fragments, schemes and unsafe operator headers", () => {
    for (const mainnetUrl of ["not-a-url", "file:///tmp/indexer", "https://user:pass@example.invalid", "https://example.invalid/#secret"]) {
      errorCode(() => createIndexerReadService({ mainnetUrl }), "INDEXER_INVALID_CONFIGURATION");
    }
    for (const headers of [{ host: "attacker.example.invalid" }, { "content-length": "1" }, { authorization: "secret\r\nInjected: true" }, { "invalid header": "x" }]) {
      errorCode(() => createIndexerReadService({ mainnetUrl: MAINNET_URL, headers }), "INDEXER_INVALID_CONFIGURATION");
    }
  });

  it("keeps unknown block progress null and does not claim snapshot consistency", async () => {
    const fetchJson = vi.fn<IndexerFetchJson>(async () => ({ data: { _meta: { status: { base: { id: 8453, block: { number: null, timestamp: null } } } } } }));
    const service = createIndexerReadService({ mainnetUrl: MAINNET_URL, fetchJson });
    const result = await service.read("_meta", { network: "mainnet" });
    expect(result).toMatchObject({ entity: "_meta", item: { chains: [{ chainId: 8453, block: null, timestamp: null }] }, semantics: { snapshotPinned: false } });
    await expect(service.status({ network: "mainnet", chainId: 8453 } as { network: "mainnet" })).rejects.toMatchObject({ code: "INDEXER_INVALID_INPUT" });
  });

  it("rejects empty, duplicate, foreign, and invalid status progress", async () => {
    for (const status of [
      {},
      { base: { id: 8453, block: { number: -1, timestamp: 1 } } },
      { base: { id: 8453, block: { number: Number.MAX_SAFE_INTEGER + 1, timestamp: 1 } } },
      { sepolia: { id: 84532, block: { number: 1, timestamp: 1 } } },
      { base: { id: 8453, block: { number: 1, timestamp: 1 } }, duplicate: { id: 8453, block: { number: 1, timestamp: 1 } } },
    ]) {
      const service = createIndexerReadService({ mainnetUrl: MAINNET_URL, fetchJson: async () => ({ data: { _meta: { status } } }) });
      await expect(service.status({ network: "mainnet" })).rejects.toMatchObject({ status: 502 });
    }
  });

  it("does not start a transport for a request that is already cancelled", async () => {
    const fetchJson = vi.fn<IndexerFetchJson>();
    const controller = new AbortController();
    controller.abort();
    const service = createIndexerReadService({ mainnetUrl: MAINNET_URL, fetchJson });
    await expect(service.list("project", { network: "mainnet" }, controller.signal)).rejects.toMatchObject({ code: "INDEXER_CANCELLED", status: 504, retryable: true });
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("cancels promptly even when a trusted fetcher ignores its AbortSignal", async () => {
    const fetchJson = vi.fn<IndexerFetchJson>(() => new Promise(() => {}));
    const service = createIndexerReadService({ mainnetUrl: MAINNET_URL, fetchJson });
    const controller = new AbortController();
    const pending = service.list("project", { network: "mainnet" }, controller.signal);
    expect(fetchJson).toHaveBeenCalledOnce();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "INDEXER_CANCELLED", status: 504, retryable: true });
    expect(fetchJson.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });

  it("enforces its own deadline even when a trusted fetcher never resolves", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetchJson = vi.fn<IndexerFetchJson>(() => new Promise(() => {}));
    const service = createIndexerReadService({ mainnetUrl: MAINNET_URL, fetchJson });
    const pending = service.list("project", { network: "mainnet" });
    expect(timeout).toHaveBeenCalledWith(15_000);
    deadline.abort();
    await expect(pending).rejects.toMatchObject({ code: "INDEXER_CANCELLED", status: 504 });
  });

  it("retains typed safe errors from the bounded transport", async () => {
    const failure = new IndexerError("INDEXER_RESPONSE_TOO_LARGE", "The indexer response exceeds the size limit.", 502);
    const service = createIndexerReadService({ mainnetUrl: MAINNET_URL, fetchJson: async () => { throw failure; } });
    await expect(service.list("project", { network: "mainnet" })).rejects.toBe(failure);
  });
});
