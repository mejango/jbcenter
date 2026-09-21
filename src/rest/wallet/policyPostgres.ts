import { types } from "node:util";
import type { Pool, PoolClient } from "pg";
import { RestError } from "../core.js";
import { validateWalletPolicyCallback, validateWalletPolicyConfiguration, validateWalletPolicyOrigin,
  walletAppGrantDefaultLifetimeSeconds, walletAppGrantMaximumLifetimeSeconds, walletPolicyConfigurationHash, type WalletPolicyConfiguration } from "./policy.js";

export interface WalletPolicyActivation {
  expectedRevision: number;
  nextRevision: number;
  configuration: WalletPolicyConfiguration;
}
export interface WalletPolicyApplicationState {
  origin: string;
  walletCallbacks: string[];
  generation: number;
  enabled: boolean;
  /** How long this application's grants live, in seconds. */
  grantLifetimeSeconds: number;
}
export interface WalletPolicySnapshot {
  revision: number;
  configurationHash: string;
  configuration: WalletPolicyConfiguration;
  activatedAt: number;
  apps: WalletPolicyApplicationState[];
}
export interface WalletPolicyCallbackAdmission {
  origin: string;
  callbackUri: string;
  expectedGeneration?: number;
  /** Unix milliseconds; checked against the database wall clock after acquiring the app lock. */
  expiresAt: number;
}

interface AppRow { origin: string; wallet_callbacks: string[]; generation: string; enabled: boolean; grant_lifetime_seconds: number }
interface PolicyRow { revision: string; configuration_hash: string; configuration: string; activated_at: string; apps: AppRow[] }
const nowSql = "floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint";
function invalid(): never { throw new RestError(400, "WALLET_POLICY_INVALID", "Wallet policy input is invalid."); }
function inactive(): never { throw new RestError(403, "WALLET_POLICY_INACTIVE", "Wallet application policy is inactive or changed."); }
function conflict(): never { throw new RestError(409, "WALLET_POLICY_CONFLICT", "Wallet policy activation revision conflicts with the current policy."); }
function plainFields(input: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!input || typeof input !== "object" || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) invalid();
  const keys = Reflect.ownKeys(input), allowed = [...required, ...optional];
  if (keys.length < required.length || keys.length > allowed.length || keys.some(key => typeof key !== "string" || !allowed.includes(key))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (required.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)) invalid();
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function appOf(row: AppRow): WalletPolicyApplicationState {
  const lifetime = Number(row.grant_lifetime_seconds);
  if (!positive(lifetime) || lifetime > walletAppGrantMaximumLifetimeSeconds) inactive();
  return { origin: row.origin, walletCallbacks: [...row.wallet_callbacks], generation: Number(row.generation), enabled: row.enabled,
    grantLifetimeSeconds: lifetime };
}
function snapshotOf(row: PolicyRow): WalletPolicySnapshot {
  const configuration = validateWalletPolicyConfiguration(JSON.parse(row.configuration));
  if (walletPolicyConfigurationHash(configuration) !== row.configuration_hash) inactive();
  return { revision: Number(row.revision), configurationHash: row.configuration_hash, configuration,
    activatedAt: Number(row.activated_at), apps: row.apps.map(appOf) };
}
// One SQL snapshot prevents a reader from combining the old document with newly committed derived app rows.
const snapshotSql = `SELECT p.*, COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.origin)
  FROM rest_wallet_policy_apps a WHERE a.policy_id=p.id), '[]'::jsonb) AS apps FROM rest_wallet_policy p WHERE p.id=1`;
async function readSnapshot(client: Pick<PoolClient, "query">): Promise<WalletPolicySnapshot | null> {
  const row = (await client.query<PolicyRow>(snapshotSql)).rows[0];
  return row ? snapshotOf(row) : null;
}

/** Internal transaction helper: caller owns BEGIN/COMMIT, retains this app's FOR SHARE lock through
 * its durable claim, and repeats this check after later blocking writes immediately before COMMIT.
 * Account/session/authority locks belong to the caller. Activation never takes those locks.
 * The returned metadata is not reusable authority after the transaction ends; this is eligibility only.
 * No RPC, pool acquisition, transaction boundary, session or spending authorization occurs here. */
export async function assertWalletPolicyCallbackInTransaction(client: PoolClient, input: WalletPolicyCallbackAdmission): Promise<WalletPolicyApplicationState> {
  const request = plainFields(input, ["origin", "callbackUri", "expiresAt"], ["expectedGeneration"]);
  const origin = validateWalletPolicyOrigin(request.origin), callback = validateWalletPolicyCallback(request.callbackUri, origin);
  const expiresAt = request.expiresAt, generation = request.expectedGeneration;
  if (!positive(expiresAt) || (generation !== undefined && !positive(generation))) invalid();
  const row = (await client.query<AppRow>("SELECT * FROM rest_wallet_policy_apps WHERE origin=$1 FOR SHARE", [origin])).rows[0];
  const now = Number((await client.query<{ now: string }>(`SELECT ${nowSql} AS now`)).rows[0]!.now);
  return admitWalletPolicyCallback(row, { origin, callback, expiresAt, generation }, now);
}
/** The admission's own checks over an app row the caller read (and share-locked) itself, at the
 * millisecond clock it read after every lock; the row is validated before the clock is consulted. */
