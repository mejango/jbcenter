import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import type { Address, Hex } from "viem";
import {
  ConflictError,
  StorageLimitError,
  type DeployPatch,
  type NewDeployment,
  type NewIntent,
  type StorageLimits,
  type Store,
} from "../store.js";
import type {
  Deployment,
  DeploymentCall,
  Intent,
  IntentDeploy,
  IntentDeployStatus,
  SearchItem,
  SearchPage,
} from "../types.js";

type IntentRow = QueryResultRow & {
  id: string;
  content_hash: Hex;
  format: string;
  deployment_version: string;
  chain_ids: string[];
  deployment_calls: DeploymentCall[];
  jb: Intent["envelope"]["jb"];
  publisher: Address;
  signature: Hex;
  name: string;
  description: string | null;
  tagline: string | null;
  tags: string[];
  logo_uri: string | null;
  owner: Address | null;
  created_at: Date;
};

type DeploymentRow = QueryResultRow & {
  chain_id: string;
  project_id: string;
  transaction_hash: Hex;
  created_at: Date;
};

type IntentDeployRow = QueryResultRow & {
  chain_id: string;
  status: IntentDeployStatus;
  bundle_uuid: string | null;
  transaction_hash: Hex | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
};

const deployment = (row: DeploymentRow): Deployment => ({
  chainId: Number(row.chain_id),
  projectId: row.project_id,
  transactionHash: row.transaction_hash,
  createdAt: row.created_at.toISOString(),
});

