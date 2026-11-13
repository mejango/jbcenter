/**
 * Curated public V6 entry points: the one list behind `/` and `/llms.txt`.
 * Verify destinations, protocol version and availability when updating.
 */
export interface DirectoryLink {
  /** The destination: the row's label. */
  name: string;
  /** What it is for, in a few lowercase words. */
  need: string;
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

/** Every column uses these three groups, in this order. */
export const GROUP_TITLES = ["Start", "Tools", "Reference"] as const;

export const directorySections: readonly DirectorySection[] = [
  {
    id: "apps",
    title: "Use",
    audience: "Fund, launch and run projects",
    groups: [
      {
        title: "Start",
        links: [
          {
            name: "Juicebox guide",
            need: "learn the basics",
            url: "https://juicebox.money/learn",
            agentNote: "Project rules and the tokens a payment may return.",
          },
          {
            name: "Revnet guide",
            need: "learn revnets",
            url: "https://revnet.money/learn",
            agentNote: "Rules set at launch, three kinds of price, and what operators can change.",
          },
        ],
      },
      {
        title: "Tools",
        id: "projects",
        links: [
          {
            name: "Juicebox Money",
            need: "fund, launch, run projects",
            url: "https://juicebox.money",
            agentNote: "Launch at https://juicebox.money/create.",
          },
          {
            name: "Revnet Money",
            need: "fund and launch revnets",
            url: "https://revnet.money",
            agentNote: "Launch at https://revnet.money/create.",
          },
          {
            name: "Juicescan",
            need: "inspect any project",
            url: JUICESCAN_URL,
            agentNote: "Current project values, contracts, and transaction tools. /inspect/:chain/:projectId redirects to one project, for example /inspect/basesep/1.",
          },
          { name: "Succulent", need: "follow activity", url: "https://succulent.money" },
        ],
      },
      {
        title: "Reference",
        links: [
          { name: "User journeys", need: "owner workflows", url: `${V6}/blob/main/USER_JOURNEYS.md` },
          { name: "Glossary", need: "look up a word", url: "/api#glossary" },
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
          { name: "Build guide", need: "choose your building blocks", url: "https://juicebox.money/build" },
          {
            name: "Tutorial",
            need: "make a test payment",
            url: "https://juicebox.money/build/first-payment",
            agentNote: "Read a project, pay it with test funds, and check the result.",
          },
        ],
      },
      {
        title: "Tools",
        id: "api",
        links: [
          {
            name: "Juice SDK",
            need: "TypeScript reads and writes",
            url: "https://github.com/Bananapus/juice-sdk-v4#v6-actions-bananapusnana-sdk-corev6",
          },
          {
            name: "REST API",
            need: "read state, prepare transactions",
            url: "/api",
            agentNote: "Public reads and unsigned transaction preparation.",
          },
          {
            name: "Bendystraw",
            need: "query projects and activity",
            url: "https://bendystraw.xyz/schema",
            agentNote: "GraphQL. Needs a key. Filter to V6.",
          },
          {
            name: "RPC",
            need: "read a chain",
            url: `${CENTER}#read-ethereum-rpc`,
            agentNote: "`POST /v1/rpc/:chainId`. Public, no key. One JSON-RPC object per request.",
          },
          {
            name: "IPFS",
            need: "fetch or publish a file",
            url: `${CENTER}#pin-and-read-ipfs-content`,
            agentNote: "`GET /ipfs/:cid` is public. `POST /v1/pins/json`, `/v1/pins/file` and `/v1/pins/media` accept approved apps; agents pin through MCP.",
          },
          {
            name: "Project intents",
            need: "launch without a transaction",
            url: "/api/docs/project-intents",
            agentNote:
              "Create a project without a transaction: `POST /v1/intents` publishes a signed, frozen project deployment; `POST /v1/intents/:id/deploy` requests a sponsored execution of its own calls, which may create its Safes and then launch, and `POST /v1/intents/:id/relay` signs any chain the payer sends itself.",
          },
        ],
      },
      {
        title: "Reference",
        links: [
          { name: "Architecture", need: "how the parts fit", url: `${V6}/blob/main/ARCHITECTURE.md` },
          { name: "Contracts", need: "addresses and ABIs", url: "/api/docs/contracts" },
          { name: "OpenAPI", need: "generate a client", url: "/api/v1/openapi.json" },
          {
            name: "Revnet build guide",
            need: "build with revnets",
            url: "https://revnet.money/build",
            agentNote: "Choose rules, draft a revnet, and connect it to an app.",
          },
          { name: "App source", need: "fork an app", url: "#repositories-webclients" },
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
        title: "Start",
        links: [
          { name: "Quickstart", need: "connect and make a first call", url: "/api/docs/quickstart" },
          { name: "skill.md", need: "load this as a skill", url: "/skill.md" },
        ],
      },
      {
        title: "Tools",
        links: [
          {
            name: "MCP server",
            need: "connect an agent",
            url: `${SKILLS}#connect-the-hosted-mcp`,
            code: "https://juicebox.center/mcp",
            agentNote: "Streamable HTTP. No REST enrollment needed.",
          },
          {
            name: "Skills",
            need: "V6 instructions",
            url: SKILLS,
            agentNote: "Portable protocol and integration guidance.",
          },
          {
            name: "Capabilities",
            need: "what is live now",
            url: "/api/v1/capabilities",
            agentNote: "Check availability on the chosen chain before planning.",
          },
          {
            name: "Signa",
            need: "accounts and bots",
            url: "https://api.signa.center/accounts",
            agentNote: "Account access, bot grants and wallet execution.",
          },
        ],
      },
      {
        title: "Reference",
        links: [
          { name: "MCP tools", need: "every tool and prompt", url: `${CENTER}/tree/main/mcp` },
          {
            name: "Journeys",
            need: "choose a workflow",
            url: "/api/docs/user-journeys",
            agentNote: "What to prepare, what to approve, and how to check the result.",
          },
          {
            name: "Agent guide",
            need: "review before signing",
            url: "/api/docs/ai-guide",
            agentNote: "Exact transaction review and recovery.",
          },
          {
            name: "Lifecycle",
            need: "track a transaction",
            url: "/api/docs/transactions",
            agentNote: "Pending, failed, and partially completed operations.",
          },
          { name: "llms.txt", need: "this page as text", url: "/llms.txt" },
        ],
      },
    ],
  },
];

export const auditLinks: readonly DirectoryLink[] = [
  { name: "Audit guide", need: "review a transaction", url: "https://juicebox.money/audit" },
  { name: "Audit instructions", need: "plan a protocol review", url: `${V6}/blob/main/AUDIT_INSTRUCTIONS.md` },
  { name: "Risks", need: "assumptions", url: `${V6}/blob/main/RISKS.md` },
  { name: "Invariants", need: "guarantees", url: `${V6}/blob/main/INVARIANTS.md` },
  { name: "Administration", need: "who controls what", url: `${V6}/blob/main/ADMINISTRATION.md` },
  {
    name: "Deployments",
    need: "deployed contracts",
    url: "https://github.com/Bananapus/deploy-all-v6/tree/main/deployments",
  },
];

// Maintainer-designated unfinished projects; deployment alone is not readiness.
export const workInProgress: readonly (DirectoryLink & { note: string })[] = [
  {
    need: "shops and NFTs",
    name: "eth.shop",
    url: "https://eth.shop",
    note: "Unfinished shop and NFT app.",
  },
  {
    need: "token locks and rewards",
    name: "Sticky",
    url: "https://sticky.center",
    note: "Unfinished token lock and reward tools.",
  },
  {
    need: "project messaging",
    name: "JBChat",
    url: "https://github.com/mejango/jbchat",
    note: "Prototype. Production messaging is not enabled.",
  },
  {
    need: "card and bank payments",
    name: "JBProcessor",
    url: "https://github.com/mejango/jbprocessor",
    note: "Live Stripe processing is unfinished.",
  },
  {
    need: "revnets for funded machines",
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