export function admitWalletPolicyCallback(row: WalletPolicyAppRow | undefined,
  request: { origin: string; callback: string; expiresAt: number; generation?: number | undefined }, nowMs: number): WalletPolicyApplicationState {
  if (validateWalletPolicyOrigin(request.origin) !== request.origin || validateWalletPolicyCallback(request.callback, request.origin) !== request.callback
    || !positive(request.expiresAt) || (request.generation !== undefined && !positive(request.generation))) invalid();
  if (!row || row.origin !== request.origin || !row.enabled || !row.wallet_callbacks.includes(request.callback)
    || (request.generation !== undefined && Number(row.generation) !== request.generation)) inactive();
  if (request.expiresAt <= nowMs) throw new RestError(410, "WALLET_POLICY_EXPIRED", "Wallet callback admission has expired.");
  return appOf(row);
}
export type WalletPolicyAppRow = AppRow;

/** Explicit operator-only activation of the shared Center trust configuration. No route, startup
 * activation, process-local authority cache, grant issuance or session/spending authority.
 * Removed app tombstones are bounded and retained; ordinary restart cannot roll back active policy.
 * All replicas must use the same historical admission limit. Only changed apps receive row updates. */
export class PostgresWalletPolicyStore {
  private readonly maxHistoricalApplications: number;
  constructor(private readonly pool: Pool, options: { maxHistoricalApplications?: number } = {}) {
    this.maxHistoricalApplications = options.maxHistoricalApplications ?? 512;
    if (!positive(this.maxHistoricalApplications) || this.maxHistoricalApplications > 4096) invalid();
  }
  async activate(input: WalletPolicyActivation): Promise<WalletPolicySnapshot> {
    // Copy bounded data synchronously before waiting for a connection or lock; later caller mutation cannot change approval.
    const request = plainFields(input, ["expectedRevision", "nextRevision", "configuration"]);
    const expectedRevision = request.expectedRevision, nextRevision = request.nextRevision;
    if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || !positive(nextRevision) || nextRevision !== expectedRevision + 1) invalid();
    const configuration = validateWalletPolicyConfiguration(request.configuration);
    const hash = walletPolicyConfigurationHash(configuration), encoded = JSON.stringify(configuration);
    if (Buffer.byteLength(encoded, "utf8") > 32768) invalid();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // The resolved table, rather than the first search_path schema, identifies shared authority.
      // This also serializes initial activation when the singleton row does not exist yet.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('wallet-policy:' || 'rest_wallet_policy'::regclass::oid::text, 0))");
      const prior = await readSnapshot(client), revision = prior?.revision ?? 0;
      if (revision === nextRevision && prior?.configurationHash === hash) { await client.query("COMMIT"); return prior; }
      if (revision !== expectedRevision) conflict();
      const apps = new Map((prior?.apps ?? []).map(app => [app.origin, app]));
      const next = new Map(configuration.applications.map(app => [app.origin, app]));
      const origins = [...new Set([...apps.keys(), ...next.keys()])].sort();
      if (origins.length > this.maxHistoricalApplications)
        throw new RestError(429, "WALLET_POLICY_LIMIT", "Wallet policy historical application limit reached.");
      if (!prior) await client.query(
        `INSERT INTO rest_wallet_policy(id,revision,configuration_hash,configuration,activated_at) VALUES(1,$1,$2,$3,${nowSql})`,
        [nextRevision, hash, encoded],
      );
      for (const origin of origins) {
        const old = apps.get(origin), desired = next.get(origin), enabled = desired !== undefined;
        const callbacks = desired ? [...desired.walletCallbacks] : [];
        // An activation states the whole allowlist: an application listed without a lifetime gets the hour.
        const lifetime = desired?.grantLifetimeSeconds ?? walletAppGrantDefaultLifetimeSeconds;
        const sameAdmission = old !== undefined && old.enabled === enabled && JSON.stringify(old.walletCallbacks) === JSON.stringify(callbacks);
        if (sameAdmission && old.grantLifetimeSeconds === lifetime) continue;
        // The lifetime is not part of what a grant was admitted under: changing it alone leaves the
        // generation, and so every live grant, as it is. Callback or enablement changes still advance it.
        if (sameAdmission) { await client.query("UPDATE rest_wallet_policy_apps SET grant_lifetime_seconds=$2 WHERE origin=$1", [origin, lifetime]); continue; }
        if (old?.generation === Number.MAX_SAFE_INTEGER) conflict();
        if (old) await client.query(
          "UPDATE rest_wallet_policy_apps SET wallet_callbacks=$2,generation=generation+1,enabled=$3,grant_lifetime_seconds=$4 WHERE origin=$1",
          [origin, callbacks, enabled, lifetime],
        );
        else await client.query(
          "INSERT INTO rest_wallet_policy_apps(origin,wallet_callbacks,generation,enabled,grant_lifetime_seconds) VALUES($1,$2,1,true,$3)",
          [origin, callbacks, lifetime],
        );
      }
      if (prior) await client.query(
        `UPDATE rest_wallet_policy SET revision=$1,configuration_hash=$2,configuration=$3,activated_at=${nowSql} WHERE id=1`,
        [nextRevision, hash, encoded],
      );
      const result = (await readSnapshot(client))!;
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  readActivePolicy(): Promise<WalletPolicySnapshot | null> { return readSnapshot(this.pool); }
}
