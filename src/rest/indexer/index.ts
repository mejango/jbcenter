import { INDEXER_SCHEMA } from "./generated.js";
import { boundedIndexerFetch } from "./fetch.js";
import {
  INDEXER_LIMITS as L,
  IndexerError,
  type IndexerEntity,
  type IndexerField,
  type IndexerNetwork,
  type IndexerReadInput,
  type IndexerServiceOptions,
} from "./types.js";

export * from "./types.js";
export { boundedIndexerFetch } from "./fetch.js";

const CHAINS = {
  mainnet: [1, 10, 8453, 42161],
  testnet: [11155111, 11155420, 84532, 421614],
} as const;
const INPUT_KEYS = new Set([
  "network",
  "chainId",
  "projectId",
  "id",
  "filters",
  "fields",
  "orderBy",
  "limit",
  "cursor",
]);
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
type Row = Record<string, unknown>;
interface SelectionNode {
  field: IndexerField;
  children?: Selection;
}
type Selection = Record<string, SelectionNode>;
interface Scope {
  network: IndexerNetwork;
  chainId?: number;
  projectId?: string;
}
export interface IndexerQuery {
  query: string;
  variables: Record<string, unknown>;
  entity: string;
  root: string;
  mode: "list" | "read";
  scope: Scope;
  selection: Selection;
  limit: number;
  cursor?: string;
  keys: Record<string, unknown>;
}

