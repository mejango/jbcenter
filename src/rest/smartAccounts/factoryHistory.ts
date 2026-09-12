import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { Pool } from "pg";
import { keccak256, stringToHex, padHex, type Address, type Hex } from "viem";
import { RestError, type RestRpc } from "../core.js";

const topic = keccak256(stringToHex("ProxyCreation(address,address)"));
const word = /^0x[0-9a-fA-F]{64}$/;
const address = /^0x[0-9a-fA-F]{40}$/;
export interface FactoryHistorySeed { chainId: number; factory: Address; through: number; hash: Hex; creations: [Address, number][] }
function unavailable(message: string): never { throw new RestError(503, "SMART_FACTORY_HISTORY_PENDING", message); }
export async function loadFactoryHistorySeed(): Promise<FactoryHistorySeed> {
  const bytes = gunzipSync(await readFile(new URL("./factory-history/base.json.gz", import.meta.url)));
  const expected = (await readFile(new URL("./factory-history/base.sha256", import.meta.url), "utf8")).trim();
  if (createHash("sha256").update(bytes).digest("hex") !== expected) unavailable("The retained factory index failed its integrity check.");
  const seed = JSON.parse(bytes.toString()) as FactoryHistorySeed;
  if (seed.chainId !== 8453 || !address.test(seed.factory) || !Number.isSafeInteger(seed.through) || seed.through < 0 || !word.test(seed.hash) || !Array.isArray(seed.creations)
      || seed.creations.some(row => !Array.isArray(row) || row.length !== 2 || !address.test(row[0]) || !Number.isSafeInteger(row[1]) || row[1] < 0 || row[1] > seed.through)) unavailable("The retained factory index is malformed.");
  return seed;
}

/** Server-built complete finalized prefix. It is not supplied by callers and never proves
 * authority itself: the inspector still checks canonical creation receipts, exact initializer,
 * pinned runtime, and every subsequent authority ingress. Empty pages advance only atomically.
 */
