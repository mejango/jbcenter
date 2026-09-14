export interface PressureOffer { sequence: number; route: "read" | "diagnostic-claim"; app: 0 | 1; scheduledAtMs: number }
export interface PressureExecution { status: number | "network-error"; admitted: boolean; success: boolean }
export const PRESSURE_HISTOGRAM_METADATA = Object.freeze({
  estimator: "nearest-rank-logarithmic-upper-bound-clamped-to-observed-max",
  bucketError: Object.freeze({
    maxRelativeOverestimate: 2 ** (1 / 16) - 1,
    relativeBoundFromMs: 0.1,
    maxAbsoluteOverestimateBelowThresholdMs: 0.1,
  }),
});
export interface PressureHistogram {
  count: number; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; maxMs: number | null;
  metadata: typeof PRESSURE_HISTOGRAM_METADATA;
}
export interface PressureCounts { offered: number; sent: number; completed: number; admitted: number; success: number;
  droppedLate: number; droppedCapacity: number }
export interface PressureRow extends PressureCounts {
  app: 0 | 1; route: PressureOffer["route"]; statuses: Record<string, number>;
  responseLatency: PressureHistogram; scheduledLatency: PressureHistogram; scheduleLag: PressureHistogram;
  rates: { offered: number; sent: number; completed: number; admitted: number; success: number };
}
export interface PressureReport extends PressureCounts {
  rows: PressureRow[]; unsettled: number; stoppedEarly: boolean; offeredDurationMs: number; elapsedMs: number;
}
export interface PressureClock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }
export interface PressureOptions {
  durationMs: number; readRate: number; mutationRate: number; maxInFlight: number; maxLagMs: number;
  execute(offer: PressureOffer, signal: AbortSignal): Promise<PressureExecution>;
  requestTimeoutMs?: number; drainTimeoutMs?: number; signal?: AbortSignal; clock?: PressureClock;
}
export function createHistogram(): { record(ms: number): void; snapshot(): PressureHistogram } {
  // Fixed logarithmic buckets: quantiles are upper bounds (at most ~4.43% above a
  // positive sample >=0.1ms), clamped to the exact observed max. Keep no sample array.
  const bounds = [0, 0.1];
  while (bounds[bounds.length - 1]! < Number.MAX_SAFE_INTEGER)
    bounds.push(Math.min(Number.MAX_SAFE_INTEGER, bounds[bounds.length - 1]! * 2 ** (1 / 16)));
  const buckets = new Uint32Array(bounds.length);
  let count = 0, max: number | null = null;
  const percentile = (fraction: number): number | null => {
    if (!count) return null;
    const rank = Math.ceil(count * fraction); let cumulative = 0;
    for (let index = 0; index < buckets.length; index++) {
      cumulative += buckets[index]!; if (cumulative >= rank) return Math.min(bounds[index]!, max!);
    }
    return null;
  };
  return {
    record(ms) {
      if (!Number.isFinite(ms) || ms < 0 || ms > Number.MAX_SAFE_INTEGER) throw new RangeError("Invalid histogram duration");
      let low = 0, high = bounds.length - 1;
      while (low < high) { const middle = (low + high) >>> 1; if (bounds[middle]! < ms) low = middle + 1; else high = middle; }
      buckets[low]!++; count++; max = Math.max(max ?? 0, ms);
    },
    snapshot: () => ({ count, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: max,
      metadata: PRESSURE_HISTOGRAM_METADATA }),
  };
}

const realClock: PressureClock = {
  now: () => performance.now(),
  sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
    const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new Error("Pressure run cancelled")); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  }),
};
const counts = (): PressureCounts => ({ offered: 0, sent: 0, completed: 0, admitted: 0, success: 0, droppedLate: 0, droppedCapacity: 0 });
const networkFailure: PressureExecution = { status: "network-error", admitted: false, success: false };
const statusBucket = (status: PressureExecution["status"]) => status === "network-error" ? status
  : status >= 200 && status < 300 ? "2xx" : [401, 403, 409, 429, 503].includes(status) ? String(status) : "other";

/** Local measurement only. Arrivals in [start,start+duration) never wait for a response.
 * Completed means a classified response/error/deadline; unsettled separately reports execute
 * callbacks still running after bounded abort/drain. Any unsettled work invalidates qualification.
 * No retries, unbounded pending queue, raw response logging, or production capacity claim. */
