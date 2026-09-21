# Production operations

Normal execution uses fresh wallet approval. Optional recurring bot permissions remain unavailable until the matching guard is deployed and an owner activates a bounded policy. Gas sponsorship does not require those permissions. See [execution operations](EXECUTION_OPERATIONS.md) for provider configuration and transaction recovery.

## Monitoring

[The production workflow](https://github.com/mejango/jbcenter/blob/main/.github/workflows/production.yml) runs [the read-only production check](https://github.com/mejango/jbcenter/blob/main/scripts/check-production.mjs) on a five-minute GitHub Actions schedule and can also be started manually. It checks the public health, readiness, capability, account and documentation routes, plus protected recovery metrics. Only the metrics credential belongs in the workflow secret; provider credentials and wallet keys do not.

GitHub schedules are best effort and can be delayed. Failed-run notification delivery depends on the operator's GitHub notification settings and has not been independently verified. Check the workflow after deployment and confirm that the responsible operator receives a failed-run notification before treating it as a paging service.

For a failed check, inspect the failing endpoint and Railway deployment status, then review the application's structured recovery logs. Check database connectivity and the configured chain's RPC and bundler health. Reconcile the existing transaction or user-operation identifier before asking a user to retry; never turn an uncertain submission into a new payment automatically.

Production shutdown grace was verified on 2026-09-07: the app has `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`; PostgreSQL has `60`.

## Database backups

Railway's native backups were enabled and verified for the production PostgreSQL volume on 2026-09-07. The app's database connection was checked against the database service before selecting the volume.

| Schedule | Retention |
| --- | --- |
| Daily | 6 days |
| Weekly | 27 days |

The first manual snapshot, `jbcenter-production-readiness-2026-09-07`, completed at `2026-09-07T15:06:48.313Z`. It is retained without an expiry. Scheduled backups run in addition to this initial recovery point. These are volume snapshots, not continuous point-in-time recovery; changes since the selected snapshot can be lost. Verify recent successful recovery points in the production Postgres service's Backups tab after changing storage or schedules. See [Railway's backup and retention documentation](https://docs.railway.com/volumes/backups).

Railway's documented snapshot restore stages a replacement volume on the attached service and redeploys it when applied. Do not use that operation as a production drill. During an actual recovery, pause application writes and execution workers, record the recovery point, preserve the current volume, review the staged replacement, and reconcile all potentially submitted transactions on their canonical chains before resuming execution. An older database can contain stale request nonces, bot revocations and transaction states; never assume a restored row proves a transaction was not sent.

## Restore verification

On 2026-09-07, a **schema-only** PostgreSQL 18 dump was restored successfully into an isolated local PostgreSQL container. Verification matched all 21 table definitions, 158 column definitions in logical order, 314 validated constraints and 59 indexes. PostgreSQL compacted ordinal gaps left by previously dropped columns; every remaining column property and its logical order matched. The source schema stayed unchanged throughout the check.

The drill used read-only access over Railway SSH without exposing the database publicly. No production user rows or credentials were exported. The temporary database had networking disabled, no published ports, no application or transaction workers, and memory-backed storage. It was removed after verification.

**Full data restoration and Railway's native snapshot restoration remain untested.** The schema check does not establish that all user data, service credentials or database role grants can be recovered, or establish recovery time under a real incident. A full-data drill requires an approved isolated destination for the private database. A native snapshot drill needs an isolated supported target or a separately approved recovery window.
