import type { Config } from './config.js';
import { RpcPool } from './adapters/rpc.js';
import { BendystrawClient } from './adapters/bendystraw.js';
import { CenterClient } from './adapters/jbcenter.js';
import { ProjectService } from './services/projects.js';
import { PaymentService } from './services/payments.js';
import { ConfigurationService } from './services/configuration.js';
import { ExtensionService } from './services/extensions.js';
import { PlanService } from './services/plans.js';
import { KnowledgeService } from './services/knowledge.js';
import { ContractService } from './services/contracts.js';
import { ProductService } from './services/products.js';
import { RoutingService } from './services/routing.js';
import { DevelopmentService } from './services/development.js';

export function createServices(config: Config) {
  const rpc = new RpcPool(config.rpcUrls);
  return {
    publicOrigin: config.publicOrigin,
    rpc,
    bendystraw: new BendystrawClient({
      mainnetUrl: config.bendystrawMainnetUrl,
      testnetUrl: config.bendystrawTestnetUrl,
    }),
    center: new CenterClient({
      baseUrl: config.centerUrl,
      ...(config.centerOrigin ? { headers: { origin: config.centerOrigin } } : {}),
    }),
    projects: new ProjectService(rpc),
    payments: new PaymentService(rpc),
    configuration: new ConfigurationService(rpc),
    extensions: new ExtensionService(rpc),
    plans: new PlanService({ rpc, secret: config.planSecret, ttlSeconds: config.planTtlSeconds }),
    knowledge: new KnowledgeService(config.knowledgePath ? { path: config.knowledgePath } : {}),
    contracts: new ContractService(),
    products: new ProductService(rpc),
    routing: new RoutingService(rpc),
    development: new DevelopmentService({ publicOrigin: config.publicOrigin }),
  };
}
export type Services = ReturnType<typeof createServices>;
