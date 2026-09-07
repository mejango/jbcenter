/** Shared decisions and resources. A view shows one route through this graph. */
export interface JourneyEdge {
  to: string;
  kind?: "return" | "cross";
}

export interface JourneyNode {
  id: string;
  title: string;
  prompt?: string;
  /** Stable destination when this node is reached from another map. */
  homeView?: string;
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
    title: "Use Juicebox",
    prompt: "What brings you here?",
    homeView: "apps",
    kind: "question",
    edges: [
      { to: "find-project" },
      { to: "observe" },
      { to: "learn" },
      { to: "projects", kind: "cross" },
    ],
  },
  {
    id: "find-project",
    title: "Use a project",
    prompt: "Choose an app, or review other actions?",
    kind: "question",
    edges: [{ to: "project-action" }, { to: "project-kind" }],
  },
  {
    id: "project-action",
    title: "Choose a project action",
    prompt: "Pay, cash out, review a transaction, or manage a project?",
    kind: "question",
    edges: [
      { to: "project-kind" },
      { to: "transaction-review" },
      { to: "projects", kind: "cross" },
    ],
  },
  {
    id: "project-kind",
    title: "Choose a project app",
    prompt: "Which app do you need?",
    kind: "question",
    edges: [
      { to: "juicebox-money" },
      { to: "revnet-money" },
      { to: "learn", kind: "return" },
    ],
  },
  {
    id: "observe",
    title: "Explore",
    prompt: "Follow activity, inspect contracts, or find a project?",
    kind: "question",
    edges: [{ to: "succulent" }, { to: "juicescan" }, { to: "project-kind" }],
  },
  {
    id: "learn",
    title: "Learn Juicebox",
    kind: "resource",
    links: [{ title: "Open the guide", url: "https://juicebox.money/learn" }],
    edges: [{ to: "apps", kind: "return" }],
  },
  {
    id: "juicebox-money",
    title: "Juicebox Money",
    kind: "resource",
    links: [
      { title: "Open app", url: "https://juicebox.money" },
      { title: "Source", url: "https://github.com/mejango/juicebox-money" },
    ],
    edges: [{ to: "transaction-review" }, { to: "developers", kind: "cross" }],
  },
  {
    id: "revnet-money",
    title: "Revnet Money",
    kind: "resource",
    links: [
      { title: "Open app", url: "https://revnet.money" },
      { title: "Source", url: "https://github.com/mejango/revnet-money" },
    ],
    edges: [{ to: "transaction-review" }, { to: "projects", kind: "cross" }],
  },
  {
    id: "succulent",
    title: "Succulent activity feed",
    kind: "resource",
    links: [
      { title: "Open activity feed", url: "https://succulent.money" },
      { title: "Source", url: "https://github.com/mejango/succulent" },
    ],
    edges: [{ to: "project-action", kind: "return" }],
  },
  {
    id: "juicescan",
    title: "Juicescan explorer",
    homeView: "apps",
    kind: "resource",
    links: [
      { title: "Open explorer", url: JUICESCAN },
      { title: "Source", url: "https://github.com/mejango/juicescan" },
    ],
    edges: [
      {
        to: "project-action",
        kind: "return",
      },
      { to: "control-review", kind: "cross" },
    ],
  },
  {
    id: "projects",
    title: "Launch or run a project",
    prompt: "New or existing project?",
    homeView: "projects",
    kind: "question",
    edges: [{ to: "control-model" }, { to: "manage-project" }],
  },
  {
    id: "control-model",
    title: "Choose project rules",
    prompt: "Owner-managed projects or precommitted revnet economics?",
    kind: "question",
    edges: [
      { to: "launch-project" },
      { to: "launch-revnet" },
      { to: "owner-journeys" },
    ],
  },
  {
    id: "manage-project",
    title: "Manage a project",
    prompt: "Configuration, permissions, or a custom integration?",
    kind: "question",
    edges: [
      { to: "juicescan" },
      { to: "control-review" },
      { to: "developers", kind: "cross" },
    ],
  },
  {
    id: "launch-project",
    title: "Create an owner-managed project",
    kind: "resource",
    links: [
      { title: "Open project builder", url: "https://juicebox.money/create" },
    ],
    edges: [{ to: "launch-checks" }],
  },
  {
    id: "launch-revnet",
    title: "Create a revnet",
    kind: "resource",
    links: [
      { title: "Open revnet builder", url: "https://revnet.money/create" },
    ],
    edges: [{ to: "launch-checks" }],
  },
  {
    id: "launch-checks",
    title: "Check project setup",
    prompt: "Rules, permissions, transactions, or deployments?",
    kind: "question",
    edges: [
      { to: "owner-journeys" },
      { to: "control-review" },
      { to: "transaction-review" },
      { to: "deployments" },
      { to: "control-model", kind: "return" },
    ],
  },
  {
    id: "owner-journeys",
    title: "Project owner journeys",
    kind: "resource",
    links: [
      { title: "Read V6 workflows", url: `${V6}/blob/main/USER_JOURNEYS.md` },
    ],
    edges: [{ to: "control-model", kind: "return" }],
  },
  {
    id: "control-review",
    title: "Permissions and control",
    homeView: "auditors",
    kind: "resource",
    links: [
      {
        title: "Read Administration",
        url: `${V6}/blob/main/ADMINISTRATION.md`,
      },
    ],
    edges: [
      { to: "transaction-review" },
      { to: "launch-checks", kind: "return" },
    ],
  },
  {
    id: "developers",
    title: "Build an app",
    prompt: "Interface, integration, or agent workflow?",
    homeView: "developers",
    kind: "question",
    edges: [
      { to: "webclient-start" },
      { to: "integration-layer" },
      { to: "agents", kind: "cross" },
    ],
  },
  {
    id: "webclient-start",
    title: "Build a webclient",
    prompt: "Start from an app, the design, or contract calls?",
    kind: "question",
    edges: [
      { to: "webclients" },
      { to: "architecture" },
      { to: "integration-layer" },
    ],
  },
  {
    id: "integration-layer",
    title: "Build an integration",
    prompt: "Contract calls, indexed data, custom behavior, or shared APIs?",
    homeView: "developers",
    kind: "question",
    edges: [
      { to: "sdk" },
      { to: "bendystraw" },
      { to: "architecture" },
      { to: "api", kind: "cross" },
    ],
  },
  {
    id: "webclients",
    title: "Start from a webclient",
    homeView: "developers",
    kind: "resource",
    content: "webclients",
    edges: [
      { to: "sdk" },
      { to: "api", kind: "cross" },
      { to: "webclient-start", kind: "return" },
    ],
  },
  {
    id: "sdk",
    title: "Juice SDK V6",
    homeView: "developers",
    kind: "resource",
    links: [
      {
        title: "Read V6 actions",
        url: "https://github.com/Bananapus/juice-sdk-v4#v6-actions-bananapusnana-sdk-corev6",
      },
    ],
    edges: [{ to: "transaction-review" }, { to: "rpc", kind: "cross" }],
  },
  {
    id: "bendystraw",
    title: "Bendystraw project data",
    homeView: "api",
    kind: "resource",
    links: [
      { title: "Explore GraphQL schema", url: "https://bendystraw.xyz/schema" },
      { title: "Source", url: "https://github.com/peripheralist/bendystraw" },
    ],
    note: "API key required. Scope queries to V6.",
    edges: [{ to: "rpc", kind: "cross" }, { to: "sdk" }],
  },
  {
    id: "architecture",
    title: "V6 architecture",
    homeView: "auditors",
    kind: "resource",
    links: [
      { title: "Trace the system", url: `${V6}/blob/main/ARCHITECTURE.md` },
      { title: "Build guide", url: "https://juicebox.money/build" },
    ],
    edges: [
      { to: "repository-index" },
      { to: "risks-invariants" },
      {
        to: "integration-layer",
        kind: "return",
      },
    ],
  },
  {
    id: "api",
    title: "Use an API",
    prompt: "Protocol access, chain data, files, or an agent?",
    homeView: "api",
    kind: "question",
    edges: [
      { to: "rest-api" },
      { to: "chain-data" },
      { to: "files" },
      { to: "agents", kind: "cross" },
    ],
  },
  {
    id: "rest-api",
    title: "Center REST API",
    homeView: "api",
    kind: "resource",
    links: [
      { title: "Read the API", url: "https://juicebox.center/api" },
      { title: "Create a bot", url: "https://juicebox.center/accounts" },
      { title: "OpenAPI specification", url: "https://juicebox.center/api/v1/openapi.json" },
    ],
    note: "V6 reads, transaction plans, and wallet-signed relay.",
    edges: [{ to: "transaction-review", kind: "cross" }],
  },
  {
    id: "chain-data",
    title: "Read chain data",
    prompt: "Live state or indexed history?",
    kind: "question",
    edges: [{ to: "rpc" }, { to: "bendystraw" }],
  },
  {
    id: "files",
    title: "Files and metadata",
    prompt: "Retrieve an existing CID or publish something new?",
    kind: "question",
    edges: [{ to: "ipfs" }, { to: "publishing" }],
  },
  {
    id: "publishing",
    title: "Publish content",
    prompt: "Approved app, agent, or another integration?",
    kind: "question",
    edges: [
      { to: "pinning" },
      { to: "agent-metadata" },
      { to: "upload-requirements" },
    ],
  },
  {
    id: "rpc",
    title: "Center read RPC",
    homeView: "api",
    kind: "resource",
    content: "rpc",
    edges: [{ to: "sdk", kind: "cross" }, { to: "bendystraw" }],
  },
  {
    id: "ipfs",
    title: "Center IPFS gateway",
    homeView: "api",
    kind: "resource",
    content: "ipfs",
    edges: [
      {
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
    edges: [{ to: "ipfs" }],
  },
  {
    id: "upload-requirements",
    title: "Check upload requirements",
    kind: "resource",
    links: [{ title: "Center API documentation", url: CENTER }],
    note: "Review allowed origins and upload limits.",
    edges: [{ to: "publishing", kind: "return" }],
  },
  {
    id: "agents",
    title: "Connect an AI agent",
    prompt: "Need setup, or ready to choose a task?",
    homeView: "agents",
    kind: "question",
    edges: [{ to: "agent-setup" }, { to: "agent-work" }],
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
    edges: [{ to: "agent-instructions" }],
  },
  {
    id: "agent-instructions",
    title: "Juicebox V6 skills",
    kind: "resource",
    links: [{ title: "Get portable instructions", url: SKILLS }],
    edges: [{ to: "agent-work" }],
  },
  {
    id: "agent-work",
    title: "Choose an agent task",
    prompt: "Research, transactions, metadata, or code?",
    kind: "question",
    edges: [
      { to: "agent-read" },
      { to: "agent-prepare" },
      { to: "agent-metadata" },
      { to: "sdk", kind: "cross" },
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
      { to: "juicescan", kind: "cross" },
      { to: "agent-work", kind: "return" },
    ],
  },
  {
    id: "agent-prepare",
    title: "Prepare and review a transaction",
    kind: "resource",
    links: [{ title: "Follow the MCP workflow", url: MCP_JOURNEYS }],
    note: "Signing and submission stay with your wallet.",
    edges: [{ to: "transaction-review" }, { to: "agent-work", kind: "return" }],
  },
  {
    id: "agent-metadata",
    title: "Publish reviewed metadata",
    homeView: "agents",
    kind: "resource",
    links: [{ title: "Follow the MCP workflow", url: MCP_JOURNEYS }],
    edges: [
      { to: "ipfs" },
      { to: "agents", kind: "cross" },
      { to: "agent-work", kind: "return" },
    ],
  },
  {
    id: "auditors",
    title: "Audit or research",
    prompt: "A transaction or the protocol?",
    homeView: "auditors",
    kind: "question",
    edges: [{ to: "transaction-scope" }, { to: "protocol-scope" }],
  },
  {
    id: "transaction-scope",
    title: "Review a transaction",
    prompt: "Inspect state, permissions, or calldata?",
    kind: "question",
    edges: [
      { to: "juicescan" },
      { to: "control-review" },
      { to: "transaction-review" },
    ],
  },
  {
    id: "transaction-review",
    title: "Review before signing",
    homeView: "auditors",
    kind: "resource",
    links: [
      { title: "Transaction audit guide", url: "https://juicebox.money/audit" },
      { title: "Agent review workflow", url: MCP_JOURNEYS },
    ],
    edges: [
      { to: "control-review" },
      {
        to: "integration-layer",
        kind: "return",
      },
      {
        to: "project-action",
        kind: "return",
      },
    ],
  },
  {
    id: "protocol-scope",
    title: "Review the protocol",
    prompt: "Set the scope, trace dependencies, or inspect deployments?",
    kind: "question",
    edges: [
      { to: "audit-plan" },
      { to: "architecture" },
      { to: "deployments" },
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
    edges: [{ to: "architecture" }, { to: "risks-invariants" }],
  },
  {
    id: "risks-invariants",
    title: "Assumptions and invariants",
    homeView: "auditors",
    kind: "resource",
    links: [
      { title: "Read Risks", url: `${V6}/blob/main/RISKS.md` },
      { title: "Read Invariants", url: `${V6}/blob/main/INVARIANTS.md` },
    ],
    edges: [
      { to: "repository-index" },
      { to: "architecture", kind: "return" },
      {
        to: "control-review",
        kind: "cross",
      },
    ],
  },
  {
    id: "deployments",
    title: "Deployment artifacts",
    homeView: "repositories",
    kind: "resource",
    links: [
      {
        title: "Find addresses and ABIs",
        url: "https://github.com/Bananapus/deploy-all-v6/tree/main/deployments",
      },
    ],
    edges: [{ to: "repository-index" }, { to: "juicescan", kind: "cross" }],
  },
  {
    id: "repositories",
    title: "Browse repositories",
    prompt: "Source or deployed contracts?",
    homeView: "repositories",
    kind: "question",
    edges: [{ to: "repository-purpose" }, { to: "deployments" }],
  },
  {
    id: "repository-purpose",
    title: "Explore the source",
    prompt: "Find a package, trace the system, or start from an app?",
    kind: "question",
    edges: [
      { to: "repository-index" },
      { to: "architecture" },
      { to: "webclients" },
    ],
  },
  {
    id: "repository-index",
    title: "All V6 repositories",
    homeView: "repositories",
    kind: "resource",
    content: "repositories",
    links: [{ title: "Open the top-level repo", url: V6 }],
    edges: [
      { to: "architecture", kind: "return" },
      {
        to: "integration-layer",
        kind: "cross",
      },
      { to: "auditors", kind: "cross" },
    ],
  },
  {
    id: "wip",
    title: "Explore WIP extensions",
    prompt: "User features or payment infrastructure?",
    homeView: "wip",
    kind: "question",
    note: "Work in progress. Not production recommendations.",
    edges: [
      { to: "wip-features" },
      { to: "wip-infrastructure" },
      { to: "wip-index" },
    ],
  },
  {
    id: "wip-features",
    title: "User features (WIP)",
    prompt: "Shops, locks, or messaging?",
    kind: "question",
    edges: [{ to: "eth-shop" }, { to: "sticky" }, { to: "jbchat" }],
  },
  {
    id: "wip-infrastructure",
    title: "Payment infrastructure (WIP)",
    prompt: "Payment rails or funded machines?",
    kind: "question",
    edges: [{ to: "jbprocessor" }, { to: "plugin" }],
  },
  {
    id: "eth-shop",
    title: "eth.shop (WIP)",
    kind: "resource",
    links: [
      { title: "Open prototype", url: "https://eth.shop" },
      { title: "Source", url: "https://github.com/mejango/eth-shop" },
    ],
    edges: [{ to: "wip-next" }],
  },
  {
    id: "sticky",
    title: "Sticky (WIP)",
    kind: "resource",
    links: [
      { title: "Explore source", url: "https://github.com/mejango/jbsticky" },
    ],
    edges: [{ to: "wip-next" }],
  },
  {
    id: "jbchat",
    title: "JBChat (WIP)",
    kind: "resource",
    links: [
      { title: "Explore source", url: "https://github.com/mejango/jbchat" },
    ],
    note: "Production messaging is not enabled.",
    edges: [{ to: "wip-next" }],
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
    edges: [{ to: "wip-next" }],
  },
  {
    id: "plugin",
    title: "Plugin (WIP)",
    kind: "resource",
    links: [
      { title: "Explore source", url: "https://github.com/mejango/plugin" },
    ],
    note: "Machine-launcher contracts are not configured.",
    edges: [{ to: "wip-next" }],
  },
  {
    id: "wip-index",
    title: "All WIP extensions",
    kind: "resource",
    content: "wip",
    edges: [{ to: "wip-next" }],
  },
  {
    id: "wip-next",
    title: "Develop or review an extension",
    prompt: "Build, review, compare, or use a production app?",
    kind: "question",
    edges: [
      { to: "developers", kind: "cross" },
      { to: "auditors", kind: "cross" },
      { to: "wip", kind: "return" },
      { to: "apps", kind: "cross" },
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
      { node: "rest-api", column: 2, row: 2 },
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
    if (node.prompt !== undefined && !node.prompt.trim()) {
      throw new Error(`Empty journey prompt: ${node.id}`);
    }
    for (const link of node.links ?? []) {
      if (!link.title.trim() || new URL(link.url).protocol !== "https:") {
        throw new Error(`Invalid resource link: ${node.id}`);
      }
    }
  }
  for (const node of nodes) {
    for (const edge of node.edges) {
      if (!ids.has(edge.to)) {
        throw new Error(`Invalid journey edge: ${node.id} -> ${edge.to}`);
      }
    }
  }

  // Every sequence of questions must reach a usable resource before it can
  // return to an earlier decision. Finding one possible exit is insufficient:
  // a question cycle could still keep someone circling past that exit.
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const resolved = new Set<string>();
  const visiting = new Set<string>();
  function resolveQuestion(id: string, path: readonly string[]): void {
    if (resolved.has(id)) return;
    const node = nodesById.get(id)!;
    if (node.kind === "resource") {
      if (!node.links?.length && !node.content) {
        throw new Error(`Journey resource has no destination: ${id}`);
      }
      resolved.add(id);
      return;
    }
    if (visiting.has(id)) {
      throw new Error(
        `Unresolving question cycle: ${[...path, id].join(" -> ")}`,
      );
    }
    if (!node.edges.length) {
      throw new Error(`Journey question has no destination: ${id}`);
    }
    visiting.add(id);
    for (const edge of node.edges) resolveQuestion(edge.to, [...path, id]);
    visiting.delete(id);
    resolved.add(id);
  }
  for (const node of nodes) resolveQuestion(node.id, []);

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
  for (const node of nodes) {
    const containingViews = views.filter((view) =>
      view.layout.some((cell) => cell.node === node.id),
    );
    if (containingViews.length > 1 && node.homeView === undefined) {
      throw new Error(`Shared journey node needs a home view: ${node.id}`);
    }
    if (
      node.homeView !== undefined &&
      !containingViews.some((view) => view.id === node.homeView)
    ) {
      throw new Error(`Invalid journey home view: ${node.id}/${node.homeView}`);
    }
  }
}

validateJourneyGraph();