function fail(code: string, message: string, status = 400): never {
  throw new IndexerError(code, message, status);
}
function object(
  value: unknown,
  code = "INDEXER_INVALID_INPUT",
  status = 400,
): Row {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return fail(code, "An ordinary JSON object is required.", status);
  for (const key of Object.keys(value))
    if (RESERVED.has(key))
      fail(code, "Reserved object keys are unsupported.", status);
  return value as Row;
}
function exactKeys(value: Row, keys: ReadonlySet<string>): void {
  if (Object.keys(value).some((key) => !keys.has(key)))
    fail(
      "INDEXER_INVALID_INPUT",
      "An unsupported request property was supplied.",
    );
}
function entityFor(name: string): IndexerEntity {
  if (!Object.hasOwn(INDEXER_SCHEMA.entities, name))
    return fail(
      "INDEXER_ENTITY_NOT_FOUND",
      "Choose an entity from the indexer catalog.",
      404,
    );
  const entity = INDEXER_SCHEMA.entities[name]!;
  if (!entity.supported)
    fail(
      "INDEXER_UNSUPPORTED_ENTITY",
      "Global wallet aggregates cannot be scoped to V6. Use versioned participants, NFTs, loans, and permissions.",
      422,
    );
  return entity;
}
function nonnegativeDecimal(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,15})$/.test(value) ||
    BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    return fail(
      "INDEXER_UNSAFE_INTEGER",
      "Project IDs must be exact nonnegative decimal strings within the indexer's safe integer range.",
    );
  return value;
}
function scalar(value: unknown, type: string, output = false): unknown {
  const code = output ? "INDEXER_INVALID_RESPONSE" : "INDEXER_INVALID_INPUT";
  const status = output ? 502 : 400;
  if (value === null) {
    if (type.endsWith("!"))
      fail(code, "A required indexer value was null.", status);
    return null;
  }
  const plain = type.endsWith("!") ? type.slice(0, -1) : type;
  if (plain.startsWith("[")) {
    if (
      !Array.isArray(value) ||
      value.length > (output ? L.maxScalarArray : L.maxFilterArray)
    )
      fail(
        code,
        "An indexer array exceeds its allowed bound or has the wrong type.",
        status,
      );
    return (value as unknown[]).map((item) =>
      scalar(item, plain.slice(1, -1), output),
    );
  }
  if (plain === "Int" || plain === "Float") {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      (plain === "Int" && (value < -2147483648 || value > 2147483647))
    )
      fail(
        output ? code : "INDEXER_UNSAFE_INTEGER",
        "Indexer integer values must be exact and within their GraphQL scalar range.",
        status,
      );
  } else if (plain === "BigInt") {
    if (
      typeof value !== "string" ||
      !/^-?(0|[1-9]\d{0,99})$/.test(value) ||
      value === "-0"
    )
      fail(
        code,
        "Indexer BigInt values must be exact decimal strings.",
        status,
      );
  } else if (plain === "String" || plain === "ID") {
    if (
      typeof value !== "string" ||
      Buffer.byteLength(value, "utf8") >
        (output ? L.maxStringBytes : L.maxInputString) ||
      value.includes("\0")
    )
      fail(code, "An indexer string is invalid or exceeds its bound.", status);
  } else if (plain === "Boolean") {
    if (typeof value !== "boolean")
      fail(code, "An indexer boolean has the wrong type.", status);
  } else if (plain === "JSON") {
    boundedJson(value, output);
  } else if (Object.hasOwn(INDEXER_SCHEMA.enums, plain)) {
    if (
      typeof value !== "string" ||
      !INDEXER_SCHEMA.enums[plain]!.includes(value)
    )
      fail(code, "An indexer enum value is unsupported.", status);
  } else fail(code, "An unsupported indexer scalar was encountered.", status);
  return value;
}
function boundedJson(value: unknown, output: boolean): void {
  let nodes = 0;
  const code = output ? "INDEXER_INVALID_RESPONSE" : "INDEXER_INVALID_INPUT";
  const status = output ? 502 : 400;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > L.maxJsonNodes || depth > L.maxJsonDepth)
      fail(code, "JSON content exceeds its complexity bound.", status);
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (
        !Number.isFinite(item) ||
        (Number.isInteger(item) && !Number.isSafeInteger(item))
      )
        fail(code, "JSON contains an unsafe numeric value.", status);
      return;
    }
    if (typeof item === "string") {
      if (Buffer.byteLength(item) > L.maxStringBytes || item.includes("\0"))
        fail(code, "JSON contains an oversized or invalid string.", status);
      return;
    }
    if (typeof item !== "object" || seen.has(item))
      fail(code, "JSON contains an unsupported or cyclic value.", status);
    seen.add(item);
    if (Array.isArray(item)) for (const child of item) visit(child, depth + 1);
    else
      for (const child of Object.values(object(item, code, status)))
        visit(child, depth + 1);
    seen.delete(item);
  };
  visit(value, 0);
}
function graphqlErrors(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 100)
    fail(
      "INDEXER_INVALID_RESPONSE",
      "The GraphQL error envelope is malformed.",
      502,
    );
  for (const raw of value) {
    const error = object(raw, "INDEXER_INVALID_RESPONSE", 502);
    if (
      typeof error.message !== "string" ||
      !error.message ||
      error.message.length > 8192
    )
      fail(
        "INDEXER_INVALID_RESPONSE",
        "A GraphQL error message is malformed.",
        502,
      );
    if (error.locations !== undefined) {
      if (!Array.isArray(error.locations) || error.locations.length > 100)
        fail(
          "INDEXER_INVALID_RESPONSE",
          "GraphQL error locations are malformed.",
          502,
        );
      for (const rawLocation of error.locations) {
        const location = object(rawLocation, "INDEXER_INVALID_RESPONSE", 502);
        for (const coordinate of [location.line, location.column])
          if (
            typeof coordinate !== "number" ||
            !Number.isSafeInteger(coordinate) ||
            coordinate < 1
          )
            fail(
              "INDEXER_INVALID_RESPONSE",
              "A GraphQL error location is malformed.",
              502,
            );
      }
    }
    if (
      error.path !== undefined &&
      (!Array.isArray(error.path) ||
        error.path.length > 32 ||
        error.path.some(
          (part) =>
            typeof part !== "string" &&
            (typeof part !== "number" ||
              !Number.isSafeInteger(part) ||
              part < 0),
        ))
    )
      fail(
        "INDEXER_INVALID_RESPONSE",
        "A GraphQL error path is malformed.",
        502,
      );
    if (error.extensions !== undefined)
      object(error.extensions, "INDEXER_INVALID_RESPONSE", 502);
  }
  return value;
}
function normalizeInput(raw: IndexerReadInput): Scope {
  const input = object(raw);
  exactKeys(input, INPUT_KEYS);
  if (input.network !== "mainnet" && input.network !== "testnet")
    fail(
      "INDEXER_INVALID_INPUT",
      "Choose the mainnet or testnet indexer explicitly.",
    );
  const network = input.network as IndexerNetwork;
  if (
    input.chainId !== undefined &&
    (typeof input.chainId !== "number" ||
      !CHAINS[network].includes(input.chainId as never))
  )
    fail(
      "INDEXER_NETWORK_MISMATCH",
      "The chain is unsupported or conflicts with the selected indexer network.",
    );
  return {
    network,
    ...(input.chainId === undefined
      ? {}
      : { chainId: input.chainId as number }),
    ...(input.projectId === undefined
      ? {}
      : { projectId: nonnegativeDecimal(input.projectId) }),
  };
}
function filtersFor(entity: IndexerEntity, raw: unknown): Row {
  const definitions = INDEXER_SCHEMA.inputs[entity.filterType]!;
  let nodes = 0;
  const visit = (value: unknown, depth: number): Row => {
    if (depth > L.maxFilterDepth)
      fail(
        "INDEXER_FILTER_TOO_COMPLEX",
        "The filter nesting exceeds its bound.",
      );
    const result: Row = {};
    for (const [key, original] of Object.entries(object(value))) {
      if (++nodes > L.maxFilterNodes)
        fail(
          "INDEXER_FILTER_TOO_COMPLEX",
          "The filter count exceeds its bound.",
        );
      if (!Object.hasOwn(definitions, key))
        fail(
          "INDEXER_UNSUPPORTED_FILTER",
          "The filter is absent from the pinned entity schema.",
        );
      if (key === "version" || key.startsWith("version_"))
        fail(
          "INDEXER_VERSION_FIXED",
          "The protocol version is fixed at V6 and cannot be overridden by filters.",
        );
      if (key === "AND" || key === "OR") {
        if (
          !Array.isArray(original) ||
          original.length === 0 ||
          original.length > L.maxFilterArray
        )
          fail(
            "INDEXER_FILTER_TOO_COMPLEX",
            "Logical filters require a bounded nonempty array.",
          );
        result[key] = (original as unknown[]).map((item) =>
          visit(item, depth + 1),
        );
      } else {
        const convert = (value: unknown) =>
          typeof value === "string" &&
          (key === "projectId" || key.startsWith("projectId_"))
            ? Number(nonnegativeDecimal(value))
            : value;
        const value = Array.isArray(original)
          ? original.map(convert)
          : convert(original);
        result[key] = scalar(value, definitions[key]!);
      }
    }
    return result;
  };
  return visit(raw === undefined ? {} : raw, 0);
}
function selectionFor(entity: IndexerEntity, requested: unknown): Selection {
  const fields = INDEXER_SCHEMA.objects[entity.name]!;
  let paths: string[];
  if (requested === undefined)
    paths = Object.entries(fields)
      .filter(
        ([name, field]) =>
          field.kind !== "object" &&
          field.namedType !== "JSON" &&
          name !== "svg",
      )
      .slice(0, 32)
      .map(([name]) => name);
  else {
    if (
      !Array.isArray(requested) ||
      !requested.length ||
      requested.length > L.maxFields ||
      requested.some((field) => typeof field !== "string")
    )
      fail(
        "INDEXER_INVALID_FIELDS",
        "Choose a nonempty bounded array of catalog field paths.",
      );
    paths = requested as string[];
    if (new Set(paths).size !== paths.length)
      fail("INDEXER_INVALID_FIELDS", "Duplicate field paths are unsupported.");
  }
  const result: Selection = {};
  let nodes = 0;
  const add = (
    target: Selection,
    typeName: string,
    path: string[],
    depth: number,
  ): void => {
    if (depth > L.maxRelationDepth)
      fail(
        "INDEXER_SELECTION_TOO_COMPLEX",
        "The relation depth exceeds its bound.",
      );
    const name = path[0]!;
    const fields = INDEXER_SCHEMA.objects[typeName]!;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !Object.hasOwn(fields, name))
      fail(
        "INDEXER_INVALID_FIELDS",
        "A requested field is absent from the pinned schema.",
      );
    const field = fields[name]!;
    if (!target[name]) {
      if (++nodes > L.maxSelectionNodes)
        fail(
          "INDEXER_SELECTION_TOO_COMPLEX",
          "The selected field count exceeds its bound.",
        );
      target[name] = { field };
    }
    if (field.kind === "object") {
      if (
        field.list ||
        Object.keys(field.args).length ||
        !INDEXER_SCHEMA.entities[field.namedType]?.supported
      )
        fail(
          "INDEXER_UNSUPPORTED_RELATION",
          "Nested collection and global-wallet relations are unsupported. Query the related versioned entity separately.",
        );
      if (path.length === 1)
        fail(
          "INDEXER_INVALID_FIELDS",
          "A singular relation requires an explicit bounded scalar subfield path.",
        );
      target[name]!.children ??= {};
      add(target[name]!.children!, field.namedType, path.slice(1), depth + 1);
    } else if (path.length !== 1)
      fail("INDEXER_INVALID_FIELDS", "Scalar fields do not have subfields.");
  };
  for (const path of paths) {
    if (path.length > 240 || path.split(".").length > L.maxRelationDepth + 1)
      fail("INDEXER_SELECTION_TOO_COMPLEX", "A field path exceeds its bound.");
    add(result, entity.name, path.split("."), 0);
  }
  const identities = (
    target: Selection,
    typeName: string,
    depth: number,
  ): void => {
    const current = INDEXER_SCHEMA.entities[typeName]!;
    const objectFields = INDEXER_SCHEMA.objects[typeName]!;
    for (const name of new Set([
      "version",
      "chainId",
      "projectId",
      ...Object.keys(current.singleArgs),
    ])) {
      const field = objectFields[name];
      if (field && field.kind !== "object")
        add(target, typeName, [name], depth);
    }
    if (typeName === "nft" || typeName === "nftTier") {
      if (depth >= L.maxRelationDepth)
        fail(
          "INDEXER_SELECTION_TOO_COMPLEX",
          "NFT identity needs one additional hook relation level.",
        );
      if (typeName === "nft") add(target, typeName, ["tierId"], depth);
      for (const name of ["address", "version", "chainId", "projectId"])
        add(target, typeName, ["hook", name], depth);
    }
    for (const node of Object.values(target))
      if (node.children)
        identities(node.children, node.field.namedType, depth + 1);
  };
  identities(result, entity.name, 0);
  return result;
}
function selectionText(selection: Selection): string {
  return Object.entries(selection)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, node]) =>
      node.children ? `${name} { ${selectionText(node.children)} }` : name,
    )
    .join(" ");
}
function readKeys(
  entity: IndexerEntity,
  input: IndexerReadInput,
  scope: Scope,
): Row {
  const keys: Row = {};
  const provided =
    typeof input.id === "object" && input.id !== null ? object(input.id) : {};
  exactKeys(provided, new Set(Object.keys(entity.singleArgs)));
  for (const [key, value] of Object.entries(provided)) keys[key] = value;
  if ("version" in entity.singleArgs) {
    if (keys.version !== undefined && keys.version !== 6)
      fail("INDEXER_VERSION_FIXED", "The protocol version is fixed at V6.");
    keys.version = 6;
  }
  for (const key of ["chainId", "projectId"] as const)
    if (scope[key] !== undefined && key in entity.singleArgs) {
      if (keys[key] !== undefined && String(keys[key]) !== String(scope[key]))
        fail(
          "INDEXER_SCOPE_MISMATCH",
          "Primary keys conflict with the requested scope.",
        );
      keys[key] = scope[key];
    }
  const missing = Object.keys(entity.singleArgs).filter(
    (key) => keys[key] === undefined,
  );
  if (typeof input.id === "string") {
    if (missing.length !== 1)
      fail(
        "INDEXER_COMPOSITE_KEY_REQUIRED",
        "Supply the remaining composite primary key fields as the id object.",
      );
    keys[missing[0]!] = input.id;
  } else if (
    input.id !== undefined &&
    (input.id === null || typeof input.id !== "object")
  )
    fail(
      "INDEXER_INVALID_INPUT",
      "Use a scalar string or a closed primary-key object for id.",
    );
  for (const [key, type] of Object.entries(entity.singleArgs)) {
    if (keys[key] === undefined)
      fail(
        "INDEXER_COMPOSITE_KEY_REQUIRED",
        "A required primary-key field is missing.",
      );
    let value = keys[key];
    if ((type === "Float!" || type === "Int!") && typeof value === "string") {
      if (
        !/^-?(0|[1-9]\d{0,15})$/.test(value) ||
        !Number.isSafeInteger(Number(value))
      )
        fail(
          "INDEXER_UNSAFE_INTEGER",
          "Primary-key integers must remain exact.",
        );
      value = Number(value);
    }
    keys[key] = scalar(value, type);
  }
  if (
    keys.chainId !== undefined &&
    (!CHAINS[scope.network].includes(keys.chainId as never) ||
      (scope.chainId !== undefined && keys.chainId !== scope.chainId))
  )
    fail(
      "INDEXER_NETWORK_MISMATCH",
      "Primary-key chain conflicts with the selected network.",
    );
  if (
    keys.projectId !== undefined &&
    (typeof keys.projectId !== "number" || keys.projectId < 0)
  )
    fail(
      "INDEXER_INVALID_INPUT",
      "Project primary keys must be nonnegative integers.",
    );
  return keys;
}

