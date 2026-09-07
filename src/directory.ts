/** Curated public V6 entry points. Verify destinations when updating. */
export interface DirectoryLink {
  title: string;
  url: string;
  description: string;
  sourceUrl?: string;
  label?: string;
}

export interface DirectoryNode {
  title: string;
  id?: string;
  url?: string;
  sourceUrl?: string;
  note?: string;
  children?: readonly DirectoryNode[];
  content?: "rpc" | "ipfs" | "pinning" | "mcp" | "repositories";
}

export interface RepositoryGroup {
  title: string;
  links: readonly DirectoryLink[];
}

// Published September 3, 2026; latest jb-directory record in Pinata, pinned by
// Filebase. HTML and app.js verified through eth.sucks on September 6.
// Update only after confirming a newer published CID, not a local build hash.
const JUICESCAN_URL =
  "https://bafybeidt2dd3bsiyyk6rfkjuuglcpjvojxeztxd2g4esamopeybpcj25di.eth.sucks/";

// WIP scope includes maintainer-designated projects; deployment alone is not readiness.
const workInProgress: readonly (DirectoryNode & {
  url: string;
  note: string;
})[] = [
  {
    title: "Shops and NFTs → eth.shop",
    url: "https://eth.shop",
    sourceUrl: "https://github.com/mejango/eth-shop",
    note: "WIP shop and NFT interface.",
  },
  {
    title: "Token locks and rewards → Sticky",
    url: "https://github.com/mejango/jbsticky",
    note: "WIP project token locks and rewards.",
  },
  {
    title: "Project messaging and support → JBChat",
    url: "https://github.com/mejango/jbchat",
    note: "Development prototype; production messaging is not enabled.",
  },
  {
    title: "Card and bank payments → JBProcessor",
    url: "https://github.com/mejango/jbprocessor",
    note: "Live Stripe settlement and end-to-end onboarding remain unfinished.",
  },
  {
    title: "Revnets for funded machines → Plugin",
    url: "https://github.com/mejango/plugin",
    note: "Frontend deployed; machine-launcher contracts are not configured.",
  },
];

