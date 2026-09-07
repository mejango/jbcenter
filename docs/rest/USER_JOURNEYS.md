# Find the shortest supported path

Use the directory for an app, MCP for an assistant, and REST for an integration
that needs authenticated reads, durable plans, or relay. Keep the user's V6
project, chain, account, asset, and amount explicit. Collect only the inputs
needed by the selected operation. Accounts, bots, and smart wallets are separate
choices; browsing and MCP use do not require all three.

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
  sponsor signatures, and deployed paymaster identity were live-checked.
- A real owner-signed sponsored V6 transaction and its verified outcome on each
  of those chains remain pending. Unsigned probes do not establish completion.
- Recurring bot execution is implemented but inactive. It needs the matching
  deployed guard and owner-approved activation. It is optional for production
  owner execution. [Operations](./EXECUTION_OPERATIONS.md) records the checks.

## Journeys and approvals

| User goal | Shortest supported path | Necessary approval or prerequisite | Status and completion boundary |
| --- | --- | --- | --- |
| Find an app, fund a project, or cash out | [Directory](https://juicebox.center) → Use Juicebox → chosen webclient. Use a known app link directly. | No Center account. The app obtains wallet approval for its transaction. | Directory live-checked. The destination app owns execution and version selection. |
| Learn, inspect contracts, or audit | Directory → Audit or research, or MCP source/ABI tools → exact V6 source, deployment, permissions, and invariant references. | No wallet approval. Verify deployment identity before treating source behavior as live behavior. | References implemented; code availability is not an audit or proof of deployed equivalence. |
| Launch a project, NFT project, or revnet | Use the matching webclient builder, or its MCP launch planner with complete terms and a metadata URI. | Review exact economics and each wallet transaction. Metadata publication is separate. | Supported core, 721, and revnet preparations; execution remains with the chosen wallet/client. |
| Operate a project, shop, routing hook, or revnet position | Read the selected project's state/rights → relevant ruleset, payout, buyback, router, tier, auto-issuance, loan, or repayment planner → wallet → verification. | Fresh approval for the exact action and confirmed prerequisites. Authority belongs to the actual caller. | [MCP journeys](https://github.com/mejango/jbcenter/blob/main/mcp/docs/USER_JOURNEYS.md) specify each adapter's coverage; REST also exposes cataloged V6 ABI methods. |
| Explore WIP products | Directory → WIP extensions → source or clearly labeled prototype. | No production setup implied. | eth.shop, Sticky, JBChat, JBProcessor, and Plugin stay WIP; they are excluded from the V6 protocol REST inventory. |
| Discover the REST interface | [API explorer](https://juicebox.center/api) → operation/schema and source → [quickstart](./QUICKSTART.md) only when protected access is needed. | None for OpenAPI, capabilities, or catalogs. | Public discovery live-checked. A catalog entry alone does not establish a deployed target. |
| Automate protected reads or plan preparation | Enroll owner once → generate or bring a local bot key → owner registers the public proof → bot signs requests. | Owner enrollment and grant signatures once per setup. Bot scope and expiry remain enforced. | Implemented. No recurring wallet prompts for bot reads/plans; no onchain spending authority from the grant. |
| Replace or revoke a bot | Register a replacement key if needed → revoke the old grant on `/accounts`. Preserve old plan identifiers for reconciliation. | Fresh owner-signed grant change. Never upload a private key. | Implemented. A replacement grant cannot take over the old grant's execution plans. Existing admitted work may finish; revocation does not undo onchain authority. |
| Read a project now | `GET /projects/{chainId}/{projectId}?source=onchain`, or `/protocol/read` for an exact method. | Signed REST request; a registered read bot can sign automatically. | Implemented with canonical onchain evidence. Failed reads remain unknown. |
| Query discovery, activity, or indexed history | Project `source=bendystraw`, or cataloged `/indexer/{entity}` with an explicit network. | Signed REST request. No personal Bendystraw key is needed through Center. | Implemented through the configured indexer. Follow cursors; indexed values and USD estimates are not execution quotes. |
| Execute from an ordinary wallet | Prepare and simulate a REST plan → wallet signs each exact transaction → relay → refresh plan. | Fresh owner-signed submission request, or bot request plus exact owner approval; wallet transaction signature is also required. | Implemented. EOA signatures lack timestamps, so the fresh dispatch approval cannot simply be removed. No smart wallet is required. |
| Execute with sponsored gas | Create or reuse a supported smart wallet → bind it once → prepare its action plan and UserOperation → sign returned `SafeOp` → submit once → reconcile. | Current Safe-owner threshold signs the validity-bound operation. API request authentication is separate. Creating a wallet currently costs owner gas. | Four chains configured and provider probes live-checked; real signed V6 execution remains pending. No session guard or bot required. |
| Execute several steps | Keep one durable plan. For direct relay, confirm prerequisites and resume remaining steps. A Safe can batch eligible calls on one chain. | Exact owner approval for each direct step or the selected Safe batch; never approve unknown future calls. | Implemented. Multi-call Safe invocation can be verified, but modeled per-call economics currently remain unknown. Use one operation per modeled step when downstream work requires verified outcomes. |
| Use prepaid cross-chain relay | Only when capabilities enable Relayr: plan → prepare wave → sign exact forward requests → publish → review/fund quote once → reconcile each chain. | Fresh owner authorization, each forward signature, and a separately approved funding transaction. | Implemented; availability is capability-dependent. At most one independent call per chain and four calls per wave. This is prepaid relay, not free gas or atomic settlement. |
| Follow an omnichain project | One known V6 identity → `/projects/{chainId}/{projectId}/omnichain` with the chosen source → inspect each member's evidence. | A bot-signed read. A subsequent bridge claim needs its proof and a separate wallet-approved transaction. | Implemented. Chain IDs/project IDs may differ; partial reads stay visible. Source confirmation, destination claim, terminal credit, and settlement remain distinct. |
| Let a bot repeat payments from a budget | Optional: fund an isolated smart wallet → approve the exact bounded onchain permission → bot executes within it. | Fresh owner approval of funding, finite allowances, policy installation, and changes. | Inactive pending guard deployment and activation. An allocation record does not set aside or escrow actual funds. Seven/thirty-day durations are implemented choices, not API requirements. |
| Ask an AI agent to research or prepare | Connect to `https://juicebox.center/mcp` → relevant tool → inspect the result. Add portable Juicebox skills when useful. | No REST enrollment. Wallet actions and public metadata publication require their respective approvals. | Transport and 56-tool catalog live-checked. MCP plans are unsigned and its tokens are not REST plan IDs. Any compatible MCP agent can connect. |
| Publish new project metadata | MCP `jb_prepare_project_metadata` → review exact JSON → `jb_pin_project_metadata` → use returned URI in the launch planner. | Explicit approval of public publication. No wallet needed for pinning. | Implemented for standard new metadata. A logo needs an existing URL/CID; upload images separately. Pinning does not launch or update a project. |
| Read IPFS content or publish app files | Public `GET /ipfs/{cid}` for reads; approved applications use `/v1/pins/json`, `/file`, or `/media` for writes. | No REST account for reads. Writes retain approved-origin and quota requirements; content becomes public. | Existing shared services. A queued redundant pin does not prove every replica is available. [Limits](https://github.com/mejango/jbcenter#pin-and-read-ipfs-content). |
| Read raw chain data | Public read-only `POST /v1/rpc/{chainId}` with one JSON-RPC request. | No REST account; read-method and request budgets apply. | Existing shared gateway. It does not sign or broadcast transactions. [RPC reference](https://github.com/mejango/jbcenter#read-ethereum-rpc). |
| Build a client or add protocol coverage | Choose REST schemas or V6 SDK actions → use current source examples from Juicebox Money, Revnet Money, or Juicescan → implement and test the feature. | Wallet approval only for resulting execution; no approval needed to inspect reference code. | Source-backed MCP integration plans and REST method catalogs implemented. Experimental apps and unsupported semantic adapters remain explicit. |

## Keep the path short without losing evidence

- Ask for `onchain` versus `bendystraw` only where both serve the requested data.
  A client can remember the user's preference. Do not query both unless comparing
  them or resolving a real discrepancy. Preparation always checks onchain state.
- Use an existing identity, selected source, binding, or durable plan when still
  valid. Do not repeat enrollment, create a new smart wallet, or require sessions
  for an ordinary transaction. Keep the creating API principal through dispatch.
- Show one concrete review of the exact calls, amounts, recipients, fees, and
  validity before the necessary signatures. API authentication, transaction
  authority, and publication approval protect different actions.
- Reconcile an uncertain submission before offering another transaction. Keep
  its existing hash, operation ID, and idempotency key. A pending result is not an
  instruction to pay again, change transport, or repeat publication.
- A directory decision must reach a usable resource. Return links are optional
  after a resource; questions cannot loop indefinitely. The shared graph
  validator and navigation checks enforce this across views.
