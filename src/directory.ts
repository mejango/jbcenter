/** Curated public V6 entry points. Verify destinations and descriptions when updating. */
export interface DirectoryLink {
  title: string;
  url: string;
  description: string;
  sourceUrl?: string;
  label?: string;
}

export interface Journey {
  id: string;
  number: string;
  title: string;
  audience: string;
  description: string;
  links: readonly DirectoryLink[];
}

export interface RepositoryGroup {
  title: string;
  links: readonly DirectoryLink[];
}

export const journeys: readonly Journey[] = [
  {
    id: "apps",
    number: "01",
    title: "Explore & participate",
    audience: "For everyone",
    description:
      "Find a project, follow its activity, and choose an app that fits.",
    links: [
      {
        title: "Juicebox Money",
        url: "https://juicebox.money",
        description:
          "Discover and fund projects, manage a treasury, or launch your own.",
        sourceUrl: "https://github.com/mejango/juicebox-money",
      },
      {
        title: "Revnet Money",
        url: "https://revnet.money",
        description:
          "Explore and launch networks with scheduled, precommitted economics.",
        sourceUrl: "https://github.com/mejango/revnet-money",
      },
      {
        title: "Succulent",
        url: "https://succulent.money",
        description:
          "Follow V6 activity, post to a project, and create a page.",
        sourceUrl: "https://github.com/mejango/succulent",
      },
      {
        title: "eth.shop",
        url: "https://eth.shop",
        description:
          "Browse V6 shops and tiered NFT collections. Shop pages are currently read-only.",
        sourceUrl: "https://github.com/mejango/eth-shop",
      },
      {
        title: "Juicescan",
        url: "https://github.com/mejango/juicescan",
        description:
          "Explore the source of a V6 explorer and transaction interface.",
        label: "Source",
      },
      {
        title: "Learn Juicebox",
        url: "https://juicebox.money/learn",
        description:
          "Understand payments, tokens, cash outs, rulesets, and multichain projects.",
      },
    ],
  },
  {
    id: "projects",
    number: "02",
    title: "Run a project",
    audience: "For project owners",
    description:
      "Launch a treasury or a revnet. Understand the controls before you configure them.",
    links: [
      {
        title: "Start a project",
        url: "https://juicebox.money/create",
        description: "Configure your project, treasury, shop, and launch.",
      },
      {
        title: "Launch a revnet",
        url: "https://revnet.money/create",
        description: "Choose the stages and economics of a revnet.",
      },
      {
        title: "Project owner journeys",
        url: "https://github.com/Bananapus/version-6/blob/main/USER_JOURNEYS.md",
        description:
          "Follow project launches, operations, payments, and cross-chain flows.",
      },
      {
        title: "Ownership and administration",
        url: "https://github.com/Bananapus/version-6/blob/main/ADMINISTRATION.md",
        description: "See which roles control which parts of the V6 ecosystem.",
      },
    ],
  },
  {
    id: "developers",
    number: "03",
    title: "Build on Juicebox",
    audience: "For developers",
    description:
      "Start with V6, connect to its data, or build your own webclient.",
    links: [
      {
        title: "V6 ecosystem",
        url: "https://github.com/Bananapus/version-6",
        description:
          "The top-level map of contracts, applications, and documentation.",
      },
      {
        title: "Build on Juicebox",
        url: "https://juicebox.money/build",
        description: "Choose building blocks for your own app or integration.",
      },
      {
        title: "Juice SDK — V6 actions",
        url: "https://github.com/Bananapus/juice-sdk-v4#v6-actions-bananapusnana-sdk-corev6",
        description:
          "TypeScript reads and transaction builders for V6. The repository retains its v4 name.",
      },
      {
        title: "Bendystraw schema",
        url: "https://bendystraw.xyz/schema",
        description:
          "Inspect the GraphQL schema. Filter queries to V6; API requests need a key.",
        sourceUrl: "https://github.com/peripheralist/bendystraw",
      },
      {
        title: "Juicebox Center",
        url: "https://github.com/mejango/jbcenter",
        description:
          "Integrate project listings, read-only RPC, IPFS pinning, and the public gateway.",
      },
      {
        title: "Architecture",
        url: "https://github.com/Bananapus/version-6/blob/main/ARCHITECTURE.md",
        description:
          "Follow component responsibilities, accounting, and integration boundaries.",
      },
    ],
  },
  {
    id: "auditors",
    number: "04",
    title: "Inspect & verify",
    audience: "For auditors & researchers",
    description:
      "Trace the system from its design and assumptions to contracts and deployments.",
    links: [
      {
        title: "Audit Juicebox",
        url: "https://juicebox.money/audit",
        description: "Start a protocol review or inspect a transaction.",
      },
      {
        title: "Audit instructions",
        url: "https://github.com/Bananapus/version-6/blob/main/AUDIT_INSTRUCTIONS.md",
        description:
          "Review scope, reading order, and cross-repository audit guidance.",
      },
      {
        title: "Risks",
        url: "https://github.com/Bananapus/version-6/blob/main/RISKS.md",
        description: "Read ecosystem risks and trust assumptions.",
      },
      {
        title: "Invariants",
        url: "https://github.com/Bananapus/version-6/blob/main/INVARIANTS.md",
        description:
          "Trace the properties the V6 ecosystem is expected to preserve.",
      },
      {
        title: "Deployment artifacts",
        url: "https://github.com/Bananapus/deploy-all-v6/tree/main/deployments",
        description:
          "Inspect chain-specific contract addresses, ABIs, and deployment records.",
      },
      {
        title: "Ownership and administration",
        url: "https://github.com/Bananapus/version-6/blob/main/ADMINISTRATION.md",
        description: "See which roles control which parts of the V6 ecosystem.",
      },
    ],
  },
  {
    id: "agents",
    number: "05",
    title: "Work with an agent",
    audience: "For any compatible AI agent",
    description:
      "Bring V6 context, live reads, and transaction preparation into your workflow.",
    links: [
      {
        title: "Connect the MCP",
        url: "https://github.com/mejango/juicebox-skills#connect-the-hosted-mcp",
        description: "Set up a client that supports Streamable HTTP MCP.",
      },
      {
        title: "Juicebox V6 skills",
        url: "https://github.com/mejango/juicebox-skills",
        description: "Portable V6 instructions and resources for AI agents.",
      },
      {
        title: "MCP reference",
        url: "https://github.com/mejango/jbcenter/tree/main/mcp",
        description: "V6 tools, resources, prompts, and client setup.",
      },
      {
        title: "MCP user journeys",
        url: "https://github.com/mejango/jbcenter/blob/main/mcp/docs/USER_JOURNEYS.md",
        description:
          "Explore supported research, launch, operation, and webclient workflows.",
      },
    ],
  },
];

