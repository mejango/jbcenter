import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INDEXER_SCHEMA } from "../src/rest/indexer/generated.js";

const require = createRequire(new URL("../mcp/package.json", import.meta.url));
const { buildSchema, isObjectType, isInputObjectType, isEnumType } = require("graphql") as typeof import("graphql");
const generatorUrl = new URL("../scripts/rest/generate-indexer.mjs", import.meta.url);
const generatorPath = fileURLToPath(generatorUrl);
const outputUrl = new URL("../src/rest/indexer/generated.ts", import.meta.url);
const fixture = readFileSync(new URL("../mcp/tests/adapters/fixtures/bendystraw-v6.graphql", import.meta.url), "utf8");
const provenance = JSON.parse(readFileSync(new URL("../mcp/tests/adapters/fixtures/bendystraw-v6.provenance.json", import.meta.url), "utf8")) as Record<string, unknown>;
const source = buildSchema(fixture);
const { buildIndexerMetadata, renderIndexerMetadata } = await import(generatorUrl.href) as {
  buildIndexerMetadata: (text: string, provenance: Record<string, unknown>) => typeof INDEXER_SCHEMA;
  renderIndexerMetadata: (metadata: typeof INDEXER_SCHEMA) => string;
};

function changedFixture(text: string) {
  return buildIndexerMetadata(text, {
    ...provenance,
    fixtureSha256: createHash("sha256").update(text).digest("hex"),
  });
}

