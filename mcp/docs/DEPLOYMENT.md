# Deployment

The deployment endpoint is `https://juicebox.center/mcp`. This package lives in the Center repository's `mcp/` directory. The parent HTTP server dispatches raw MCP requests before its browser API middleware; the MCP handler retains its own Host/Origin, body, concurrency and lifecycle checks. Building either package does not deploy it or establish upstream availability.

## Integrated production environment

Build and run from the JB Center repository root using the parent `Dockerfile`, package scripts and `railway.json`. The parent build compiles the MCP package first. Configure the existing Center database, RPC and pinning credentials as described in its [README](../../README.md), then add:

| Variable                      | Behavior                                                                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_PLAN_SECRET`             | Required in production; at least 32 bytes of cryptographically random secret entropy, stable across releases and replicas. Authenticates transaction plans and separately scoped metadata review tokens. |
| `MCP_PUBLIC_ORIGIN`           | Default `https://juicebox.center`; a plain HTTPS origin without `/mcp`, credentials, query or fragment.                                                                                                  |
| `MCP_BENDYSTRAW_MAINNET_URL`  | Authorized complete mainnet GraphQL endpoint; absent means mainnet indexed operations report `NOT_CONFIGURED`.                                                                                           |
| `MCP_BENDYSTRAW_TESTNET_URL`  | Independently authorized complete testnet GraphQL endpoint; mainnet credentials do not establish testnet access.                                                                                         |
| `MCP_ALLOWED_HOSTS`           | Optional comma-separated additional Host authorities; the public-origin hostname is included automatically.                                                                                              |
| `MCP_ALLOWED_ORIGINS`         | Optional comma-separated additional browser origins; the public origin and Center's active-environment browser origins are included automatically.                                                       |
| `MCP_PLAN_TTL_SECONDS`        | Transaction-plan lifetime, default `300` seconds, range `30`–`1800`. Metadata reviews have a separate maximum ten-minute lifetime.                                                                       |
| `MCP_MAX_CONCURRENT_REQUESTS` | Per-process MCP HTTP concurrency, default `16`, range `1`–`128`.                                                                                                                                         |
| `MCP_KNOWLEDGE_PATH`          | Optional reviewed knowledge bundle override; packaged references are the default.                                                                                                                        |

`NODE_ENV`, `HOST` and `PORT` come from the parent environment. The integrated service calls Center's configured read-only RPC gateway, store and pinning service directly through bounded callbacks. There is no self-HTTP hop or impersonated approved browser Origin. RPC retains the owning gateway's provider failover, read-method allowlist and credential sanitization. Providers must support the canonical block-hash reads used by the MCP. Standalone `RPC_URL_*` and `JBCENTER_ORIGIN` settings are not host integration settings.

Terminate TLS at the hosting ingress. Non-browser MCP clients can connect without inventing an Origin; browser clients remain subject to the configured Origin allowlist. The MCP has no account-authentication session or wallet keys. Its direct publication workflow requires an expiring exact-document review token and explicit user approval of a public upload. A token authenticates content and does not establish approval. New publication types, private saved drafts or delegated wallets need their own authorization design.

## Readiness and Railway

The parent `railway.json` keeps `/readyz`, which checks PostgreSQL. `/healthz` is parent process liveness. `/mcp/healthz` reports MCP liveness and `/mcp/readyz` confirms local configuration and bundles loaded, returning `upstreamHealth: "not_checked"`. Use a separate read-only monitor for RPC/indexer availability; readiness never implies every network is configured.

If configuring an additional Railway probe to `/mcp/readyz`, add `healthcheck.railway.app` to `MCP_ALLOWED_HOSTS` because Railway uses that Host. The parent `/readyz` probe does not pass through MCP's Host check. Railway's startup probe is not ongoing upstream monitoring.

Use the same stable secret across releases and replicas. Key rotation invalidates old plan/review tokens; establish a deliberate historical verification policy before rotating. Allow the parent's shutdown/drain interval to finish in-flight operations. Center requires PostgreSQL and its existing backup policy; packaged MCP references and self-contained tokens add no persistent volume requirement.

