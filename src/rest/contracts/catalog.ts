import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AbiParameter } from "viem";
import type {
  CodeRecord, ContractAbiVariant, ContractCatalogData, ContractDeploymentMatch,
  ContractFilter, ContractMethod, ContractRecord, JsonSchema,
} from "./types.js";

export * from "./types.js";

export class ContractCatalogError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ContractCatalogError";
  }
}

/** Stable serialization is shared with the generator's integrity calculation. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export class ContractCatalog {
  readonly data: ContractCatalogData;
  readonly #contracts = new Map<string, ContractRecord>();
  readonly #codes = new Map<string, CodeRecord>();
  readonly #addresses = new Map<string, ContractDeploymentMatch[]>();

  constructor(data: ContractCatalogData) {
    if (data.schemaVersion !== 1 || data.protocolVersion !== 6) {
      throw new ContractCatalogError("CATALOG_VERSION", "Only the V6 catalog schema is supported.");
    }
    const expected = createHash("sha256").update(stable({
      ...data, generation: { ...data.generation, contentHash: "" },
    })).digest("hex");
    if (expected !== data.generation.contentHash) {
      throw new ContractCatalogError("CATALOG_INTEGRITY", "The pinned contract catalog failed its integrity check.");
    }
    this.data = freeze(data);
    const chainIds = new Set(data.chains.map((chain) => chain.id));
    const packageIds = new Set(data.packages.map((entry) => entry.id));
    for (const code of data.codes) {
      if (this.#codes.has(code.id)) throw new ContractCatalogError("CATALOG_DUPLICATE", `Duplicate code ID: ${code.id}`);
      this.#codes.set(code.id, code);
    }
    for (const contract of data.contracts) {
      if (this.#contracts.has(contract.id) || !packageIds.has(contract.packageId)) {
        throw new ContractCatalogError("CATALOG_REFERENCE", `Invalid contract ID or package: ${contract.id}`);
      }
      if (!contract.variants.some((variant) => variant.abiHash === contract.abiHash)) {
        throw new ContractCatalogError("CATALOG_REFERENCE", `Missing primary ABI: ${contract.id}`);
      }
      const observedChains = new Set<number>();
      for (const chain of contract.deployments) {
        if (!chainIds.has(chain.chainId) || observedChains.has(chain.chainId)
          || (chain.status === "published") !== (chain.instances.length > 0)) {
          throw new ContractCatalogError("CATALOG_REFERENCE", `Invalid deployment chain: ${contract.id}`);
        }
        observedChains.add(chain.chainId);
        for (const deployment of chain.instances) {
          if (deployment.chainId !== chain.chainId || !/^0x[0-9a-fA-F]{40}$/.test(deployment.address)
            || typeof deployment.retired !== "boolean"
            || (deployment.generation !== undefined && !["current", "previous", "v1"].includes(deployment.generation))
            || !this.#codes.has(deployment.codeId)
            || !contract.variants.some((variant) => variant.abiHash === deployment.abiHash && variant.usage === "published")) {
            throw new ContractCatalogError("CATALOG_REFERENCE", `Invalid deployment: ${contract.id}/${deployment.alias}`);
          }
          const code = this.#codes.get(deployment.codeId)!;
          if (code.compilerEvidence !== null
            && (code.compilerEvidence.sourceInputIdentitySha256 !== deployment.compilerInputIdentitySha256
              || !code.compilerEvidence.deploymentPaths?.includes(deployment.artifactPath))) {
            throw new ContractCatalogError("CATALOG_REFERENCE", `Compiler proof belongs to another deployment: ${contract.id}/${deployment.alias}`);
          }
          const key = `${chain.chainId}:${deployment.address.toLowerCase()}`;
          const entries = this.#addresses.get(key) ?? [];
          entries.push(freeze({ contract, deployment }));
          this.#addresses.set(key, entries);
        }
      }
      if (observedChains.size !== chainIds.size) {
        throw new ContractCatalogError("CATALOG_REFERENCE", `Missing chain availability: ${contract.id}`);
      }
      this.#contracts.set(contract.id, contract);
    }
    for (const entries of this.#addresses.values()) freeze(entries);
  }

  static async load(path: URL = new URL("./data/catalog.json", import.meta.url)): Promise<ContractCatalog> {
    if (path.protocol !== "file:") throw new ContractCatalogError("CATALOG_SOURCE", "Catalog data must be a local file.");
    return new ContractCatalog(JSON.parse(await readFile(path, "utf8")) as ContractCatalogData);
  }

  list(filter: ContractFilter = {}): readonly ContractRecord[] {
    if (filter.chainId !== undefined) this.assertChain(filter.chainId);
    return this.data.contracts.filter((contract) => {
      if (filter.packageId !== undefined && contract.packageId !== filter.packageId) return false;
      if (filter.category !== undefined && contract.category !== filter.category) return false;
      if (filter.executableOnly && !contract.executable) return false;
      if (filter.deployedOnly) return contract.deployments.some((chain) =>
        chain.status === "published" && (filter.chainId === undefined || chain.chainId === filter.chainId));
      return true;
    });
  }

  get(id: string): ContractRecord {
    const contract = this.#contracts.get(id);
    if (!contract) throw new ContractCatalogError("CONTRACT_NOT_FOUND", `Unknown qualified contract ID: ${id}`);
    return contract;
  }

  lookup(chainId: number, address: string): readonly ContractDeploymentMatch[] {
    this.assertChain(chainId);
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new ContractCatalogError("INVALID_ADDRESS", "Expected a 20-byte address.");
    return this.#addresses.get(`${chainId}:${address.toLowerCase()}`) ?? [];
  }

  variant(contractId: string, abiHash?: string): ContractAbiVariant {
    const contract = this.get(contractId);
    const variant = contract.variants.find((entry) => entry.abiHash === (abiHash ?? contract.abiHash));
    if (!variant) throw new ContractCatalogError("ABI_NOT_FOUND", `Unknown ABI variant for ${contractId}`);
    return variant;
  }

  method(contractId: string, signature: string, abiHash?: string): ContractMethod {
    const method = this.variant(contractId, abiHash).methods.find((entry) => entry.signature === signature);
    if (!method) throw new ContractCatalogError("METHOD_NOT_FOUND", `Unknown full method signature: ${signature}`);
    return method;
  }

  code(id: string): CodeRecord {
    const code = this.#codes.get(id);
    if (!code) throw new ContractCatalogError("CODE_NOT_FOUND", `Unknown code ID: ${id}`);
    return code;
  }

  assertChain(chainId: number): void {
    if (!this.data.chains.some((chain) => chain.id === chainId)) {
      throw new ContractCatalogError("UNSUPPORTED_CHAIN", `Chain ${chainId} is outside the pinned V6 deployment manifest.`);
    }
  }
}

let catalogPromise: Promise<ContractCatalog> | undefined;
export function getContractCatalog(): Promise<ContractCatalog> {
  return catalogPromise ??= ContractCatalog.load();
}

/** Canonical ABI tuple expansion; Solidity overloads are identified by full signature. */
export function canonicalAbiType(parameter: AbiParameter): string {
  if (!parameter.type.startsWith("tuple")) return parameter.type;
  if (!("components" in parameter)) throw new ContractCatalogError("INVALID_ABI", "Tuple components are missing.");
  return `(${parameter.components.map(canonicalAbiType).join(",")})${parameter.type.slice(5)}`;
}

