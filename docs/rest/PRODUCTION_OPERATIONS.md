# Production operations

Center owns protocol reads/preparation, project intents, publication, shared quotas and the intent sponsor. Signa owns account and wallet execution. No Center account migration or compatibility service is required.

## Monitoring

`/healthz` reports process liveness and `/readyz` checks PostgreSQL. `/mcp/readyz` reports local MCP readiness, not upstream availability. `/api/v1/capabilities` describes the protocol API. Protected `/metrics` requires the operator's metrics token.

The [production workflow](https://github.com/mejango/jbcenter/blob/main/.github/workflows/production.yml) runs [the read-only production check](https://github.com/mejango/jbcenter/blob/main/scripts/check-production.mjs). Verify the deployed workflow and actual response contract after rollout. GitHub schedules are best effort, and notification delivery depends on operator settings.

For a failure, inspect the request ID, structured logs, database connectivity and configured RPC/indexer/pinning providers. Missing upstream evidence must stay unavailable. Account recovery alerts belong to Signa.

## Sponsored intent recovery

The intent sponsor retains its deployment rows, bundle identities, nonces and funding reservations. Pause new sponsorship with `SPONSOR_PAUSED=1` when investigating. An unknown Relayr submission must be reconciled with its original bundle and canonical destination receipts before replacement. A failure after funding is not an unused reservation.

Center runs one replica while intent sponsorship is enabled. Stop the HTTP listener and sponsor worker cleanly before closing PostgreSQL. See [the intent guide](PROJECT_INTENTS.md) for limits and retry semantics.

## Database and storage

Keep backups for intents, signed envelopes, deployment associations, sponsor queues and quota state. Removing account runtime code does not authorize dropping production tables. New installs use only the retained Center schema; existing historical account rows may remain inert until an independently reviewed storage cleanup.

Verify current backup settings and recovery points with the hosting provider. Historical checks do not establish current recoverability. A restore must preserve the current volume, identify its recovery point and reconcile sponsored submissions that may have occurred after that point before resuming writes. Never assume an older queue proves that a transaction was not sent.

A full-data restore drill needs an isolated destination with no sponsor workers or production credentials capable of spending. Record what was restored, which checks passed and what remains untested. The IPFS disk cache is regenerable and must not be treated as the only copy of pinned content.

## Release checks

Run `npm run check` against a disposable PostgreSQL 16 database and build the production container. The retained sponsor checks also require Anvil, the pinned Solidity 0.8.26 compiler in the Foundry cache, and Playwright Chromium. The [CI workflow](https://github.com/mejango/jbcenter/blob/main/.github/workflows/ci.yml) owns their installation commands and tool pins. The gate includes retained protocol, publication, sponsor and MCP behavior. Review that account routes and bundles are absent and that existing project-intent consumers still work. Local checks establish the source build, not deployment readiness or successful production transactions.
