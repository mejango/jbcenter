import type { Pool } from "pg";
import type { Hex } from "viem";
import { RestError } from "../core.js";
import type { WalletNetworkBundle, WalletNetworkRow, WalletNetworksStore } from "./networks.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function invalid(): never { throw new RestError(400, "WALLET_NETWORKS_INVALID", "Invalid network record."); }
type BundleRow = { id: string; account_id: string; family: string; state: string; bundle_uuid: string; document: Omit<WalletNetworkBundle, "id" | "accountId" | "family" | "state" | "createdAtMs" | "updatedAtMs">; created_at_ms: string; updated_at_ms: string };
type NetworkRow = { chain_id: string; state: string; bundle_id: string | null; tx_hash: string | null; updated_at_ms: string };
const bundleOf = (row: BundleRow): WalletNetworkBundle => ({ ...row.document, id: row.id, accountId: row.account_id, family: row.family as WalletNetworkBundle["family"],
  state: row.state as WalletNetworkBundle["state"], createdAtMs: Number(row.created_at_ms), updatedAtMs: Number(row.updated_at_ms) });
const networkOf = (row: NetworkRow): WalletNetworkRow => ({ chainId: Number(row.chain_id), state: row.state as WalletNetworkRow["state"], bundleId: row.bundle_id,
  txHash: row.tx_hash as Hex | null, updatedAtMs: Number(row.updated_at_ms) });
/** Durable bundle and per-chain records. Authority for the account itself lives elsewhere; these rows only say what was quoted, paid and seen. */
export class PostgresWalletNetworksStore implements WalletNetworksStore {
  constructor(private readonly pool: Pool) {}
  async listNetworks(accountId: string): Promise<WalletNetworkRow[]> {
    return (await this.pool.query<NetworkRow>("SELECT chain_id,state,bundle_id,tx_hash,updated_at_ms FROM rest_wallet_networks WHERE account_id=$1 ORDER BY chain_id", [accountId])).rows.map(networkOf);
  }
  async listBundles(accountId: string): Promise<WalletNetworkBundle[]> {
    return (await this.pool.query<BundleRow>("SELECT * FROM rest_wallet_network_bundles WHERE account_id=$1 ORDER BY created_at_ms,id", [accountId])).rows.map(bundleOf);
  }
  async getBundle(accountId: string, id: string): Promise<WalletNetworkBundle | null> {
    if (!uuid.test(id)) invalid();
    const row = (await this.pool.query<BundleRow>("SELECT * FROM rest_wallet_network_bundles WHERE account_id=$1 AND id=$2", [accountId, id])).rows[0];
    return row ? bundleOf(row) : null;
  }
  async createBundle(bundle: WalletNetworkBundle, now: number): Promise<void> {
    const { id, accountId, family, state, createdAtMs: _c, updatedAtMs: _u, ...document } = bundle;
    if (!uuid.test(id) || !uuid.test(document.quote.bundleUuid)) invalid();
    await this.pool.query(`INSERT INTO rest_wallet_network_bundles(id,account_id,family,state,bundle_uuid,document,created_at_ms,updated_at_ms)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$7)`, [id, accountId, family, state, document.quote.bundleUuid, JSON.stringify(document), now]);
  }
  async transitionBundle(bundle: WalletNetworkBundle, from: WalletNetworkBundle["state"], now: number): Promise<boolean> {
    const { id, accountId, family: _f, state, createdAtMs: _c, updatedAtMs: _u, ...document } = bundle;
    const result = await this.pool.query("UPDATE rest_wallet_network_bundles SET state=$3,document=$4::jsonb,updated_at_ms=GREATEST(updated_at_ms,$5) WHERE account_id=$1 AND id=$2 AND state=$6",
      [accountId, id, state, JSON.stringify(document), now, from]);
    return result.rowCount === 1;
  }
  async claimNetworks(accountId: string, chainIds: number[], bundleId: string, now: number): Promise<number> {
    let claimed = 0;
    for (const chainId of chainIds) {
      const result = await this.pool.query(`INSERT INTO rest_wallet_networks(account_id,chain_id,state,bundle_id,tx_hash,updated_at_ms) VALUES($1,$2,'quoted',$3,NULL,$4)
        ON CONFLICT(account_id,chain_id) DO UPDATE SET state='quoted',bundle_id=EXCLUDED.bundle_id,tx_hash=NULL,updated_at_ms=GREATEST(rest_wallet_networks.updated_at_ms,EXCLUDED.updated_at_ms)
        WHERE rest_wallet_networks.state='failed'`, [accountId, chainId, bundleId, now]);
      claimed += result.rowCount ?? 0;
    }
    return claimed;
  }
  async upsertNetwork(accountId: string, row: Omit<WalletNetworkRow, "updatedAtMs">, now: number): Promise<void> {
    await this.pool.query(`INSERT INTO rest_wallet_networks(account_id,chain_id,state,bundle_id,tx_hash,updated_at_ms) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(account_id,chain_id) DO UPDATE SET state=EXCLUDED.state,bundle_id=EXCLUDED.bundle_id,tx_hash=EXCLUDED.tx_hash,updated_at_ms=GREATEST(rest_wallet_networks.updated_at_ms,EXCLUDED.updated_at_ms)`,
      [accountId, row.chainId, row.state, row.bundleId, row.txHash?.toLowerCase() ?? null, now]);
  }
}
