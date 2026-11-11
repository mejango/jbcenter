import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Hex } from "viem";
import type {
  ProtocolOperation,
  ProtocolOperations,
  BlockEvidence,
} from "@juicebox/mcp/host";
import type { Store } from "../store.js";
import {
  ContractCatalog,
  functionInputJsonSchema,
  functionOutputJsonSchema,
  type ContractCategory,
} from "./contracts/catalog.js";
import {
  RestError,
  type RestBlockEvidence,
  type RestPlanDraft,
  type RestRpc,
} from "./core.js";
import { withRestRequest } from "./context.js";
import type { IndexerReadInput, IndexerReadService } from "./indexer/index.js";
import type {
  createProtocolReadService,
  PrepareInput,
  ReadInput,
  ResolveInput,
} from "./protocol/index.js";
import {
  integer,
  jsonBody,
  jsonValue,
  object,
  problem,
  query,
  required,
  requestTarget,
  response,
  REST_LIMITS,
  REST_PREFIX,
  validateTarget,
} from "./http.js";

export interface RestDependencies {
  quota: Pick<Store, "consumeRequest">;
  contracts: ContractCatalog;
  protocol: ReturnType<typeof createProtocolReadService>;
  rpc: RestRpc;
  indexer: IndexerReadService;
  operations: ProtocolOperations;
  omnichain?: {
    getProjectGroup(
      project: { chainId: number; projectId: string; version: 6 },
      options: { source: "onchain" | "bendystraw"; maxMembers?: number },
      signal?: AbortSignal,
    ): Promise<unknown>;
  };
  openapi?: unknown;
  maxConcurrentRequests?: number;
}

type RestEnv = {
  Variables: { requestId: string; restSignal: AbortSignal };
  Bindings: {
    incoming?: { url?: string; socket?: { remoteAddress?: string } };
  };
};
const page = (params: URLSearchParams) => ({
  offset: integer(params.get("offset") ?? "0", "offset", 100_000),
  limit: integer(params.get("limit") ?? "25", "limit", 100),
});
const nonTransactionPreparations = new Set([
  "prepare_project_metadata",
  "prepare_nft_metadata",
  "prepare_intent",
]);
const statelessPlanOperations = new Set([
  "inspect_plan",
  "simulate_plan",
  "verify_plan",
]);

export function isRestReadOperation(
  operation: Pick<ProtocolOperation, "id" | "kind" | "transaction" | "effects">,
): boolean {
  return (
    !operation.effects.externalMutation &&
    !operation.transaction &&
    (operation.kind !== "prepare" ||
      nonTransactionPreparations.has(operation.id))
  );
}

export function operationDescriptors(operations: ProtocolOperations) {
  return operations
    .list()
    .filter(
      (operation) =>
        !operation.effects.externalMutation &&
        !statelessPlanOperations.has(operation.id),
    )
    .map((operation) => ({
      id: operation.id,
      description: operation.description,
      kind: operation.kind,
      sources: operation.sources.map((source) =>
        source === "indexer" ? "bendystraw" : source,
      ),
      transaction: operation.transaction,
      effects: operation.effects,
      inputJsonSchema: operation.inputJsonSchema,
      method: operation.transaction ? "POST" : "GET",
      path: operation.transaction
        ? `${REST_PREFIX}/operations/${operation.id}/plans`
        : `${REST_PREFIX}/operations/${operation.id}`,
    }));
}

function source(params: URLSearchParams): "onchain" | "bendystraw" {
  const value = required(params, "source");
  if (value !== "onchain" && value !== "bendystraw")
    throw new RestError(
      400,
      "INVALID_SOURCE",
      "Choose onchain or bendystraw explicitly",
    );
  return value;
}

function protocolInput(params: URLSearchParams, read: true): ReadInput;
function protocolInput(params: URLSearchParams, read: false): ResolveInput;
function protocolInput(
  params: URLSearchParams,
  read: boolean,
): ReadInput | ResolveInput {
  const common = {
    chainId: integer(required(params, "chainId"), "chainId"),
    contractId: required(params, "contractId"),
    ...(params.has("address") ? { address: required(params, "address") } : {}),
    ...(params.has("projectId")
      ? { projectId: required(params, "projectId") }
      : {}),
    ...(params.has("blockNumber")
      ? { blockNumber: required(params, "blockNumber") }
      : {}),
  };
  if (!read) return common;
  const args = jsonValue(required(params, "args"), "args");
  if (!Array.isArray(args))
    throw new RestError(
      400,
      "INVALID_ARGUMENTS",
      "Function arguments must be a JSON array",
    );
  return { ...common, function: required(params, "function"), args };
}