export const repositoryGroups: readonly RepositoryGroup[] = [
  {
    title: "Core & identity",
    links: [
      {
        title: "Core protocol",
        url: "https://github.com/Bananapus/nana-core-v6",
        description:
          "Projects, rulesets, accounting, tokens, payments, and cash outs.",
      },
      {
        title: "Permission IDs",
        url: "https://github.com/Bananapus/nana-permission-ids-v6",
        description: "Shared constants for V6 operator permissions.",
      },
      {
        title: "Project ownership",
        url: "https://github.com/Bananapus/nana-ownable-v6",
        description:
          "Contract ownership that follows a project and its permissions.",
      },
      {
        title: "Address registry",
        url: "https://github.com/Bananapus/nana-address-registry-v6",
        description: "Record and inspect contract deployer provenance.",
      },
      {
        title: "Project handles",
        url: "https://github.com/Bananapus/nana-project-handles-v6",
        description: "Resolve ENS handles linked to specific projects.",
      },
      {
        title: "Project payer",
        url: "https://github.com/Bananapus/nana-project-payer-v6",
        description:
          "Create payment addresses that forward funds to a project.",
      },
    ],
  },
  {
    title: "Hooks & liquidity",
    links: [
      {
        title: "721 hook",
        url: "https://github.com/Bananapus/nana-721-hook-v6",
        description:
          "Tiered NFT minting, pricing, supply, and collection rules.",
      },
      {
        title: "Buyback hook",
        url: "https://github.com/Bananapus/nana-buyback-hook-v6",
        description:
          "Compare pool execution with protocol mint and cash-out paths.",
      },
      {
        title: "Router terminal",
        url: "https://github.com/Bananapus/nana-router-terminal-v6",
        description: "Convert incoming tokens into assets a project accepts.",
      },
      {
        title: "Uniswap V4 router",
        url: "https://github.com/Bananapus/nana-univ4-router-v6",
        description: "Protocol-aware Uniswap V4 hooks and oracle utilities.",
      },
      {
        title: "Uniswap V4 LP split hook",
        url: "https://github.com/Bananapus/nana-univ4-lp-split-hook-v6",
        description:
          "Deploy reserved project tokens into concentrated liquidity.",
      },
      {
        title: "Swap split hook",
        url: "https://github.com/Bananapus/nana-swap-split-hook-v6",
        description: "Rebalance a project treasury between accounting tokens.",
      },
    ],
  },
  {
    title: "Cross-chain & deployment",
    links: [
      {
        title: "Suckers",
        url: "https://github.com/Bananapus/nana-suckers-v6",
        description: "Bridge project tokens and their backing across chains.",
      },
      {
        title: "Omnichain deployers",
        url: "https://github.com/Bananapus/nana-omnichain-deployers-v6",
        description: "Launch projects with hooks and cross-chain connections.",
      },
      {
        title: "Deploy All V6",
        url: "https://github.com/Bananapus/deploy-all-v6",
        description: "Coordinate deployments and inspect chain artifacts.",
      },
      {
        title: "Fee project deployer",
        url: "https://github.com/Bananapus/nana-fee-project-deployer-v6",
        description: "Deploy the V6 protocol fee beneficiary project.",
      },
    ],
  },
  {
    title: "Products & rewards",
    links: [
      {
        title: "Revnet core",
        url: "https://github.com/rev-net/revnet-core-v6",
        description:
          "Staged economics, cross-chain revnets, and collateralized loans.",
      },
      {
        title: "Croptop",
        url: "https://github.com/mejango/croptop-core-v6",
        description: "Publish NFT tiers under project-defined posting rules.",
      },
      {
        title: "Banny retail",
        url: "https://github.com/mejango/banny-retail-v6",
        description: "Compose onchain avatar bodies, outfits, and backgrounds.",
      },
      {
        title: "Defifa",
        url: "https://github.com/BallKidz/defifa",
        description:
          "Prediction games with NFT pieces and scorecard settlement.",
      },
      {
        title: "Distributor",
        url: "https://github.com/Bananapus/nana-distributor-v6",
        description: "Distribute token and NFT rewards with vesting rounds.",
      },
      {
        title: "JBX distributor",
        url: "https://github.com/Bananapus/nana-jbx-distributor-v6",
        description: "Route split-funded rewards to JBX staking snapshots.",
      },
      {
        title: "JBSticky",
        url: "https://github.com/mejango/jbsticky",
        description:
          "Time-locked project tokens and rewards for long-term holders.",
      },
      {
        title: "JBChat",
        url: "https://github.com/mejango/jbchat",
        description: "Project messaging and support integration source.",
      },
    ],
  },
  {
    title: "Webclients",
    links: [
      {
        title: "Juicebox Money",
        url: "https://github.com/mejango/juicebox-money",
        description: "General-purpose project webclient.",
      },
      {
        title: "Revnet Money",
        url: "https://github.com/mejango/revnet-money",
        description: "Revnet webclient.",
      },
      {
        title: "Juicescan",
        url: "https://github.com/mejango/juicescan",
        description: "Static V6 explorer and transaction interface.",
      },
      {
        title: "eth.shop",
        url: "https://github.com/mejango/eth-shop",
        description: "V6 shop and tiered NFT interface.",
      },
      {
        title: "Succulent",
        url: "https://github.com/mejango/succulent",
        description: "V6 activity feed and project posts.",
      },
    ],
  },
  {
    title: "SDK, data & agents",
    links: [
      {
        title: "Juice SDK — V6 actions",
        url: "https://github.com/Bananapus/juice-sdk-v4#v6-actions-bananapusnana-sdk-corev6",
        description: "TypeScript reads and transaction builders for V6.",
      },
      {
        title: "Bendystraw",
        url: "https://github.com/peripheralist/bendystraw",
        description:
          "GraphQL indexing for projects, balances, and activity. Scope queries to V6.",
      },
      {
        title: "Juicebox Center",
        url: "https://github.com/mejango/jbcenter",
        description:
          "Shared project intents, public read RPC, IPFS, and MCP services.",
      },
      {
        title: "Juicebox V6 skills",
        url: "https://github.com/mejango/juicebox-skills",
        description: "Portable V6 instructions and resources for AI agents.",
      },
      {
        title: "MCP reference",
        url: "https://github.com/mejango/jbcenter/tree/main/mcp",
        description: "V6 tools, resources, prompts, and client setup.",
      },
    ],
  },
];
