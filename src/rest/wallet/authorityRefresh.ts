import type { WalletAuthoritySnapshot } from './authority.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { RestError } from '../core.js';
import { walletAppAccount, walletAppUuid } from './appGrants.js';

export interface AuthorityRefreshLease { accountId: string; token: string; untilMs: number }
export type AuthorityRefreshOutcome = 'verified' | 'unready' | 'conflict' | 'failed';
export interface AuthorityRefreshResult { outcome: AuthorityRefreshOutcome; readyUntilMs: number | null }
export interface AuthorityRefreshRequest { status: 'queued' | 'coalesced' | 'overloaded'; retryAtMs: number | null }
export interface AuthorityRefreshStats {
  tracked: number; interested: number; due: number; inFlight: number;
  oldestDueAtMs: number | null; startsInWindow: number; maxStartsPerMinute: number;
}
export interface AuthorityRefreshQueue {
  request(accountId: string): Promise<AuthorityRefreshRequest>;
  claim(): Promise<AuthorityRefreshLease | null>;
  complete(lease: AuthorityRefreshLease, result: AuthorityRefreshResult): Promise<boolean>;
  stats(): Promise<AuthorityRefreshStats>;
}
export interface AuthorityRefreshTick {
  claimed: number; verified: number; unready: number; conflicts: number;
  failed: number; leaseLost: number; queueFailed: number;
}
export type AuthorityRefreshEvent = 'verified' | 'unready' | 'conflict' | 'failed' | 'lease_lost'
  | 'queue_failed' | 'attempt_timeout' | 'shutdown_timeout';
export interface AuthorityRefreshOptions {
  queue: AuthorityRefreshQueue;
  service: { refreshAuthority(accountId: string, signal?: AbortSignal): Promise<{ snapshot: WalletAuthoritySnapshot; replayed: boolean }> };
  concurrency?: number; tickMs?: number; attemptTimeoutMs?: number; shutdownTimeoutMs?: number;
  now?: () => number; onEvent?: (event: AuthorityRefreshEvent) => void;
}

/** Construct during runtime startup, outside HTTP request context. Internal demand comes from
 * a proved identity; queueing itself grants no authority. */
