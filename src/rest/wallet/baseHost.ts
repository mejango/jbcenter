import type { Pool } from "pg";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RestError, type RestRpc } from "../core.js";
import type { createSmartAccountService } from "../smartAccounts/service.js";
import { PostgresSmartAccountRegistry } from "../smartAccounts/postgres.js";
import type { ContractPin, SmartAccountManifest } from "../smartAccounts/types.js";
import { PostgresWalletAuthorityStore } from "./authorityPostgres.js";
import { createWalletAuthorityChain } from "./authorityChain.js";
import { createWalletAuthorityService } from "./authorityService.js";
import { createBaseWalletDeploymentReader, createBaseWalletDeploymentSettlement, createBaseWalletDeploymentTransport } from "./deploymentBase.js";
import { createWalletDeploymentChain } from "./deploymentChain.js";
import { createWalletDeploymentExecution } from "./deploymentExecution.js";
import { PostgresWalletDeploymentStore, type WalletDeploymentPoolConfiguration } from "./deploymentPostgres.js";
import { PostgresWalletEnrollmentStore } from "./enrollmentPostgres.js";
import { createLocalWalletSignup } from "./signup.js";
import { PostgresWalletSignupStore } from "./signupPostgres.js";
import type { RestWalletRuntime } from "../runtime.js";

export interface BaseWalletSignupHostOptions {
  url: string;
  genesisHash?: Hex;
  /** Dedicated creation treasury key. Read from the host environment only; never logged. */
  signerKey: Hex;
  poolId: string;
  allocationWei: string;
  /** The sender's expected first nonce. Initialization never adopts a provider value. */
  initialNonce: string;
  manifest: SmartAccountManifest;
  utility: ContractPin;
  onEvent?: Parameters<typeof createLocalWalletSignup>[0]["onEvent"];
}
/** Reviewed pilot relay policy: one Safe creation per operation, bounded execution envelope. The
 * whole allocation must cover one maximum envelope; L1/operator fees are reserved separately. */
export const baseWalletCreationPolicy = Object.freeze({ maximumRawBytes: 32768, maximumGas: "2000000", maximumFeePerGas: "10000000000",
  maximumTransactionCost: "20000000000000000", maximumObservationAgeMs: 10_000 });

/** Explicit host composition for hosted Base signup. Startup configures the single permanent pool
 * and initializes its accounting exactly once; a later start with different values fails closed. */
export async function createBaseWalletSignupHost(context: { pool: Pool; rpc: RestRpc; wallet: RestWalletRuntime;
  smart: ReturnType<typeof createSmartAccountService> }, options: BaseWalletSignupHostOptions) {
  if (typeof options.signerKey !== "string" || !/^0x[0-9a-f]{64}$/i.test(options.signerKey) ||
      typeof options.initialNonce !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(options.initialNonce))
    throw new RestError(500, "WALLET_CREATION_CONFIG_INVALID", "Hosted creation requires a signer key and explicit first nonce.");
  const signer = privateKeyToAccount(options.signerKey);
  const configuration: WalletDeploymentPoolConfiguration = { id: options.poolId, chainId: 8453, sender: signer.address.toLowerCase() as Hex,
    allocationWei: options.allocationWei, globalAllocationLimitWei: options.allocationWei, policy: { ...baseWalletCreationPolicy } };
  const base = { url: options.url, ...(options.genesisHash ? { genesisHash: options.genesisHash } : {}) };
  const reader = createBaseWalletDeploymentReader(base);
  const deployments = new PostgresWalletDeploymentStore(context.pool);
  const settlement = createBaseWalletDeploymentSettlement({ ...base, utility: options.utility });
  await deployments.configurePool(configuration);
  const funding = await deployments.loadFundingContext(configuration.id);
  if (!funding.pool.accounting) await deployments.initializeAccounting(funding, await settlement.observeFunding(funding), options.initialNonce);
  // Every chain read for creation goes through the single Dwellir endpoint, never a public fallback.
  const chain = createWalletDeploymentChain({ rpc: reader.reads, configuration, manifest: options.manifest, utility: options.utility });
  const execution = createWalletDeploymentExecution({ store: deployments, chain, signer, experimentalTransport: createBaseWalletDeploymentTransport(base) });
  const authority = createWalletAuthorityService({ store: new PostgresWalletAuthorityStore(context.pool),
    chain: createWalletAuthorityChain({ rpc: context.rpc, manifest: options.manifest, utility: options.utility }) });
  return createLocalWalletSignup({ flows: new PostgresWalletSignupStore(context.pool, { rpId: new URL(context.wallet.origin).hostname,
      origin: context.wallet.origin, manifest: options.manifest }), enrollments: new PostgresWalletEnrollmentStore(context.pool),
    deployments, settlement, execution, chain, smart: context.smart, registry: new PostgresSmartAccountRegistry(context.pool), authority,
    poolId: configuration.id, ...(options.onEvent ? { onEvent: options.onEvent } : {}) });
}
