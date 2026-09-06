/** Shared decisions and resources. A view shows one route through this graph. */
export interface JourneyEdge {
  label: string;
  to: string;
  kind?: "return" | "cross";
}

export interface JourneyNode {
  id: string;
  title: string;
  kind: "question" | "resource";
  links?: readonly { title: string; url: string }[];
  note?: string;
  content?:
    | "rpc"
    | "ipfs"
    | "pinning"
    | "mcp"
    | "repositories"
    | "webclients"
    | "wip";
  edges: readonly JourneyEdge[];
}

export interface JourneyView {
  id: string;
  title: string;
  entry: string;
  layout: readonly { node: string; column: 1 | 2 | 3; row: number }[];
}

const V6 = "https://github.com/Bananapus/version-6";
const CENTER = "https://github.com/mejango/jbcenter";
const SKILLS = "https://github.com/mejango/juicebox-skills";
const MCP_JOURNEYS = `${CENTER}/blob/main/mcp/docs/USER_JOURNEYS.md`;
// The published CID verified in directory.ts, not a local build hash.
const JUICESCAN =
  "https://bafybeidt2dd3bsiyyk6rfkjuuglcpjvojxeztxd2g4esamopeybpcj25di.eth.sucks/";

export const journeyNodes: readonly JourneyNode[] = [
  {
    id: "apps",
    title: "What brings you here?",
    kind: "question",
    edges: [
      { label: "Use a project", to: "find-project" },
      { label: "Explore", to: "observe" },
      { label: "Learn first", to: "learn" },
      { label: "Launch a project", to: "projects", kind: "cross" },
    ],
  },
  {
    id: "find-project",
    title: "Know the project?",
    kind: "question",
    edges: [
      { label: "Yes", to: "project-action" },
      { label: "Help me find one", to: "project-kind" },
    ],
  },
  {
    id: "project-action",
    title: "What do you want to do?",
    kind: "question",
    edges: [
      { label: "Pay or cash out", to: "project-kind" },
      { label: "Check a transaction", to: "transaction-review" },
      { label: "Manage the project", to: "projects", kind: "cross" },
    ],
  },
  {
    id: "project-kind",
    title: "Project or revnet?",
    kind: "question",
    edges: [
      { label: "Project", to: "juicebox-money" },
      { label: "Revnet", to: "revnet-money" },
      { label: "Explain the basics", to: "learn", kind: "return" },
    ],
  },
  {
    id: "observe",
    title: "What do you want to follow?",
    kind: "question",
    edges: [
      { label: "Activity and posts", to: "succulent" },
      { label: "Projects and contracts", to: "juicescan" },
      { label: "Find something to fund", to: "project-kind" },
    ],
  },
  {
    id: "learn",
    title: "Learn Juicebox",
    kind: "resource",
    links: [{ title: "Open the guide", url: "https://juicebox.money/learn" }],
    edges: [{ label: "Put it into practice", to: "apps", kind: "return" }],
  },
  {
    id: "juicebox-money",
    title: "Juicebox Money",
    kind: "resource",
    links: [
      { title: "Open app", url: "https://juicebox.money" },
      { title: "Source", url: "https://github.com/mejango/juicebox-money" },
    ],
    edges: [
      { label: "Review before signing", to: "transaction-review" },
      { label: "Build an interface", to: "developers", kind: "cross" },
    ],
  },
  {
    id: "revnet-money",
    title: "Revnet Money",
    kind: "resource",
    links: [
      { title: "Open app", url: "https://revnet.money" },
      { title: "Source", url: "https://github.com/mejango/revnet-money" },
    ],
    edges: [
      { label: "Review before signing", to: "transaction-review" },
      { label: "Launch your own", to: "projects", kind: "cross" },
    ],
  },
  {
    id: "succulent",
    title: "Succulent",
    kind: "resource",
    links: [
      { title: "Open activity feed", url: "https://succulent.money" },
      { title: "Source", url: "https://github.com/mejango/succulent" },
    ],
    edges: [
      { label: "Act on a project", to: "project-action", kind: "return" },
    ],
  },
  {
    id: "juicescan",
    title: "Juicescan",
    kind: "resource",
    links: [
      { title: "Open explorer", url: JUICESCAN },
      { title: "Source", url: "https://github.com/mejango/juicescan" },
    ],
    edges: [
      {
        label: "Choose a project action",
        to: "project-action",
        kind: "return",
      },
      { label: "Review its controls", to: "control-review", kind: "cross" },
    ],
  },
  {
    id: "projects",
    title: "New or existing project?",
    kind: "question",
    edges: [
      { label: "Start something new", to: "control-model" },
      { label: "Run an existing project", to: "manage-project" },
    ],
  },
  {
    id: "control-model",
    title: "How should rules change?",
    kind: "question",
    edges: [
      { label: "Ongoing owner control", to: "launch-project" },
      { label: "Precommitted revnet economics", to: "launch-revnet" },
      { label: "Understand the options", to: "owner-journeys" },
    ],
  },
  {
    id: "manage-project",
    title: "What needs attention?",
    kind: "question",
    edges: [
      { label: "Project configuration", to: "juicescan" },
      { label: "Permissions and control", to: "control-review" },
      { label: "A custom integration", to: "developers", kind: "cross" },
    ],
  },
  {
    id: "launch-project",
    title: "Create a Juicebox project",
    kind: "resource",
    links: [
      { title: "Open project builder", url: "https://juicebox.money/create" },
    ],
    edges: [{ label: "Check the setup", to: "launch-checks" }],
  },
  {
    id: "launch-revnet",
    title: "Create a revnet",
    kind: "resource",
    links: [
      { title: "Open revnet builder", url: "https://revnet.money/create" },
    ],
    edges: [{ label: "Check the setup", to: "launch-checks" }],
  },
  {
    id: "launch-checks",
    title: "What should you check?",
    kind: "question",
    edges: [
      { label: "Rules and owner workflows", to: "owner-journeys" },
      { label: "Permissions", to: "control-review" },
      { label: "The transaction", to: "transaction-review" },
      { label: "Contract deployments", to: "deployments" },
      { label: "Change the setup", to: "control-model", kind: "return" },
    ],
  },
  {
    id: "owner-journeys",
    title: "Project owner journeys",
    kind: "resource",
    links: [
      { title: "Read V6 workflows", url: `${V6}/blob/main/USER_JOURNEYS.md` },
    ],
    edges: [{ label: "Choose the setup", to: "control-model", kind: "return" }],
  },
  {
    id: "control-review",
    title: "Permissions and control",
    kind: "resource",
    links: [
      {
        title: "Read Administration",
        url: `${V6}/blob/main/ADMINISTRATION.md`,
      },
    ],
    edges: [
      { label: "Recheck the transaction", to: "transaction-review" },
      { label: "Revisit the setup", to: "launch-checks", kind: "return" },
    ],
  },
  {
    id: "developers",
    title: "What are you building?",
    kind: "question",
    edges: [
      { label: "A webclient", to: "webclient-start" },
      { label: "An integration", to: "integration-layer" },
      { label: "An agent workflow", to: "agents", kind: "cross" },
    ],
  },
  {
    id: "webclient-start",
    title: "Where do you want to start?",
    kind: "question",
    edges: [
      { label: "An existing interface", to: "webclients" },
      { label: "The protocol design", to: "architecture" },
      { label: "Contract calls", to: "integration-layer" },
    ],
  },
  {
    id: "integration-layer",
    title: "What does the integration need?",
    kind: "question",
    edges: [
      { label: "Reads and transactions", to: "sdk" },
      { label: "Indexed projects and activity", to: "bendystraw" },
      { label: "Hooks or protocol extensions", to: "architecture" },
      { label: "RPC or IPFS", to: "api", kind: "cross" },
    ],
  },
  {
    id: "webclients",
    title: "Start from a webclient",
    kind: "resource",
    content: "webclients",
    edges: [
      { label: "Add contract calls", to: "sdk" },
      { label: "Use shared services", to: "api", kind: "cross" },
      { label: "Change the approach", to: "webclient-start", kind: "return" },
    ],
  },
  {
    id: "sdk",
    title: "Juice SDK V6",
    kind: "resource",
    links: [
      {
        title: "Read V6 actions",
        url: "https://github.com/Bananapus/juice-sdk-v4#v6-actions-bananapusnana-sdk-corev6",
      },
    ],
    edges: [
      { label: "Review prepared calldata", to: "transaction-review" },
      { label: "Connect a read RPC", to: "rpc", kind: "cross" },
    ],
  },
  {
    id: "bendystraw",
    title: "Bendystraw",
    kind: "resource",
    links: [
      { title: "Explore GraphQL schema", url: "https://bendystraw.xyz/schema" },
      { title: "Source", url: "https://github.com/peripheralist/bendystraw" },
    ],
    note: "API key required. Scope queries to V6.",
    edges: [
      { label: "Need current chain state", to: "rpc", kind: "cross" },
      { label: "Add transactions", to: "sdk" },
    ],
  },
  {
    id: "architecture",
    title: "V6 architecture",
    kind: "resource",
    links: [
      { title: "Trace the system", url: `${V6}/blob/main/ARCHITECTURE.md` },
      { title: "Build guide", url: "https://juicebox.money/build" },
    ],
    edges: [
      { label: "Find the implementation", to: "repository-index" },
      { label: "Check assumptions", to: "risks-invariants" },
      {
        label: "Choose an integration",
        to: "integration-layer",
        kind: "return",
      },
    ],
  },
  {
    id: "api",
    title: "What do you need from an API?",
    kind: "question",
    edges: [
      { label: "Chain data", to: "chain-data" },
      { label: "Files and metadata", to: "files" },
      { label: "Tools for an agent", to: "agents", kind: "cross" },
    ],
  },
  {
    id: "chain-data",
    title: "Live state or indexed history?",
    kind: "question",
    edges: [
      { label: "Read the chain", to: "rpc" },
      { label: "Query projects and activity", to: "bendystraw" },
    ],
  },
  {
    id: "files",
    title: "Have a CID already?",
    kind: "question",
    edges: [
      { label: "Yes, retrieve it", to: "ipfs" },
      { label: "No, publish content", to: "publishing" },
    ],
  },
  {
    id: "publishing",
    title: "Where are you publishing?",
    kind: "question",
    edges: [
      { label: "An approved browser app", to: "pinning" },
      { label: "An agent workflow", to: "agent-metadata" },
      { label: "Another integration", to: "upload-requirements" },
    ],
  },
  {
    id: "rpc",
    title: "Center read RPC",
    kind: "resource",
    content: "rpc",
    edges: [
      { label: "Prefer typed contract calls", to: "sdk", kind: "cross" },
      { label: "Need indexed history", to: "bendystraw" },
    ],
  },
  {
    id: "ipfs",
    title: "Center IPFS gateway",
    kind: "resource",
    content: "ipfs",
    edges: [
      {
        label: "Publish replacement content",
        to: "publishing",
        kind: "return",
      },
    ],
  },
  {
    id: "pinning",
    title: "Center IPFS pinning",
    kind: "resource",
    content: "pinning",
    note: "Approved browser origins required.",
    edges: [{ label: "Retrieve the published CID", to: "ipfs" }],
  },
  {
    id: "upload-requirements",
    title: "Check upload requirements",
    kind: "resource",
    links: [{ title: "Center API documentation", url: CENTER }],
    note: "Review allowed origins and upload limits.",
    edges: [
      { label: "Choose a publishing route", to: "publishing", kind: "return" },
    ],
  },
  {
    id: "agents",
    title: "Is your agent connected?",
    kind: "question",
    edges: [
      { label: "Connect it first", to: "agent-setup" },
      { label: "Already connected", to: "agent-work" },
    ],
  },
  {
    id: "agent-setup",
    title: "Connect the hosted MCP",
    kind: "resource",
    content: "mcp",
    links: [
      {
        title: "Connection instructions",
        url: `${SKILLS}#connect-the-hosted-mcp`,
      },
    ],
    edges: [{ label: "Add V6 guidance", to: "agent-instructions" }],
  },
  {
    id: "agent-instructions",
    title: "Juicebox V6 skills",
    kind: "resource",
    links: [{ title: "Get portable instructions", url: SKILLS }],
    edges: [{ label: "Choose a task", to: "agent-work" }],
  },
  {
    id: "agent-work",
    title: "What should the agent help with?",
    kind: "question",
    edges: [
      { label: "Read and research", to: "agent-read" },
      { label: "Prepare a transaction", to: "agent-prepare" },
      { label: "Publish metadata", to: "agent-metadata" },
      { label: "Build an integration", to: "sdk", kind: "cross" },
    ],
  },
  {
    id: "agent-read",
    title: "Read with the MCP",
    kind: "resource",
    links: [
      { title: "Find a tool", url: `${CENTER}/tree/main/mcp` },
      { title: "Follow a user journey", url: MCP_JOURNEYS },
    ],
    edges: [
      { label: "Inspect in an explorer", to: "juicescan", kind: "cross" },
      { label: "Choose another task", to: "agent-work", kind: "return" },
    ],
  },
  {
    id: "agent-prepare",
    title: "Prepare and review a transaction",
    kind: "resource",
    links: [{ title: "Follow the MCP workflow", url: MCP_JOURNEYS }],
    note: "Signing and submission stay with your wallet.",
    edges: [
      { label: "Inspect the result", to: "transaction-review" },
      { label: "Change the task", to: "agent-work", kind: "return" },
    ],
  },
  {
    id: "agent-metadata",
    title: "Publish reviewed metadata",
    kind: "resource",
    links: [{ title: "Follow the MCP workflow", url: MCP_JOURNEYS }],
    edges: [
      { label: "Retrieve the published CID", to: "ipfs" },
      { label: "Connect an agent", to: "agents", kind: "cross" },
      { label: "Choose another task", to: "agent-work", kind: "return" },
    ],
  },
  {
    id: "auditors",
    title: "What are you reviewing?",
    kind: "question",
    edges: [
      { label: "A transaction", to: "transaction-scope" },
      { label: "The protocol", to: "protocol-scope" },
    ],
  },
  {
    id: "transaction-scope",
    title: "What context do you need?",
    kind: "question",
    edges: [
      { label: "Project and chain state", to: "juicescan" },
      { label: "Permissions", to: "control-review" },
      { label: "Calldata and effects", to: "transaction-review" },
    ],
  },
  {
    id: "transaction-review",
    title: "Review before signing",
    kind: "resource",
    links: [
      { title: "Transaction audit guide", url: "https://juicebox.money/audit" },
      { title: "Agent review workflow", url: MCP_JOURNEYS },
    ],
    edges: [
      { label: "Check permissions", to: "control-review" },
      {
        label: "Revise the integration",
        to: "integration-layer",
        kind: "return",
      },
      {
        label: "Change the project action",
        to: "project-action",
        kind: "return",
      },
    ],
  },
  {
    id: "protocol-scope",
    title: "Where should the review start?",
    kind: "question",
    edges: [
      { label: "Define the review", to: "audit-plan" },
      { label: "Trace the system", to: "architecture" },
      { label: "Identify deployed code", to: "deployments" },
    ],
  },
  {
    id: "audit-plan",
    title: "Plan the protocol review",
    kind: "resource",
    links: [
      {
        title: "Read audit instructions",
        url: `${V6}/blob/main/AUDIT_INSTRUCTIONS.md`,
      },
    ],
    edges: [
      { label: "Map the components", to: "architecture" },
      { label: "Check assumptions", to: "risks-invariants" },
    ],
  },
  {
    id: "risks-invariants",
    title: "Assumptions and invariants",
    kind: "resource",
    links: [
      { title: "Read Risks", url: `${V6}/blob/main/RISKS.md` },
      { title: "Read Invariants", url: `${V6}/blob/main/INVARIANTS.md` },
    ],
    edges: [
      { label: "Inspect the implementation", to: "repository-index" },
      { label: "Recheck dependencies", to: "architecture", kind: "return" },
      {
        label: "Inspect privileged control",
        to: "control-review",
        kind: "cross",
      },
    ],
  },
  {
    id: "deployments",
    title: "Deployment artifacts",
    kind: "resource",
    links: [
      {
        title: "Find addresses and ABIs",
        url: "https://github.com/Bananapus/deploy-all-v6/tree/main/deployments",
      },
    ],
    edges: [
      { label: "Inspect the source", to: "repository-index" },
      { label: "Inspect a project", to: "juicescan", kind: "cross" },
    ],
  },
  {
    id: "repositories",
    title: "Source or deployed contracts?",
    kind: "question",
    edges: [
      { label: "Source code", to: "repository-purpose" },
      { label: "Addresses and ABIs", to: "deployments" },
    ],
  },
  {
    id: "repository-purpose",
    title: "What do you want from the source?",
    kind: "question",
    edges: [
      { label: "Find a package", to: "repository-index" },
      { label: "Understand the system", to: "architecture" },
      { label: "Start from a webclient", to: "webclients" },
    ],
  },
  {
    id: "repository-index",
    title: "All V6 repositories",
    kind: "resource",
    content: "repositories",
    links: [{ title: "Open the top-level repo", url: V6 }],
    edges: [
      { label: "Trace dependencies", to: "architecture", kind: "return" },
      {
        label: "Build with these contracts",
        to: "integration-layer",
        kind: "cross",
      },
      { label: "Plan a review", to: "auditors", kind: "cross" },
    ],
  },
  {
    id: "wip",
    title: "What would you like to explore?",
    kind: "question",
    note: "Work in progress. Not production recommendations.",
    edges: [
      { label: "User features", to: "wip-features" },
      { label: "Payment infrastructure", to: "wip-infrastructure" },
      { label: "Browse all WIP", to: "wip-index" },
    ],
  },
  {
    id: "wip-features",
    title: "Shops, locks, or messaging?",
    kind: "question",
    edges: [
      { label: "Shops and NFTs", to: "eth-shop" },
      { label: "Token locks and rewards", to: "sticky" },
      { label: "Project messaging", to: "jbchat" },
    ],
  },
  {
    id: "wip-infrastructure",
    title: "Payment rails or funded machines?",
    kind: "question",
    edges: [
      { label: "Card and bank payments", to: "jbprocessor" },
      { label: "Funded machines", to: "plugin" },
    ],
  },
  {
    id: "eth-shop",
    title: "eth.shop (WIP)",
    kind: "resource",
    links: [
      { title: "Open prototype", url: "https://eth.shop" },
      { title: "Source", url: "https://github.com/mejango/eth-shop" },
    ],
    edges: [{ label: "Take it further", to: "wip-next" }],
  },
  {
    id: "sticky",
    title: "Sticky (WIP)",
    kind: "resource",
    links: [
      { title: "Explore source", url: "https://github.com/mejango/jbsticky" },
    ],
    edges: [{ label: "Take it further", to: "wip-next" }],
  },
  {
    id: "jbchat",
    title: "JBChat (WIP)",
    kind: "resource",
    links: [
      { title: "Explore source", url: "https://github.com/mejango/jbchat" },
    ],
    note: "Production messaging is not enabled.",
    edges: [{ label: "Take it further", to: "wip-next" }],
  },
  {
    id: "jbprocessor",
    title: "JBProcessor (WIP)",
    kind: "resource",
    links: [
      {
        title: "Explore source",
        url: "https://github.com/mejango/jbprocessor",
      },
    ],
    note: "Live settlement and end-to-end onboarding remain unfinished.",
    edges: [{ label: "Take it further", to: "wip-next" }],
  },
  {
    id: "plugin",
    title: "Plugin (WIP)",
    kind: "resource",
    links: [
      { title: "Explore source", url: "https://github.com/mejango/plugin" },
    ],
    note: "Machine-launcher contracts are not configured.",
    edges: [{ label: "Take it further", to: "wip-next" }],
  },
  {
    id: "wip-index",
    title: "All WIP extensions",
    kind: "resource",
    content: "wip",
    edges: [{ label: "Take one further", to: "wip-next" }],
  },
  {
    id: "wip-next",
    title: "What next?",
    kind: "question",
    edges: [
      { label: "Build on it", to: "developers", kind: "cross" },
      { label: "Review its contracts", to: "auditors", kind: "cross" },
      { label: "Compare another idea", to: "wip", kind: "return" },
      { label: "Find a production app", to: "apps", kind: "cross" },
    ],
  },
];

