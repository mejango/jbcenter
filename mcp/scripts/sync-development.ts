import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';
import {
  assertSourcePath,
  sourceDiffersFromCommit,
  writeBundleAtomically,
} from './sync-knowledge.js';
import {
  createDevelopmentBundle,
  MAX_DEVELOPMENT_BUNDLE_BYTES,
  type DevelopmentFeature,
  type DevelopmentReference,
} from '../src/services/development.js';

// Review this explicit allowlist when adding sources. Never walk a repository or copy environment/config files.
const SOURCES = {
  juicescan: {
    directory: 'webclients/juicescan',
    upstream: 'https://github.com/mejango/juicescan',
    framework: 'vanilla',
    files: [
      ['scan.pay', 'src/pay-component.js'],
      ['scan.pay-preview', 'src/pay-preview.js'],
      ['scan.cashout', 'src/cashout-component.js'],
      ['scan.721', 'src/nft721-build.js'],
      ['scan.721-ruleset', 'src/nft721-ruleset.js'],
      ['scan.queue', 'src/ruleset-queue-lifecycle.js'],
      ['scan.account', 'src/account-view.js'],
      ['scan.relayr', 'src/relayr.js'],
      ['scan.ipfs', 'src/ipfs-pin.js'],
      ['scan.pay-test', 'test/permit2-swap.test.js'],
      ['scan.cashout-test', 'test/cashout-fee.test.js'],
      ['scan.721-test', 'test/nft721-build.test.js'],
      ['scan.buyback-test', 'test/operator-buyback.test.js'],
      ['scan.relayr-test', 'test/relayr.test.js'],
      ['scan.ipfs-test', 'test/ipfs-pin.test.js'],
    ],
  },
  'juicebox-money': {
    directory: 'webclients/juicebox-money',
    upstream: 'https://github.com/mejango/juicebox-money',
    framework: 'react',
    files: [
      ['money.pay-panel', 'src/components/project/PayPanel.tsx'],
      ['money.pay-router-entry', 'src/lib/payment-router-entry.ts'],
      ['money.protocol-rollout', 'src/lib/protocol-rollout.ts'],
      ['money.protocol-deployments', 'src/lib/protocol-rollout.json'],
      ['money.buyback-router', 'src/components/project/MultiChainBuybackRouterCard.tsx'],
      ['money.builders', 'src/lib/transaction-builders.ts'],
      ['money.review', 'src/lib/transaction-review.ts'],
      ['money.simulation', 'src/lib/transaction-simulation.ts'],
      ['money.safe-hook', 'src/hooks/useSafeTx.ts'],
      ['money.permit2-hook', 'src/hooks/useReviewedPermit2Signature.ts'],
      ['money.relayr', 'src/lib/relayr.ts'],
      ['money.authority', 'src/lib/authority.ts'],
      ['money.cashout', 'src/lib/cashOut.ts'],
      ['money.launch', 'src/lib/launch.ts'],
      ['money.queue', 'src/lib/ruleset-queue.ts'],
      ['money.queries', 'src/lib/bendystraw.ts'],
      ['money.browser-query', 'src/lib/bendystraw-browser.ts'],
      ['money.query-operation', 'src/lib/bendystraw-operation.ts'],
      ['money.ipfs', 'src/lib/jbcenter-ipfs.ts'],
      ['money.claims', 'src/lib/sucker-claims.ts'],
      ['money.tiers', 'src/lib/shop-tiers.ts'],
      ['money.review-test', 'test/transactions/review.test.ts'],
      ['money.simulation-test', 'test/transactions/transaction-simulation.test.ts'],
      ['money.relayr-test', 'test/transactions/relayr-orchestration.test.ts'],
      ['money.safe-test', 'test/transactions/safe-orchestration.test.ts'],
      ['money.builders-test', 'test/contracts/transaction-builders.test.ts'],
      ['money.cashout-test', 'test/contracts/cash-out.test.ts'],
      ['money.launch-test', 'test/contracts/launch.test.ts'],
      ['money.claims-test', 'test/contracts/sucker-claim-status.test.ts'],
    ],
  },
  'revnet-money': {
    directory: 'webclients/revnet-money',
    upstream: 'https://github.com/mejango/revnet-money',
    framework: 'react',
    files: [
      ['revnet.pay', 'src/lib/v6/pay.ts'],
      ['revnet.pay-routes', 'src/lib/paymentTerminal.ts'],
      ['revnet.cashout', 'src/lib/cashOutQuote.ts'],
      ['revnet.loans', 'src/lib/loanTransactions.ts'],
      ['revnet.account', 'src/lib/accountHoldings.ts'],
      ['revnet.project-refs', 'src/lib/bendystraw/projectRefs.ts'],
      ['revnet.query', 'src/lib/bendystraw/client.ts'],
      ['revnet.claims', 'src/lib/v6/suckerProofs.ts'],
      ['revnet.shop', 'src/app/[slug]/components/v6/shop/shopLib.ts'],
      ['revnet.shop-permissions', 'src/app/[slug]/components/v6/shop/shopPermissions.ts'],
      ['revnet.shop-cart', 'src/app/[slug]/components/v6/ShopCartContext.tsx'],
      ['revnet.pay-shop', 'src/app/[slug]/components/v6/pay/usePayShop.ts'],
      ['revnet.stage-schema', 'src/app/create/helpers/stageSchema.ts'],
      ['revnet.stage-starts', 'src/app/create/helpers/recalculateStageStarts.ts'],
      ['revnet.deploy-data', 'src/app/create/helpers/parseDeployData.ts'],
      ['revnet.deploy-ui', 'src/app/create/buttons/PayAndDeploy.tsx'],
      ['revnet.draft', 'src/lib/revnet-draft.ts'],
      ['revnet.ipfs', 'src/lib/jbcenter-ipfs.ts'],
      ['revnet.safe-hook', 'src/hooks/useReviewedSafeSignature.ts'],
      ['revnet.permit2-hook', 'src/hooks/useReviewedPermit2Signature.ts'],
      ['revnet.relayr-hook', 'src/hooks/useReviewedRelayr.ts'],
      ['revnet.pay-test', 'test/pay-route.test.ts'],
      ['revnet.router-test', 'test/buyback-router-dialog.test.tsx'],
      ['revnet.cashout-test', 'test/cash-out-quote.test.ts'],
      ['revnet.loans-test', 'test/loan-transactions.test.ts'],
      ['revnet.account-test', 'test/account-holdings.test.ts'],
      ['revnet.query-test', 'test/bendystraw-operations.test.ts'],
      ['revnet.scope-test', 'test/project-ref-filters.test.ts'],
      ['revnet.shop-test', 'test/shop-permissions.test.ts'],
      ['revnet.create-test', 'test/deploy-encoding.test.ts'],
      ['revnet.stage-test', 'test/create-helpers.test.ts'],
      ['revnet.ipfs-test', 'test/jbcenter-ipfs.test.ts'],
      ['revnet.permit2-test', 'test/reviewed-permit2-signature.test.tsx'],
      ['revnet.safe-test', 'test/reviewed-safe-signature.test.tsx'],
      ['revnet.relayr-test', 'test/reviewed-relayr.test.ts'],
    ],
  },
  'juice-sdk-v4': {
    directory: 'juice-sdk-v4',
    upstream: 'https://github.com/Bananapus/juice-sdk-v4',
    framework: 'shared',
    files: [
      ['sdk.package', 'packages/core/package.json'],
      ['sdk.v6', 'packages/core/src/v6/index.ts'],
      ['sdk.pay', 'packages/core/src/v6/pay.ts'],
      ['sdk.terminals', 'packages/core/src/v6/terminals.ts'],
      ['sdk.cashout', 'packages/core/src/v6/cashOut.ts'],
      ['sdk.direct-pay', 'packages/core/src/v6/directPay.ts'],
      ['sdk.permit2', 'packages/core/src/v6/permit2.ts'],
      ['sdk.nft', 'packages/core/src/v6/nft.ts'],
      ['sdk.launch', 'packages/core/src/v6/launch.ts'],
      ['sdk.rulesets', 'packages/core/src/v6/rulesets.ts'],
      ['sdk.revnets', 'packages/core/src/v6/revnets.ts'],
      ['sdk.loans', 'packages/core/src/v6/loans.ts'],
      ['sdk.loan-math', 'packages/core/src/v6/loanMath.ts'],
      ['sdk.suckers', 'packages/core/src/v6/suckers.ts'],
      ['sdk.center', 'packages/core/src/jbcenter.ts'],
      ['sdk.queries', 'packages/core/src/utils/bendystraw.ts'],
      ['sdk.pay-test', 'packages/core/src/v6/pay.test.ts'],
      ['sdk.terminals-test', 'packages/core/src/v6/terminals.test.ts'],
      ['sdk.cashout-test', 'packages/core/src/v6/cashOut.test.ts'],
      ['sdk.nft-test', 'packages/core/src/v6/nft.test.ts'],
      ['sdk.rulesets-test', 'packages/core/src/v6/rulesets.test.ts'],
      ['sdk.revnets-test', 'packages/core/src/v6/revnets.test.ts'],
      ['sdk.suckers-test', 'packages/core/src/v6/suckers.test.ts'],
      ['sdk.center-test', 'packages/core/src/jbcenter.test.ts'],
    ],
  },
} as const;

