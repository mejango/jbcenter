# Deployment

The repository is prepared for `https://juicebox.diy/mcp`. `PUBLIC_ORIGIN` can be changed to `https://juicebox.tools` without changing protocol services or reference bundles. No hosted deployment is created by building this repository.

## Production environment

Set `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=3000`, `PUBLIC_ORIGIN=https://juicebox.diy`, and a cryptographically random `PLAN_SECRET` of at least 32 bytes shared by every replica. Configure the actual Bendystraw endpoints and optional per-chain RPC URLs. Configure approved JB Center integration access separately; a forged Origin is not an integration.

Terminate TLS at the hosting ingress. The application deliberately exposes public read/reference/model/unsigned-preparation capabilities and has no private account authentication or signing keys. Introducing private saved drafts, publication, delegated wallets, or other writes requires a separately designed authorization boundary rather than merely changing a tool annotation.

```sh
docker build -t juicebox-mcp .
docker run --rm -p 3000:3000 --env-file .env.production juicebox-mcp
```

The image runs as the unprivileged Node user and can run with a read-only filesystem and all Linux capabilities dropped. Its runtime depends only on compiled code, installed production packages and checked-in `data/` bundles. Docker does not copy local `.env` files or source repositories into the image.

## Railway

`railway.json` uses `/readyz` for deployment readiness. Railway's health probe sends `Host: healthcheck.railway.app`; add that exact hostname to `ALLOWED_HOSTS`. The public-origin hostname is already included by configuration. Railway's startup probe is not ongoing upstream monitoring.

Use the same stable plan secret across releases and replicas. Set an adequate shutdown/drain interval so the application's ten-second graceful shutdown can finish. No persistent volume is required by this implementation.

## Operational limits

| Boundary                               |              Default |
| -------------------------------------- | -------------------: |
| Request body, HTTP and stdio           |              256 KiB |
| Plan payload / token                   |    128 KiB / 192 KiB |
| Tool result data                       |              512 KiB |
| HTTP concurrent requests per process   |                   16 |
| HTTP per socket-IP rate / burst        | 120 per minute / 120 |
| Rate-limit identities retained         |               10,000 |
| HTTP operation deadline                |           60 seconds |
| Body/header receive timeout            |      15 / 10 seconds |
| Graceful shutdown                      |           10 seconds |
| Upstream requests per tool             |                  128 |
| RPC timeout / response cap             |   12 seconds / 5 MiB |
| Default adapter timeout / response cap |   15 seconds / 2 MiB |
| Simulation/view gas bound              |           30,000,000 |
| RPC log range                          |        50,000 blocks |
| Plan lifetime                          |          300 seconds |

The HTTP service rejects legacy JSON-RPC batch arrays to prevent per-request concurrency limits being bypassed. MCP GET and DELETE return 405; this implementation uses stateless POST request/response and does not provide an SSE subscription stream.

Host and browser Origin are checked against explicit allowlists. Forwarded headers are ignored. If a reverse proxy uses one socket address for all users, the local per-IP quota is shared; configure distributed per-user/IP quotas at the trusted ingress. Process-local rate limits alone are not a distributed quota.

`/healthz` is process liveness. `/readyz` confirms that application configuration and bundles loaded, and returns `upstreamHealth: "not_checked"`. Use a separate read-only monitor for RPC/indexer/Center availability. Logs intentionally exclude request bodies, upstream URLs, plan secrets and wallet data.

Production dependency audit and Docker build belong in release validation. Refresh source references in a controlled workspace, review changes and commit the resulting bundles; runtime instances never pull arbitrary upstream source.