export const journeyViews: readonly JourneyView[] = [
  {
    id: "apps",
    title: "Use Juicebox",
    entry: "apps",
    layout: [
      { node: "apps", column: 2, row: 1 },
      { node: "find-project", column: 1, row: 2 },
      { node: "learn", column: 2, row: 2 },
      { node: "observe", column: 3, row: 2 },
      { node: "project-action", column: 1, row: 3 },
      { node: "project-kind", column: 2, row: 3 },
      { node: "succulent", column: 3, row: 3 },
      { node: "juicebox-money", column: 1, row: 4 },
      { node: "revnet-money", column: 2, row: 4 },
      { node: "juicescan", column: 3, row: 4 },
      { node: "transaction-review", column: 2, row: 5 },
    ],
  },
  {
    id: "projects",
    title: "Launch or run a project",
    entry: "projects",
    layout: [
      { node: "projects", column: 2, row: 1 },
      { node: "control-model", column: 1, row: 2 },
      { node: "manage-project", column: 3, row: 2 },
      { node: "launch-project", column: 1, row: 3 },
      { node: "launch-revnet", column: 2, row: 3 },
      { node: "juicescan", column: 3, row: 3 },
      { node: "owner-journeys", column: 1, row: 4 },
      { node: "launch-checks", column: 2, row: 4 },
      { node: "control-review", column: 3, row: 4 },
      { node: "transaction-review", column: 2, row: 5 },
      { node: "deployments", column: 3, row: 5 },
    ],
  },
  {
    id: "developers",
    title: "Build an app",
    entry: "developers",
    layout: [
      { node: "developers", column: 2, row: 1 },
      { node: "webclient-start", column: 1, row: 2 },
      { node: "integration-layer", column: 3, row: 2 },
      { node: "webclients", column: 1, row: 3 },
      { node: "sdk", column: 2, row: 3 },
      { node: "architecture", column: 3, row: 3 },
      { node: "api", column: 1, row: 4 },
      { node: "bendystraw", column: 2, row: 4 },
      { node: "repository-index", column: 3, row: 4 },
      { node: "transaction-review", column: 2, row: 5 },
      { node: "risks-invariants", column: 3, row: 5 },
    ],
  },
  {
    id: "api",
    title: "Use an API",
    entry: "api",
    layout: [
      { node: "api", column: 2, row: 1 },
      { node: "chain-data", column: 1, row: 2 },
      { node: "files", column: 3, row: 2 },
      { node: "rpc", column: 1, row: 3 },
      { node: "bendystraw", column: 2, row: 3 },
      { node: "publishing", column: 3, row: 3 },
      { node: "agent-metadata", column: 1, row: 4 },
      { node: "pinning", column: 2, row: 4 },
      { node: "upload-requirements", column: 3, row: 4 },
      { node: "ipfs", column: 2, row: 5 },
    ],
  },
  {
    id: "agents",
    title: "Connect an AI agent",
    entry: "agents",
    layout: [
      { node: "agents", column: 2, row: 1 },
      { node: "agent-setup", column: 1, row: 2 },
      { node: "agent-instructions", column: 1, row: 3 },
      { node: "agent-work", column: 2, row: 3 },
      { node: "agent-read", column: 1, row: 4 },
      { node: "agent-prepare", column: 2, row: 4 },
      { node: "agent-metadata", column: 3, row: 4 },
      { node: "sdk", column: 1, row: 5 },
      { node: "transaction-review", column: 2, row: 5 },
      { node: "ipfs", column: 3, row: 5 },
    ],
  },
  {
    id: "auditors",
    title: "Audit or research",
    entry: "auditors",
    layout: [
      { node: "auditors", column: 2, row: 1 },
      { node: "transaction-scope", column: 1, row: 2 },
      { node: "protocol-scope", column: 3, row: 2 },
      { node: "juicescan", column: 1, row: 3 },
      { node: "control-review", column: 2, row: 3 },
      { node: "audit-plan", column: 3, row: 3 },
      { node: "transaction-review", column: 1, row: 4 },
      { node: "deployments", column: 2, row: 4 },
      { node: "architecture", column: 3, row: 4 },
      { node: "repository-index", column: 2, row: 5 },
      { node: "risks-invariants", column: 3, row: 5 },
    ],
  },
  {
    id: "repositories",
    title: "Browse repositories",
    entry: "repositories",
    layout: [
      { node: "repositories", column: 2, row: 1 },
      { node: "repository-purpose", column: 1, row: 2 },
      { node: "deployments", column: 3, row: 2 },
      { node: "webclients", column: 1, row: 3 },
      { node: "repository-index", column: 2, row: 3 },
      { node: "juicescan", column: 3, row: 3 },
      { node: "integration-layer", column: 1, row: 4 },
      { node: "architecture", column: 2, row: 4 },
      { node: "risks-invariants", column: 3, row: 4 },
      { node: "sdk", column: 1, row: 5 },
    ],
  },
  {
    id: "wip",
    title: "Explore WIP extensions",
    entry: "wip",
    layout: [
      { node: "wip", column: 2, row: 1 },
      { node: "wip-features", column: 1, row: 2 },
      { node: "wip-index", column: 2, row: 2 },
      { node: "wip-infrastructure", column: 3, row: 2 },
      { node: "eth-shop", column: 1, row: 3 },
      { node: "sticky", column: 2, row: 3 },
      { node: "jbprocessor", column: 3, row: 3 },
      { node: "jbchat", column: 1, row: 4 },
      { node: "plugin", column: 3, row: 4 },
      { node: "wip-next", column: 2, row: 5 },
    ],
  },
];