type Binding = DevelopmentFeature['actions'][number]['bindings'][number];
const binding = (referenceId: string, symbol: string, importFrom?: string): Binding => ({
  referenceId,
  symbol,
  ...(importFrom ? { importFrom } : {}),
});
const sdk = (referenceId: string, symbol: string, subpath = '/v6') =>
  binding(referenceId, symbol, `@bananapus/nana-sdk-core${subpath}`);
const action = (
  phase: 'read' | 'build' | 'prove',
  description: string,
  ...bindings: Binding[]
) => ({ phase, description, bindings });
function feature(
  id: DevelopmentFeature['id'],
  title: string,
  dependsOn: DevelopmentFeature['id'][],
  actions: DevelopmentFeature['actions'],
  constraints: string[],
  sourceIds: string[],
  testIds: string[],
  revnetOnly = false,
): DevelopmentFeature {
  return {
    id,
    title,
    dependsOn,
    actions,
    constraints,
    sourceIds: [
      ...new Set([
        ...sourceIds,
        ...actions.flatMap((action) => action.bindings.map((binding) => binding.referenceId)),
      ]),
    ],
    testIds,
    projectTypes: revnetOnly ? ['revnet'] : ['project', 'revnet'],
  };
}

const FEATURES: DevelopmentFeature[] = [
  feature(
    'indexed-queries',
    'Versioned indexed reads and browser/server boundaries',
    [],
    [
      action(
        'read',
        'Use a persisted operation contract for browser queries; retain version, chain and project identity in every filter.',
        binding('money.browser-query', 'requestPersistedBendystraw'),
        binding('revnet.project-refs', 'projectRefKey'),
      ),
      action(
        'build',
        'Compile and validate operation variables and data at the API boundary; map exact project reference groups to bounded filters.',
        binding('money.query-operation', 'compileBendystrawOperation'),
        binding('revnet.project-refs', 'projectRefsWheres'),
      ),
      action(
        'prove',
        'Exercise schema drift, missing data and cross-chain/version collisions using the bundled query and scope tests.',
        binding('revnet.project-refs', 'matchesProjectRef'),
        binding('money.browser-query', 'requestPersistedBendystraw'),
      ),
    ],
    [
      'Indexed data can lag RPC. Keep indexing freshness and read failures visible.',
      'Keep API credentials on the server. Production-only account examples require adaptation for testnets.',
      'Flow-accrued USD amounts do not establish a current market value of treasury balances.',
    ],
    ['money.queries', 'revnet.query', 'sdk.queries', 'scan.account'],
    ['revnet.query-test', 'revnet.scope-test'],
  ),
  feature(
    'review-pipeline',
    'Exact transaction review, simulation, Safe, Relayr and Permit2',
    [],
    [
      action(
        'read',
        'Resolve account authority, Safe state and Permit2 authorization before selecting an execution route.',
        binding('money.authority', 'readAuthorityOf'),
        sdk('sdk.permit2', 'readPermit2Allowance'),
      ),
      action(
        'build',
        'Simulate state-changing calls and require review of exact destinations, chain, calldata, value, gas and output floors before a wallet request.',
        binding('money.simulation', 'simulateStateChangingTransaction'),
        binding('money.review', 'requireTransactionReview'),
        sdk('sdk.permit2', 'permit2TypedData'),
      ),
      action(
        'prove',
        'Reconcile Safe execution and Relayr destination receipts, persist uncertain sessions, and test signature denial and quote changes. Transport acceptance is not destination execution.',
        binding('money.relayr', 'resumeRelayrSession'),
        binding('scan.relayr', 'verifyRelayrDestinationRecords'),
        binding('money.safe-hook', 'useSafeTx'),
      ),
    ],
    [
      'Keep signing and custody in the user wallet; a development plan neither authorizes nor submits a transaction.',
      'Do not silently fall back from a denied signature or repeat a potentially submitted payment.',
      'Permit2 review must identify token, amount, spender, chain, nonce and expiry. Safe EIP-1271 behavior can require an onchain approval route.',
      'Simulating each call against original state does not prove a dependent batch. Verify prerequisite state or simulate the actual batch.',
    ],
    [
      'money.permit2-hook',
      'revnet.safe-hook',
      'revnet.permit2-hook',
      'revnet.relayr-hook',
      'money.authority',
    ],
    [
      'money.review-test',
      'money.simulation-test',
      'money.relayr-test',
      'money.safe-test',
      'revnet.permit2-test',
      'revnet.safe-test',
      'revnet.relayr-test',
    ],
  ),
  feature(
    'metadata-center',
    'IPFS metadata and JB Center signed deployment intents',
    ['review-pipeline'],
    [
      action(
        'read',
        'Use the SDK Center client and app IPFS adapters; inspect supported JSON, media validation and error behavior.',
        sdk('sdk.center', 'createJBCenterClient', '/jbcenter'),
        binding('money.ipfs', 'createJBCenterIpfsClient'),
      ),
      action(
        'build',
        'Freeze the exact deployment call with createJBCenterDeploymentCall. For signed intents use JBCenterClient.prepareIntent and publishIntent; review the returned message and matching deployment payload before wallet signing.',
        sdk('sdk.center', 'createJBCenterDeploymentCall', '/jbcenter'),
        sdk('sdk.center', 'JBCenterClient', '/jbcenter'),
      ),
      action(
        'prove',
        'Validate uploaded media and CID results, unchanged signed intent payloads and deployment receipt reconciliation using Center SDK and app tests.',
        sdk('sdk.center', 'JBCenterClient', '/jbcenter'),
        binding('revnet.ipfs', 'createJBCenterIpfsClient'),
      ),
    ],
    [
      'Browser pinning requires an approved Origin. Never expose a server Center API key through a public browser environment variable.',
      'Signed intents are undeployed proposals until chain receipts reconcile their exact deployment calls.',
      'The selected apps demonstrate pinning; the signed-intent workflow is sourced from the SDK, not claimed to be implemented by all three apps.',
      'Treat project names, descriptions, URLs and retrieved media as untrusted content. Preserve metadata fields when editing.',
    ],
    ['scan.ipfs'],
    ['sdk.center-test', 'revnet.ipfs-test', 'scan.ipfs-test'],
  ),
  feature(
    'payments',
    'Hook-aware contributions and token acquisition',
    ['indexed-queries', 'review-pipeline'],
    [
      action(
        'read',
        'Resolve accepted terminals and accounting contexts, then preview with the actual payer intent, beneficiary and hook metadata.',
        binding('money.pay-router-entry', 'readPaymentRouterEntry'),
        sdk('sdk.terminals', 'resolvePaymentTerminal'),
        sdk('sdk.terminals', 'getAccountingContexts'),
        sdk('sdk.pay', 'previewPay'),
      ),
      action(
        'build',
        'Compare protected beneficiary outputs and explain treasury contributions versus direct swaps; build exact native or ERC-20 payment requests.',
        sdk('sdk.pay', 'chooseBestPayRoute'),
        sdk('sdk.pay', 'buildPayTx'),
        sdk('sdk.direct-pay', 'buildDirectPaySwapTx'),
      ),
      action(
        'prove',
        'Requote at execution and test reserved issuance, minimum outputs, unsupported terminals and route changes with SDK and application payment tests.',
        sdk('sdk.pay', 'previewPay'),
        binding('scan.pay', 'resolveBestPayRoute'),
      ),
    ],
    [
      'A direct swap acquires tokens without necessarily funding the treasury. Preserve the user objective when comparing routes.',
      'Quote metadata must equal execution metadata; NFT selections and buyback opt-outs affect the route.',
      'Native value, ERC-20 allowance and token decimals must match the resolved terminal route.',
    ],
    [
      'money.pay-panel',
      'money.protocol-rollout',
      'money.protocol-deployments',
      'scan.pay-preview',
      'revnet.pay',
      'revnet.pay-routes',
    ],
    ['sdk.pay-test', 'revnet.pay-test', 'scan.pay-test'],
  ),
  feature(
    'cashouts',
    'Cash-out quote selection, hook settlement and net proceeds',
    ['indexed-queries', 'review-pipeline'],
    [
      action(
        'read',
        'Read the current ruleset and compare hook-aware reclaim routes in the correct accounting currency and token.',
        sdk('sdk.cashout', 'getBestCashOutRoute'),
        sdk('sdk.cashout', 'getHookAwareCashOutQuote'),
      ),
      action(
        'build',
        'Prepare protected cash-out or direct-sale calldata using fresh state; preserve hook specifications and output floor.',
        sdk('sdk.cashout', 'prepareBestCashOut'),
        sdk('sdk.cashout', 'buildCashOutTx'),
      ),
      action(
        'prove',
        'Test route changes, accounting contexts and conditional protocol fees; display what the beneficiary receives after applicable fees.',
        sdk('sdk.cashout', 'cashOutProtocolFee'),
        sdk('sdk.cashout', 'resolveCashOutRoute'),
      ),
    ],
    [
      'Cash-out surplus differs from treasury balance and payout availability.',
      'A failed quote is unavailable, not zero; do not substitute a different currency for an accounting-context token.',
      'The app examples have application-specific route and display behavior; use the live hook-aware SDK result for execution.',
    ],
    ['money.cashout', 'scan.cashout', 'revnet.cashout'],
    ['sdk.cashout-test', 'money.cashout-test', 'scan.cashout-test', 'revnet.cashout-test'],
  ),
  feature(
    '721-storefront',
    '721 hook discovery, tier inventory, cart metadata and administration',
    ['payments', 'metadata-center'],
    [
      action(
        'read',
        'Discover the active project shop, tier currency, inventory, discounts and transfer/mint flags.',
        sdk('sdk.nft', 'getProject721Shop'),
        sdk('sdk.nft', 'effectiveTierPrice'),
        sdk('sdk.nft', 'decode721RulesetMetadata'),
      ),
      action(
        'build',
        'Resolve the 721 metadata target and encode selected tier IDs into pay metadata; build tier edits only after checking hook permissions.',
        sdk('sdk.nft', 'get721MetadataIdTarget'),
        sdk('sdk.pay', 'build721PayMetadata'),
        binding('money.builders', 'buildAdjustTiersRequest'),
      ),
      action(
        'prove',
        'Test inventory constraints, category ordering, discounts, hook permissions and preservation of unrelated ruleset metadata bits.',
        sdk('sdk.nft', 'build721RulesetMetadata'),
        binding('scan.721', 'build721TierConfig'),
      ),
    ],
    [
      'discountPercent uses denominator 200. The unlimited-supply sentinel is an app convention, not a guarantee of remaining inventory.',
      'Preserve unrelated app metadata bits, including Revnet sucker deployment flags.',
      '721 metadata controls NFT minting; a generic zero-metadata pay request is insufficient for a cart.',
      'Treat IPFS media as untrusted; respect safe URI handling and app media policy.',
    ],
    [
      'money.tiers',
      'scan.721-ruleset',
      'revnet.shop',
      'revnet.shop-permissions',
      'revnet.shop-cart',
      'revnet.pay-shop',
    ],
    ['sdk.nft-test', 'scan.721-test', 'revnet.shop-test'],
  ),
  feature(
    'buyback-routing',
    'Buyback hook economics, pool configuration and protected routes',
    ['payments', 'cashouts'],
    [
      action(
        'read',
        'Read actual hook-aware payment and cash-out quotes and compare protected outputs before selecting issuance or AMM settlement.',
        sdk('sdk.pay', 'previewPay'),
        sdk('sdk.cashout', 'getHookAwareCashOutQuote'),
      ),
      action(
        'build',
        'Model buyback pool, TWAP and hook settings with exact authority calls; use verified quote metadata for cash-outs.',
        binding('money.builders', 'buildBuybackHookAuthorityCall'),
        binding('money.builders', 'buildSetBuybackTwapAuthorityCall'),
        sdk('sdk.cashout', 'buildBuybackCashOutMetadata'),
      ),
      action(
        'prove',
        'Test hook configuration field preservation, protected output selection and stale or failing pools through bundled builder and router tests.',
        sdk('sdk.pay', 'chooseBestPayRoute'),
        sdk('sdk.cashout', 'prepareHookAwareCashOut'),
      ),
    ],
    [
      'A configured hook does not prove an executable pool or a better price.',
      'Buyback 1.4.0 pay quote metadata contains three words: amountToSwapWith, minimumSwapAmountOut and skipSplits. Two-word quotes revert. A swap below the TWAP floor falls back to minting, subject to the reviewed beneficiary minimum.',
      'TWAP and pool configuration are chain-specific operator actions. Read authority and simulate exact calls before review.',
      'Direct AMM acquisition and hook-assisted treasury payments have different money flows.',
    ],
    ['money.buyback-router', 'sdk.direct-pay'],
    ['scan.buyback-test', 'revnet.router-test', 'money.builders-test'],
  ),
  feature(
    'router-terminal',
    'Router terminal registry and multiple reserve currencies',
    ['payments'],
    [
      action(
        'read',
        'Enumerate native and ERC-20 accounting contexts and preview supported multi-terminal and registry routes for the requested token.',
        sdk('sdk.terminals', 'getAccountingContexts'),
        binding('revnet.pay-routes', 'resolveBestV6PayRoute'),
      ),
      action(
        'build',
        'Prepare router-terminal authority edits and use terminal configuration builders for launch accounting contexts.',
        binding('money.builders', 'buildRouterTerminalAuthorityCall'),
        sdk('sdk.launch', 'buildTerminalConfigurations'),
      ),
      action(
        'prove',
        'Exercise missing registry deployments, unsupported tokens, quote failures and tie-breaking with live preview tests.',
        sdk('sdk.terminals', 'resolvePaymentTerminal'),
        binding('revnet.pay-routes', 'resolveBestV6PayRoute'),
      ),
    ],
    [
      'Resolve the project registry terminalOf first, then gateway ROUTER where the selected terminal is a recorded gateway. Preserve the outer approval target; the underlying router is not necessarily registry-selectable.',
      'Gateway JBRouterTerminalGateway_QueuePendingCall retains failed opted-in fee or protocol-payer input. JBRouterTerminalGateway_ProcessPendingCall, JBRouterTerminalGateway_RefundPendingCall and JBRouterTerminalGateway_RecordTerminalCallFailure distinguish settlement, refund and retry failure. A queued fee is pending, not paid or forgiven; refunds do not restore core feeFreeSurplusOf.',
      'Read rollout addresses from executed per-chain deployment records. Keep previous and v1 addresses for history and unmigrated projects. A mainnet proposal does not make the new stack live.',
      'JBRatioPriceFeed supplies USDC/native and USDC/ETH conversion on chains where registered in JBPrices; feed-only chains may still lack a buyback hook, router or gateway.',
      'Currency identifiers, token addresses and decimals are separate dimensions; retain all three.',
      'Requested chains are planning scope only. A chain supported by the SDK may lack a particular deployment.',
    ],
    ['money.buyback-router'],
    ['sdk.terminals-test', 'revnet.pay-test', 'revnet.router-test'],
  ),
  feature(
    'project-launch',
    'Project launch configurations, receipt identity and persistent drafts',
    ['metadata-center'],
    [
      action(
        'read',
        'Inspect required accounting feeds, treasury currencies, hook configuration and creation fees before resolving a launch plan.',
        binding('money.launch', 'requiredFeedPairs'),
        sdk('sdk.launch', 'getProjectCreationFee'),
      ),
      action(
        'build',
        'Build typed ruleset, terminal, split and omnichain launch configurations; retain exact chain-specific calldata for review.',
        binding('money.launch', 'buildLaunchRequest'),
        sdk('sdk.launch', 'buildLaunchProjectTx'),
      ),
      action(
        'prove',
        'Decode project IDs from actual launch receipts and verify configuration encoding and multi-chain outcomes.',
        sdk('sdk.launch', 'projectIdFromLaunchLogs'),
        sdk('sdk.launch', 'decodeLaunchProjectId'),
      ),
    ],
    [
      'Do not predict a project ID as proof of deployment. Reconcile the emitted event for each chain.',
      'Pin metadata before constructing the signed deployment intent so the reviewed URI and calldata remain identical.',
      'Creation fees, price feeds, 721 deployment and cross-chain configuration must be resolved for every selected chain.',
    ],
    ['money.builders'],
    ['money.launch-test', 'money.builders-test'],
  ),
  feature(
    'ruleset-editing',
    'Current and queued terms, approval lifecycle and safe edits',
    ['indexed-queries', 'review-pipeline'],
    [
      action(
        'read',
        'Read current, upcoming and historical rulesets plus approval-hook status before describing effective dates.',
        sdk('sdk.rulesets', 'getCurrentRuleset'),
        sdk('sdk.rulesets', 'getUpcomingRuleset'),
        binding('money.queue', 'planRulesetQueue'),
      ),
      action(
        'build',
        'Build the exact queued ruleset array and authority calls while preserving unchanged metadata, splits and terminal configuration.',
        sdk('sdk.rulesets', 'buildQueueRulesetsTx'),
        binding('money.builders', 'buildQueueRulesetsAuthorityCall'),
      ),
      action(
        'prove',
        'Exercise approved, replaceable, multiple queued and custom approval-hook cases. Confirm the receipt and reread the resulting queue.',
        binding('scan.queue', 'planRulesetQueue'),
        sdk('sdk.rulesets', 'getAllRulesets'),
      ),
    ],
    [
      'An earliest start timestamp is not by itself proof that approval conditions are satisfied.',
      'Keep ownership, delegated permissions and controller authority separate. Revnet stage commitments restrict generic ruleset editing.',
      'Explain which terms change for contributors, operators and reserved-token recipients.',
    ],
    ['money.launch'],
    ['sdk.rulesets-test', 'money.builders-test'],
  ),
  feature(
    'revnet-launch',
    'Revnet deployment, stage commitments and auto issuance',
    ['metadata-center', 'revnet-stages'],
    [
      action(
        'read',
        'Validate the draft, per-chain reserve assets and stage data using Revnet Money deployment parsing.',
        binding('revnet.draft', 'parseRevnetDraft'),
        binding('revnet.deploy-data', 'parseDeployData'),
      ),
      action(
        'build',
        'Build committed Revnet stages and deploy configurations, including 721 and sucker extensions when selected.',
        sdk('sdk.revnets', 'buildRevnetStageConfig'),
        sdk('sdk.revnets', 'buildDeployRevnetTx'),
      ),
      action(
        'prove',
        'Check encoded deployment data, per-chain receipt project IDs, auto-issuance chain assignments and partial deployment outcomes.',
        sdk('sdk.launch', 'projectIdFromLaunchLogs'),
        binding('revnet.deploy-data', 'parseDeployData'),
      ),
    ],
    [
      'Revnet operator powers differ from project ownership. Do not offer mutable economic terms when the deployer has committed them.',
      'Existing app drafts are application schemas; validate before converting to SDK contract types.',
      'SDK deployment support does not prove the configured deployer or extensions exist on every requested chain.',
    ],
    ['revnet.deploy-ui', 'sdk.package'],
    ['sdk.revnets-test', 'revnet.create-test'],
    true,
  ),
  feature(
    'revnet-stages',
    'Revnet stage timing, issuance and claims',
    ['indexed-queries', 'review-pipeline'],
    [
      action(
        'read',
        'Resolve current and future issuance stages, including inherited weights, decay and stage timing.',
        sdk('sdk.rulesets', 'resolveRulesetIssuanceStages'),
        sdk('sdk.rulesets', 'rulesetIssuanceRateAt'),
      ),
      action(
        'build',
        'Validate staged form values and translate relative cuts into final starts; build eligible auto-issuance claims.',
        binding('revnet.stage-schema', 'validateStage'),
        binding('revnet.stage-starts', 'calculateFinalStageStarts'),
        sdk('sdk.revnets', 'buildAutoIssueTx'),
      ),
      action(
        'prove',
        'Test stage boundaries, inherited issuance weights, auto-issuance amounts and chain-specific allocations.',
        sdk('sdk.revnets', 'getAmountToAutoIssue'),
        sdk('sdk.rulesets', 'rulesetIssuanceRateWithinStage'),
      ),
    ],
    [
      'Display issuance rate in its declared base currency and fixed-point units.',
      'Keep configured commitments distinct from an operator action that is currently permitted.',
      'Auto issuance is a transaction; use the included review pipeline for execution.',
    ],
    [],
    ['sdk.rulesets-test', 'sdk.revnets-test', 'revnet.stage-test'],
    true,
  ),
  feature(
    'revnet-loans',
    'Revnet collateral, borrowing, repayment and reallocation',
    ['cashouts'],
    [
      action(
        'read',
        'Read fresh borrowability for the exact Revnet project, reserve token and collateral amount.',
        binding('revnet.loans', 'readFreshBorrowableAmount'),
        sdk('sdk.loans', 'getBorrowableAmount'),
      ),
      action(
        'build',
        'Apply a protected minimum to borrowing and collateral reallocation; build repayment with exact allowance and source context.',
        binding('revnet.loans', 'buildProtectedBorrowTx'),
        binding('revnet.loans', 'buildProtectedReallocateCollateralTx'),
        sdk('sdk.loans', 'buildRepayLoanTx'),
      ),
      action(
        'prove',
        'Test quote floors and project scope, then reconcile the loan event and actual net beneficiary proceeds.',
        binding('revnet.loans', 'minimumBorrowAmount'),
        sdk('sdk.loans', 'buildBorrowTx'),
      ),
    ],
    [
      'Gross borrowability differs from net proceeds after prepaid and applicable fees.',
      'Retain loan contract address, loan ID, project scope, reserve source, collateral and maturity.',
      'Burn permissions and token approvals are distinct; read the required allowance for the selected action.',
    ],
    ['sdk.loan-math'],
    ['revnet.loans-test', 'sdk.cashout-test'],
    true,
  ),
  feature(
    'account-portfolio',
    'Cross-chain holdings, unclaimed credits, NFTs and operator projects',
    ['indexed-queries'],
    [
      action(
        'read',
        'Aggregate token holdings, credits, NFT holdings, owned projects and operator roles using full versioned project references.',
        binding('scan.account', 'dedupeTokenHoldings'),
        binding('scan.account', 'groupNftHoldings'),
      ),
      action(
        'build',
        'Map exact project identities across requested chains and distinguish direct ownership from ownership through a Safe.',
        binding('revnet.project-refs', 'projectRefsWheres'),
        binding('scan.account', 'dedupeOwnedProjects'),
      ),
      action(
        'prove',
        'Test colliding project IDs across chains, double counting, pagination caps and partial data failures.',
        binding('scan.account', 'capNote'),
        binding('revnet.project-refs', 'matchesProjectRef'),
      ),
    ],
    [
      'ERC-20 balance excludes unclaimed token credits. Display both without double counting indexed totals.',
      'Operator roles are not ownership; an indexer candidate requires current permission verification.',
      'The Revnet Money account adapter defaults to production; adapt its network selection when a testnet is requested.',
    ],
    ['revnet.account', 'money.queries'],
    ['revnet.account-test', 'revnet.scope-test'],
  ),
  feature(
    'omnichain-claims',
    'Sucker movement proofs, accounting contexts and destination claims',
    ['indexed-queries', 'review-pipeline'],
    [
      action(
        'read',
        'Discover all accounting-context pairs and verify source leaves, outbox roots and destination inbox state before labeling claims ready.',
        sdk('sdk.suckers', 'getAllV6SuckerPairs'),
        sdk('sdk.suckers', 'getSuckerMovements'),
        binding('revnet.claims', 'fetchV6BridgeRows'),
      ),
      action(
        'build',
        'Build destination claims only from verified claimable movements; classify transport and budget native transport costs for shipping.',
        sdk('sdk.suckers', 'claimFromSuckerMovement'),
        sdk('sdk.suckers', 'buildBridgeClaimTx'),
        sdk('sdk.suckers', 'classifySuckerTransport'),
      ),
      action(
        'prove',
        'Test Merkle proofs, already-claimed leaves and token mapping, and reread destination execution before marking completion.',
        binding('money.claims', 'buildClaim'),
        sdk('sdk.suckers', 'getSuckerMovements'),
      ),
    ],
    [
      'Token movement and cross-chain accounting synchronization have distinct lifecycles.',
      'Unknown transport is not free transport. CCIP shipping requires an actual native transport value.',
      'A source receipt is not proof of a destination claim; retain partial completion and retry scope.',
    ],
    [],
    ['sdk.suckers-test', 'money.claims-test'],
  ),
];

