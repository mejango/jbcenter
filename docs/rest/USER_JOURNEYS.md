# Find the shortest supported path

Find an app in the directory, connect an assistant, or build with Center's API.
An **API** lets software request data or actions from a service. Assistants use
Center's tools through **MCP** (Model Context Protocol); other integrations can
use its web request interface, **REST**.

For a transaction, a **plan** stores the exact calls for review. **Relay** means
submitting transactions the wallet has signed. Choose only the setup the task
needs: browsing and MCP do not require an API account or bot. Keep the user's
V6 project, network, wallet, asset, and amount explicit. See the
[glossary](https://juicebox.center/api#glossary) as technical terms arise.

## What is ready

This review records the September 7, 2026 release state. **Implemented** means
the documented path exists and has local checks; it does not mean a live wallet
has completed it. **Configured** means the production service enables it.
**Live-checked** identifies the narrower observations made against production.
Always read [capabilities](https://juicebox.center/api/v1/capabilities) for current
availability before preparing an action.

- Directory, API discovery, authenticated-route boundaries, and the 56-tool MCP
  catalog were live-checked. This checks availability, not every tool invocation
  or economic outcome.
- Sponsored Safe-owner execution is configured on Ethereum (`1`), Optimism
  (`10`), Base (`8453`), and Arbitrum (`42161`). Provider quotes, gas estimates,
  sponsor signatures, and the deployed sponsor contract's identity were live-checked.
- A real owner-signed sponsored V6 transaction and its verified outcome on each
  of those chains remain pending. Unsigned probes do not establish completion.
- Recurring bot execution is implemented but inactive. It needs the matching
  deployed guard and owner-approved activation. It is optional for production
  owner execution. [Operations](./EXECUTION_OPERATIONS.md) records the checks.

## Journeys and approvals

| User goal | Shortest supported path | Necessary approval or prerequisite | Status and completion boundary |
| --- | --- | --- | --- |
| Find an app, fund a project, or cash out | [Directory](https://juicebox.center) → Use Juicebox → chosen app. Use a known app link directly. | No Center account. The app obtains wallet approval for its transaction. | Directory live-checked. The destination app owns execution and version selection. |
| Learn, inspect code, or audit | Directory → Audit or research → V6 source, deployed addresses, permissions, and documented guarantees. Assistants can use MCP source tools. | No wallet approval. Verify the deployed code before applying what the source says. | References implemented; source alone is not an audit or proof of what is deployed. |
| Launch a project, NFT project, or revnet | Use the matching app builder, or its MCP launch planner with complete terms and a link to the project description. | Review the economics and each wallet transaction. Publishing the description is a separate action. | Supported core, 721, and revnet preparations; the chosen wallet or app handles execution. |
| Manage a project, shop, or revnet position | Read current settings and permissions → prepare the change → approve it in the wallet → verify the result. | Fresh approval for the exact action. Required earlier steps must be confirmed. Permissions belong to the wallet that acts. | [MCP journeys](https://github.com/mejango/jbcenter/blob/main/mcp/docs/USER_JOURNEYS.md) lists supported settings, payouts, routing, NFT tiers, token issuance, loans, and repayments; REST also exposes cataloged V6 contract methods. |
| Explore unfinished tools | Directory → Explore unfinished tools → source or clearly labeled prototype. | No production setup implied. | eth.shop, Sticky, JBChat, JBProcessor, and Plugin are unfinished; they are excluded from the V6 protocol REST inventory. |
| Discover the REST interface | [API explorer](https://juicebox.center/api) → operation/schema and source → [quickstart](./QUICKSTART.md) only when protected access is needed. | None for OpenAPI, capabilities, or catalogs. | Public discovery live-checked. A catalog entry alone does not establish a deployed target. |
| Automate protected reads or plan preparation | Create an API account → generate or bring a local bot key → owner registers it → bot signs requests. | The owner signs once per setup. The bot's API permissions (its **grant**) have enforced scopes and expiry. | Implemented. Bot reads and plans need no recurring wallet prompts; a grant gives no onchain spending authority. |
| Replace or revoke a bot | Register a replacement key if needed → revoke the old grant on `/accounts`. Keep old plan IDs to check pending results. | Fresh owner-signed grant change. Never upload a private key. | Implemented. A replacement grant cannot take over the old grant's execution plans. Already admitted work may finish; revocation does not undo onchain authority. |
| Read a project now | `GET /projects/{chainId}/{projectId}?source=onchain`, or `/protocol/read` for an exact method. | Signed REST request; a registered read bot can sign automatically. | Implemented with evidence from a block in the accepted chain (**canonical**). Failed reads remain unknown. |
| Search projects, activity, or history | Use Bendystraw, an **indexer** that organizes chain records: project `source=bendystraw`, or cataloged `/indexer/{entity}` with an explicit network. | Signed REST request. No personal Bendystraw key is needed through Center. | Implemented. Follow page cursors; indexed values and USD estimates are not transaction quotes. |
| Execute from an ordinary wallet | Prepare and simulate a REST plan → wallet signs each exact transaction → relay → refresh plan. | Fresh owner-signed submission request, or bot request plus exact owner approval; wallet transaction signature is also required. | Implemented. These transaction signatures lack timestamps, so fresh submission approval remains necessary. No smart wallet is required. |
| Execute with sponsored gas | Create or reuse a supported smart wallet → bind it once → prepare its action plan and UserOperation → sign returned `SafeOp` → submit once → reconcile. | Current Safe-owner threshold signs the validity-bound operation. API request authentication is separate. Creating a wallet currently costs owner gas. | Four chains configured and provider probes live-checked; real signed V6 execution remains pending. No session guard or bot required. |
| Execute several steps | Keep one durable plan. For direct relay, confirm prerequisites and resume remaining steps. A Safe can batch eligible calls on one chain. | Exact owner approval for each direct step or the selected Safe batch; never approve unknown future calls. | Implemented. Multi-call Safe invocation can be verified, but modeled per-call economics currently remain unknown. Use one operation per modeled step when downstream work requires verified outcomes. |
| Use prepaid cross-chain relay | Only when capabilities enable Relayr: plan → prepare wave → sign exact forward requests → publish → review/fund quote once → reconcile each chain. | Fresh owner authorization, each forward signature, and a separately approved funding transaction. | Implemented; availability is capability-dependent. At most one independent call per chain and four calls per wave. This is prepaid relay, not free gas or atomic settlement. |
| Follow a project across chains | Start with one known V6 project → `/projects/{chainId}/{projectId}/omnichain` with the chosen source → inspect each chain's evidence. | A bot-signed read. Claiming funds sent across a bridge needs its proof and a separate wallet-approved transaction. | Implemented. Chain IDs/project IDs may differ; partial reads stay visible. Source confirmation, destination claim, credit to the project's payment contract, and final settlement remain distinct. |
| Let a bot repeat payments from a budget | Optional: fund an isolated smart wallet → approve the exact bounded onchain permission → bot executes within it. | Fresh owner approval of funding, finite allowances, policy installation, and changes. | Inactive pending guard deployment and activation. An allocation record does not set aside or escrow actual funds. Seven/thirty-day durations are implemented choices, not API requirements. |
| Ask an AI agent to research or prepare | Connect to `https://juicebox.center/mcp` → relevant tool → inspect the result. Add portable Juicebox skills when useful. | No REST enrollment. Wallet actions and public metadata publication require their respective approvals. | Transport and 56-tool catalog live-checked. MCP plans are unsigned and its tokens are not REST plan IDs. Any compatible MCP agent can connect. |
| Publish a project description (**metadata**) | MCP `jb_prepare_project_metadata` → review exact JSON → `jb_pin_project_metadata` → use the returned link in the launch planner. | Explicit approval to publish. No wallet needed for publication. | Implemented for standard new metadata. Upload logos separately and supply an existing link. Publishing a file does not launch or update a project. |
| Read or publish files through IPFS | **IPFS** shares files by content; a **CID** identifies the content. Read with public `GET /ipfs/{cid}`; approved apps publish with `/v1/pins/json`, `/file`, or `/media`. | No REST account for reads. Writes retain approved-origin and quota requirements; content becomes public. | Existing shared services. Queuing another stored copy (**pin**) does not prove it is available. [Limits](https://github.com/mejango/jbcenter#pin-and-read-ipfs-content). |
| Read raw chain data | **RPC** is the request interface to a blockchain node. Send one read-only JSON-RPC request to public `POST /v1/rpc/{chainId}`. | No REST account; read-method and request budgets apply. | Existing shared gateway. It does not sign or broadcast transactions. [RPC reference](https://github.com/mejango/jbcenter#read-ethereum-rpc). |
| Build a client or add protocol coverage | Choose REST schemas or V6 SDK actions → use current source examples from Juicebox Money, Revnet Money, or Juicescan → implement and test the feature. | Wallet approval only for resulting execution; no approval needed to inspect reference code. | Source-backed MCP integration plans and REST method catalogs implemented. Experimental apps and unsupported semantic adapters remain explicit. |

## Keep the path short without losing evidence

- Ask for `onchain` versus `bendystraw` only where both serve the requested data.
  A client can remember the user's preference. Do not query both unless comparing
  them or resolving a real discrepancy. Preparation always checks onchain state.
- Reuse an existing account, selected source, wallet link, or plan when still
  valid. Do not repeat enrollment, create a new smart wallet, or require sessions
  for an ordinary transaction. Keep the same API owner or bot through submission.
- Show one concrete review of the exact calls, amounts, recipients, fees, and
  validity before the necessary signatures. API authentication, transaction
  authority, and publication approval protect different actions.
- Check an uncertain submission against chain evidence before offering another transaction. Keep
  its existing hash, operation ID, and idempotency key. A pending result is not an
  instruction to pay again, change transport, or repeat publication.
- A directory decision must reach a usable resource. Return links are optional
  after a resource; questions cannot loop indefinitely. The shared graph
  validator and navigation checks enforce this across views.