/** Only names verified against generated metadata enter query text; user values use variables. */
export function buildIndexerQuery(
  name: string,
  input: IndexerReadInput,
  mode: "list" | "read" = "list",
): IndexerQuery {
  const entity = entityFor(name);
  const scope = normalizeInput(input);
  const objectFields = INDEXER_SCHEMA.objects[name]!;
  if (
    (scope.chainId !== undefined && !objectFields.chainId) ||
    (scope.projectId !== undefined && !objectFields.projectId)
  )
    fail(
      "INDEXER_UNSUPPORTED_SCOPE",
      "This entity does not expose the requested chain or project scope; its aggregates cannot be narrowed that way.",
    );
  const selection = selectionFor(entity, input.fields);
  if (mode === "read") {
    if (
      [input.filters, input.orderBy, input.limit, input.cursor].some(
        (value) => value !== undefined,
      )
    )
      fail(
        "INDEXER_INVALID_INPUT",
        "Single reads accept identity and field selection only.",
      );
    const keys = readKeys(entity, input, scope);
    const definitions = Object.entries(entity.singleArgs)
      .map(([key, type]) => `$${key}: ${type}`)
      .join(", ");
    const arguments_ = Object.keys(entity.singleArgs)
      .map((key) => `${key}: $${key}`)
      .join(", ");
    return {
      entity: name,
      root: name,
      mode,
      scope,
      selection,
      limit: 1,
      keys,
      variables: keys,
      query: `query IndexerRead(${definitions}) { ${name}(${arguments_}) { ${selectionText(selection)} } }`,
    };
  }
  if (input.id !== undefined)
    fail(
      "INDEXER_INVALID_INPUT",
      "Use filters for list queries and id for single reads.",
    );
  const limit = input.limit === undefined ? L.defaultRows : input.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > L.maxRows)
    fail("INDEXER_INVALID_INPUT", "The page limit must be between 1 and 50.");
  if (
    input.cursor !== undefined &&
    (typeof input.cursor !== "string" ||
      !input.cursor ||
      Buffer.byteLength(input.cursor) > L.maxCursorBytes ||
      input.cursor.includes("\0"))
  )
    fail(
      "INDEXER_INVALID_CURSOR",
      "The opaque cursor is invalid or exceeds its bound.",
    );
  const filters = filtersFor(entity, input.filters);
  const constraints: Row[] = [{ version: 6 }];
  if (objectFields.chainId)
    constraints.push(
      scope.chainId === undefined
        ? { chainId_in: [...CHAINS[scope.network]] }
        : { chainId: scope.chainId },
    );
  if (scope.projectId !== undefined)
    constraints.push({ projectId: scalar(Number(scope.projectId), "Int!") });
  if (Object.keys(filters).length) constraints.push(filters);
  const variables: Row = {
    where: { AND: constraints },
    limit,
    ...(input.cursor === undefined ? {} : { after: input.cursor }),
  };
  if (input.orderBy !== undefined) {
    const order = object(input.orderBy);
    exactKeys(order, new Set(["field", "direction"]));
    const field =
      typeof order.field === "string" &&
      Object.hasOwn(objectFields, order.field)
        ? objectFields[order.field]
        : undefined;
    if (
      !field ||
      field.kind === "object" ||
      field.list ||
      field.namedType === "JSON" ||
      (order.direction !== undefined &&
        !["asc", "desc"].includes(String(order.direction)))
    )
      fail(
        "INDEXER_INVALID_ORDER",
        "Order by a catalog scalar field and asc or desc.",
      );
    variables.orderBy = order.field;
    variables.orderDirection = order.direction ?? "asc";
  }
  return {
    entity: name,
    root: entity.listField,
    mode,
    scope,
    selection,
    limit,
    keys: {},
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    variables,
    query: `query IndexerList($where: ${entity.filterType}, $limit: Int!, $after: String, $orderBy: String, $orderDirection: String) { ${entity.listField}(where: $where, limit: $limit, after: $after, orderBy: $orderBy, orderDirection: $orderDirection) { items { ${selectionText(selection)} } totalCount pageInfo { hasNextPage hasPreviousPage startCursor endCursor } } }`,
  };
}