function sourceSurface(path: string, text: string) {
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const exports = new Set<string>();
  const imports = new Set<string>();
  for (const statement of ast.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    )
      imports.add(statement.moduleSpecifier.text);
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    )
      for (const element of statement.exportClause.elements) exports.add(element.name.text);
    if (
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name)) exports.add(declaration.name.text);
          else {
            /* Destructured public exports require explicit support before being bound. */
          }
      if ('name' in statement && statement.name && ts.isIdentifier(statement.name as ts.Node))
        exports.add((statement.name as ts.Identifier).text);
    }
  }
  return { exports: [...exports].sort(), imports: [...imports].sort() };
}

const git = (cwd: string, args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

type RepositoryDefinition = {
  directory: string;
  upstream: string;
  framework: DevelopmentReference['framework'];
  files: ReadonlyArray<readonly [string, string]>;
};
type RepositorySnapshot = {
  repository: DevelopmentReference['source']['repository'];
  root: string;
  commit: string;
  gitStatus: string;
  files: Array<{ path: string; fileSha256: string }>;
  references: DevelopmentReference[];
};

function readSourceBytes(repo: string, path: string): Buffer {
  const file = assertSourcePath(repo, path);
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > 750_000)
    throw new Error(`Source is not a bounded file: ${path}`);
  const bytes = readFileSync(file);
  if (bytes.length > 750_000) throw new Error(`Source too large: ${path}`);
  return bytes;
}