/** Decimal strings in [1,max], with neither leading zeros nor exponent notation. */
function positiveDecimalPattern(maximum: bigint): string {
  const digits = maximum.toString();
  const choices: string[] = [digits];
  if (digits.length > 1) choices.push(`[1-9][0-9]{0,${digits.length - 2}}`);
  for (let index = 0; index < digits.length; index++) {
    const upper = Number(digits[index]) - 1;
    const lower = index === 0 ? 1 : 0;
    if (upper < lower) continue;
    const digit = lower === upper ? String(lower) : `[${lower}-${upper}]`;
    const rest = digits.length - index - 1;
    choices.push(`${digits.slice(0, index)}${digit}${rest === 0 ? "" : `[0-9]{${rest}}`}`);
  }
  return `(?:${choices.join("|")})`;
}

export function abiParameterJsonSchema(parameter: AbiParameter): JsonSchema {
  const suffix = /^(.*)\[([0-9]*)\]$/.exec(parameter.type);
  if (suffix) {
    const length = suffix[2] === "" ? undefined : Number(suffix[2]);
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 1)) {
      throw new ContractCatalogError("INVALID_ABI", "Invalid fixed array size.");
    }
    return {
      type: "array", items: abiParameterJsonSchema({ ...parameter, type: suffix[1] } as AbiParameter),
      ...(length === undefined ? {} : { minItems: length, maxItems: length }),
    };
  }
  if (parameter.type === "tuple") {
    if (!("components" in parameter)) throw new ContractCatalogError("INVALID_ABI", "Tuple components are missing.");
    return parameterListJsonSchema(parameter.components);
  }
  if (parameter.type === "address") return { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
  if (parameter.type === "bool") return { type: "boolean" };
  if (parameter.type === "string") return { type: "string" };
  if (parameter.type === "bytes") return { type: "string", pattern: "^0x(?:[0-9a-fA-F]{2})*$" };
  if (parameter.type === "function") return { type: "string", pattern: "^0x[0-9a-fA-F]{48}$" };
  const bytes = /^bytes([0-9]+)$/.exec(parameter.type);
  if (bytes && Number(bytes[1]) >= 1 && Number(bytes[1]) <= 32) {
    return { type: "string", pattern: `^0x[0-9a-fA-F]{${Number(bytes[1]) * 2}}$` };
  }
  const integer = /^(u?int)([0-9]*)$/.exec(parameter.type);
  if (integer) {
    const bits = integer[2] === "" ? 256 : Number(integer[2]);
    if (bits < 8 || bits > 256 || bits % 8 !== 0) throw new ContractCatalogError("INVALID_ABI", "Invalid integer width.");
    const signed = integer[1] === "int";
    const bound = 1n << BigInt(signed ? bits - 1 : bits);
    const positive = positiveDecimalPattern(bound - 1n);
    return {
      type: "string", pattern: `^(?:0|${positive}${signed ? `|-${positiveDecimalPattern(bound)}` : ""})$`,
      description: `${parameter.type} as a lossless decimal string`,
    };
  }
  throw new ContractCatalogError("UNSUPPORTED_ABI_TYPE", `Unsupported ABI type: ${parameter.type}`);
}

function parameterListJsonSchema(parameters: readonly AbiParameter[]): JsonSchema {
  return {
    type: "array", minItems: parameters.length, maxItems: parameters.length,
    prefixItems: parameters.map((parameter) => ({
      ...abiParameterJsonSchema(parameter), ...(parameter.name ? { title: parameter.name } : {}),
    })), items: false,
  };
}

export function functionInputJsonSchema(method: Pick<ContractMethod, "inputs">): JsonSchema {
  return { $schema: "https://json-schema.org/draft/2020-12/schema", ...parameterListJsonSchema(method.inputs) };
}

export function functionOutputJsonSchema(method: Pick<ContractMethod, "outputs">): JsonSchema {
  return { $schema: "https://json-schema.org/draft/2020-12/schema", ...parameterListJsonSchema(method.outputs) };
}
