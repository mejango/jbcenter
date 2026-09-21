#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve through the MCP package, which pins the GraphQL parser dependency.
const require = createRequire(new URL("../../mcp/package.json", import.meta.url));
const {
  assertValidSchema,
  buildSchema,
  getNamedType,
  getNullableType,
  isEnumType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
} = require("graphql");

const FIXTURE = new URL("../../mcp/tests/adapters/fixtures/bendystraw-v6.graphql", import.meta.url);
const PROVENANCE = new URL("../../mcp/tests/adapters/fixtures/bendystraw-v6.provenance.json", import.meta.url);
const OUTPUT = new URL("../../src/rest/indexer/generated.ts", import.meta.url);

// Adding a root requires a deliberate review of its V6 isolation policy. Do not
// silently expose new source entities merely because the fixture was updated.
const ENTITY_NAMES = [
  "_sucker",
  "accountingSyncEvent",
  "activityEvent",
  "addNftTierEvent",
  "addToBalanceEvent",
  "autoIssueEvent",
  "borrowLoanEvent",
  "bridgeClaimEvent",
  "bridgeToOutboxEvent",
  "bridgeToRemoteEvent",
  "burnEvent",
  "buybackPool",
  "buybackPoolEvent",
  "buybackPoolLiquidityEvent",
  "buybackPoolPosition",
  "buybackPoolRange",
  "cashOutTaxSnapshot",
  "cashOutTokensEvent",
  "decorateBannyEvent",
  "deployErc20Event",
  "inboxRootReceivedEvent",
  "liquidateLoanEvent",
  "loan",
  "manualBurnEvent",
  "manualMintTokensEvent",
  "mintNftEvent",
  "mintTokensEvent",
  "nft",
  "nftHook",
  "nftTier",
  "operatorPermissionsSetEvent",
  "participant",
  "participantSnapshot",
  "payEvent",
  "permissionHolder",
  "project",
  "projectCreateEvent",
  "projectMoment",
  "projectPayer",
  "projectTransferEvent",
  "reallocateLoanEvent",
  "removeNftTierEvent",
  "repayLoanEvent",
  "rulesetQueuedEvent",
  "sendPayoutToSplitEvent",
  "sendPayoutsEvent",
  "sendReservedTokensToSplitEvent",
  "sendReservedTokensToSplitsEvent",
  "setUriEvent",
  "storeAutoIssuanceAmountEvent",
  "suckerGroup",
  "suckerGroupMoment",
  "suckerTransaction",
  "swapEvent",
  "useAllowanceEvent",
  "wallet",
];

function sortEntries(record) {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(sortEntries(value).map(([key, item]) => [key, canonicalJson(item)]));
  }
  return value;
}