/** Shared with focused sync tests; the production caller supplies only the fixed SOURCES allowlist. */
export function readDevelopmentRepository(
  workspace: string,
  repository: DevelopmentReference['source']['repository'],
  definition: RepositoryDefinition,
): RepositorySnapshot {
  const repo = realpathSync(resolve(workspace, definition.directory));
  if (relative(workspace, repo).startsWith(`..${sep}`) || relative(workspace, repo) === '..')
    throw new Error(`Repository escapes workspace: ${repository}`);
  if (realpathSync(git(repo, ['rev-parse', '--show-toplevel'])) !== repo)
    throw new Error(`Source must be its own Git checkout: ${repository}`);
  const commit = git(repo, ['rev-parse', '--verify', 'HEAD']);
  const gitStatus = git(repo, ['status', '--porcelain', '--untracked-files=normal']);
  const packagePath = repository === 'juice-sdk-v4' ? 'packages/core/package.json' : 'package.json';
  const packageBytes = readSourceBytes(repo, packagePath);
  const pkg = JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(packageBytes),
  ) as {
    version?: string;
    license?: string;
  };
  const files = [
    { path: packagePath, fileSha256: createHash('sha256').update(packageBytes).digest('hex') },
  ];
  const references: DevelopmentReference[] = [];
  for (const [id, path] of definition.files) {
    const bytes = readSourceBytes(repo, path);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const fileSha256 = createHash('sha256').update(bytes).digest('hex');
    files.push({ path, fileSha256 });
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) ||
      /(?:api[_-]?key|secret|password|mnemonic|private[_-]?key)\s*(?::[^=\n]+)?\s*=\s*['"][A-Za-z0-9_/-]{16,}['"]/i.test(
        text,
      )
    )
      throw new Error(
        `Credential-shaped literal in allowlisted source: ${id}; omit the file rather than redact provenance`,
      );
    const spdx = text.match(/SPDX-License-Identifier:\s*([^\r\n*]+)/)?.[1]?.trim();
    const copyrightNotices = text
      .split('\n')
      .filter((line) => /SPDX-FileCopyrightText:|Copyright\s*(?:\(c\)|©|\d{4})/i.test(line))
      .map((line) => line.trim());
    references.push({
      id,
      title: `${repository}: ${path}`,
      kind: path.endsWith('package.json')
        ? 'manifest'
        : path.includes('.test.')
          ? 'test'
          : 'implementation',
      framework: definition.framework,
      text,
      ...sourceSurface(path, text),
      source: {
        repository: repository as DevelopmentReference['source']['repository'],
        path,
        commit,
        fileSha256,
        fileDirty: sourceDiffersFromCommit(repo, path, commit, bytes),
        repositoryDirty: false,
        ...(pkg.version ? { packageVersion: pkg.version } : {}),
        upstreamUrl: `${definition.upstream}/blob/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`,
        spdxLicenseIdentifier: spdx ?? pkg.license ?? 'NOASSERTION',
        copyrightNotices,
        startLine: 1,
        endLine: text.split('\n').length,
      },
    });
  }
  const repositoryDirty =
    gitStatus.length > 0 ||
    references.some((reference) => reference.source.fileDirty) ||
    sourceDiffersFromCommit(repo, packagePath, commit, packageBytes);
  for (const reference of references) reference.source.repositoryDirty = repositoryDirty;
  return { repository, root: repo, commit, gitStatus, files, references };
}