function indexerInput(params: URLSearchParams): IndexerReadInput {
  const value: Record<string, unknown> = {
    network: required(params, "network"),
  };
  for (const key of ["chainId", "limit"])
    if (params.has(key)) value[key] = integer(required(params, key), key);
  for (const key of ["projectId", "cursor"])
    if (params.has(key)) value[key] = required(params, key);
  for (const key of ["id", "filters", "fields", "orderBy"])
    if (params.has(key)) value[key] = jsonValue(required(params, key), key);
  return value as unknown as IndexerReadInput;
}

/** Mount at /api/v1. Reads and unsigned preparation never create account authority. */
export function createRestApp(deps: RestDependencies): Hono<RestEnv> {
  const app = new Hono<RestEnv>();
  const descriptors = operationDescriptors(deps.operations);
  const byId = new Map(descriptors.map((entry) => [entry.id, entry]));
  let active = 0;
  const maximum =
    deps.maxConcurrentRequests ?? REST_LIMITS.maxConcurrentRequests;
  if (!Number.isSafeInteger(maximum) || maximum < 1)
    throw new Error("Invalid REST concurrency limit");

  app.onError(problem);
  app.use(
    "*",
    cors({
      origin: "*",
      credentials: false,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
      exposeHeaders: [
        "X-Request-Id",
        "Retry-After",
        "RateLimit-Limit",
        "RateLimit-Remaining",
      ],
      maxAge: 600,
    }),
  );
  app.use("*", async (context, next) => {
    context.set("requestId", randomUUID());
    context.header("X-Request-Id", context.get("requestId"));
    context.header("Cache-Control", "no-store");
    context.header("X-Content-Type-Options", "nosniff");
    validateTarget(requestTarget(context));
    if (
      ["GET", "HEAD"].includes(context.req.method) &&
      (context.req.header("transfer-encoding") ||
        Number(context.req.header("content-length") ?? 0) !== 0)
    )
      throw new RestError(
        400,
        "GET_BODY_UNSUPPORTED",
        "GET reads must put their input in the query string",
      );
    if (active >= maximum)
      throw new RestError(
        429,
        "SERVICE_BUSY",
        "The service has reached its concurrent request limit",
      );
    active++;
    try {
      // The transport owns peer identity. Client-supplied forwarding headers cannot reset this budget.
      const peer = context.env?.incoming?.socket?.remoteAddress ?? "unknown";
      const key = createHash("sha256").update(peer).digest("hex");
      const caller = await deps.quota.consumeRequest(
        `rest:peer:${key}`,
        REST_LIMITS.requestsPerMinute,
        60,
      );
      context.header("RateLimit-Limit", String(REST_LIMITS.requestsPerMinute));
      context.header("RateLimit-Remaining", String(caller.remaining));
      if (!caller.allowed)
        throw new RestError(
          429,
          "RATE_LIMITED",
          "The transport peer request budget is spent; retry later",
        );
      const site = await deps.quota.consumeRequest(
        "rest:site",
        REST_LIMITS.siteRequestsPerMinute,
        60,
      );
      if (!site.allowed)
        throw new RestError(
          429,
          "RATE_LIMITED",
          "The REST service request budget is spent; retry later",
        );
      const signal = AbortSignal.any([
        context.req.raw.signal,
        AbortSignal.timeout(REST_LIMITS.timeoutMs),
      ]);
      context.set("restSignal", signal);
      await withRestRequest(signal, next);
      signal.throwIfAborted();
    } finally {
      active--;
    }
  });

  const canonicalHead = async (
    input: unknown,
    signal: AbortSignal,
  ): Promise<RestBlockEvidence> => {
    const head = object(input, [
      "chainId",
      "blockNumber",
      "blockHash",
      "timestamp",
      "source",
    ]);
    if (
      !Number.isSafeInteger(head.chainId) ||
      Number(head.chainId) <= 0 ||
      typeof head.blockNumber !== "string" ||
      !/^(0|[1-9][0-9]{0,77})$/.test(head.blockNumber) ||
      typeof head.timestamp !== "string" ||
      !/^(0|[1-9][0-9]{0,77})$/.test(head.timestamp) ||
      typeof head.blockHash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(head.blockHash) ||
      head.source !== "onchain"
    )
      throw new RestError(
        400,
        "INVALID_BLOCK_EVIDENCE",
        "Supply an exact onchain block identity",
      );
    const chainId = head.chainId as number;
    if (!deps.contracts.data.chains.some((chain) => chain.id === chainId))
      throw new RestError(
        400,
        "UNSUPPORTED_CHAIN",
        "The requested chain is not supported",
      );
    const observedChain = await deps.rpc.request(
      chainId,
      "eth_chainId",
      [],
      signal,
    );
    if (observedChain !== `0x${chainId.toString(16)}`)
      throw new RestError(
        502,
        "RPC_CHAIN_MISMATCH",
        "The RPC did not establish the requested chain",
      );
    const block = await deps.rpc.request(
      chainId,
      "eth_getBlockByNumber",
      [`0x${BigInt(head.blockNumber).toString(16)}`, false],
      signal,
    );
    if (!block || typeof block !== "object" || Array.isArray(block))
      throw new RestError(
        409,
        "BLOCK_EVIDENCE_UNAVAILABLE",
        "The requested canonical block is unavailable",
      );
    const observed = block as Record<string, unknown>;
    if (
      typeof observed.hash !== "string" ||
      observed.hash.toLowerCase() !== head.blockHash.toLowerCase() ||
      observed.number !== `0x${BigInt(head.blockNumber).toString(16)}` ||
      observed.timestamp !== `0x${BigInt(head.timestamp).toString(16)}`
    )
      throw new RestError(
        409,
        "BLOCK_EVIDENCE_MISMATCH",
        "The supplied block identity does not match the canonical chain",
      );
    return {
      chainId,
      blockNumber: head.blockNumber,
      blockHash: head.blockHash as Hex,
      timestamp: head.timestamp,
      source: "onchain",
    };
  };
  const draftFor = async (
    id: string,
    input: unknown,
    signal: AbortSignal,
    head?: unknown,
  ): Promise<RestPlanDraft> => {
    if (id === "contract_calls" || id === "protocol-contract-calls") {
      if (head !== undefined)
        throw new RestError(
          400,
          "PINNED_HEAD_UNSUPPORTED",
          "Catalog call preparation establishes its own canonical block evidence",
        );
      return deps.protocol.prepare(
        object(input) as unknown as PrepareInput,
        signal,
      );
    }
    if (!byId.get(id)?.transaction)
      throw new RestError(
        404,
        "TRANSACTION_OPERATION_NOT_FOUND",
        "Choose a transaction operation from the catalog",
      );
    if (head !== undefined && id !== "prepare_pay")
      throw new RestError(
        400,
        "HEAD_UNSUPPORTED",
        "Only prepare_pay currently accepts caller-supplied canonical block evidence",
      );
    const at =
      head === undefined ? undefined : await canonicalHead(head, signal);
    const draft = await deps.operations.prepare(id, input, {
      source: "onchain",
      signal,
      ...(at
        ? {
            at: {
              ...at,
              chainId: at.chainId as BlockEvidence["chainId"],
              source: "rpc" as const,
            },
          }
        : {}),
    });
    if (
      at &&
      (!draft.evidence.some((item) => item.chainId === at.chainId) ||
        draft.evidence.some(
          (item) =>
            item.chainId === at.chainId &&
            (item.blockNumber !== at.blockNumber ||
              item.blockHash.toLowerCase() !== at.blockHash.toLowerCase() ||
              item.timestamp !== at.timestamp),
        ))
    )
      throw new RestError(
        409,
        "BLOCK_EVIDENCE_MISMATCH",
        "The prepared calls do not use the supplied canonical block",
      );
    return {
      ...draft,
      evidence: draft.evidence.map((item) => ({ ...item, source: "onchain" })),
    };
  };
  app.get("/", (context) => {
    query(context, []);
    return response(context, {
      version: "1",
      protocolVersion: 6,
      documentation: "/api",
      openapi: `${REST_PREFIX}/openapi.json`,
      accountService: "https://api.signa.center",
      capabilities: `${REST_PREFIX}/capabilities`,
    });
  });
  app.get("/openapi.json", (context) => {
    query(context, []);
    if (!deps.openapi)
      throw new RestError(
        503,
        "SPECIFICATION_UNAVAILABLE",
        "The API specification is unavailable",
      );
    return response(context, deps.openapi);
  });
  app.get("/capabilities", async (context) => {
    query(context, []);
    return response(context, {
      version: "1",
      protocolVersion: 6,
      authentication: { scheme: "none" },
      execution: { available: false, service: "https://api.signa.center" },
      chains: deps.contracts.data.chains,
      limits: REST_LIMITS,
      omnichain: {
        available: Boolean(deps.omnichain),
        atomicAcrossChains: false,
        receiptConfirmsBridgeSettlement: false,
      },
      sources: {
        onchain: { canonicalBlockHash: true },
        bendystraw: {
          canonicalBlockHash: false,
          pagination: "cursor",
          protocolVersion: 6,
        },
      },
      catalogs: {
        contracts: `${REST_PREFIX}/catalog/contracts`,
        indexer: `${REST_PREFIX}/catalog/indexer`,
        operations: `${REST_PREFIX}/catalog/operations`,
      },
    });
  });
  app.get("/catalog/contracts", (context) => {
    const params = query(context, [
      "packageId",
      "category",
      "chainId",
      "deployedOnly",
      "executableOnly",
      "offset",
      "limit",
    ]);
    for (const key of ["deployedOnly", "executableOnly"])
      if (params.has(key) && !["true", "false"].includes(params.get(key)!))
        throw new RestError(
          400,
          "INVALID_BOOLEAN",
          `${key} must be true or false`,
        );
    const category = params.get("category");
    if (
      category &&
      !["contract", "abstract", "interface", "library", "script"].includes(
        category,
      )
    )
      throw new RestError(
        400,
        "INVALID_CATEGORY",
        "Choose a catalog contract category",
      );
    const all = deps.contracts.list({
      ...(params.has("packageId")
        ? { packageId: required(params, "packageId") }
        : {}),
      ...(category ? { category: category as ContractCategory } : {}),
      ...(params.has("chainId")
        ? { chainId: integer(required(params, "chainId"), "chainId") }
        : {}),
      deployedOnly: params.get("deployedOnly") === "true",
      executableOnly: params.get("executableOnly") === "true",
    });
    const { offset, limit } = page(params);
    if (limit < 1)
      throw new RestError(400, "INVALID_LIMIT", "Page limit must be positive");
    return response(context, {
      protocolVersion: 6,
      provenance: deps.contracts.data.deploymentManifest,
      packages: deps.contracts.data.packages,
      exclusions: deps.contracts.data.exclusions,
      items: all.slice(offset, offset + limit).map((item) => ({
        id: item.id,
        name: item.name,
        packageId: item.packageId,
        category: item.category,
        executable: item.executable,
        methodCounts: {
          read: item.methods.filter((method) => method.kind === "read").length,
          write: item.methods.filter((method) => method.kind === "write")
            .length,
        },
        chains: item.deployments.map((deployment) => ({
          chainId: deployment.chainId,
          status: deployment.status,
          addresses: deployment.instances.map((instance) => instance.address),
          instances: deployment.instances.map(
            ({ address, retired, generation }) => ({
              address,
              retired,
              ...(generation ? { generation } : {}),
            }),
          ),
        })),
      })),
      total: all.length,
      nextOffset: offset + limit < all.length ? offset + limit : null,
    });
  });
  app.get("/catalog/contract", (context) => {
    const params = query(context, ["id"]);
    return response(context, deps.contracts.get(required(params, "id")));
  });
  app.get("/catalog/method", (context) => {
    const params = query(context, ["contractId", "signature", "abiHash"]);
    const method = deps.contracts.method(
      required(params, "contractId"),
      required(params, "signature"),
      params.get("abiHash") ?? undefined,
    );
    return response(context, {
      ...method,
      inputJsonSchema: functionInputJsonSchema(method),
      outputJsonSchema: functionOutputJsonSchema(method),
    });
  });
  app.get("/catalog/indexer", (context) => {
    query(context, []);
    return response(context, deps.indexer.catalog());
  });
  app.get("/catalog/operations", (context) => {
    query(context, []);
    return response(context, { data: { operations: descriptors } });
  });
  app.get("/catalog/operations/:id", (context) => {
    query(context, []);
    const descriptor = byId.get(context.req.param("id"));
    if (!descriptor)
      throw new RestError(
        404,
        "OPERATION_NOT_FOUND",
        "Choose an operation from the catalog",
      );
    return response(context, descriptor);
  });

  app.get("/protocol/resolve", async (context) => {
    const params = query(context, [
      "chainId",
      "contractId",
      "address",
      "projectId",
      "blockNumber",
    ]);
    return response(
      context,
      await deps.protocol.resolve(
        protocolInput(params, false),
        context.get("restSignal"),
      ),
    );
  });
  app.get("/protocol/read", async (context) => {
    const params = query(context, [
      "chainId",
      "contractId",
      "address",
      "projectId",
      "blockNumber",
      "function",
      "args",
    ]);
    return response(
      context,
      await deps.protocol.read(
        protocolInput(params, true),
        context.get("restSignal"),
      ),
    );
  });
  app.get("/indexer/status", async (context) => {
    const params = query(context, ["network"]);
    return response(
      context,
      await deps.indexer.status(
        { network: required(params, "network") as "mainnet" | "testnet" },
        context.get("restSignal"),
      ),
    );
  });
  app.get("/indexer/:entity/record", async (context) => {
    const params = query(context, [
      "network",
      "chainId",
      "projectId",
      "id",
      "fields",
    ]);
    return response(
      context,
      await deps.indexer.read(
        context.req.param("entity"),
        indexerInput(params),
        context.get("restSignal"),
      ),
    );
  });
  app.get("/indexer/:entity", async (context) => {
    const params = query(context, [
      "network",
      "chainId",
      "projectId",
      "filters",
      "fields",
      "orderBy",
      "limit",
      "cursor",
    ]);
    return response(
      context,
      await deps.indexer.list(
        context.req.param("entity"),
        indexerInput(params),
        context.get("restSignal"),
      ),
    );
  });
  app.get("/projects/:chainId/:projectId", async (context) => {
    const selected = source(query(context, ["source"]));
    return response(
      context,
      await deps.operations.execute(
        "get_project",
        {
          project: {
            chainId: integer(context.req.param("chainId"), "chainId"),
            projectId: context.req.param("projectId"),
            version: 6,
          },
        },
        {
          source: selected === "bendystraw" ? "indexer" : "onchain",
          signal: context.get("restSignal"),
        },
      ),
    );
  });
  app.get("/projects/:chainId/:projectId/omnichain", async (context) => {
    const params = query(context, ["source", "maxMembers"]);
    const selected = source(params);
    if (!deps.omnichain)
      throw new RestError(
        503,
        "OMNICHAIN_UNAVAILABLE",
        "The omnichain reader is not configured",
      );
    return response(
      context,
      await deps.omnichain.getProjectGroup(
        {
          chainId: integer(context.req.param("chainId"), "chainId"),
          projectId: context.req.param("projectId"),
          version: 6,
        },
        {
          source: selected,
          ...(params.has("maxMembers")
            ? {
                maxMembers: integer(
                  required(params, "maxMembers"),
                  "maxMembers",
                  8,
                ),
              }
            : {}),
        },
        context.get("restSignal"),
      ),
    );
  });
  app.get("/operations/:id", async (context) => {
    const params = query(context, ["input", "source"]);
    const id = context.req.param("id");
    const descriptor = byId.get(id);
    if (!descriptor || !isRestReadOperation(descriptor))
      throw new RestError(
        404,
        "READ_OPERATION_NOT_FOUND",
        "Choose a read operation from the catalog",
      );
    const selectable = descriptor.sources.filter(
      (source) => source === "onchain" || source === "bendystraw",
    );
    const selected = params.has("source") ? source(params) : undefined;
    if (selectable.length > 1 && !selected)
      throw new RestError(
        400,
        "SOURCE_REQUIRED",
        "Choose onchain or bendystraw explicitly",
      );
    return response(
      context,
      await deps.operations.execute(
        id,
        jsonValue(params.get("input") ?? "{}"),
        {
          signal: context.get("restSignal"),
          ...(selected
            ? { source: selected === "bendystraw" ? "indexer" : "onchain" }
            : {}),
        },
      ),
    );
  });
  app.post("/operations/:id/plans", async (context) => {
    query(context, []);
    const draft = await draftFor(
      context.req.param("id"),
      await jsonBody(context.req.raw, context.get("restSignal")),
      context.get("restSignal"),
    );
    return response(context, { data: draft });
  });
  app.post("/plans", async (context) => {
    query(context, []);
    const body = object(
      await jsonBody(context.req.raw, context.get("restSignal")),
      ["operation", "input", "at"],
    );
    if (typeof body.operation !== "string")
      throw new RestError(
        400,
        "OPERATION_REQUIRED",
        "Choose a transaction operation or contract_calls",
      );
    const draft = await draftFor(
      body.operation,
      body.input,
      context.get("restSignal"),
      body.at,
    );
    return response(context, { data: draft });
  });
  return app;
}