function validateRow(
  raw: unknown,
  typeName: string,
  selection: Selection,
  scope: Scope,
  parent?: Row,
): Row {
  const row = object(raw, "INDEXER_INVALID_RESPONSE", 502);
  const result: Row = {};
  for (const [name, node] of Object.entries(selection)) {
    if (!Object.hasOwn(row, name))
      fail(
        "INDEXER_INVALID_RESPONSE",
        "A selected field is missing from the indexer response.",
        502,
      );
    const value = row[name];
    if (node.children) {
      if (value === null) {
        if (
          node.field.nonNull ||
          (name === "hook" && (typeName === "nft" || typeName === "nftTier"))
        )
          fail(
            "INDEXER_RELATION_UNAVAILABLE",
            "A relation required to verify row identity is unavailable.",
            502,
          );
        result[name] = null;
      } else
        result[name] = validateRow(
          value,
          node.field.namedType,
          node.children,
          scope,
          row,
        );
    } else result[name] = scalar(value, node.field.type, true);
  }
  if (row.version !== 6)
    fail(
      "INDEXER_VERSION_MISMATCH",
      "The indexer returned a row outside Juicebox V6.",
      502,
    );
  if (
    selection.chainId &&
    (!CHAINS[scope.network].includes(row.chainId as never) ||
      (scope.chainId !== undefined && row.chainId !== scope.chainId) ||
      (parent?.chainId !== undefined && row.chainId !== parent.chainId))
  )
    fail(
      "INDEXER_SCOPE_MISMATCH",
      "The indexer returned a row or relation outside the requested chain scope.",
      502,
    );
  if (selection.projectId) {
    if (
      typeof row.projectId !== "number" ||
      row.projectId < 0 ||
      (scope.projectId !== undefined &&
        String(row.projectId) !== scope.projectId) ||
      (parent?.projectId !== undefined && row.projectId !== parent.projectId)
    )
      fail(
        "INDEXER_SCOPE_MISMATCH",
        "The indexer returned a row or relation outside the requested project scope.",
        502,
      );
    result.projectId = String(row.projectId);
  }
  if (
    typeName === "nftHook" &&
    (typeof row.address !== "string" || !/^0x[0-9a-f]{40}$/i.test(row.address))
  )
    fail(
      "INDEXER_INVALID_RESPONSE",
      "The NFT hook relation does not contain a valid address.",
      502,
    );
  if (typeName === "nftTier" && parent) {
    if (parent.tierId !== undefined && row.tierId !== parent.tierId)
      fail(
        "INDEXER_IDENTITY_MISMATCH",
        "The NFT tier relation returned a different tier identity.",
        502,
      );
    if (parent.hook && row.hook) {
      const parentHook = object(parent.hook, "INDEXER_INVALID_RESPONSE", 502);
      const tierHook = object(row.hook, "INDEXER_INVALID_RESPONSE", 502);
      if (
        String(parentHook.address).toLowerCase() !==
        String(tierHook.address).toLowerCase()
      )
        fail(
          "INDEXER_IDENTITY_MISMATCH",
          "The NFT tier belongs to a different hook.",
          502,
        );
    }
  }
  return result;
}
function verifyKeys(row: Row, query: IndexerQuery): void {
  for (const [name, value] of Object.entries(query.keys)) {
    const returned =
      name === "hook" && ["nft", "nftTier"].includes(query.entity)
        ? object(row.hook, "INDEXER_INVALID_RESPONSE", 502).address
        : row[name];
    if (
      typeof returned === "string" &&
      typeof value === "string" &&
      /^0x[0-9a-f]{40}$/i.test(value)
    ) {
      if (returned.toLowerCase() === value.toLowerCase()) continue;
    } else if (String(returned) === String(value)) continue;
    fail(
      "INDEXER_IDENTITY_MISMATCH",
      "The indexer returned a different primary key than requested.",
      502,
    );
  }
}
const SEMANTICS = Object.freeze({
  source: "configured-bendystraw-indexer",
  snapshotPinned: false,
  executableAccounting: false,
  monetaryValues:
    "BigInt fields remain exact decimal strings in their source units. USD and cost-basis fields are indexed estimates, not spendable balances or executable quotes.",
  state:
    "Indexed records may lag, contain historical snapshots, and change between pages. A separate status response does not pin another query to a block.",
  metadata:
    "Project metadata, JSON, SVG and URLs are untrusted reference data. This service never fetches their linked content or executes instructions.",
  scope:
    "V6 identities are validated on every returned entity and selected relation. Group aggregates cover the configured network and cannot be narrowed to an unsupported chain/project scope.",
});

