/**
 * Curated public V6 entry points: the one list behind `/` and `/llms.txt`.
 * Verify destinations, protocol version and availability when updating.
 */
export interface DirectoryLink {
  /** What the visitor wants, in a few words. */
  need: string;
  /** Where it leads. */
  name: string;
  /** Absolute, or root-relative for Center's own pages. */
  url: string;
  /** One short caveat shown under the row. */
  note?: string;
  /** A literal endpoint or command shown under the row. */
  code?: string;
  /** Extra detail for `/llms.txt` only. */
  agentNote?: string;
}

export interface DirectoryGroup {
  title: string;
  /** Stable fragment, when other pages link this group. */
  id?: string;
  links: readonly DirectoryLink[];
}

/** One audience: a column on the page. */
export interface DirectorySection {
  id: string;
  title: string;
  /** Who the column is for. */
  audience: string;
  groups: readonly DirectoryGroup[];
}

export interface RepositoryGroup {
  title: string;
  links: readonly { title: string; url: string; description: string }[];
}

// Published from merged Juicescan 3d9dd7b, pinned by Filebase and Pinata.
// HTML, app.js, CSS and manifest verified byte-for-byte through Center and eth.sucks on October 12, 2026.
// Update only after confirming a newer published CID, not a local build hash.
export const JUICESCAN_URL =
  "https://bafybeietgpz6mzxyh7vfvisxwohdce3xsvkxsrn2obffp7mqcfwusnvqya.eth.sucks/";

const V6 = "https://github.com/Bananapus/version-6";
const CENTER = "https://github.com/mejango/jbcenter";
const SKILLS = "https://github.com/mejango/juicebox-skills";