export class FactoryHistoryIndex {
  private syncing: Promise<void> | undefined;
  private readonly shutdown = new AbortController();
  async stop() { this.shutdown.abort(); await this.syncing?.catch(() => {}); }
  constructor(private readonly pool: Pool, private readonly rpc: RestRpc, readonly seed: FactoryHistorySeed) {}
  private async header(block: string, signal?: AbortSignal) {
    const h = await this.rpc.request(this.seed.chainId, "eth_getBlockByNumber", [block, false], signal) as {number?: string; hash?: string};
    if (!h || typeof h.number !== "string" || !/^0x[0-9a-f]+$/i.test(h.number) || !word.test(h.hash ?? "")) unavailable("A canonical factory-index anchor is unavailable.");
    return {number: BigInt(h.number), hash: h.hash!};
  }
  private async logs(from: bigint, to: bigint, proxy?: Address, signal?: AbortSignal) {
    if (to < from || to - from >= 500n) throw new Error("Factory history requires 500-block pages");
    const result = await this.rpc.request(this.seed.chainId, "eth_getLogs", [{address: this.seed.factory, topics: proxy ? [topic, padHex(proxy, {size: 32})] : [topic], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`}], signal);
    if (!Array.isArray(result) || result.length >= 10000) unavailable("A factory history page is incomplete.");
    const seen = new Set<string>();
    for (const l of result) {
      if (!l || l.removed !== false || typeof l.address !== "string" || l.address.toLowerCase() !== this.seed.factory.toLowerCase() || !Array.isArray(l.topics) || l.topics.length !== 2 || l.topics[0] !== topic || !/^0x0{24}[0-9a-fA-F]{40}$/.test(l.topics[1]) || !word.test(l.blockHash) || !word.test(l.transactionHash) || !/^0x[0-9a-f]+$/i.test(l.blockNumber) || !/^0x[0-9a-f]+$/i.test(l.logIndex) || BigInt(l.blockNumber) < from || BigInt(l.blockNumber) > to || (proxy && l.topics[1].slice(-40).toLowerCase() !== proxy.slice(2).toLowerCase())) unavailable("A factory history page contains invalid evidence.");
      const id = `${l.blockHash}:${l.logIndex}`; if (seen.has(id)) unavailable("A factory history page contains duplicate evidence."); seen.add(id);
    }
    return result as Record<string, any>[];
  }
  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    if (this.shutdown.signal.aborted) return Promise.reject(new Error("Factory index is stopping"));
    const run = this.advance(); this.syncing = run;
    void run.finally(() => { if (this.syncing === run) this.syncing = undefined; }).catch(() => {});
    return run;
  }
  private async advance() {
    const signal = AbortSignal.any([AbortSignal.timeout(25000),this.shutdown.signal]), client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const lock = await client.query<{locked: boolean}>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked", [`factory-history:${this.seed.chainId}:${this.seed.factory.toLowerCase()}`]);
      if (!lock.rows[0]?.locked) { await client.query("ROLLBACK"); return; }
      const row = await client.query<{through_block: string; block_hash: string}>("SELECT through_block,block_hash FROM rest_factory_history WHERE chain_id=$1 AND factory=$2", [this.seed.chainId,this.seed.factory.toLowerCase()]);
      let through = BigInt(row.rows[0]?.through_block ?? this.seed.through), hash = row.rows[0]?.block_hash ?? this.seed.hash;
      if (through < BigInt(this.seed.through)) unavailable("The factory index predates its retained prefix.");
      if ((await this.header(`0x${through.toString(16)}`,signal)).hash.toLowerCase() !== hash.toLowerCase()) unavailable("The finalized factory index changed; it must be rebuilt.");
      const previousThrough = through, previousHash = hash;
      const finalized = await this.header("finalized",signal);
      // Small transactions keep request latency and quota bounded. Maintenance resumes the rest.
      for (let page = 0; page < 12 && through < finalized.number; page++) {
        const to = through + 500n < finalized.number ? through + 500n : finalized.number;
        const logs = await this.logs(through + 1n,to,undefined,signal);
        if (logs.length) await client.query("INSERT INTO rest_factory_creations(chain_id,factory,proxy,block_number,log_index) SELECT $1,$2,proxy,block_number,log_index FROM unnest($3::text[],$4::bigint[],$5::bigint[]) AS page(proxy,block_number,log_index) ON CONFLICT DO NOTHING", [this.seed.chainId,this.seed.factory.toLowerCase(),logs.map(log=>`0x${log.topics[1].slice(-40)}`.toLowerCase()),logs.map(log=>BigInt(log.blockNumber).toString()),logs.map(log=>BigInt(log.logIndex).toString())]);
        through = to;
      }
      hash = (await this.header(`0x${through.toString(16)}`,signal)).hash;
      await client.query("INSERT INTO rest_factory_history(chain_id,factory,through_block,block_hash) VALUES($1,$2,$3,$4) ON CONFLICT(chain_id,factory) DO UPDATE SET through_block=EXCLUDED.through_block,block_hash=EXCLUDED.block_hash", [this.seed.chainId,this.seed.factory.toLowerCase(),through.toString(),hash]);
      if ((await this.header(`0x${previousThrough.toString(16)}`,signal)).hash.toLowerCase() !== previousHash.toLowerCase()) unavailable("The factory index anchor changed during its update.");
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally {client.release();}
  }
  async creationLogs(chainId: number, factory: Address, proxy: Address, end: bigint, signal?: AbortSignal): Promise<Record<string, unknown>[] | undefined> {
    if (chainId !== this.seed.chainId || factory.toLowerCase() !== this.seed.factory.toLowerCase()) return undefined;
    await this.sync();
    const row = await this.pool.query<{through_block: string; block_hash: string}>("SELECT through_block,block_hash FROM rest_factory_history WHERE chain_id=$1 AND factory=$2",[chainId,factory.toLowerCase()]);
    const through = BigInt(row.rows[0]?.through_block ?? this.seed.through);
    const hash = row.rows[0]?.block_hash ?? this.seed.hash;
    if ((await this.header(`0x${through.toString(16)}`,signal)).hash.toLowerCase() !== hash.toLowerCase()) unavailable("The factory index anchor is no longer canonical.");
    if (end > through + 10000n) unavailable("Account history is catching up. Try checking the account again shortly.");
    const prefix = this.seed.creations.filter(([account,block])=>account.toLowerCase()===proxy.toLowerCase() && BigInt(block)<=end).map(([,block])=>BigInt(block));
    const tail = await this.pool.query<{block_number:string}>("SELECT block_number FROM rest_factory_creations WHERE chain_id=$1 AND factory=$2 AND proxy=$3 AND block_number<=$4 AND block_number>$5",[chainId,factory.toLowerCase(),proxy.toLowerCase(),end.toString(),this.seed.through]);
    const blocks = [...prefix,...tail.rows.map(r=>BigInt(r.block_number))];
    const found: Record<string,unknown>[] = [];
    for (const block of new Set(blocks)) found.push(...await this.logs(block,block,proxy,signal));
    if (found.length !== blocks.length) unavailable("The retained creation index disagrees with canonical logs.");
    for (let from=through+1n;from<=end;from+=500n) found.push(...await this.logs(from,from+499n<end?from+499n:end,proxy,signal));
    return found;
  }
}