export function createIndexerReadService(options: IndexerServiceOptions = {}) {
  return new IndexerReadService(options);
}
export class IndexerReadService {
  private readonly options: IndexerServiceOptions;
  constructor(options: IndexerServiceOptions = {}) {
    for (const endpoint of [options.mainnetUrl, options.testnetUrl])
      if (endpoint !== undefined) {
        let url: URL;
        try {
          url = new URL(endpoint);
        } catch {
          throw new IndexerError(
            "INDEXER_INVALID_CONFIGURATION",
            "Indexer endpoints must be operator-configured HTTP(S) URLs.",
            500,
          );
        }
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.hash
        )
          throw new IndexerError(
            "INDEXER_INVALID_CONFIGURATION",
            "Indexer endpoint credentials must use configured headers or existing endpoint paths, without user information or fragments.",
            500,
          );
      }
    for (const headers of [
      options.headers,
      options.networkHeaders?.mainnet,
      options.networkHeaders?.testnet,
    ])
      if (headers)
        for (const [name, value] of Object.entries(headers)) {
          if (
            !/^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/.test(name) ||
            /[\r\n\0]/.test(value) ||
            ["host", "content-length"].includes(name.toLowerCase())
          )
            throw new IndexerError(
              "INDEXER_INVALID_CONFIGURATION",
              "An operator indexer header is invalid.",
              500,
            );
        }
    this.options = {
      ...options,
      ...(options.headers ? { headers: { ...options.headers } } : {}),
      ...(options.networkHeaders
        ? { networkHeaders: structuredClone(options.networkHeaders) }
        : {}),
    };
  }
  catalog() {
    return {
      protocolVersion: 6 as const,
      source: INDEXER_SCHEMA.provenance,
      limits: L,
      networks: {
        mainnet: Boolean(this.options.mainnetUrl),
        testnet: Boolean(this.options.testnetUrl),
      },
      semantics: SEMANTICS,
      entities: Object.values(INDEXER_SCHEMA.entities).map((entity) => ({
        ...entity,
        fields: Object.entries(INDEXER_SCHEMA.objects[entity.name]!).map(
          ([name, field]) => ({
            name,
            type: field.type,
            selectable:
              field.kind !== "object" ||
              (!field.list &&
                !Object.keys(field.args).length &&
                Boolean(INDEXER_SCHEMA.entities[field.namedType]?.supported)),
            ...(field.kind === "object"
              ? {
                  relatedEntity: field.namedType,
                  access: Object.keys(field.args).length
                    ? "separate-entity-list"
                    : field.namedType === "wallet"
                      ? "unsupported-global-aggregate"
                      : "bounded-singular-relation",
                }
              : {}),
          }),
        ),
        filters: Object.keys(INDEXER_SCHEMA.inputs[entity.filterType]!).filter(
          (name) => name !== "version" && !name.startsWith("version_"),
        ),
      })),
      metadata: { root: "_meta", method: "status", snapshotPinned: false },
    };
  }
  private async request(
    network: IndexerNetwork,
    body: { query: string; variables: Row },
    signal?: AbortSignal,
  ): Promise<Row> {
    const url =
      network === "mainnet" ? this.options.mainnetUrl : this.options.testnetUrl;
    if (!url)
      throw new IndexerError(
        "INDEXER_NOT_CONFIGURED",
        "The requested indexer network is not configured.",
        503,
      );
    const deadline = AbortSignal.timeout(L.timeoutMs);
    const combined = AbortSignal.any([deadline, ...(signal ? [signal] : [])]);
    const fetcher = this.options.fetchJson ?? boundedIndexerFetch;
    let cancel: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancel = () =>
          reject(
            new IndexerError(
              "INDEXER_CANCELLED",
              "The indexer request was cancelled or exceeded its deadline.",
              504,
              true,
            ),
          );
        if (combined.aborted) cancel();
        else combined.addEventListener("abort", cancel, { once: true });
      });
      if (combined.aborted) await cancelled;
      const raw = await Promise.race([
        cancelled,
        fetcher(url, {
          method: "POST",
          body,
          signal: combined,
          maxBytes: L.maxResponseBytes,
          timeoutMs: L.timeoutMs,
          headers: {
            ...this.options.headers,
            ...this.options.networkHeaders?.[network],
            accept: "application/json",
            "content-type": "application/json",
          },
        }),
      ]);
      boundedJson(raw, true);
      if (Buffer.byteLength(JSON.stringify(raw)) > L.maxResponseBytes)
        throw new IndexerError(
          "INDEXER_RESPONSE_TOO_LARGE",
          "The indexer response exceeds the size limit.",
          502,
        );
      const response = object(raw, "INDEXER_INVALID_RESPONSE", 502);
      if (
        Object.hasOwn(response, "errors") &&
        graphqlErrors(response.errors).length
      )
        fail(
          "INDEXER_GRAPHQL_ERROR",
          "The indexer returned GraphQL errors; partial data is not accepted.",
          502,
        );
      return object(response.data, "INDEXER_INVALID_RESPONSE", 502);
    } catch (error) {
      if (error instanceof IndexerError) throw error;
      throw new IndexerError(
        "INDEXER_UNAVAILABLE",
        "The configured indexer request failed.",
        502,
        true,
      );
    } finally {
      if (cancel) combined.removeEventListener("abort", cancel);
    }
  }
  async list(entity: string, input: IndexerReadInput, signal?: AbortSignal) {
    const query = buildIndexerQuery(entity, input, "list");
    const data = await this.request(
      query.scope.network,
      { query: query.query, variables: query.variables },
      signal,
    );
    const page = object(data[query.root], "INDEXER_INVALID_RESPONSE", 502);
    if (!Array.isArray(page.items) || page.items.length > query.limit)
      fail(
        "INDEXER_INVALID_RESPONSE",
        "The indexer returned an invalid or oversized page.",
        502,
      );
    const items = (page.items as unknown[]).map((row) =>
      validateRow(row, entity, query.selection, query.scope),
    );
    const totalCount = scalar(page.totalCount, "Int!", true) as number;
    if (totalCount < items.length)
      fail(
        "INDEXER_INVALID_RESPONSE",
        "The indexer total is inconsistent with the page.",
        502,
      );
    const info = object(page.pageInfo, "INDEXER_INVALID_RESPONSE", 502);
    const pageInfo = {
      hasNextPage: scalar(info.hasNextPage, "Boolean!", true) as boolean,
      hasPreviousPage: scalar(
        info.hasPreviousPage,
        "Boolean!",
        true,
      ) as boolean,
      startCursor: scalar(info.startCursor, "String", true) as string | null,
      endCursor: scalar(info.endCursor, "String", true) as string | null,
    };
    for (const cursor of [pageInfo.startCursor, pageInfo.endCursor])
      if (
        cursor !== null &&
        (!cursor || Buffer.byteLength(cursor) > L.maxCursorBytes)
      )
        fail(
          "INDEXER_INVALID_RESPONSE",
          "An indexer cursor exceeds the continuation bound.",
          502,
        );
    if (
      pageInfo.hasNextPage &&
      (!pageInfo.endCursor || pageInfo.endCursor === query.cursor)
    )
      fail(
        "INDEXER_INVALID_RESPONSE",
        "The indexer continuation cursor is absent or did not advance.",
        502,
      );
    return {
      entity,
      network: query.scope.network,
      protocolVersion: 6 as const,
      items,
      totalCount,
      pageInfo,
      nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null,
      provenance: INDEXER_SCHEMA.provenance,
      semantics: SEMANTICS,
    };
  }
  async read(entity: string, input: IndexerReadInput, signal?: AbortSignal) {
    if (entity === "_meta") {
      const status = await this.status(input, signal);
      return {
        entity,
        network: status.network,
        protocolVersion: 6 as const,
        item: { chains: status.chains } as Row,
        provenance: status.provenance,
        semantics: status.semantics,
      };
    }
    const query = buildIndexerQuery(entity, input, "read");
    const data = await this.request(
      query.scope.network,
      { query: query.query, variables: query.variables },
      signal,
    );
    if (!Object.hasOwn(data, query.root))
      fail(
        "INDEXER_INVALID_RESPONSE",
        "The requested GraphQL field is missing.",
        502,
      );
    const item =
      data[query.root] === null
        ? null
        : validateRow(data[query.root], entity, query.selection, query.scope);
    if (item) verifyKeys(item, query);
    return {
      entity,
      network: query.scope.network,
      protocolVersion: 6 as const,
      item,
      provenance: INDEXER_SCHEMA.provenance,
      semantics: SEMANTICS,
    };
  }
  async status(input: { network: IndexerNetwork }, signal?: AbortSignal) {
    exactKeys(object(input), new Set(["network"]));
    const scope = normalizeInput(input);
    const data = await this.request(
      scope.network,
      { query: "query IndexerStatus { _meta { status } }", variables: {} },
      signal,
    );
    const meta = object(data._meta, "INDEXER_INVALID_RESPONSE", 502);
    const statuses = object(meta.status, "INDEXER_INVALID_RESPONSE", 502);
    const seen = new Set<number>();
    const chains = Object.values(statuses).map((value) => {
      const row = object(value, "INDEXER_INVALID_RESPONSE", 502);
      const chainId = scalar(row.id, "Int!", true) as number;
      const block = object(row.block, "INDEXER_INVALID_RESPONSE", 502);
      if (
        !CHAINS[scope.network].includes(chainId as never) ||
        seen.has(chainId)
      )
        fail(
          "INDEXER_SCOPE_MISMATCH",
          "Indexer progress contains duplicate or unexpected chains.",
          502,
        );
      seen.add(chainId);
      const number = scalar(block.number, "Int", true) as number | null;
      const timestamp = scalar(block.timestamp, "Int", true) as number | null;
      if (
        (number !== null && number < 0) ||
        (timestamp !== null && timestamp < 0)
      )
        fail(
          "INDEXER_INVALID_RESPONSE",
          "Indexer progress cannot be negative.",
          502,
        );
      return { chainId, block: number, timestamp };
    });
    if (!chains.length || chains.length > 8)
      fail(
        "INDEXER_INVALID_RESPONSE",
        "Indexer progress has no bounded chain set.",
        502,
      );
    return {
      network: scope.network,
      protocolVersion: 6 as const,
      chains,
      provenance: INDEXER_SCHEMA.provenance,
      semantics: SEMANTICS,
    };
  }
}