function argsMetadata(args) {
  return Object.fromEntries(
    args.map((arg) => [arg.name, String(arg.type)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

function classification(name) {
  if (name === "wallet") return "cross-version-aggregate";
  if (name.endsWith("Event")) return "protocol-event";
  if (name.endsWith("Snapshot") || name.endsWith("Moment")) return "protocol-snapshot";
  return "protocol-state";
}

/** Build metadata from the pinned source contract without querying an indexer. */
export function buildIndexerMetadata(fixtureText, provenance) {
  assert.equal(typeof fixtureText, "string", "The schema fixture must be text.");
  assert(provenance && typeof provenance === "object" && !Array.isArray(provenance), "Missing schema provenance.");
  assert.match(provenance.fixtureSha256 ?? "", /^[a-f0-9]{64}$/, "Invalid fixtureSha256 in schema provenance.");
  assert.match(provenance.sourceSha256 ?? "", /^[a-f0-9]{64}$/, "Invalid sourceSha256 in schema provenance.");
  assert.match(provenance.sourceCommit ?? "", /^[a-f0-9]{40}$/, "Invalid sourceCommit in schema provenance.");
  assert.equal(
    createHash("sha256").update(fixtureText, "utf8").digest("hex"),
    provenance.fixtureSha256,
    "Schema fixture does not match its provenance fixtureSha256; regenerate the source fixture deliberately.",
  );

  const schema = buildSchema(fixtureText);
  assertValidSchema(schema);
  const query = schema.getQueryType();
  assert(query && query.name === "Query", "Expected the pinned Query root.");
  assert(!schema.getMutationType() && !schema.getSubscriptionType(), "Unexpected write or subscription roots in the read-only indexer schema.");
  const roots = query.getFields();
  const objects = {};
  const inputs = {};
  const enums = {};

  for (const [name, type] of sortEntries(schema.getTypeMap())) {
    if (name.startsWith("__")) continue;
    if (isObjectType(type)) {
      objects[name] = Object.fromEntries(sortEntries(type.getFields()).map(([fieldName, field]) => {
        const named = getNamedType(field.type);
        const kind = isScalarType(named) ? "scalar" : isEnumType(named) ? "enum" : isObjectType(named) ? "object" : undefined;
        assert(kind, `Unsupported output type ${named.name} at ${name}.${fieldName}.`);
        return [fieldName, {
          type: String(field.type),
          namedType: named.name,
          kind,
          list: isListType(getNullableType(field.type)),
          nonNull: isNonNullType(field.type),
          args: argsMetadata(field.args),
        }];
      }));
    } else if (isInputObjectType(type)) {
      inputs[name] = Object.fromEntries(sortEntries(type.getFields()).map(([fieldName, field]) => [fieldName, String(field.type)]));
    } else if (isEnumType(type)) {
      enums[name] = type.getValues().map((value) => value.name);
    } else {
      assert(isScalarType(type), `Unsupported schema type ${name}.`);
    }
  }

  const entities = {};
  const coveredRoots = new Set(["_meta"]);
  assert.equal(String(roots._meta?.type), "Meta", "Unexpected _meta root type.");
  assert.equal(roots._meta.args.length, 0, "Unexpected _meta root arguments.");

  for (const name of ENTITY_NAMES) {
    const single = roots[name];
    assert(single && String(single.type) === name, `Missing or changed single root ${name}.`);
    const entityType = schema.getType(name);
    assert(isObjectType(entityType), `Entity ${name} is not an object.`);

    // Pair roots using the actual page element type, not an English pluralizer.
    const lists = Object.values(roots).filter((field) => {
      const page = getNamedType(field.type);
      if (!isObjectType(page)) return false;
      const items = page.getFields().items;
      return items && isListType(getNullableType(items.type)) && getNamedType(items.type).name === name;
    });
    assert.equal(lists.length, 1, `Expected exactly one list root for ${name}.`);
    const list = lists[0];
    const page = getNamedType(list.type);
    assert.equal(String(list.type), `${name}Page!`, `Changed list root type for ${name}.`);
    assert.equal(String(page.getFields().items.type), `[${name}!]!`, `Changed page item nullability for ${name}.`);
    assert.equal(String(page.getFields().pageInfo?.type), "PageInfo!", `Changed pageInfo type for ${name}.`);
    assert.equal(String(page.getFields().totalCount?.type), "Int!", `Changed totalCount type for ${name}.`);

    const where = list.args.find((arg) => arg.name === "where");
    assert(where && isInputObjectType(where.type), `Missing nullable input filter for ${list.name}.`);
    const filterType = where.type.name;
    assert.equal(filterType, `${name}Filter`, `Changed filter type for ${name}.`);
    assert.deepEqual(argsMetadata(list.args), {
      after: "String", before: "String", limit: "Int", offset: "Int",
      orderBy: "String", orderDirection: "String", where: filterType,
    }, `Changed pagination/filter arguments for ${list.name}.`);

    const supported = name !== "wallet";
    if (supported) {
      assert.equal(String(entityType.getFields().version?.type), "Int!", `Entity ${name} cannot be verified as V6.`);
      assert.equal(inputs[filterType].version, "Int", `Entity ${name} cannot be filtered to V6.`);
    } else {
      assert(!entityType.getFields().version && !inputs[filterType].version, "Wallet version semantics changed; review whether V6 isolation is now possible.");
    }

    entities[name] = {
      name,
      listField: list.name,
      singleArgs: argsMetadata(single.args),
      filterType,
      supported,
      ...(supported ? {} : {
        unsupportedReason: "Wallet aggregates have no version field or version filter, so their values cannot be isolated to V6.",
      }),
      classification: classification(name),
    };
    coveredRoots.add(name);
    coveredRoots.add(list.name);
  }

  assert.deepEqual(Object.keys(roots).sort(), [...coveredRoots].sort(), "Unexpected indexer query roots; review and classify every new root before exposure.");

  // Keep the original source commit, source digest, and working-tree disclosure.
  // A generation timestamp or the current Center HEAD would misstate provenance.
  return { provenance: canonicalJson(provenance), entities, objects, inputs, enums };
}

export function renderIndexerMetadata(metadata) {
  return "// Generated by scripts/rest/generate-indexer.mjs. Do not edit.\n"
    + "// Source provenance includes the exact fixture and source working-tree digests.\n"
    + 'import type { IndexerSchemaMetadata } from "./types.js";\n\n'
    + `export const INDEXER_SCHEMA: IndexerSchemaMetadata = ${JSON.stringify(metadata, null, 2)};\n`;
}

async function main() {
  const args = process.argv.slice(2);
  assert(args.length === 0 || (args.length === 1 && args[0] === "--check"), "Usage: node scripts/rest/generate-indexer.mjs [--check]");
  const [fixtureText, provenanceText] = await Promise.all([readFile(FIXTURE, "utf8"), readFile(PROVENANCE, "utf8")]);
  const metadata = buildIndexerMetadata(fixtureText, JSON.parse(provenanceText));
  const output = renderIndexerMetadata(metadata);
  if (args[0] === "--check") {
    const existing = await readFile(OUTPUT, "utf8").catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    assert(existing === output, "Generated indexer metadata is stale or missing. Run node scripts/rest/generate-indexer.mjs.");
    console.log(`Indexer metadata is current: ${Object.keys(metadata.entities).length} entities, ${Object.keys(metadata.objects).length} object types.`);
  } else {
    await mkdir(dirname(fileURLToPath(OUTPUT)), { recursive: true });
    await writeFile(OUTPUT, output, "utf8");
    console.log(`Generated src/rest/indexer/generated.ts: ${Object.keys(metadata.entities).length} entities, ${Object.keys(metadata.objects).length} object types.`);
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    // Node resolves symlinks in import.meta.url (including macOS /tmp), whereas
    // argv may retain the caller's spelling of the path.
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