const toDeploy = (row: IntentDeployRow): IntentDeploy => ({
  chainId: Number(row.chain_id),
  status: row.status,
  transactionHash: row.transaction_hash,
  bundleUuid: row.bundle_uuid,
  error: row.error,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

function intent(row: IntentRow, deployments: Deployment[] = [], deploys: IntentDeploy[] = []): Intent {
  const chainIds = row.chain_ids.map(Number);
  return {
    id: row.id,
    status: deployments.length ? "deployed" : "undeployed",
    contentHash: row.content_hash,
    envelope: {
      format: row.format,
      deploymentVersion: row.deployment_version,
      chainIds,
      deploymentCalls: row.deployment_calls,
      jb: row.jb,
    },
    publisher: row.publisher,
    signature: row.signature,
    name: row.name,
    description: row.description,
    tagline: row.tagline,
    tags: row.tags,
    logoUri: row.logo_uri,
    owner: row.owner,
    createdAt: row.created_at.toISOString(),
    deployments,
    deploys,
  };
}

const selectIntent = `
  SELECT id, content_hash, format, deployment_version, chain_ids, deployment_calls, jb, publisher,
         signature, name, description, tagline, tags, logo_uri, owner, created_at
  FROM intents
`;

const selectDeploys = `
  SELECT chain_id, status, bundle_uuid, transaction_hash, error, created_at, updated_at
  FROM intent_deploys WHERE intent_id = $1 ORDER BY chain_id
`;

export function createPool(connectionString: string): Pool & { connectsSinceLast(): number } {
  const pool = new Pool({
    connectionString,
    max: 10,
    // pg closes an idle connection after 10 s by default, so the first requests of a payment after
    // any quiet each opened a fresh one (TCP, SCRAM, backend start: tens of ms per acquisition,
    // several per admission). Kept connections cost nothing while the pool is under its maximum.
    idleTimeoutMillis: 600_000,
    // A kept socket whose peer went away silently would otherwise fail the next request instead of
    // being dropped while idle.
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 12_000,
    idle_in_transaction_session_timeout: 10_000,
  });
  // A connection the server terminates (idle-in-transaction timeout, restart) emits "error" on
  // the client that holds it. Without a listener that is an uncaught exception and the whole
  // process dies; with one, the query in flight rejects and the caller reports it.
  const report = (source: string) => (error: Error) =>
    console.error(JSON.stringify({ level: "error", service: "db", code: "PG_CONNECTION_ERROR", source, message: String(error.message).slice(0, 200) }));
  let connects = 0;
  pool.on("error", report("idle"));
  pool.on("connect", (client) => { client.on("error", report("client")); connects += 1; });
  // Connections opened since the last call, for the maintenance tick's db_pool line.
  return Object.assign(pool, { connectsSinceLast: () => { const n = connects; connects = 0; return n; } });
}

export class PostgresStore implements Store {
  constructor(readonly pool: Pool) {}

  async health(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async consumeRequest(
    client: string,
    limit: number,
    windowSeconds = 60,
  ): Promise<{ allowed: boolean; remaining: number }> {
    const result = await this.pool.query<{ request_count: number }>(
      `INSERT INTO rate_limits (client_name, window_start, request_count)
       VALUES (
         $1,
         to_timestamp(floor(extract(epoch FROM now()) / $2) * $2),
         1
       )
       ON CONFLICT (client_name, window_start)
       DO UPDATE SET request_count = rate_limits.request_count + 1
       RETURNING request_count`,
      [client, windowSeconds],
    );
    const count = result.rows[0]!.request_count;
    return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
  }

  /** Drops spent rate-limit windows; runs on the maintenance tick, not in front of every request. */
  async cleanupRateLimits(): Promise<number> {
    const result = await this.pool.query("DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'");
    return result.rowCount ?? 0;
  }

  async createIntent(
    value: NewIntent,
    limits: StorageLimits,
  ): Promise<{ intent: Intent; created: boolean }> {
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `intent:${value.publisher}:${value.contentHash}`,
      ]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [value.submittedBy]);
      const existing = await client.query<IntentRow>(
        `${selectIntent} WHERE publisher = $1 AND content_hash = $2`,
        [value.publisher, value.contentHash],
      );
      if (existing.rows[0]) {
        const deploymentResult = await client.query<DeploymentRow>(
          `SELECT chain_id, project_id::text, transaction_hash, created_at
           FROM deployments WHERE intent_id = $1 ORDER BY chain_id`,
          [existing.rows[0].id],
        );
        await client.query("COMMIT");
        return {
          intent: intent(existing.rows[0], deploymentResult.rows.map(deployment)),
          created: false,
        };
      }
      const usage = await client.query<{ count: string; bytes: string }>(
        `SELECT count(*)::text AS count, coalesce(sum(jb_bytes), 0)::text AS bytes
         FROM intents WHERE submitted_by = $1`,
        [value.submittedBy],
      );
      if (Number(usage.rows[0]!.count) >= limits.maxIntents) {
        throw new StorageLimitError("Client intent quota exceeded");
      }
      if (Number(usage.rows[0]!.bytes) + value.jbBytes > limits.maxBytes) {
        throw new StorageLimitError("Client storage quota exceeded");
      }
      const result = await client.query<IntentRow>(
        `INSERT INTO intents (
           id, content_hash, format, deployment_version, chain_ids, deployment_calls, jb, publisher,
           signature, name, description, tagline, tags, logo_uri, owner, submitted_by, jb_bytes,
           search_vector
         ) VALUES (
           $1, $2, $3, $4, $5::bigint[], $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
           $17,
           to_tsvector(
             'simple',
             concat_ws(' ', $10::text, $11::text, $12::text, array_to_string($13::text[], ' '))
           )
         )
         RETURNING *`,
        [
          id,
          value.contentHash,
          value.envelope.format,
          value.envelope.deploymentVersion,
          value.envelope.chainIds,
          JSON.stringify(value.envelope.deploymentCalls),
          value.envelope.jb,
          value.publisher,
          value.signature,
          value.name,
          value.description,
          value.tagline,
          value.tags,
          value.logoUri,
          value.owner,
          value.submittedBy,
          value.jbBytes,
        ],
      );
      await client.query("COMMIT");
      return { intent: intent(result.rows[0]!), created: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getIntent(id: string): Promise<Intent | null> {
    const [intentResult, deploymentResult, deployResult] = await Promise.all([
      this.pool.query<IntentRow>(`${selectIntent} WHERE id = $1`, [id]),
      this.pool.query<DeploymentRow>(
        `SELECT chain_id, project_id::text, transaction_hash, created_at
         FROM deployments WHERE intent_id = $1 ORDER BY chain_id`,
        [id],
      ),
      this.pool.query<IntentDeployRow>(selectDeploys, [id]),
    ]);
    return intentResult.rows[0]
      ? intent(intentResult.rows[0], deploymentResult.rows.map(deployment), deployResult.rows.map(toDeploy))
      : null;
  }

  async search(query: string, limit: number, offset: number): Promise<SearchPage> {
    const params: unknown[] = [];
    const search = query
      ? "AND search_vector @@ websearch_to_tsquery('simple', $1)"
      : "";
    if (query) params.push(query);
    const limitParam = params.push(limit);
    const offsetParam = params.push(offset);
    const order = query
      ? "ts_rank(search_vector, websearch_to_tsquery('simple', $1)) DESC, created_at DESC, id"
      : "created_at DESC, id";
    const [rows, count] = await Promise.all([
      this.pool.query<IntentRow>(
        `${selectIntent}
         WHERE NOT EXISTS (SELECT 1 FROM deployments WHERE deployments.intent_id = intents.id)
         ${search}
         ORDER BY ${order}
         LIMIT $${limitParam} OFFSET $${offsetParam}`,
        params,
      ),
      this.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM intents
         WHERE NOT EXISTS (SELECT 1 FROM deployments WHERE deployments.intent_id = intents.id)
         ${search}`,
        query ? [query] : [],
      ),
    ]);
    const totalCount = Number(count.rows[0]!.count);
    const items: SearchItem[] = rows.rows.map((row) => {
      const value = intent(row);
      return {
        source: "jbcenter",
        status: "undeployed",
        intentId: value.id,
        contentHash: value.contentHash,
        format: value.envelope.format,
        deploymentVersion: value.envelope.deploymentVersion,
        chainIds: value.envelope.chainIds,
        publisher: value.publisher,
        name: value.name,
        description: value.description,
        tagline: value.tagline,
        tags: value.tags,
        logoUri: value.logoUri,
        owner: value.owner,
        createdAt: value.createdAt,
      };
    });
    return {
      items,
      totalCount,
      nextCursor: offset + items.length < totalCount ? String(offset + items.length) : null,
    };
  }

  async recordDeployment(intentId: string, value: NewDeployment): Promise<Deployment> {
    let inserted;
    try {
      inserted = await this.pool.query<DeploymentRow>(
        `INSERT INTO deployments (intent_id, chain_id, project_id, transaction_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (intent_id, chain_id) DO NOTHING
         RETURNING chain_id, project_id::text, transaction_hash, created_at`,
        [intentId, value.chainId, value.projectId, value.transactionHash],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new ConflictError("That onchain project or transaction is already linked");
      }
      throw error;
    }
    if (inserted.rows[0]) return deployment(inserted.rows[0]);
    const existing = await this.pool.query<DeploymentRow>(
      `SELECT chain_id, project_id::text, transaction_hash, created_at
       FROM deployments WHERE intent_id = $1 AND chain_id = $2`,
      [intentId, value.chainId],
    );
    const current = existing.rows[0];
    if (!current || current.project_id !== value.projectId || current.transaction_hash !== value.transactionHash) {
      throw new ConflictError("A different deployment is already recorded for that chain");
    }
    return deployment(current);
  }

  async queueDeploys(
    intentId: string,
    chainIds: number[],
    requester: string,
    reservedWeiPerChain: bigint,
  ): Promise<IntentDeploy[]> {
    await this.pool.query(
      `INSERT INTO intent_deploys (intent_id, chain_id, requester, reserved_wei)
       SELECT $1, unnest($2::bigint[]), $3, $4::numeric
       ON CONFLICT (intent_id, chain_id) DO NOTHING`,
      [intentId, chainIds, requester, reservedWeiPerChain.toString()],
    );
    return this.listDeploys(intentId);
  }

  async listDeploys(intentId: string): Promise<IntentDeploy[]> {
    const result = await this.pool.query<IntentDeployRow>(selectDeploys, [intentId]);
    return result.rows.map(toDeploy);
  }

  async claimQueuedDeploys(
    leaseSeconds: number,
    limit: number,
  ): Promise<{ intentId: string; chainIds: number[] }[]> {
    const result = await this.pool.query<{ intent_id: string; chain_id: string }>(
      `WITH picked AS (
         SELECT intent_id FROM intent_deploys
         WHERE status = 'queued' AND (lease_until IS NULL OR lease_until < now()) AND attempts < 3
         GROUP BY intent_id ORDER BY intent_id LIMIT $2
       )
       UPDATE intent_deploys d SET lease_until = now() + make_interval(secs => $1), attempts = attempts + 1, updated_at = now()
       FROM picked WHERE d.intent_id = picked.intent_id AND d.status = 'queued'
       RETURNING d.intent_id, d.chain_id`,
      [leaseSeconds, limit],
    );
    const byIntent = new Map<string, number[]>();
    for (const row of result.rows) {
      const chainIds = byIntent.get(row.intent_id) ?? [];
      chainIds.push(Number(row.chain_id));
      byIntent.set(row.intent_id, chainIds);
    }
    return [...byIntent.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([intentId, chainIds]) => ({ intentId, chainIds: chainIds.sort((a, b) => a - b) }));
  }

  async updateDeploy(intentId: string, chainId: number, patch: DeployPatch): Promise<void> {
    await this.pool.query(
      `UPDATE intent_deploys SET status = $3,
         transaction_hash = coalesce($4, transaction_hash), bundle_uuid = coalesce($5, bundle_uuid),
         error = $6, spent_wei = coalesce($7::numeric, spent_wei),
         reserved_wei = CASE WHEN $3 IN ('confirmed', 'failed') THEN 0 ELSE reserved_wei END,
         updated_at = now()
       WHERE intent_id = $1 AND chain_id = $2`,
      [
        intentId,
        chainId,
        patch.status,
        patch.transactionHash ?? null,
        patch.bundleUuid ?? null,
        patch.error ?? null,
        patch.spentWei?.toString() ?? null,
      ],
    );
  }

  async sponsoredWeiSince(since: Date): Promise<bigint> {
    const result = await this.pool.query<{ wei: string }>(
      "SELECT coalesce(sum(reserved_wei + spent_wei), 0)::text AS wei FROM intent_deploys WHERE created_at >= $1",
      [since],
    );
    return BigInt(result.rows[0]!.wei);
  }
}