describe("generated indexer source contract", () => {
  it("accounts for all 56 entity pairs and the separate status root", () => {
    const entities = Object.values(INDEXER_SCHEMA.entities);
    expect(entities).toHaveLength(56);
    expect(entities.filter((entity) => entity.supported)).toHaveLength(55);
    const roots = entities.flatMap((entity) => [entity.name, entity.listField]);
    expect([...roots, "_meta"].sort()).toEqual(Object.keys(source.getQueryType()!.getFields()).sort());
    expect(new Set(roots).size).toBe(112);
    expect(INDEXER_SCHEMA.entities._meta).toBeUndefined();
    expect(INDEXER_SCHEMA.objects.Query?._meta).toMatchObject({ type: "Meta", kind: "object", args: {} });
  });

  it("only supports entities whose rows and filters carry a V6 discriminator", () => {
    for (const entity of Object.values(INDEXER_SCHEMA.entities)) {
      if (!entity.supported) continue;
      expect(INDEXER_SCHEMA.objects[entity.name]?.version?.type, entity.name).toBe("Int!");
      expect(INDEXER_SCHEMA.inputs[entity.filterType]?.version, entity.name).toBe("Int");
      expect(entity.unsupportedReason).toBeUndefined();
    }
    expect(INDEXER_SCHEMA.entities.wallet).toMatchObject({
      name: "wallet", listField: "wallets", supported: false,
      classification: "cross-version-aggregate",
      unsupportedReason: expect.stringMatching(/cannot be isolated to V6/u),
    });
    expect(INDEXER_SCHEMA.objects.wallet?.version).toBeUndefined();
    expect(INDEXER_SCHEMA.inputs.walletFilter?.version).toBeUndefined();
  });

  it("preserves every object field, input field, and enum from the pinned schema", () => {
    const types = Object.values(source.getTypeMap()).filter((type) => !type.name.startsWith("__"));
    expect(Object.keys(INDEXER_SCHEMA.objects).sort()).toEqual(types.filter(isObjectType).map((type) => type.name).sort());
    expect(Object.keys(INDEXER_SCHEMA.inputs).sort()).toEqual(types.filter(isInputObjectType).map((type) => type.name).sort());
    expect(Object.keys(INDEXER_SCHEMA.enums).sort()).toEqual(types.filter(isEnumType).map((type) => type.name).sort());
    for (const type of types) {
      if (isObjectType(type)) {
        const generated = INDEXER_SCHEMA.objects[type.name]!;
        expect(Object.keys(generated).sort(), type.name).toEqual(Object.keys(type.getFields()).sort());
        for (const field of Object.values(type.getFields())) {
          expect(generated[field.name]?.type, `${type.name}.${field.name}`).toBe(String(field.type));
          expect(generated[field.name]?.args, `${type.name}.${field.name}`).toEqual(
            Object.fromEntries(field.args.map((arg) => [arg.name, String(arg.type)])),
          );
        }
      } else if (isInputObjectType(type)) {
        expect(INDEXER_SCHEMA.inputs[type.name], type.name).toEqual(
          Object.fromEntries(Object.values(type.getFields()).map((field) => [field.name, String(field.type)])),
        );
      } else if (isEnumType(type)) {
        expect(INDEXER_SCHEMA.enums[type.name], type.name).toEqual(type.getValues().map((value) => value.name));
      }
    }
  });

  it("keeps exact composite keys, nullable scalar lists, enums, and paged relation arguments", () => {
    expect(INDEXER_SCHEMA.entities._sucker?.singleArgs).toEqual({ projectId: "Float!", chainId: "Float!", version: "Float!", address: "String!" });
    expect(INDEXER_SCHEMA.entities.buybackPoolRange?.singleArgs).toEqual({ chainId: "Float!", poolId: "String!", tickLower: "Float!", tickUpper: "Float!" });
    expect(INDEXER_SCHEMA.entities.nft?.singleArgs).toEqual({ chainId: "Float!", hook: "String!", tokenId: "BigInt!", version: "Float!" });
    expect(INDEXER_SCHEMA.objects.project?.tags).toEqual({ type: "[String!]", namedType: "String", kind: "scalar", list: true, nonNull: false, args: {} });
    expect(INDEXER_SCHEMA.objects.suckerGroup?.addresses).toEqual({ type: "[String!]!", namedType: "String", kind: "scalar", list: true, nonNull: true, args: {} });
    expect(INDEXER_SCHEMA.objects.suckerTransaction?.status).toEqual({ type: "suckerTransactionStatus", namedType: "suckerTransactionStatus", kind: "enum", list: false, nonNull: false, args: {} });
    expect(INDEXER_SCHEMA.objects.project?.participants).toEqual({
      type: "participantPage", namedType: "participantPage", kind: "object", list: false, nonNull: false,
      args: { where: "participantFilter", orderBy: "String", orderDirection: "String", before: "String", after: "String", limit: "Int", offset: "Int" },
    });
    expect(INDEXER_SCHEMA.objects.participantPage?.items).toMatchObject({ type: "[participant!]!", namedType: "participant", kind: "object", list: true, nonNull: true });
    expect(INDEXER_SCHEMA.objects.project?.metadata).toMatchObject({ namedType: "JSON", kind: "scalar" });
  });

  it("retains honest source provenance and emits deterministic bytes", () => {
    expect(INDEXER_SCHEMA.provenance).toEqual(provenance);
    expect(INDEXER_SCHEMA.provenance.note).toMatch(/working-tree changes/u);
    const metadata = buildIndexerMetadata(fixture, provenance);
    expect(metadata).toEqual(INDEXER_SCHEMA);
    const reversedProvenance = Object.fromEntries(Object.entries(provenance).reverse());
    expect(renderIndexerMetadata(buildIndexerMetadata(fixture, reversedProvenance))).toBe(renderIndexerMetadata(metadata));
    expect(renderIndexerMetadata(metadata)).toBe(readFileSync(outputUrl, "utf8"));
  });

  it("rejects fixture bytes that do not match their pinned provenance", () => {
    expect(() => buildIndexerMetadata(`${fixture}\n`, provenance)).toThrow(/fixtureSha256/u);
    expect(() => buildIndexerMetadata(fixture, { ...provenance, fixtureSha256: "wrong" })).toThrow(/fixtureSha256/u);
    expect(() => buildIndexerMetadata(fixture, { ...provenance, sourceSha256: "wrong" })).toThrow(/sourceSha256/u);
  });

  it("fails closed when an updated fixture adds an unreviewed root", () => {
    const changed = fixture.replace("type Query {", "type Query {\n  allVersionWallet: wallet");
    expect(() => changedFixture(changed)).toThrow(/Unexpected indexer query roots/u);
  });

  it("fails closed when a supported entity loses row or filter version enforcement", () => {
    const missingRowVersion = fixture.replace("type _sucker {\n  projectId: Int!\n  chainId: Int!\n  version: Int!", "type _sucker {\n  projectId: Int!\n  chainId: Int!");
    expect(missingRowVersion).not.toBe(fixture);
    expect(() => changedFixture(missingRowVersion)).toThrow(/_sucker cannot be verified as V6/u);
    const missingFilterVersion = fixture.replace(/(input _suckerFilter \{[\s\S]*?)\n  version: Int\n/u, "$1\n");
    expect(missingFilterVersion).not.toBe(fixture);
    expect(() => changedFixture(missingFilterVersion)).toThrow(/_sucker cannot be filtered to V6/u);
  });

  it("runs --check independently of the working directory without modifying output", () => {
    const before = statSync(outputUrl);
    const result = spawnSync(process.execPath, [generatorPath, "--check"], { cwd: tmpdir(), encoding: "utf8", timeout: 10_000, maxBuffer: 16_384 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/56 entities, 116 object types/u);
    expect(statSync(outputUrl).mtimeMs).toBe(before.mtimeMs);
  });

  it("rejects stale and missing generated files without rewriting them", () => {
    const directory = mkdtempSync(join(tmpdir(), "jb-indexer-generation-"));
    try {
      mkdirSync(join(directory, "scripts/rest"), { recursive: true });
      mkdirSync(join(directory, "mcp/tests/adapters/fixtures"), { recursive: true });
      mkdirSync(join(directory, "src/rest/indexer"), { recursive: true });
      symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
      writeFileSync(join(directory, "mcp/package.json"), "{}\n");
      copyFileSync(generatorUrl, join(directory, "scripts/rest/generate-indexer.mjs"));
      writeFileSync(join(directory, "mcp/tests/adapters/fixtures/bendystraw-v6.graphql"), fixture);
      writeFileSync(join(directory, "mcp/tests/adapters/fixtures/bendystraw-v6.provenance.json"), JSON.stringify(provenance));
      const output = join(directory, "src/rest/indexer/generated.ts");
      writeFileSync(output, "// deliberately stale\n");
      const run = () => spawnSync(process.execPath, [join(directory, "scripts/rest/generate-indexer.mjs"), "--check"], { cwd: directory, encoding: "utf8", timeout: 10_000, maxBuffer: 16_384 });
      const stale = run();
      expect(stale.status).toBe(1);
      expect(stale.stderr).toMatch(/metadata is stale or missing/u);
      expect(readFileSync(output, "utf8")).toBe("// deliberately stale\n");
      rmSync(output);
      const missing = run();
      expect(missing.status).toBe(1);
      expect(missing.stderr).toMatch(/metadata is stale or missing/u);
      expect(() => statSync(output)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects unexpected CLI options without modifying output", () => {
    const before = statSync(outputUrl);
    const result = spawnSync(process.execPath, [generatorPath, "--unknown"], { encoding: "utf8", timeout: 10_000, maxBuffer: 16_384 });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Usage:/u);
    expect(statSync(outputUrl).mtimeMs).toBe(before.mtimeMs);
  });
});
