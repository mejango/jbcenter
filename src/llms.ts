import { journeyNodes } from "./journeyGraph.js";

/** Index the existing resources; capabilities remain a live, separate document. */
export function llmsIndex(audience = "https://juicebox.center"): string {
  const origin = new URL(audience).origin;
  const explorer = journeyNodes.find((node) => node.id === "juicescan")!.links![0]!.url;
  return `# Juicebox Center

> Find, learn, build, and inspect Juicebox V6 projects. Public discovery and MCP
> reads need no wallet. Protected REST requests and wallet execution are separate.

## Learn, build, inspect

- [Understand a payment](https://juicebox.money/learn#learn-before-you-pay): terms, tokens, routes, and fees.
- [Read a project and try a test payment](https://juicebox.money/build/first-payment): a wallet-free read followed by a reviewed testnet payment and verification.
- [Learn revnets](https://revnet.money/learn): committed schedules, three prices, and remaining operator powers.
- [Build with revnets](https://revnet.money/build): model terms, prepare a draft, and integrate V6.
- [Inspect in Juicescan](${explorer}): current project state, contracts, and transaction tools.
- [Inspect the tutorial project](${origin}/inspect/basesep/1): a stable link to Base Sepolia project 1 in the directory's current explorer deployment.
- [Directory](${origin}/): choose an app, integration, or source repository.

## APIs and agents

- [Choose a journey](${origin}/api/docs/user-journeys): prerequisites, evidence, and execution limits.
- [Quickstart](${origin}/api/docs/quickstart): public discovery, MCP, and protected REST access.
- [API explorer](${origin}/api): read, prepare, review, sign, and reconcile.
- [OpenAPI](${origin}/api/v1/openapi.json): current HTTP schemas.
- [Live capabilities](${origin}/api/v1/capabilities): check availability on the chosen chain before planning.
- [Agent guide](${origin}/api/docs/ai-guide): exact transaction review and recovery.
- [Transaction lifecycle](${origin}/api/docs/transactions): pending, failed, and partially completed operations.
- [Authentication](${origin}/api/docs/authentication): signed requests and bot API grants.
- [Juicebox V6 skills](https://github.com/mejango/juicebox-skills): portable protocol and integration guidance.
- [MCP connection guide](https://github.com/mejango/jbcenter/blob/main/mcp/README.md): connect a compatible client to ${origin}/mcp without REST enrollment.

## Evidence and authority

Use chain ID plus project ID to identify a project. Keep protocol version 6 explicit.
Resolve current contracts and re-read transaction dependencies before signing.
Amounts use exact integers in their token's units. Indexed history is not a canonical
block snapshot. Unknown reads are not zero or permission.

A bot API grant does not authorize spending wallet funds. Plans are unsigned;
wallet execution requires its own approval. Configured, simulated, submitted, and
canonically verified are different states. A Safe proposal is not execution, and a
source-chain receipt does not prove destination settlement. Reconcile an uncertain
operation by its existing identifiers before retrying. Read live capabilities for
current session and sponsorship support instead of assuming it from this index.
`;
}
