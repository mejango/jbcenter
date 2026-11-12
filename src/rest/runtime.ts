import { createProtocolOperations, type Config, type Services } from "@juicebox/mcp/host";
import type { Store } from "../store.js";
import type { RpcUpstreams } from "../rpc.js";
import { createRestApp } from "./app.js";
import { getContractCatalog } from "./contracts/catalog.js";
import { RestError, type RestRpc } from "./core.js";
import { restRequest } from "./context.js";
import { apiDocsCss, apiDocsPage, apiReferencePages, apiSearchTerms, buildRestOpenApi, docsAssetNames } from "./docs/index.js";
import { createIndexerReadService } from "./indexer/index.js";
import { createOmnichainService } from "./omnichain/index.js";
import { createProtocolReadService } from "./protocol/index.js";
import { createRestRpc } from "./rpc.js";
import { readRestAssets, type RestSite } from "./site.js";

/** Center owns protocol evidence and unsigned drafts; Signa owns accounts and execution. */
export async function createRestRuntime(options: {
  store: Pick<Store, "consumeRequest" | "cleanupRateLimits">;
  services: Services;
  config: Config;
  upstreams: RpcUpstreams;
  audience?: string;
  rpcSiteLimitPerMinute?: number;
  rpc?: RestRpc;
}): Promise<{ site: RestSite; rpc: RestRpc; catalog: Awaited<ReturnType<typeof getContractCatalog>>; stop(): Promise<void> }> {
  const contracts = await getContractCatalog();
  const shutdown = new AbortController();
  const backend = options.rpc ?? createRestRpc({
    upstreams: options.upstreams,
    consume: async () => {
      const [quota, site] = await Promise.all([
        options.store.consumeRequest("rpc:rest", 20_000, 60),
        options.store.consumeRequest("rpc:site", options.rpcSiteLimitPerMinute ?? 20_000, 60),
      ]);
      if (!quota.allowed || !site.allowed)
        throw new RestError(429, "RATE_LIMITED", "The shared chain request budget is spent; retry later");
    },
  });
  const rpc: RestRpc = {
    request: (chainId, method, params, signal) => backend.request(chainId, method, params,
      AbortSignal.any([shutdown.signal, ...(signal ? [signal] : []), ...(restRequest() ? [restRequest()!.signal] : [])])),
  };
  const operations = createProtocolOperations(options.services);
  const protocol = createProtocolReadService({ rpc, catalog: contracts });
  const indexer = createIndexerReadService({
    ...(options.config.bendystrawMainnetUrl ? { mainnetUrl: options.config.bendystrawMainnetUrl } : {}),
    ...(options.config.bendystrawTestnetUrl ? { testnetUrl: options.config.bendystrawTestnetUrl } : {}),
  });
  const omnichain = createOmnichainService({ operations, indexer });
  const audience = options.audience ?? options.config.publicOrigin;
  const openapi = buildRestOpenApi({ contracts, indexer, operations, publicOrigin: audience });
  const assets = await readRestAssets();
  let cleaning: Promise<unknown> | undefined;
  const cleanup = setInterval(() => {
    cleaning ??= options.store.cleanupRateLimits().catch(() => {
      console.error(JSON.stringify({ service: "rest", code: "RATE_LIMIT_CLEANUP_UNAVAILABLE" }));
    }).finally(() => { cleaning = undefined; });
  }, 60_000);
  cleanup.unref();
  return {
    site: {
      app: createRestApp({ quota: options.store, contracts, protocol, indexer, operations, omnichain, rpc, openapi }),
      audience,
      docsHtml: apiDocsPage(openapi, docsAssetNames(assets.docsScript)),
      apiReference: apiReferencePages(openapi, docsAssetNames(assets.docsScript)),
      apiTerms: JSON.stringify(apiSearchTerms(openapi)),
      docsCss: apiDocsCss,
      ...assets,
    },
    rpc,
    catalog: contracts,
    async stop() { clearInterval(cleanup); shutdown.abort(); await cleaning; },
  };
}