export const directorySections: readonly DirectorySection[] = [
  {
    id: "apps",
    title: "Use",
    audience: "Fund, launch and run projects",
    groups: [
      {
        title: "Apps",
        links: [
          { need: "Fund or cash out a project", name: "Juicebox Money", url: "https://juicebox.money" },
          { need: "Fund or cash out a revnet", name: "Revnet Money", url: "https://revnet.money" },
          {
            need: "Inspect or manage a project",
            name: "Juicescan",
            url: JUICESCAN_URL,
            agentNote: "Current project values, contracts, and transaction tools. /inspect/:chain/:projectId redirects to one project, for example /inspect/basesep/1.",
          },
          { need: "Follow activity", name: "Succulent", url: "https://succulent.money" },
        ],
      },
      {
        title: "Launch",
        id: "projects",
        links: [
          { need: "Launch a project", name: "Juicebox Money", url: "https://juicebox.money/create" },
          { need: "Launch a revnet", name: "Revnet Money", url: "https://revnet.money/create" },
          { need: "Follow owner workflows", name: "User journeys", url: `${V6}/blob/main/USER_JOURNEYS.md` },
        ],
      },
      {
        title: "Learn",
        links: [
          {
            need: "Learn the basics",
            name: "Juicebox guide",
            url: "https://juicebox.money/learn",
            agentNote: "Project rules and the tokens a payment may return.",
          },
          {
            need: "Learn revnets",
            name: "Revnet guide",
            url: "https://revnet.money/learn",
            agentNote: "Rules set at launch, three kinds of price, and what operators can change.",
          },
          { need: "Look up a word", name: "Glossary", url: "/api#glossary" },
        ],
      },
    ],
  },
  {
    id: "developers",
    title: "Build",
    audience: "Make an app or integration",
    groups: [
      {
        title: "Start",
        links: [
          { need: "Start here", name: "Build guide", url: "https://juicebox.money/build" },
          {
            need: "Make a test payment",
            name: "Tutorial",
            url: "https://juicebox.money/build/first-payment",
            agentNote: "Read a project, pay it with test funds, and check the result.",
          },
          {
            need: "Build with revnets",
            name: "Revnet build guide",
            url: "https://revnet.money/build",
            agentNote: "Choose rules, draft a revnet, and connect it to an app.",
          },
          { need: "See how the parts fit", name: "Architecture", url: `${V6}/blob/main/ARCHITECTURE.md` },
        ],
      },
      {
        title: "Code and data",
        links: [
          {
            need: "Read and write from TypeScript",
            name: "Juice SDK",
            url: "https://github.com/Bananapus/juice-sdk-v4#v6-actions-bananapusnana-sdk-corev6",
          },
          {
            need: "Query projects and activity",
            name: "Bendystraw",
            url: "https://bendystraw.xyz/schema",
            agentNote: "GraphQL. Needs a key. Filter to V6.",
          },
          { need: "Find contract addresses", name: "Contracts", url: "/api/docs/contracts" },
          { need: "Fork an app", name: "App source", url: "#repositories-webclients" },
        ],
      },
      {
        title: "Center APIs",
        id: "api",
        links: [
          {
            need: "Read state, prepare transactions",
            name: "REST API",
            url: "/api",
            agentNote: "Public reads and unsigned transaction preparation.",
          },
          { need: "Generate a client", name: "OpenAPI", url: "/api/v1/openapi.json" },
          {
            need: "Read a chain",
            name: "RPC",
            url: `${CENTER}#read-ethereum-rpc`,
            agentNote: "`POST /v1/rpc/:chainId`. Public, no key. One JSON-RPC object per request.",
          },
          {
            need: "Fetch or publish a file",
            name: "IPFS",
            url: `${CENTER}#pin-and-read-ipfs-content`,
            agentNote: "`GET /ipfs/:cid` is public. `POST /v1/pins/json`, `/v1/pins/file` and `/v1/pins/media` accept approved apps; agents pin through MCP.",
          },
          {
            need: "Launch without a transaction",
            name: "Project intents",
            url: "/api/docs/project-intents",
            agentNote:
              "Create a project without a transaction: `POST /v1/intents` publishes a signed, frozen project deployment; `POST /v1/intents/:id/deploy` requests a sponsored execution of its own calls, which may create its Safes and then launch, and `POST /v1/intents/:id/relay` signs any chain the payer sends itself.",
          },
        ],
      },
    ],
  },
  {
    id: "agents",
    title: "Automate",
    audience: "Connect an AI agent",
    groups: [
      {
        title: "Connect",
        links: [
          {
            need: "Connect over MCP",
            name: "Setup",
            url: `${SKILLS}#connect-the-hosted-mcp`,
            code: "https://juicebox.center/mcp",
            agentNote: "Streamable HTTP. No REST enrollment needed.",
          },
          { need: "Find a tool", name: "MCP reference", url: `${CENTER}/tree/main/mcp` },
          {
            need: "Check what is live",
            name: "Capabilities",
            url: "/api/v1/capabilities",
            agentNote: "Check availability on the chosen chain before planning.",
          },
          { need: "Get started", name: "Quickstart", url: "/api/docs/quickstart" },
        ],
      },
      {
        title: "Instructions",
        links: [
          { need: "Load a skill", name: "skill.md", url: "/skill.md" },
          { need: "Read this page as text", name: "llms.txt", url: "/llms.txt" },
          {
            need: "Add V6 instructions",
            name: "Skills",
            url: SKILLS,
            agentNote: "Portable protocol and integration guidance.",
          },
        ],
      },
      {
        title: "Act safely",
        links: [
          {
            need: "Choose a workflow",
            name: "Journeys",
            url: "/api/docs/user-journeys",
            agentNote: "What to prepare, what to approve, and how to check the result.",
          },
          {
            need: "Review before signing",
            name: "Agent guide",
            url: "/api/docs/ai-guide",
            agentNote: "Exact transaction review and recovery.",
          },
          {
            need: "Track a transaction",
            name: "Lifecycle",
            url: "/api/docs/transactions",
            agentNote: "Pending, failed, and partially completed operations.",
          },
          {
            need: "Manage accounts and bots",
            name: "Signa",
            url: "https://api.signa.center/accounts",
            agentNote: "Account access, bot grants and wallet execution.",
          },
        ],
      },
    ],
  },
];

export const auditLinks: readonly DirectoryLink[] = [
  { need: "Review a transaction", name: "Audit guide", url: "https://juicebox.money/audit" },
  { need: "Plan a protocol review", name: "Audit instructions", url: `${V6}/blob/main/AUDIT_INSTRUCTIONS.md` },
  { need: "Check assumptions", name: "Risks", url: `${V6}/blob/main/RISKS.md` },
  { need: "Check guarantees", name: "Invariants", url: `${V6}/blob/main/INVARIANTS.md` },
  { need: "Check who controls what", name: "Administration", url: `${V6}/blob/main/ADMINISTRATION.md` },
  {
    need: "Find deployed contracts",
    name: "Deployments",
    url: "https://github.com/Bananapus/deploy-all-v6/tree/main/deployments",
  },
];

// Maintainer-designated unfinished projects; deployment alone is not readiness.
export const workInProgress: readonly (DirectoryLink & { note: string })[] = [
  {
    need: "Shops and NFTs",
    name: "eth.shop",
    url: "https://eth.shop",
    note: "Unfinished shop and NFT app.",
  },
  {
    need: "Token locks and rewards",
    name: "Sticky",
    url: "https://sticky.center",
    note: "Unfinished token lock and reward tools.",
  },
  {
    need: "Project messaging",
    name: "JBChat",
    url: "https://github.com/mejango/jbchat",
    note: "Prototype. Production messaging is not enabled.",
  },
  {
    need: "Card and bank payments",
    name: "JBProcessor",
    url: "https://github.com/mejango/jbprocessor",
    note: "Live Stripe processing is unfinished.",
  },
  {
    need: "Revnets for funded machines",
    name: "Plugin",
    url: "https://github.com/mejango/plugin",
    note: "Website only. Its contracts are not configured.",
  },
];

