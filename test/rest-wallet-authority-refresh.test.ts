import { afterEach, describe, expect, it, vi } from 'vitest';
import { RestError } from '../src/rest/core.js';
import { createWalletAuthorityRefresh, type AuthorityRefreshEvent, type AuthorityRefreshLease,
  type AuthorityRefreshQueue } from '../src/rest/wallet/authorityRefresh.js';
import type { WalletAuthoritySnapshot } from '../src/rest/wallet/authority.js';
import { restRequest, withRestRequest } from '../src/rest/context.js';

const account = `eip155:8453:0x${'12'.repeat(20)}`, now = 1_800_000_120_000;
const lease = (number = 1): AuthorityRefreshLease => ({ accountId: account,
  token: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`, untilMs: now + 45_000 });
// Producer doubles exercise scheduling only. Authority proof and storage have independent real-EVM/PG suites.
const snapshot = (validUntilMs: number | null = now + 30_000, readiness = 'verified') => ({
  accountId: account, readiness, bootstrapRequired: false, activeFence: null, validUntilMs,
}) as WalletAuthoritySnapshot;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(options: { concurrency?: number; attemptTimeoutMs?: number; shutdownTimeoutMs?: number; tickMs?: number } = {}) {
  const events: AuthorityRefreshEvent[] = [];
  const queue = {
    request: vi.fn<AuthorityRefreshQueue['request']>(async () => ({ status: 'queued', retryAtMs: now })),
    claim: vi.fn<AuthorityRefreshQueue['claim']>().mockResolvedValueOnce(lease()).mockResolvedValue(null),
    complete: vi.fn<AuthorityRefreshQueue['complete']>(async () => true),
    stats: vi.fn<AuthorityRefreshQueue['stats']>(async () => ({ tracked: 1, interested: 1, due: 0, inFlight: 0,
      oldestDueAtMs: null, startsInWindow: 1, maxStartsPerMinute: 30 })),
  };
  const service = { refreshAuthority: vi.fn(async (_account: string, _signal?: AbortSignal) => ({ snapshot: snapshot(), replayed: false })) };
  const worker = createWalletAuthorityRefresh({ queue, service, now: () => now, onEvent: event => events.push(event), ...options });
  return { worker, queue, service, events };
}
afterEach(() => { vi.useRealTimers(); });

describe('bounded internal wallet authority refresh worker', () => {
  it('claims before calling the existing service and completes only aggregate scheduling metadata', async () => {
    const f = fixture({ concurrency: 1 });
    const result = await f.worker.tick();
    expect(f.service.refreshAuthority).toHaveBeenCalledOnce();
    expect(f.service.refreshAuthority.mock.calls[0]![0]).toBe(account);
    expect(f.queue.complete).toHaveBeenCalledExactlyOnceWith(lease(), { outcome: 'verified', readyUntilMs: now + 30_000 });
    expect(result).toEqual({ claimed: 1, verified: 1, unready: 0, progress: 0, conflicts: 0, failed: 0, leaseLost: 0, queueFailed: 0 });
    expect(f.events).toEqual(['verified']);
    expect(await f.worker.stats()).toEqual(await f.queue.stats());
    await f.worker.stop();
  });

  it.each([now - 1, now, null])('never turns an expired replay receipt into renewed readiness (%s)', async deadline => {
    const f = fixture({ concurrency: 1 });
    f.service.refreshAuthority.mockResolvedValue({ snapshot: snapshot(deadline), replayed: true });
    expect(await f.worker.tick()).toMatchObject({ verified: 0, unready: 1 });
    expect(f.queue.complete).toHaveBeenCalledWith(lease(), { outcome: 'unready', readyUntilMs: null });
    await f.worker.stop();
  });

  it('reports a history still catching up as progress, not as an unready failure', async () => {
    const f = fixture({ concurrency: 1 });
    f.service.refreshAuthority.mockResolvedValue({ snapshot: { ...snapshot(null, 'unknown'),
      latestObservation: { reason: 'authority-history-catching-up' } } as WalletAuthoritySnapshot, replayed: false });
    expect(await f.worker.tick()).toMatchObject({ progress: 1, unready: 0, verified: 0 });
    expect(f.queue.complete).toHaveBeenCalledWith(lease(), { outcome: 'progress', readyUntilMs: null });
    await f.worker.stop();
  });

  it('treats fenced authority and a mismatched service account as unavailable scheduling results', async () => {
    const f = fixture({ concurrency: 1 });
    f.service.refreshAuthority.mockResolvedValue({ snapshot: snapshot(now + 30_000, 'fenced'), replayed: false });
    expect(await f.worker.tick()).toMatchObject({ unready: 1 });
    f.queue.claim.mockResolvedValueOnce(lease(2));
    f.service.refreshAuthority.mockResolvedValue({ snapshot: { ...snapshot(), accountId: `eip155:8453:0x${'34'.repeat(20)}` }, replayed: false });
    expect(await f.worker.tick()).toMatchObject({ failed: 1, verified: 0 });
    await f.worker.stop();
  });

  it('coalesces overlapping ticks and never exceeds the configured number of local in-flight jobs', async () => {
    const f = fixture({ concurrency: 2 }), pending = deferred<{ snapshot: WalletAuthoritySnapshot; replayed: boolean }>();
    f.queue.claim.mockReset().mockResolvedValueOnce(lease()).mockResolvedValueOnce(lease(2)).mockResolvedValueOnce(lease(3)).mockResolvedValue(null);
    f.service.refreshAuthority.mockImplementation(() => pending.promise);
    const first = f.worker.tick(), second = f.worker.tick();
    await vi.waitFor(() => expect(f.service.refreshAuthority).toHaveBeenCalledTimes(2));
    expect(f.queue.claim).toHaveBeenCalledTimes(2);
    pending.resolve({ snapshot: snapshot(), replayed: false });
    expect(await first).toEqual(await second);
    await f.worker.tick();
    expect(f.service.refreshAuthority).toHaveBeenCalledTimes(3);
    await f.worker.stop();
  });

  it('refills a completed slot while retaining a stubborn peer in its own bounded slot', async () => {
    const f = fixture({ concurrency: 2 }), stuck = deferred<{ snapshot: WalletAuthoritySnapshot; replayed: boolean }>();
    f.queue.claim.mockReset().mockResolvedValueOnce(lease()).mockResolvedValueOnce(lease(2)).mockResolvedValueOnce(lease(3)).mockResolvedValue(null);
    f.service.refreshAuthority.mockImplementationOnce(() => stuck.promise);
    const first = f.worker.tick();
    try {
      await vi.waitFor(() => expect(f.queue.complete).toHaveBeenCalledTimes(1));
      void f.worker.tick();
      await vi.waitFor(() => expect(f.service.refreshAuthority).toHaveBeenCalledTimes(3), { timeout: 200 });
    } finally {
      stuck.resolve({ snapshot: snapshot(), replayed: false });
      await first; await f.worker.stop();
    }
  });

  it('returns demand admission without inline RPC and rejects malformed account identities first', async () => {
    const f = fixture();
    expect(await f.worker.request(account)).toEqual({ status: 'queued', retryAtMs: now });
    f.queue.request.mockResolvedValue({ status: 'overloaded', retryAtMs: now + 1_000 });
    expect(await f.worker.request(account)).toEqual({ status: 'overloaded', retryAtMs: now + 1_000 });
    expect(f.service.refreshAuthority).not.toHaveBeenCalled();
    for (const invalid of ['', 'eip155:1:0x' + '12'.repeat(20), 'eip155:8453:0x' + 'AB'.repeat(20)])
      await expect(f.worker.request(invalid)).rejects.toMatchObject({ code: 'WALLET_AUTHORITY_ACCOUNT_INVALID' });
    expect(f.queue.request).toHaveBeenCalledTimes(2);
    await f.worker.stop();
  });

  it('runs shared refresh outside the requesting HTTP cancellation context', async () => {
    const f = fixture({ concurrency: 1 }), caller = new AbortController();
    let inheritedRequest = false, workerSignal: AbortSignal | undefined;
    f.service.refreshAuthority.mockImplementation(async (_account, signal) => {
      inheritedRequest = restRequest() !== undefined; workerSignal = signal;
      caller.abort();
      return { snapshot: snapshot(), replayed: false };
    });
    const result = await withRestRequest(caller.signal, () => f.worker.tick());
    expect(result.verified).toBe(1);
    expect(inheritedRequest).toBe(false);
    expect(workerSignal!.aborted).toBe(false);
    await f.worker.stop();
  });

  it('reports lost lease completion without claiming a fresh worker result', async () => {
    const f = fixture({ concurrency: 1 }); f.queue.complete.mockResolvedValue(false);
    expect(await f.worker.tick()).toMatchObject({ claimed: 1, leaseLost: 1, verified: 0 });
    expect(f.events).toEqual(['lease_lost']);
    await f.worker.stop();
  });

  it('classifies a context conflict once without reloading or retrying captured epochs', async () => {
    const f = fixture({ concurrency: 1 });
    f.service.refreshAuthority.mockRejectedValue(new RestError(409, 'WALLET_AUTHORITY_CONFLICT', 'private provider detail'));
    expect(await f.worker.tick()).toMatchObject({ conflicts: 1 });
    expect(f.service.refreshAuthority).toHaveBeenCalledOnce();
    expect(f.queue.complete).toHaveBeenCalledWith(lease(), { outcome: 'conflict', readyUntilMs: null });
    expect(f.events).toEqual(['conflict']);
    await f.worker.stop();
  });

  it('drains already claimed work if a later claim fails, and reports only fixed error categories', async () => {
    const f = fixture({ concurrency: 2 });
    f.queue.claim.mockReset().mockResolvedValueOnce(lease()).mockRejectedValueOnce(new Error('secret query'));
    expect(await f.worker.tick()).toMatchObject({ claimed: 1, verified: 1, queueFailed: 1 });
    expect(f.queue.complete).toHaveBeenCalledOnce();
    expect([...f.events].sort()).toEqual(['queue_failed', 'verified']);
    f.queue.claim.mockResolvedValueOnce(lease(2));
    f.queue.complete.mockRejectedValue(new Error('sensitive observation'));
    expect(await f.worker.tick()).toMatchObject({ queueFailed: 1, verified: 0 });
    expect(JSON.stringify(f.events)).not.toContain('sensitive');
    await f.worker.stop();
  });

  it('starts one bounded timer, stops it, and cannot resurrect demand after shutdown', async () => {
    vi.useFakeTimers();
    const f = fixture({ tickMs: 10, concurrency: 1 }); f.queue.claim.mockReset().mockResolvedValue(null);
    f.worker.start(); f.worker.start();
    await vi.advanceTimersByTimeAsync(25);
    expect(f.queue.claim).toHaveBeenCalledTimes(3);
    await f.worker.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.queue.claim).toHaveBeenCalledTimes(3);
    await expect(f.worker.request(account)).rejects.toMatchObject({ code: 'WALLET_AUTHORITY_STOPPED' });
    expect(() => f.worker.start()).toThrow();
  });

  it('aborts timed-out work but retains its local slot until a stubborn service settles', async () => {
    vi.useFakeTimers();
    const f = fixture({ concurrency: 1, attemptTimeoutMs: 10, shutdownTimeoutMs: 5 });
    const pending = deferred<{ snapshot: WalletAuthoritySnapshot; replayed: boolean }>();
    f.service.refreshAuthority.mockImplementation(() => pending.promise);
    const running = f.worker.tick();
    await vi.advanceTimersByTimeAsync(11);
    expect(f.service.refreshAuthority.mock.calls[0]![1]!.aborted).toBe(true);
    void f.worker.tick();
    expect(f.queue.claim).toHaveBeenCalledOnce();
    const stopped = f.worker.stop();
    await vi.advanceTimersByTimeAsync(6); await stopped;
    expect(f.events).toEqual(['attempt_timeout', 'shutdown_timeout']);
    // A completed observation still belongs to the authority service; the queue alone is lease-fenced.
    pending.resolve({ snapshot: snapshot(), replayed: false }); await running;
    expect(f.queue.complete).toHaveBeenCalledOnce();
    await f.worker.stop();
  });

  it('captures configured dependencies and isolates aggregate observation sink failures', async () => {
    const f = fixture({ concurrency: 1 }), original = f.queue.claim;
    f.queue.claim = vi.fn(async () => { throw new Error('replaced'); });
    expect(await f.worker.tick()).toMatchObject({ verified: 1 });
    expect(original).toHaveBeenCalledOnce();
    const separate = createWalletAuthorityRefresh({ queue: { ...f.queue, claim: async () => lease() }, service: f.service,
      concurrency: 1, now: () => now, onEvent: () => { throw new Error('sink failure'); } });
    expect(await separate.tick()).toMatchObject({ verified: 1 });
    await separate.stop(); await f.worker.stop();
  });
});