/** Fail during rendering/build checks if a directory edit leaves a broken route. */
export function validateJourneyGraph(
  nodes: readonly JourneyNode[] = journeyNodes,
  views: readonly JourneyView[] = journeyViews,
): void {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (!/^[a-z][a-z0-9-]*$/.test(node.id) || ids.has(node.id)) {
      throw new Error(`Invalid or duplicate journey node: ${node.id}`);
    }
    ids.add(node.id);
    if (!node.title.trim())
      throw new Error(`Untitled journey node: ${node.id}`);
    for (const link of node.links ?? []) {
      if (!link.title.trim() || new URL(link.url).protocol !== "https:") {
        throw new Error(`Invalid resource link: ${node.id}`);
      }
    }
  }
  for (const node of nodes) {
    for (const edge of node.edges) {
      if (!edge.label.trim() || !ids.has(edge.to)) {
        throw new Error(`Invalid journey edge: ${node.id} -> ${edge.to}`);
      }
    }
  }
  const viewIds = new Set<string>();
  const placed = new Set<string>();
  for (const view of views) {
    if (!/^[a-z][a-z0-9-]*$/.test(view.id) || viewIds.has(view.id))
      throw new Error(`Invalid or duplicate journey view: ${view.id}`);
    viewIds.add(view.id);
    const viewNodes = new Set<string>();
    const positions = new Set<string>();
    for (const cell of view.layout) {
      const position = `${cell.column}:${cell.row}`;
      if (
        !ids.has(cell.node) ||
        viewNodes.has(cell.node) ||
        positions.has(position) ||
        ![1, 2, 3].includes(cell.column) ||
        !Number.isInteger(cell.row) ||
        cell.row < 1
      ) {
        throw new Error(`Invalid journey placement: ${view.id}/${cell.node}`);
      }
      viewNodes.add(cell.node);
      positions.add(position);
      placed.add(cell.node);
    }
    if (!viewNodes.has(view.entry))
      throw new Error(`Missing journey entry: ${view.id}`);
  }
  for (const id of ids) {
    if (!placed.has(id)) throw new Error(`Journey node has no view: ${id}`);
  }
}

validateJourneyGraph();
