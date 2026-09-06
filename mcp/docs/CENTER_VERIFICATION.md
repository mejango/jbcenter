# Center integration verification

Verified locally on 2026-09-06. This record establishes release validation of the integrated Center service; it does not assert that the public endpoint has been deployed.

## Reproducible checks

- Parent `npm run check` passed with Node 22.23.1 and PostgreSQL 16: 344 MCP tests and 127 Center tests, including the real PostgreSQL store suite. Both TypeScript builds, formatting, and the generated catalog check passed.
- Parent and MCP `npm audit --omit=dev --audit-level=high` each reported zero vulnerabilities.
- Both source synchronization checks passed before the release commit. The corpus contains 427 references from 24 repositories, including all 55 V6 skills from `juicebox-skills` commit `54edeefb7592334798a5725c68fc498b5e47c252`. The webclient bundle contains 100 references and 15 feature mappings.
- The production Dockerfile built successfully using clean lockfile installs, production-only dependencies, the packaged bundles, and the unprivileged `node` user.
- PostgreSQL reported active 10-second statement and idle-transaction timeouts for the production pool configuration.

The knowledge bundle is `c5937fe11a0c8936fd7c902f19c5dc0a388869a0edefe1d80613bc75d25c43fa`. The development bundle is `0a4085bcaa098e70f653ca363e6fce858a2c29842aa82219082c8634a78ea507`. Two knowledge documents, Center's README and RPC implementation, capture reviewed local changes relative to the import commit and accurately retain `fileDirty: true`. Their recorded SHA256 values identify the exact bundled bytes. Committing Center changes its own source provenance; a later synchronization is a deliberate new snapshot, not a runtime requirement.

## Packaged HTTP validation

The final image (`sha256:1d2f5c47ca9c07486e5dc50c967b2798d34ff6c0e3adde048a0472649757e891`) ran against an isolated PostgreSQL database with dummy provider credentials. An official MCP SDK 1.30.0 client passed 19 checks:

- Center and MCP health/readiness, rejection of unapproved browser origins, invalid JSON, unsupported content types, and oversized bodies.
- Initialization, 56 tools, ten V6 capability families, three resources, two resource templates, and four prompts.
- Explicit V6 project resolution and rejection of a V4 project URL.
- The full source/skill corpus, both feedback guides, contract references for buyback/721/router/revnet, all webclient references, and a React revnet integration plan.
- Exact metadata JSON byte count and SHA256, configured publication callback, and a review token that does not establish user authorization.
- Store-backed V6 discovery and honest `NOT_CONFIGURED` reporting for the local instance's absent indexer endpoint.

The test suites additionally exercise version filtering with mixed Center pages and preserved cursors, authenticated metadata review boundaries, fake provider publication and uncertain outcomes, RPC/provider cancellation and response bounds, intact multipart streams, shared quotas, and graceful/forced shutdown.

## External validation boundaries

The existing authorized mainnet Bendystraw endpoint passed read-only checks for project search, project detail, activity, account, sucker groups, and status using the MCP adapter. The testnet endpoint remains independently unconfigured.

No metadata was publicly pinned, no project was launched, and no transaction was signed or broadcast during this verification. Provider publication is covered by controlled integration fixtures. A public release still requires production configuration and a separate live HTTP, indexer, and canonical-block RPC check against the deployed revision.
