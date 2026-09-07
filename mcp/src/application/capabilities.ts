interface CapabilityEntry {
  name: string;
  description: string;
}

const areas = [
  {
    id: 'metadata',
    title: 'V6 project metadata and IPFS publication',
    tools: ['prepare_project_metadata', 'pin_project_metadata'],
    references: ['JB Center', 'jb-project-metadata'],
    limits: [
      'Preparation returns exact new metadata for review; it does not merge an existing document.',
      'Pinning publishes the reviewed JSON publicly and requires explicit user authorization.',
      'The metadata token is not approval. Image bytes are not fetched or uploaded by these tools.',
      'Upload errors can leave public content behind; cancellation does not roll back publication.',
    ],
  },
  {
    id: 'projects',
    title: 'Projects, accounts and indexed activity',
    tools: [
      'resolve_project',
      'search_projects',
      'get_project',
      'get_rulesets',
      'get_position',
      'get_account',
      'get_activity',
      'get_indexer_status',
      'get_permissions',
    ],
    references: ['JBController', 'JBTerminalStore', 'Bendystraw', 'JB Center'],
    limits: [
      'V6 only. Every identity includes chain and project ID.',
      'Indexed positions and event pages have explicit coverage; current balances are read on-chain.',
    ],
  },
  {
    id: 'payments',
    title: 'Payments, cash-outs and payouts',
    tools: [
      'quote_pay',
      'prepare_pay',
      'quote_cash_out',
      'prepare_cash_out',
      'quote_payout',
      'prepare_payout',
    ],
    references: ['JBMultiTerminal', 'JBBuybackHook', 'JBRouterTerminal', 'jb-tx-safety'],
    limits: [
      'Supported canonical compositions are verified before quoting.',
      'Quotes do not claim globally optimal market routing.',
      'Custom hooks, partial swaps and nested forwarding require their own supported adapters.',
    ],
  },
  {
    id: 'configuration',
    title: 'Ruleset design and project launches',
    tools: [
      'model_economics',
      'preview_ruleset_change',
      'prepare_ruleset_change',
      'prepare_launch',
    ],
    references: ['JBRulesets', 'JBFundAccessLimits', 'JBSplits', 'JBController'],
    limits: [
      'Core launch is an explicit composition. NFT and revnet launch semantics are separate.',
      'Scenarios report assumptions; future approval-hook outcomes are not predicted.',
    ],
  },
  {
    id: 'routing',
    title: 'Buyback hooks and router terminals',
    tools: [
      'get_routing',
      'prepare_buyback_pool',
      'prepare_buyback_twap',
      'prepare_buyback_hook',
      'prepare_router_terminal',
    ],
    references: [
      'JBBuybackHook',
      'JBBuybackHookRegistry',
      'JBRouterTerminalRegistry',
      'JBUniswapV4Hook',
    ],
    limits: [
      'Oracle and route availability are state-dependent.',
      'Only operations present in the current V6 contracts are exposed.',
    ],
  },
  {
    id: 'nfts',
    title: '721 shops and tier configuration',
    tools: [
      'get_721_shop',
      'quote_721_pay',
      'prepare_721_pay',
      'prepare_adjust_tiers',
      'prepare_721_launch',
    ],
    references: ['JB721TiersHook', 'JB721TiersHookStore', 'jb-721-tier-content'],
    limits: [
      'Tier inventory is per chain.',
      'Hook identity and metadata target are verified before building metadata.',
    ],
  },
  {
    id: 'revnets',
    title: 'Revnet economics, deployment and loans',
    tools: [
      'get_revnet',
      'prepare_revnet_deploy',
      'prepare_auto_issue',
      'quote_loan',
      'prepare_borrow',
      'get_loan',
      'prepare_repay',
    ],
    references: ['REVDeployer', 'REVOwner', 'REVLoans', 'revnet-economics'],
    limits: [
      'Loan debt, capacity, and liquid proceeds are distinct.',
      'Conditional fee fallback produces a proceeds range rather than a false exact prediction.',
    ],
  },
  {
    id: 'omnichain',
    title: 'Omnichain discovery, claims and accounting',
    tools: [
      'get_bridges',
      'get_omnichain_group',
      'prepare_bridge_claim',
      'prepare_accounting_sync',
    ],
    references: ['JBSucker', 'JBSuckerRegistry', 'JBOmnichainDeployer'],
    limits: [
      'Cross-chain reads report independent blocks.',
      'Accounting synchronization is separate from token bridging and claim settlement.',
    ],
  },
  {
    id: 'plans',
    title: 'Reviewed transaction plans and verification',
    tools: ['inspect_plan', 'simulate_plan', 'verify_plan', 'get_intent', 'prepare_intent'],
    references: ['jb-tx-safety', 'JB Center'],
    limits: [
      'The server does not sign, broadcast, pin, or publish.',
      'Plan tokens expire for simulation; expired tokens remain inspectable for receipt verification.',
      'Nested Safe/Relayr execution cannot be claimed verified without matching inner-call evidence.',
    ],
  },
  {
    id: 'development',
    title: 'Webclient and protocol development',
    tools: [
      'plan_integration',
      'get_webclient_reference',
      'list_webclient_references',
      'search_reference',
      'get_reference',
      'list_references',
      'get_contract',
      'decode_calldata',
    ],
    references: ['Juicescan', 'Juicebox Money', 'Revnet Money', 'nana-sdk-core', 'Juice skills'],
    limits: [
      'Bundled source has revision and hash provenance. It does not prove live deployed bytecode.',
      'App examples retain app-specific imports and are not represented as standalone generated applications.',
    ],
  },
] as const;

export function capabilityCatalog(tools: CapabilityEntry[], publicOrigin: string) {
  return {
    name: 'Juicebox MCP',
    version: '0.1.0',
    protocolVersion: 6,
    publicOrigin,
    amountEncoding:
      'All asset amounts and uint256 identifiers are base-10 integer strings with explicit currency and decimal context.',
    execution:
      'V6 reads, pure models, unsigned authenticated transaction plans and receipt verification. Explicitly authorized metadata publication is available through jb_pin_project_metadata when a publisher is configured. Blockchain signing/execution remain in the external wallet.',
    families: areas.map((area) => ({
      ...area,
      tools: area.tools
        .map((name) => tools.find((tool) => tool.name === `jb_${name}`))
        .filter((tool): tool is CapabilityEntry => tool !== undefined)
        .map((tool) => ({ name: tool.name, description: tool.description })),
    })),
    serviceOperations: [
      {
        name: 'jb_list_capabilities',
        description: 'Discover capability families, supported operations and explicit limitations.',
      },
    ],
  };
}
