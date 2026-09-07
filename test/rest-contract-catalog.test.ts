import { beforeAll, describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";
import {
  ContractCatalog, ContractCatalogError, abiParameterJsonSchema, canonicalAbiType,
  functionInputJsonSchema, getContractCatalog,
} from "../src/rest/contracts/catalog.js";

let catalog: ContractCatalog;
beforeAll(async () => { catalog = await getContractCatalog(); });

describe("pinned V6 contract catalog", () => {
  it("covers every official package and exposes every supported chain explicitly", () => {
    expect(catalog.data.protocolVersion).toBe(6);
    expect(catalog.data.packages.filter((entry) => entry.category !== "dependency")).toHaveLength(22);
    expect(catalog.data.chains.map((chain) => chain.id)).toEqual([1, 10, 8453, 42161, 84532, 421614, 11155111, 11155420]);
    expect(catalog.data.deploymentManifest.commit).toMatch(/^[a-f0-9]{40}$/);
    const deployments = catalog.data.contracts.flatMap((contract) => contract.deployments.flatMap((chain) => chain.instances));
    expect(deployments).toHaveLength(620);
    for (const contract of catalog.data.contracts) {
      expect(contract.deployments).toHaveLength(8);
      expect(contract.id).toBe(`${contract.packageId}:${contract.sourcePath}:${contract.name}`);
      expect(contract.executable).toBe(contract.category === "contract");
      for (const chain of contract.deployments) {
        expect(chain.status === "published").toBe(chain.instances.length > 0);
      }
    }
    expect(deployments.some((entry) => /_deprecated\d*$|__TwapOracleUpgrade$/.test(entry.alias))).toBe(false);
    expect(catalog.data.contracts.some((entry) => entry.sourcePath.includes("/archive/"))).toBe(false);
    expect(catalog.data.packages.some((entry) => /sticky|jbchat|processor|plugin/i.test(entry.id))).toBe(false);
  });

  it("keeps absent deployments absent and source-only contracts discoverable", () => {
    for (const name of ["JBBuybackHook", "JBRouterTerminal", "JBUniswapV4Hook", "JBUniswapV4LPSplitHook"]) {
      const contract = catalog.list().find((entry) => entry.name === name && entry.category === "contract")!;
      expect(contract.deployments.find((chain) => chain.chainId === 11155420)).toMatchObject({ status: "missing", instances: [] });
      expect(contract.deployments.find((chain) => chain.chainId === 1)?.status).toBe("published");
    }
    for (const name of ["JB721Distributor", "JBTokenDistributor", "JBXDistributor", "JBSwapSplitHook", "JBPayRouteResolver", "JBRouterTerminalGateway"]) {
      const contract = catalog.list().find((entry) => entry.name === name && entry.category === "contract")!;
      expect(contract).toBeDefined();
      expect(contract.deployments.every((chain) => chain.status === "missing")).toBe(true);
      expect(contract.variants.some((variant) => variant.usage === "source-only")).toBe(true);
    }
    expect(catalog.list({ category: "script" }).length).toBeGreaterThan(0);
    expect(catalog.list({ category: "script", executableOnly: true })).toHaveLength(0);
    expect(catalog.list({ packageId: "@bananapus/permission-ids-v6", category: "library" })).toHaveLength(1);
  });

  it("disambiguates source declarations and resolves exact chain addresses and ABI variants", () => {
    const distributors = catalog.list().filter((contract) => contract.name === "JBDistributor");
    expect(distributors).toHaveLength(2);
    expect(new Set(distributors.map((entry) => entry.id)).size).toBe(2);
    const source = catalog.list({ deployedOnly: true, chainId: 1 }).find((contract) => contract.name === "JBController")!;
    const deployment = source.deployments.find((chain) => chain.chainId === 1)!.instances[0]!;
    const matches = catalog.lookup(1, deployment.address.toLowerCase());
    expect(matches.some((match) => match.contract.id === source.id && match.deployment.alias === deployment.alias)).toBe(true);
    const variant = catalog.variant(source.id, deployment.abiHash);
    expect(variant.usage).toBe("published");
    expect(variant.provenance.some((entry) => entry.kind === "deployment-artifact" && entry.commit === catalog.data.deploymentManifest.commit)).toBe(true);
    expect(catalog.lookup(1, "0x0000000000000000000000000000000000000000")).toEqual([]);
    expect(() => catalog.lookup(56, deployment.address)).toThrow(/outside the pinned V6/);
    expect(() => catalog.lookup(1, "https://rpc.example")).toThrow(/20-byte address/);
    expect(() => catalog.get("JBController")).toThrow(/qualified contract ID/);
  });

  it("selects overloads by canonical signatures and preserves mutability", () => {
    for (const contract of catalog.list()) {
      for (const variant of contract.variants) {
        expect(new Set(variant.methods.map((entry) => entry.signature)).size).toBe(variant.methods.length);
        for (const method of variant.methods) {
          expect(catalog.method(contract.id, method.signature, variant.abiHash)).toBe(method);
          expect(method.kind).toBe(["view", "pure"].includes(method.stateMutability) ? "read" : "write");
          if (contract.category !== "library") expect(method.selector).toBe(toFunctionSelector(method.signature));
        }
      }
    }
    const overloaded = catalog.list().find((contract) =>
      contract.methods.some((method, index, methods) => methods.findIndex((other) => other.name === method.name) !== index))!;
    const name = overloaded.methods.find((method, index, methods) => methods.findIndex((other) => other.name === method.name) !== index)!.name;
    expect(() => catalog.method(overloaded.id, name)).toThrow(/full method signature/);
  });

  it("distinguishes compiler templates and clone families from address verification", () => {
    const token = catalog.list().find((entry) => entry.name === "JBERC20" && entry.category === "contract")!;
    expect(token.cloneFamilies[0]).toMatchObject({ standard: "erc-1167", implementationGetter: "TOKEN()" });
    const hook = catalog.list().find((entry) => entry.name === "JB721TiersHook" && entry.category === "contract")!;
    expect(hook.cloneFamilies[0]).toMatchObject({ standard: "solady-libclone", implementationGetter: "HOOK()" });
    for (const contract of catalog.list({ deployedOnly: true })) {
      for (const deployment of contract.deployments.flatMap((chain) => chain.instances)) {
        expect(deployment.instanceKind).toBe("unclassified");
        expect(deployment.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(deployment.receipt.transactionHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
        const code = catalog.code(deployment.codeId);
        expect(code.runtimeTemplate.length).toBe(code.runtimeTemplateByteLength * 2 + 2);
        expect(code.compilerEvidence === null).toBe(code.immutableReferences === null);
        if (code.compilerEvidence !== null) {
          expect(code.compilerEvidence.sourceInputIdentitySha256).toBe(deployment.compilerInputIdentitySha256);
          expect(code.compilerEvidence.deploymentPaths).toContain(deployment.artifactPath);
        }
        for (const span of code.immutableReferences ?? []) {
          expect(span.start).toBeGreaterThanOrEqual(0);
          expect(span.start + span.length).toBeLessThanOrEqual(code.runtimeTemplateByteLength);
        }
      }
    }
  });

  it("rejects modified pinned data and never loads catalogs over HTTP", async () => {
    const altered = structuredClone(catalog.data);
    altered.protocolVersion = 6;
    (altered.generation as { contentHash: string }).contentHash = "0".repeat(64);
    expect(() => new ContractCatalog(altered)).toThrow(ContractCatalogError);
    expect(() => { (catalog.get(catalog.data.contracts[0]!.id) as { name: string }).name = "changed"; }).toThrow();
    await expect(ContractCatalog.load(new URL("https://example.com/catalog.json"))).rejects.toThrow(/local file/);
  });
});

describe("lossless Solidity JSON schemas", () => {
  it("enforces full integer ranges without floating-point conversion", () => {
    const unsigned = new RegExp(String(abiParameterJsonSchema({ type: "uint8" }).pattern));
    const signed = new RegExp(String(abiParameterJsonSchema({ type: "int8" }).pattern));
    for (let value = -260; value <= 260; value++) {
      expect(unsigned.test(String(value))).toBe(value >= 0 && value <= 255);
      expect(signed.test(String(value))).toBe(value >= -128 && value <= 127);
    }
    for (const invalid of ["-0", "+1", "01", "1e2", " 1", "1.0", ""]) expect(unsigned.test(invalid) || signed.test(invalid)).toBe(false);
    const wide = new RegExp(String(abiParameterJsonSchema({ type: "uint256" }).pattern));
    expect(wide.test(((1n << 256n) - 1n).toString())).toBe(true);
    expect(wide.test((1n << 256n).toString())).toBe(false);
  });

  it("preserves tuple-array structure, argument names and fixed sizes", () => {
    const parameter = { name: "items", type: "tuple[][2]", components: [{ name: "who", type: "address" }, { name: "amount", type: "uint256" }] } as const;
    expect(canonicalAbiType(parameter)).toBe("(address,uint256)[][2]");
    expect(abiParameterJsonSchema(parameter)).toMatchObject({ type: "array", minItems: 2, maxItems: 2,
      items: { type: "array", items: { type: "array", minItems: 2, maxItems: 2, items: false } } });
    expect(functionInputJsonSchema({ inputs: [parameter] })).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema", minItems: 1, maxItems: 1, items: false,
      prefixItems: [{ title: "items" }],
    });
    expect(new RegExp(String(abiParameterJsonSchema({ type: "bytes2" }).pattern)).test("0xabcd")).toBe(true);
    expect(new RegExp(String(abiParameterJsonSchema({ type: "bytes2" }).pattern)).test("0xabc")).toBe(false);
  });
});