export function assertDevelopmentSnapshot(snapshot: RepositorySnapshot): void {
  if (git(snapshot.root, ['rev-parse', '--verify', 'HEAD']) !== snapshot.commit)
    throw new Error(`Source commit changed during sync: ${snapshot.repository}`);
  if (
    git(snapshot.root, ['status', '--porcelain', '--untracked-files=normal']) !== snapshot.gitStatus
  )
    throw new Error(`Source Git status changed during sync: ${snapshot.repository}`);
  for (const file of snapshot.files) {
    const hash = createHash('sha256')
      .update(readSourceBytes(snapshot.root, file.path))
      .digest('hex');
    if (hash !== file.fileSha256)
      throw new Error(`Source bytes changed during sync: ${snapshot.repository}/${file.path}`);
  }
}

export function writeDevelopmentBundle(output: string, serialized: string, check = false): void {
  if (Buffer.byteLength(serialized) > MAX_DEVELOPMENT_BUNDLE_BYTES)
    throw new Error('Development bundle too large');
  if (check) {
    if (!existsSync(output) || readFileSync(output, 'utf8') !== serialized)
      throw new Error(
        'Vendored development bundle differs from selected sources; inspect changes and run development:sync',
      );
  } else {
    writeBundleAtomically(output, serialized);
  }
}