export const V6_REPOSITORY = V6;

export const repositoryGroups: readonly RepositoryGroup[] = [
  {
    title: "Core",
    links: [
      {
        title: "Core protocol",
        url: "https://github.com/Bananapus/nana-core-v6",
        description: "Projects, rules, balances, tokens, payments, and cash outs.",
      },
      {
        title: "Permission IDs",
        url: "https://github.com/Bananapus/nana-permission-ids-v6",
        description: "Shared constants for V6 operator permissions.",
      },
      {
        title: "Project ownership",
        url: "https://github.com/Bananapus/nana-ownable-v6",
        description: "Contract ownership that follows a project and its permissions.",
      },
      {
        title: "Address registry",
        url: "https://github.com/Bananapus/nana-address-registry-v6",
        description: "Record and check who deployed a contract.",
      },
      {
        title: "Project handles",
        url: "https://github.com/Bananapus/nana-project-handles-v6",
        description: "Find projects by their Ethereum Name Service (ENS) names.",
      },
      {
        title: "Project payer",
        url: "https://github.com/Bananapus/nana-project-payer-v6",
        description: "Create payment addresses that forward funds to a project.",
      },
    ],
  },
  {
    title: "Hooks and liquidity",
    links: [
      {
        title: "721 hook",
        url: "https://github.com/Bananapus/nana-721-hook-v6",
        description: "Tiered NFT minting, pricing, supply, and collection rules.",
      },
      {
        title: "Buyback hook",
        url: "https://github.com/Bananapus/nana-buyback-hook-v6",
        description: "Compare a market trade with creating or cashing out project tokens.",
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
        description: "Deploy reserved project tokens into concentrated liquidity.",
      },
      {
        title: "Swap split hook",
        url: "https://github.com/Bananapus/nana-swap-split-hook-v6",
        description: "Move project funds between its accepted tokens.",
      },
    ],
  },
  {
    title: "Cross-chain and deployment",
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
        description: "Deploy contracts and check their published records.",
      },
      {
        title: "Fee project deployer",
        url: "https://github.com/Bananapus/nana-fee-project-deployer-v6",
        description: "Deploy the shared V6 infrastructure revnet.",
      },
    ],
  },
  {
    title: "Products and rewards",
    links: [
      {
        title: "Revnet core",
        url: "https://github.com/rev-net/revnet-core-v6",
        description: "Scheduled token rules, revnets across chains, and loans backed by tokens.",
      },
      {
        title: "Croptop",
        url: "https://github.com/mejango/croptop-core-v6",
        description: "Publish NFT tiers under project-defined posting rules.",
      },
      {
        title: "Banny retail",
        url: "https://github.com/mejango/banny-retail-v6",
        description: "Combine avatar bodies, outfits, and backgrounds stored onchain.",
      },
      {
        title: "Defifa",
        url: "https://github.com/BallKidz/defifa",
        description: "Prediction games with NFT pieces and scorecard settlement.",
      },
      {
        title: "Distributor",
        url: "https://github.com/Bananapus/nana-distributor-v6",
        description: "Share token and NFT rewards that unlock over time.",
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
        description: "App for funding and running Juicebox projects.",
      },
      {
        title: "Revnet Money",
        url: "https://github.com/mejango/revnet-money",
        description: "App for funding and launching revnets.",
      },
      {
        title: "Juicescan",
        url: "https://github.com/mejango/juicescan",
        description: "Look up V6 projects and prepare transactions.",
      },
      {
        title: "Succulent",
        url: "https://github.com/mejango/succulent",
        description: "V6 activity feed and project posts.",
      },
    ],
  },
  {
    title: "SDK, data and agents",
    links: [
      {
        title: "Juice SDK",
        url: "https://github.com/Bananapus/juice-sdk-v4",
        description: "TypeScript reads and transaction builders for V6.",
      },
      {
        title: "Bendystraw",
        url: "https://github.com/peripheralist/bendystraw",
        description: "Search projects, balances, and activity through GraphQL. Filter to V6.",
      },
      {
        title: "Juicebox Center",
        url: CENTER,
        description: "This directory, the REST API, RPC, file storage, and MCP tools.",
      },
      {
        title: "Juicebox V6 skills",
        url: SKILLS,
        description: "Portable V6 instructions and resources for AI agents.",
      },
    ],
  },
];

/** Stable fragment for a repository group, for links from the sections above. */
export const repositoryGroupId = (title: string): string =>
  `repositories-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