## Shared backend budgets

Center's PostgreSQL-backed quotas apply across replicas, including when callbacks avoid an HTTP hop:

| Boundary                          | Quota key          |                                                Default |
| --------------------------------- | ------------------ | -----------------------------------------------------: |
| Center search and intent reads    | `center:mcp:reads` |                                         600 per minute |
| MCP read-only RPC requests        | `rpc:mcp`          |                                       5,000 per minute |
| Combined trusted-site and MCP RPC | `rpc:site`         | `RPC_SITE_LIMIT_PER_MINUTE`, default 20,000 per minute |
| MCP reviewed JSON publication     | `pin:mcp`          |                                     10 per 600 seconds |
| Combined site and MCP pin writes  | `pin:site`         |                                    200 per 600 seconds |

These are service-wide budgets rather than per-user allowances. The public RPC gateway's separate public budget remains separate. Pin quotas and provider availability are checked at publication time; preparation does not reserve quota or guarantee upload success. The pin receipt distinguishes primary upload acknowledgment, queued redundancy and unverified retrieval. A publication failure with an uncertain receipt may already have made content public; inspect backend status before deliberately retrying.

## Transport and service limits

| Boundary                                   |              Default |
| ------------------------------------------ | -------------------: |
| Request body, HTTP and stdio               |              256 KiB |
| Plan payload / token                       |    128 KiB / 192 KiB |
| New metadata canonical JSON / review token |     64 KiB / 100 KiB |
| Tool result data                           |              512 KiB |
| HTTP concurrent requests per process       |                   16 |
| HTTP per socket-IP rate / burst            | 120 per minute / 120 |
| Rate-limit identities retained             |               10,000 |
| HTTP operation deadline                    |           60 seconds |
| Body/header receive timeout                |      15 / 10 seconds |
| Standalone MCP graceful shutdown           |           10 seconds |
| Integrated Center graceful shutdown        |           25 seconds |
| Upstream requests per tool                 |                  128 |
| RPC timeout / response cap                 |   12 seconds / 5 MiB |
| Default adapter timeout / response cap     |   15 seconds / 2 MiB |
| Simulation/view gas bound                  |           30,000,000 |
| RPC log range                              |        50,000 blocks |
| Transaction-plan lifetime                  |          300 seconds |
| Metadata-review lifetime                   |          600 seconds |

Legacy JSON-RPC batch arrays are rejected. MCP GET and DELETE return 405; this is stateless POST request/response without an SSE subscription stream. Forwarded headers are ignored. If an ingress presents one socket address for all users, the local per-IP quota is shared; configure distributed per-user/IP quotas at the trusted ingress when needed. Process-local transport limits and shared backend budgets protect different resources.

Logs exclude request bodies, upstream URLs, plan secrets and wallet data. Source bundles are refreshed deliberately, reviewed and committed before release; runtime never pulls arbitrary upstream source.

## Standalone package mode

Standalone HTTP and stdio remain available from `mcp/` using its own package scripts and `.env.example`. Their variables omit the `MCP_` prefix: for example `PLAN_SECRET`, `PUBLIC_ORIGIN`, `BENDYSTRAW_MAINNET_URL`, `BENDYSTRAW_TESTNET_URL` and optional per-chain `RPC_URL_<chainId>`. The production origin defaults to `https://juicebox.center`; alternate origins such as `juicebox.diy` or `juicebox.tools` remain configurable.

Standalone HTTP serves `/mcp`, `/healthz` and `/readyz`. It has no direct Center store or pinning callback. Public Center RPC is its default read transport; non-RPC Center API reads require an approved integration Origin configured as `JBCENTER_ORIGIN`. Metadata preparation explains the missing backend and directs the client to prepare the same document through the integrated Center endpoint before obtaining approval there. Review tokens are not assumed portable between servers.

The package's standalone Dockerfile remains useful for isolated transport verification. It is not the deployment image for integrated Center. Both images exclude local `.env` files and source workspaces and run as an unprivileged user. Release validation includes the parent and MCP test suites, dependency audits, production build, container transport checks and separately reported live read checks.