export const directoryTree: readonly DirectoryNode[] = [
  {
    title: "Use Juicebox",
    id: "apps",
    children: [
      {
        title: "Find or fund a project → Juicebox Money",
        url: "https://juicebox.money",
        sourceUrl: "https://github.com/mejango/juicebox-money",
      },
      {
        title: "Cash out project tokens → Juicebox Money",
        url: "https://juicebox.money",
      },
      {
        title: "Explore revnets → Revnet Money",
        url: "https://revnet.money",
        sourceUrl: "https://github.com/mejango/revnet-money",
      },
      {
        title: "Follow activity or post → Succulent",
        url: "https://succulent.money",
        sourceUrl: "https://github.com/mejango/succulent",
      },
      {
        title: "Explore projects and contracts → Juicescan",
        url: JUICESCAN_URL,
        sourceUrl: "https://github.com/mejango/juicescan",
      },
      {
        title: "Learn how it works → Juicebox guide",
        url: "https://juicebox.money/learn",
      },
    ],
  },
  {
    title: "Launch or run a project",
    id: "projects",
    children: [
      {
        title: "Launch a project → Juicebox Money",
        url: "https://juicebox.money/create",
      },
      {
        title: "Launch a revnet → Revnet Money",
        url: "https://revnet.money/create",
      },
      {
        title: "Manage an existing project → Juicescan",
        url: JUICESCAN_URL,
        sourceUrl: "https://github.com/mejango/juicescan",
      },
      {
        title: "Follow owner workflows → User journeys",
        url: "https://github.com/Bananapus/version-6/blob/main/USER_JOURNEYS.md",
      },
      {
        title: "Understand permissions and control → Administration",
        url: "https://github.com/Bananapus/version-6/blob/main/ADMINISTRATION.md",
      },
    ],
  },
  {
    title: "Build an app",
    id: "developers",
    children: [
      {
        title: "Choose your building blocks → Build guide",
        url: "https://juicebox.money/build",
      },
      {
        title: "Find the right component → V6 ecosystem",
        url: "https://github.com/Bananapus/version-6",
      },
      {
        title: "Read contracts and prepare transactions → Juice SDK V6",
        url: "https://github.com/Bananapus/juice-sdk-v4#v6-actions-bananapusnana-sdk-corev6",
      },
      {
        title: "Query projects and activity → Bendystraw",
        url: "https://bendystraw.xyz/schema",
        sourceUrl: "https://github.com/peripheralist/bendystraw",
        note: "Filter queries to V6. API queries require a key.",
      },
      {
        title: "Integrate project listings and shared services → Center",
        url: "https://github.com/mejango/jbcenter",
      },
      {
        title: "Understand how components fit → Architecture",
        url: "https://github.com/Bananapus/version-6/blob/main/ARCHITECTURE.md",
      },
      {
        title: "Start from a webclient",
        children: [
          {
            title: "General-purpose projects → Juicebox Money source",
            url: "https://github.com/mejango/juicebox-money",
          },
          {
            title: "Revnets → Revnet Money source",
            url: "https://github.com/mejango/revnet-money",
          },
          {
            title: "Static explorer → Juicescan source",
            url: "https://github.com/mejango/juicescan",
          },
          {
            title: "Shop prototype → eth.shop source (WIP)",
            url: "https://github.com/mejango/eth-shop",
          },
          {
            title: "Activity feed → Succulent source",
            url: "https://github.com/mejango/succulent",
          },
        ],
      },
    ],
  },
  {
    title: "Use an API",
    id: "api",
    children: [
      {
        title: "Read V6 data and relay signed transactions → REST API",
        url: "https://juicebox.center/api",
      },
      {
        title: "Create and manage a bot → Accounts",
        url: "https://juicebox.center/accounts",
      },
      {
        title: "Generate an API client → OpenAPI specification",
        url: "https://juicebox.center/api/v1/openapi.json",
      },
      {
        title: "Read a chain → RPC",
        id: "rpc",
        content: "rpc",
      },
      {
        title: "Retrieve a file → IPFS gateway",
        id: "ipfs",
        content: "ipfs",
      },
      {
        title: "Publish a file → IPFS pinning",
        id: "pinning",
        content: "pinning",
      },
    ],
  },
  {
    title: "Connect an AI agent",
    id: "agents",
    content: "mcp",
    children: [
      {
        title: "Connect your agent → MCP setup",
        url: "https://github.com/mejango/juicebox-skills#connect-the-hosted-mcp",
      },
      {
        title: "Add V6 instructions → Juicebox skills",
        url: "https://github.com/mejango/juicebox-skills",
      },
      {
        title: "Find a tool → MCP reference",
        url: "https://github.com/mejango/jbcenter/tree/main/mcp",
      },
      {
        title: "Choose a workflow → MCP user journeys",
        url: "https://github.com/mejango/jbcenter/blob/main/mcp/docs/USER_JOURNEYS.md",
      },
    ],
  },
  {
    title: "Audit or research",
    id: "auditors",
    children: [
      {
        title: "Review a transaction → Audit guide",
        url: "https://juicebox.money/audit",
      },
      {
        title: "Plan a protocol review → Audit instructions",
        url: "https://github.com/Bananapus/version-6/blob/main/AUDIT_INSTRUCTIONS.md",
      },
      {
        title: "Check assumptions → Risks",
        url: "https://github.com/Bananapus/version-6/blob/main/RISKS.md",
      },
      {
        title: "Check guarantees → Invariants",
        url: "https://github.com/Bananapus/version-6/blob/main/INVARIANTS.md",
      },
      {
        title: "Find addresses and ABIs → Deployment artifacts",
        url: "https://github.com/Bananapus/deploy-all-v6/tree/main/deployments",
      },
      {
        title: "Inspect control and permissions → Administration",
        url: "https://github.com/Bananapus/version-6/blob/main/ADMINISTRATION.md",
      },
    ],
  },
  {
    title: "Browse all repositories",
    id: "repositories",
    content: "repositories",
  },
  {
    title: "Explore WIP extensions",
    id: "wip",
    children: workInProgress,
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
  {
    title: "WIP extensions",
    links: workInProgress.map(({ title, url, sourceUrl, note }) => ({
      title,
      url: sourceUrl ?? url,
      description: note,
    })),
  },
];