export function createWalletAuthorityRefresh(options: AuthorityRefreshOptions): {
  request(accountId: string): Promise<AuthorityRefreshRequest>;
  tick(): Promise<AuthorityRefreshTick>;
  start(): void;
  stop(): Promise<void>;
  stats(): Promise<AuthorityRefreshStats>;
} {
  const concurrency = options.concurrency ?? 2, tickMs = options.tickMs ?? 500;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 30_000, shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
  // An attempt covers one hosted-provider observation (budget 90 s) plus the store round trips.
  if ([[concurrency, 2], [tickMs, 1_000], [attemptTimeoutMs, 120_000], [shutdownTimeoutMs, 5_000]]
    .some(([value, maximum]) => !Number.isSafeInteger(value) || value! < 1 || value! > maximum!))
    throw new RestError(500, 'WALLET_AUTHORITY_REFRESH_CONFIG_INVALID', 'Use bounded authority refresh worker settings.');
  const request = options.queue.request.bind(options.queue), claim = options.queue.claim.bind(options.queue);
  const complete = options.queue.complete.bind(options.queue), stats = options.queue.stats.bind(options.queue);
  const refresh = options.service.refreshAuthority.bind(options.service), now = options.now ?? Date.now, observer = options.onEvent;
  // The shared runtime RPC wrapper consults request-local cancellation. Preserve startup context
  // even when a trusted HTTP request wakes this worker; its disconnect must not cancel shared work.
  const inWorkerContext = AsyncLocalStorage.snapshot();
  const shutdown = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined, currentTick: Promise<AuthorityRefreshTick> | undefined;
  let currentClaims: Promise<Promise<void>[]> | undefined;
  const inFlight = new Set<Promise<void>>();
  let stopped = false, closing: Promise<void> | undefined;
  const empty = (): AuthorityRefreshTick => ({ claimed: 0, verified: 0, unready: 0, conflicts: 0, failed: 0, leaseLost: 0, queueFailed: 0 });
  const emit = (event: AuthorityRefreshEvent) => { try { observer?.(event); } catch { /* Metrics cannot change scheduling or authority. */ } };
  const assertRunning = () => {
    if (stopped) throw new RestError(503, 'WALLET_AUTHORITY_STOPPED', 'Authority refresh is stopping.');
  };
  const fresh = (result: AuthorityRefreshResult): boolean => {
    const current = now();
    return Number.isSafeInteger(current) && current > 0 && Number.isSafeInteger(result.readyUntilMs) && result.readyUntilMs! > current;
  };
  async function attempt(lease: AuthorityRefreshLease, counts: AuthorityRefreshTick): Promise<void> {
    const controller = new AbortController(), abort = () => controller.abort();
    shutdown.signal.addEventListener('abort', abort, { once: true });
    if (shutdown.signal.aborted) abort();
    const deadline = setTimeout(() => { emit('attempt_timeout'); controller.abort(); }, attemptTimeoutMs);
    deadline.unref();
    let result: AuthorityRefreshResult = { outcome: 'failed', readyUntilMs: null };
    try {
      if (!controller.signal.aborted && lease.untilMs > now()) {
        const { snapshot } = await refresh(lease.accountId, controller.signal);
        if (snapshot.accountId !== lease.accountId) throw new Error('Mismatched authority account');
        result = { outcome: 'unready', readyUntilMs: null };
        if (snapshot.readiness === 'verified' && !snapshot.bootstrapRequired && snapshot.activeFence === null
          && fresh({ outcome: 'verified', readyUntilMs: snapshot.validUntilMs }))
          result = { outcome: 'verified', readyUntilMs: snapshot.validUntilMs };
      }
    } catch (error) {
      result = { outcome: error instanceof RestError && error.code === 'WALLET_AUTHORITY_CONFLICT' ? 'conflict' : 'failed', readyUntilMs: null };
    } finally {
      clearTimeout(deadline); shutdown.signal.removeEventListener('abort', abort);
    }
    // Completed observations belong to the existing authority service, including proven revocation.
    // Leases fence only queue acknowledgement. Never rewrite epochs or turn a late receipt into fresh evidence.
    try {
      if (!await complete(lease, result)) { counts.leaseLost++; emit('lease_lost'); return; }
      if (result.outcome === 'verified' && !fresh(result)) result = { outcome: 'unready', readyUntilMs: null };
      counts[result.outcome === 'conflict' ? 'conflicts' : result.outcome]++;
      emit(result.outcome);
    } catch { counts.queueFailed++; emit('queue_failed'); }
  }
  async function claimAvailable(counts: AuthorityRefreshTick): Promise<Promise<void>[]> {
    const work: Promise<void>[] = [];
    for (let slot = 0; slot < concurrency && inFlight.size < concurrency && !stopped; slot++) {
      try {
        const lease = await claim();
        if (!lease) break;
        if (!walletAppAccount(lease.accountId) || !walletAppUuid(lease.token)
          || !Number.isSafeInteger(lease.untilMs) || lease.untilMs <= 0) throw new Error('Invalid scheduling lease');
        counts.claimed++;
        const job = attempt({ ...lease }, counts).finally(() => { inFlight.delete(job); });
        inFlight.add(job); work.push(job);
      } catch { counts.queueFailed++; emit('queue_failed'); break; }
    }
    return work;
  }
  function tick(): Promise<AuthorityRefreshTick> {
    if (stopped) return Promise.resolve(empty());
    if (currentTick) return currentTick;
    const counts = empty(), claims = inWorkerContext(claimAvailable, counts);
    currentClaims = claims;
    const finished = claims.then(async work => { await Promise.all(work); return counts; });
    currentTick = finished;
    const claimed = () => { if (currentClaims === claims) { currentClaims = undefined; currentTick = undefined; } };
    void claims.then(claimed, claimed);
    // Coalesce claim passes, not entire batches. A slow transport retains its own slot while
    // later ticks refill completed slots; only the configured observer bounds physical RPC work.
    return finished;
  }
  function kick() { void tick().catch(() => emit('queue_failed')); }
  return {
    async request(accountId) {
      assertRunning();
      if (!walletAppAccount(accountId)) throw new RestError(400, 'WALLET_AUTHORITY_ACCOUNT_INVALID', 'A canonical Base wallet account is required.');
      const result = await request(accountId);
      if (timer && !stopped && result.status !== 'overloaded') kick();
      return result;
    },
    tick,
    start() {
      assertRunning(); if (timer) return;
      timer = setInterval(kick, tickMs); timer.unref(); kick();
    },
    stop() {
      if (closing) return closing;
      stopped = true; if (timer) clearInterval(timer); shutdown.abort();
      closing = new Promise<void>(resolve => {
        const deadline = setTimeout(() => { emit('shutdown_timeout'); resolve(); }, shutdownTimeoutMs);
        const done = () => { clearTimeout(deadline); resolve(); };
        void Promise.resolve(currentClaims).then(() => Promise.allSettled([...inFlight])).then(done, done);
      });
      return closing;
    },
    stats,
  };
}