export async function runOpenLoop(options: PressureOptions): Promise<PressureReport> {
  const { durationMs, readRate, mutationRate, maxInFlight, maxLagMs, execute, signal } = options;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000, drainTimeoutMs = options.drainTimeoutMs ?? requestTimeoutMs + 1_000;
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 7_200_000
    || ![readRate, mutationRate].every(rate => Number.isFinite(rate) && rate >= 0) || readRate + mutationRate <= 0 || readRate + mutationRate > 1200
    || !Number.isSafeInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 512
    || !Number.isFinite(maxLagMs) || maxLagMs < 0 || maxLagMs > 60_000
    || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30_000
    || !Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1 || drainTimeoutMs > 60_000 || typeof execute !== "function")
    throw new RangeError("Invalid bounded pressure schedule");
  const clock = options.clock ?? realClock;
  if (typeof clock.now !== "function" || typeof clock.sleep !== "function") throw new RangeError("Invalid pressure clock");
  const start = clock.now();
  if (!Number.isFinite(start)) throw new RangeError("Invalid pressure clock");
  const rows = (["read", "diagnostic-claim"] as const).flatMap(route => ([0, 1] as const).map(app => ({
    ...counts(), app, route, statuses: Object.fromEntries(["2xx", "401", "403", "409", "429", "503", "other", "network-error"].map(key => [key, 0])),
    responseLatency: createHistogram(), scheduledLatency: createHistogram(), scheduleLag: createHistogram(),
  })));
  const streams = [{ route: "read" as const, rate: readRate, index: 0 }, { route: "diagnostic-claim" as const, rate: mutationRate, index: 0 }]
    .filter(stream => stream.rate > 0).map(stream => ({ ...stream, total: Math.ceil(durationMs * stream.rate / 1000) }));
  type Slot = { controller: AbortController; abort(): void; timer: ReturnType<typeof setTimeout> };
  const inFlight = new Set<Slot>();
  let sequence = 0, closed = false, phaseEndedAt = start, stoppedEarly = signal?.aborted ?? false;
  const cancelled = () => { stoppedEarly = true; for (const slot of inFlight) slot.abort(); };
  signal?.addEventListener("abort", cancelled, { once: true });
  const cleanup = () => {
    closed = true; signal?.removeEventListener("abort", cancelled);
    for (const slot of inFlight) { clearTimeout(slot.timer); slot.controller.abort(); }
  };

  function dispatch(offer: PressureOffer, row: typeof rows[number]) {
    const startedAt = clock.now(), controller = new AbortController();
    let classified = false;
    const finish = (value: PressureExecution) => {
      if (classified || closed) return;
      classified = true; clearTimeout(slot.timer);
      const finishedAt = clock.now(), elapsed = Math.max(0, finishedAt - startedAt);
      const valid = value && typeof value.admitted === "boolean" && typeof value.success === "boolean"
        && (value.status === "network-error" || (Number.isInteger(value.status) && value.status >= 100 && value.status <= 599))
        && (!value.success || (value.admitted && typeof value.status === "number" && value.status >= 200 && value.status < 300));
      const failed = controller.signal.aborted || elapsed >= requestTimeoutMs || !valid;
      const result = failed ? networkFailure : value;
      if (failed) controller.abort();
      row.completed++; if (result.admitted) row.admitted++; if (result.success) row.success++;
      row.statuses[statusBucket(result.status)]!++;
      row.responseLatency.record(elapsed); row.scheduledLatency.record(Math.max(0, finishedAt - offer.scheduledAtMs));
    };
    const slot: Slot = { controller, timer: setTimeout(() => slot.abort(), requestTimeoutMs),
      abort: () => { controller.abort(); finish(networkFailure); } };
    inFlight.add(slot); row.sent++;
    // Attach handlers even for a synchronous throw. Capacity remains reserved until the actual
    // callback settles, so ignored aborts cannot spawn unlimited replacement work.
    let pending: Promise<PressureExecution>;
    try { pending = Promise.resolve(execute(offer, controller.signal)); } catch { pending = Promise.resolve(networkFailure); }
    void pending.then(value => { inFlight.delete(slot); finish(value); }, () => { inFlight.delete(slot); finish(networkFailure); });
  }
  try {
    while (!signal?.aborted) {
      const next = streams.filter(stream => stream.index < stream.total)
        .sort((a, b) => a.index / a.rate - b.index / b.rate)[0];
      if (!next) {
        const remaining = start + durationMs - clock.now();
        if (remaining > 0) await clock.sleep(remaining, signal);
        break;
      }
      const scheduledAtMs = start + next.index * 1000 / next.rate, remaining = scheduledAtMs - clock.now();
      if (remaining > 0) { await clock.sleep(remaining, signal); continue; }
      const offer: PressureOffer = { sequence: sequence++, route: next.route, app: next.index % 2 as 0 | 1, scheduledAtMs };
      next.index++;
      const row = rows[(next.route === "read" ? 0 : 2) + offer.app]!, lag = Math.max(0, clock.now() - scheduledAtMs);
      row.offered++; row.scheduleLag.record(lag);
      if (lag > maxLagMs) row.droppedLate++;
      else if (inFlight.size >= maxInFlight) row.droppedCapacity++;
      else dispatch(offer, row);
    }
  } catch (error) { if (!signal?.aborted) { cleanup(); throw error; } }
  finally { phaseEndedAt = clock.now(); }
  try {
    const drainUntil = clock.now() + drainTimeoutMs;
    while (inFlight.size && clock.now() < drainUntil) await clock.sleep(Math.min(10, Math.max(0, drainUntil - clock.now())));
    for (const slot of inFlight) slot.abort();
    // Give cooperative fetch/body cancellation a microtask turn to settle before reporting.
    await Promise.resolve(); await Promise.resolve();
    const elapsedMs = Math.max(0, clock.now() - start), offeredDurationMs = Math.max(0, phaseEndedAt - start);
    const rate = (count: number, milliseconds: number) => milliseconds > 0 ? count * 1000 / milliseconds : 0;
    const snapshots: PressureRow[] = rows.map(row => ({ ...row, statuses: { ...row.statuses },
      responseLatency: row.responseLatency.snapshot(), scheduledLatency: row.scheduledLatency.snapshot(), scheduleLag: row.scheduleLag.snapshot(),
      rates: { offered: rate(row.offered, offeredDurationMs), sent: rate(row.sent, offeredDurationMs), completed: rate(row.completed, elapsedMs),
        admitted: rate(row.admitted, elapsedMs), success: rate(row.success, elapsedMs) } }));
    const total = counts();
    for (const row of rows) for (const key of Object.keys(total) as Array<keyof PressureCounts>) total[key] += row[key];
    return { ...total, rows: snapshots, unsettled: inFlight.size, stoppedEarly, offeredDurationMs, elapsedMs };
  } finally { cleanup(); }
}
