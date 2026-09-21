import { createProtocolOperations, createServices, loadConfig } from "@juicebox/mcp/host";
import { Ajv2020 } from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";
import { getContractCatalog } from "../src/rest/contracts/catalog.js";
import { buildRestOpenApi, type OpenApiDocument } from "../src/rest/docs/openapi.js";
import { buildIndexerQuery, createIndexerReadService } from "../src/rest/indexer/index.js";

let spec: OpenApiDocument;
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
const address = `0x${"11".repeat(20)}`;
beforeAll(async () => {
  const operations = createProtocolOperations(createServices(loadConfig({ NODE_ENV: "test", PUBLIC_ORIGIN: "https://juicebox.center", PLAN_SECRET: "indexer-schema-tests-only-32-byte-secret" })));
  spec = buildRestOpenApi({ contracts: await getContractCatalog(), indexer: createIndexerReadService({}), operations, publicOrigin: "https://juicebox.center" });
  ajv.addSchema({ $id: "urn:juicebox:indexer-test", components: spec.components });
});
function validates(name: string, value: unknown): boolean {
  let validate = validators.get(name);
  if (!validate) {
    validate = ajv.compile({ $ref: `urn:juicebox:indexer-test#/components/schemas/${name}` });
    validators.set(name, validate);
  }
  return Boolean(validate(value));
}

describe("OpenAPI matches indexer identity normalization", () => {
  it("requires the injected NFT tier ID and non-null hook while permitting optional relation nulls", () => {
    const row = { chainId: 8453, projectId: "1", version: 6, tokenId: "1", tierId: 1,
      hook: { chainId: 8453, projectId: "1", version: 6, address } };
    expect(validates("IndexerRow_nft", row)).toBe(true);
    const { tierId: _tier, ...withoutTier } = row;
    expect(validates("IndexerRow_nft", withoutTier)).toBe(false);
    expect(validates("IndexerRow_nft", { ...row, hook: null })).toBe(false);
    expect(validates("IndexerRow_nft", { ...row, tier: null })).toBe(true);
    expect(validates("IndexerRow_nftTier", { chainId: 8453, projectId: "1", version: 6, tierId: 1, hook: null })).toBe(false);
  });

  it("bounds normalized project strings to Int32 output while read primary keys retain safe Float range", () => {
    expect(validates("IndexerRow_project", { chainId: 8453, projectId: "2147483647", version: 6 })).toBe(true);
    expect(validates("IndexerRow_project", { chainId: 8453, projectId: "2147483648", version: 6 })).toBe(false);
    for (const projectId of [2147483648, "2147483648", Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)]) {
      expect(validates("IndexerKey_project", { chainId: "8453", projectId })).toBe(true);
      expect(() => buildIndexerQuery("project", { network: "mainnet", id: { chainId: "8453", projectId } }, "read")).not.toThrow();
    }
    expect(validates("IndexerKey_project", { chainId: 8453, projectId: -1 })).toBe(false);
    expect(validates("IndexerKey_project", { chainId: 999999, projectId: 1 })).toBe(false);
    expect(validates("IndexerKey_project", { chainId: 8453, projectId: 1, version: "6" })).toBe(false);
  });

  it("accepts integer and exact decimal-string project filters with the same Int32 range", () => {
    for (const filters of [{ projectId: "2147483647" }, { projectId: 2147483647 }, { projectId: -1 }, { projectId_in: ["0", 1, null] }]) {
      expect(validates("IndexerFilter_projectFilter", filters)).toBe(true);
      expect(() => buildIndexerQuery("project", { network: "mainnet", filters }, "list")).not.toThrow();
    }
    for (const filters of [{ projectId: "2147483648" }, { projectId: "-1" }, { projectId_in: ["2147483648"] }]) {
      expect(validates("IndexerFilter_projectFilter", filters)).toBe(false);
      expect(() => buildIndexerQuery("project", { network: "mainnet", filters }, "list")).toThrow();
    }
  });

  it("documents scalar shorthand for the remaining key rather than only keys named id", () => {
    for (const [entity, id, scope] of [
      ["nftHook", address, { chainId: 8453 }],
      ["participant", address, { chainId: 8453, projectId: "1" }],
      ["buybackPoolPosition", "9007199254740993", { chainId: 8453 }],
      ["project", "1", { chainId: 8453 }],
    ] as const) {
      expect(validates(`IndexerKey_${entity}`, id)).toBe(true);
      expect(() => buildIndexerQuery(entity, { network: "mainnet", id, ...scope }, "read")).not.toThrow();
    }
    expect(validates("IndexerKey_nft", "1")).toBe(false);
    expect(String(spec.components.schemas.IndexerKey_nftHook!.description)).toContain("exactly one key remains");
  });

  it("accepts exact signed decimal tick keys without allowing float/exponent strings", () => {
    const key = { chainId: "8453", poolId: `0x${"22".repeat(32)}`, tickLower: "-120", tickUpper: "120" };
    expect(validates("IndexerKey_buybackPoolRange", key)).toBe(true);
    expect(() => buildIndexerQuery("buybackPoolRange", { network: "mainnet", id: key }, "read")).not.toThrow();
    for (const tickLower of ["1.2", "1e3", "9007199254740992"]) expect(validates("IndexerKey_buybackPoolRange", { ...key, tickLower })).toBe(false);
  });
});
