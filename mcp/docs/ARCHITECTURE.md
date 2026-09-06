# Architecture

The V6 protocol services are transport-independent. MCP translates validated user intent into service calls; it does not own financial math, private keys, arbitrary RPC access, or an execution queue. JB Center embeds this package at `/mcp`, with a separately authorized public-metadata publication service alongside unsigned transaction workflows.

```mermaid
flowchart TD
  Client[MCP client] --> Transport[stdio or stateless HTTP]
  Transport --> Tools[Typed tools, resources and prompts]
  Tools --> Services[Project, payment, routing, NFT, revnet and configuration services]
  Tools --> References[Source and webclient reference services]
  Tools --> Metadata[Exact metadata review and explicit public-upload approval]
  Metadata --> Pinning[Center pinning callback and shared quota]
  Services --> SDK[Pinned nana-sdk-core readers and builders]
  Services --> Plans[Authenticated plans, simulation and receipt evidence]
  SDK --> RPC[Canonical block-hash RPC snapshots]
  Services --> Indexer[Bendystraw fixed GraphQL operations]
  Services --> Center[JB Center bounded reads and local intent commitments]
  References --> Bundles[Checked-in content with revision and file hashes]
  Plans --> Wallet[Unsigned payload for external wallet review]
  Wallet --> Chain[User-authorized execution]
  Chain --> RPC
```

## Dependency rules

`domain` has no transport dependency. `adapters` own network boundaries and runtime response validation. `services` own protocol behavior and produce JSON-safe observations, unsigned `PlanDraft` objects, or explicitly scoped metadata reviews and publication receipts. `mcp` validates/advertises tool inputs and wraps results in a common envelope. `transport` owns connection lifecycle, concurrency, HTTP headers and cancellation.

The parent `src/server.ts` dispatches `/mcp` and its subpaths to the raw MCP HTTP handler before Center's browser API middleware. Parent `src/mcp.ts` injects bounded callbacks for the two Center read routes, allowlisted read-only RPC, and reviewed JSON pinning. These callbacks preserve cancellation, response limits, provider error sanitization and PostgreSQL-backed shared quotas. They call the owning store/gateway/pinning objects directly; there is no self-HTTP hop or fabricated approved Origin. Standalone HTTP and stdio retain their ordinary external read adapters and have no pinning callback by default.

Tests inject `RpcProvider` or bounded adapter requests. Financial tests exercise the actual pinned SDK/viem encoders and decoded calldata, so expected semantic behavior is checked beyond a mocked builder return value.

## State and authority

Deployment addresses and ABIs come from the pinned SDK. The live directory determines a project's controller and terminals; hooks, clone identity and project relationships are checked where required. Source reference bundles provide explanations and development examples, and carry file-level provenance. They never replace deployed-state reads.

`RpcPool.snapshot` first verifies chain identity and reads a mined block. State queries are then bound to `{blockHash, requireCanonical:true}` using EIP-1898. All nested SDK `eth_call` requests inherit that snapshot, with bounded gas. Gas estimation remains a block-number request, followed by the plan verifier's canonical-hash check. Providers unable to serve the required snapshot fail without a weaker fallback.

Partial observations are explicit `known`/`unknown` values. No failed balance, price, configuration or permission read becomes zero or permission. Indexer state remains a separate observation because GraphQL and RPC do not share a transactionally consistent snapshot. Cross-chain identity is verified per peer; each chain's evidence retains its own block.

## Plans

Services return `PlanDraft` with exact account, calls, decoded arguments, dependencies, block evidence, summary and warnings. `PlanService` normalizes bounded JSON, hashes the content and authenticates an expiring self-contained envelope with HMAC-SHA256. Replicas share the parent `MCP_PLAN_SECRET` (standalone `PLAN_SECRET`); no process-local plan store is needed.

Authentication protects server-generated review content from modification. It does not grant permission, prove user approval, encrypt content or ensure a transaction will remain executable. Wallet signatures are the execution authority. Tool replay alone cannot pay twice because this server never broadcasts.

Simulation requires an unexpired plan and exact sender. Earlier prerequisite calls must be confirmed with matching sender, destination, value and calldata. No state overrides are used. Verification separately establishes transaction inclusion and supported operation-specific event evidence. A receipt may confirm a transaction while failing to prove an intended outcome, particularly nested Safe/Relayr execution, hook failures or incomplete cross-chain settlement.

Preparation snapshots also prevent an old matching transaction from being reused as evidence for a new plan. Receipt verification is allowed after plan expiry so historical outcomes remain inspectable. Key rotation invalidates old plan authentication; retain the old deployment/key for historical verification if that continuity is needed, or introduce an explicit versioned keyring before rotation.

## Metadata publication

`ProjectMetadataService.prepare` validates a complete new V6 standard document, rejects ambiguous JSON and invalid URI placeholders, then commits to exact canonical JSON with sorted keys, no trailing newline and no Unicode normalization. The review includes SHA256 and UTF-8 byte size; the whole document is capped at 64 KiB. A purpose-scoped HMAC key derived from the plan secret authenticates an audience-bound token with a maximum ten-minute lifetime. It is a separate token format from transaction plans and cannot authorize wallet execution.

Preparation does not upload anything or establish user approval. The client must show the exact public document and obtain explicit authorization before calling `jb_pin_project_metadata` with `confirmPublicUpload: true`. The pin service authenticates the token, content hash, byte size, audience and expiry before passing those exact bytes to the injected backend. Center applies the shared `pin:mcp` and `pin:site` quotas, retains Filebase's canonical CID and queues redundant pinning through Pinata. This is a public mutation and is advertised accordingly in MCP annotations; generic read-only treatment would be incorrect.

The result separates primary-upload acknowledgment and queued redundancy from retrieval verification and linked-content availability. An uncertain publication outcome may already have made content public and must not trigger an automatic retry. There is no logo upload/fetch, existing-document merge, existing-project URI update, signed-intent publication or on-chain transaction in this service. The returned URI is an input to a separately reviewed V6 launch.

## MCP shape

Tools expose narrow typed operations and return `{schemaVersion, observedAt, ok, data|error}` with structured JSON and text compatibility. Validation errors and safe domain failures do not expose upstream credential-bearing URLs. Discovery starts at `jb_list_capabilities`, followed by family-specific operations.

Resources expose the capability catalog, ABI inventory, source summary, and paginated source/webclient pages. Prompts organize project review, contributions, project design and webclient integration. Source discovery and content retrieval are separate to bound context size.

The HTTP transport creates a fresh MCP server and transport per request while sharing stateless application services. It has no session ID store or cross-client protocol state. Stdio creates one server per process and uses stdout solely for MCP messages. Shared backend budgets belong to Center's PostgreSQL store; transport concurrency and per-socket-IP limits remain per process. The embedded readiness paths are `/mcp/healthz` and `/mcp/readyz`; the latter reports local MCP configuration/bundles, while Center's `/readyz` checks PostgreSQL.

## Extension process

When adding behavior, first identify its owning contract and source tests, then add a typed domain schema and transport-independent service method. Resolve deployment/project identity, represent unknown state explicitly, and test failure boundaries and decoded calldata. Add operation-specific receipt evidence before advertising semantic completion. Finally register the tool in its capability family and regenerate the tool catalog.

Do not register stub tools that promise future functionality. Unsupported execution compositions remain explicit limitations even when their complete source and ABI are available for development.