function syncDevelopment(options: { workspace?: string; output?: string; check?: boolean }) {
  const workspace = realpathSync(
    options.workspace ??
      process.env.JUICEBOX_SOURCE_ROOT ??
      fileURLToPath(new URL('../../../../', import.meta.url)),
  );
  const output = resolve(
    options.output ?? fileURLToPath(new URL('../data/development.json', import.meta.url)),
  );
  const snapshots = Object.entries(SOURCES).map(([repository, definition]) =>
    readDevelopmentRepository(
      workspace,
      repository as DevelopmentReference['source']['repository'],
      definition,
    ),
  );
  const references = snapshots.flatMap((snapshot) => snapshot.references);

  // Package imports are checked against the actual export map and the V6 barrel; app aliases never become package imports.
  const byId = new Map(references.map((reference) => [reference.id, reference]));
  const sdkPackage = JSON.parse(byId.get('sdk.package')!.text) as {
    exports: Record<string, unknown>;
  };
  for (const feature of FEATURES)
    for (const action of feature.actions)
      for (const entry of action.bindings) {
        if (!entry.importFrom) continue;
        const subpath = entry.importFrom.replace('@bananapus/nana-sdk-core', '') || '';
        if (!sdkPackage.exports[`.${subpath}`])
          throw new Error(`SDK package subpath is not exported: ${entry.importFrom}`);
        const path = byId.get(entry.referenceId)!.source.path;
        if (subpath === '/jbcenter' && path !== 'packages/core/src/jbcenter.ts')
          throw new Error(`Wrong Center module: ${entry.referenceId}`);
        if (subpath === '/v6') {
          const filename = path.split('/').at(-1)!.replace(/\.ts$/, '.js');
          if (
            !path.startsWith('packages/core/src/v6/') ||
            !byId.get('sdk.v6')!.imports.includes(`./${filename}`)
          )
            throw new Error(`SDK V6 barrel does not export source module: ${entry.referenceId}`);
        }
      }
  const bundle = createDevelopmentBundle(references, FEATURES);
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  for (const snapshot of snapshots) assertDevelopmentSnapshot(snapshot);
  writeDevelopmentBundle(output, serialized, options.check);
  process.stdout.write(
    `${options.check ? 'Verified' : 'Synced'} ${bundle.references.length} development references and ${bundle.features.length} features; bundle ${bundle.bundleId}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      workspace: { type: 'string' },
      output: { type: 'string' },
      check: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help)
    process.stdout.write(
      'Usage: node --import tsx scripts/sync-development.ts [--workspace PATH] [--output PATH] [--check]\n--check verifies reproducibility without writing.\n',
    );
  else syncDevelopment(values);
}
