// Test-only composition for a fresh process observing the parent's unforked Anvil.
import type { Pool } from 'pg';
import { privateKeyToAccount } from 'viem/accounts';
import { createSmartAccountService } from '../../src/rest/smartAccounts/service.js';
import { PostgresSmartAccountRegistry } from '../../src/rest/smartAccounts/postgres.js';
import { PostgresOnboardingStore } from '../../src/rest/smartAccounts/onboardingPostgres.js';
import { createSafe7579Inspector } from '../../src/rest/smartAccounts/inspector.js';
import { createInstalledSessionVerifier } from '../../src/rest/smartAccounts/installed.js';
import { PostgresWalletAuthorityStore } from '../../src/rest/wallet/authorityPostgres.js';
import { createWalletAuthorityChain } from '../../src/rest/wallet/authorityChain.js';
import { createWalletAuthorityService } from '../../src/rest/wallet/authorityService.js';
import { PostgresWalletRecoveryStore } from '../../src/rest/wallet/recoveryPostgres.js';
import { PostgresWalletRecoveryFlowStore } from '../../src/rest/wallet/recoveryFlowPostgres.js';
import { createLocalAnvilWalletRecovery } from '../../src/rest/wallet/recoveryLocalAnvil.js';
import { createLocalWalletRecovery, type LocalWalletRecoveryDependencies } from '../../src/rest/wallet/recoveryService.js';
import { createWalletDeploymentAnvilRpc, type startWalletDeploymentAnvil } from './wallet-deployment-anvil.js';

export type RecoveryCrashConfiguration = Pick<Awaited<ReturnType<typeof startWalletDeploymentAnvil>>,
  'endpoint' | 'expectedGenesisHash' | 'manifest' | 'utility'> & { origin: string; rpId: string; audience: string };
export function createRecoveryCrashRuntime(pool: Pool, config: RecoveryCrashConfiguration,
  onEvent?: LocalWalletRecoveryDependencies['onEvent']) {
  const rpc = createWalletDeploymentAnvilRpc(config.endpoint);
  const chain = createWalletAuthorityChain({ rpc, manifest: config.manifest, utility: config.utility });
  const smart = createSmartAccountService({ rpc, manifests: [config.manifest], audience: config.audience,
    registry: new PostgresSmartAccountRegistry(pool), onboarding: new PostgresOnboardingStore(pool),
    moduleInspectors: [createSafe7579Inspector({ rpc, utility: config.utility,
      inspectSessions: createInstalledSessionVerifier({ rpc }).inspectAllAt })] });
  const authority = createWalletAuthorityService({ store: new PostgresWalletAuthorityStore(pool), chain });
  const recoveries = new PostgresWalletRecoveryStore(pool, { origin: config.origin, rpId: config.rpId },
    { audience: config.audience, observe: context => chain.observe(context) });
  const service = createLocalWalletRecovery({ audience: config.audience, smart, authority, recoveries,
    flows: new PostgresWalletRecoveryFlowStore(pool), ...(onEvent ? { onEvent } : {}),
    rotation: createLocalAnvilWalletRecovery({ pool, endpoint: config.endpoint, expectedGenesisHash: config.expectedGenesisHash,
      // Same public fixture key as the completed parent rotation; no production wallet.
      signer: privateKeyToAccount(`0x${'55'.repeat(32)}`), manifest: config.manifest, utility: config.utility,
      maximumOperations: 2, maximumCostWei: '1000000000000000000' }) });
  return { service, recoveries };
}
