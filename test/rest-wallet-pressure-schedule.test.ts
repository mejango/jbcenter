import { afterEach, describe, expect, it, vi } from "vitest";
import { createHistogram, runOpenLoop, type PressureExecution, type PressureOffer, type PressureOptions } from "../scripts/rest/wallet-pressure-schedule.js";

const success: PressureExecution = { status: 200, admitted: true, success: true };
const settings = { durationMs: 1000, readRate: 10, mutationRate: 0, maxInFlight: 4, maxLagMs: 20,
  requestTimeoutMs: 500, drainTimeoutMs: 600 };
const clock = { now: () => Date.now(), sleep: (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new Error("Aborted")); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
  signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
}) };
function run(execute: PressureOptions["execute"], extra: Partial<PressureOptions> = {}) {
  const result = runOpenLoop({ ...settings, clock, execute, ...extra });
  void result.catch(() => {}); return result;
}
afterEach(() => { vi.useRealTimers(); });

describe("open-loop local wallet pressure scheduling", () => {
  it("keeps independent arrival deadlines while responses are pending and counts capacity drops", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const seen: PressureOffer[] = [];
    const pending = run(async offer => { seen.push(offer); await clock.sleep(250); return success; }, { maxInFlight: 1 });
    await vi.advanceTimersByTimeAsync(1700);
    const result = await pending;
    expect(result).toMatchObject({ offered: 10, sent: 4, completed: 4, success: 4, droppedCapacity: 6, droppedLate: 0, unsettled: 0 });
    expect(seen.map(offer => offer.scheduledAtMs)).toEqual([10000, 10300, 10600, 10900]);
  });

  it("balances each app within each route even when route rates have matching periods", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const seen: PressureOffer[] = [];
    const pending = run(async offer => { seen.push(offer); return success; }, { readRate: 4, mutationRate: 4 });
    await vi.advanceTimersByTimeAsync(1100); const result = await pending;
    expect(result).toMatchObject({ offered: 8, sent: 8, success: 8 });
    expect(new Set(seen.map(offer => offer.sequence)).size).toBe(8);
    for (const row of result.rows) expect(row).toMatchObject({ offered: 2, sent: 2, success: 2 });
    expect(result.rows).toHaveLength(4);
  });

  it("drops overdue arrivals without a catch-up burst and records generator lag", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    let offset = 0; const customClock = { ...clock, now: () => Date.now() + offset };
    const pending = run(async () => success, { clock: customClock });
    await vi.advanceTimersByTimeAsync(1); offset = 500;
    await vi.advanceTimersByTimeAsync(1100); const result = await pending;
    expect(result).toMatchObject({ offered: 10, droppedLate: 5, sent: 5, success: 5 });
    expect(Math.max(...result.rows.map(row => row.scheduleLag.maxMs ?? 0))).toBeGreaterThanOrEqual(500);
    expect(result.offered).toBe(result.sent + result.droppedLate + result.droppedCapacity);
  });

  it("keeps rate-limit and auth failures in each app and route offered denominator", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const pending = run(async offer => offer.app === 0 ? success : { status: 429, admitted: false, success: false });
    await vi.advanceTimersByTimeAsync(1200); const result = await pending;
    expect(result).toMatchObject({ offered: 10, sent: 10, completed: 10, admitted: 5, success: 5 });
    const rejected = result.rows.find(row => row.app === 1 && row.route === "read")!;
    expect(rejected.statuses["429"]).toBe(5); expect(rejected.success).toBe(0);
    expect(result.rows.find(row => row.app === 0 && row.route === "read")!.rates.success).toBe(5);
  });

  it("supports mutation-only traffic and counts network failures explicitly", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const pending = run(async () => { throw new Error("Private generator detail"); }, { readRate: 0, mutationRate: 2 });
    await vi.advanceTimersByTimeAsync(1200); const result = await pending;
    expect(result).toMatchObject({ offered: 2, sent: 2, completed: 2, admitted: 0, success: 0 });
    expect(result.rows.filter(row => row.route === "read").every(row => row.offered === 0)).toBe(true);
    expect(result.rows.filter(row => row.route === "diagnostic-claim").every(row => row.statuses["network-error"] === 1)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("Private generator detail");
  });

  it("aborts deadline-exceeded requests and does not call late timer resolution a success", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    let offset = 0; const signals: AbortSignal[] = [];
    const pending = run(async (_offer, signal) => { signals.push(signal); offset += 501; return success; },
      { readRate: 1, durationMs: 100, clock: { ...clock, now: () => Date.now() + offset } });
    await vi.advanceTimersByTimeAsync(800); const result = await pending;
    expect(result).toMatchObject({ offered: 1, sent: 1, completed: 1, success: 0, admitted: 0 });
    expect(signals[0]!.aborted).toBe(true);
    expect(result.rows[0]!.statuses["network-error"]).toBe(1);
  });

  it("bounds drain of an abort-ignoring callback, retains its slot and labels incomplete evidence", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    let release!: (result: PressureExecution) => void; const signals: AbortSignal[] = [];
    const pending = run(async (_offer, signal) => { signals.push(signal); return new Promise(resolve => { release = resolve; }); },
      { maxInFlight: 1, requestTimeoutMs: 100, drainTimeoutMs: 150 });
    await vi.advanceTimersByTimeAsync(1200); const result = await pending;
    expect(result).toMatchObject({ offered: 10, sent: 1, completed: 1, success: 0, droppedCapacity: 9, unsettled: 1 });
    expect(signals[0]!.aborted).toBe(true);
    const frozen = JSON.stringify(result); release(success); await vi.advanceTimersByTimeAsync(1);
    expect(JSON.stringify(result)).toBe(frozen);
  });

  it("stops future offers on caller cancellation and drains a cooperative request", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000); const controller = new AbortController();
    const pending = run(async (_offer, signal) => { await clock.sleep(5000, signal); return success; }, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(10); controller.abort();
    await vi.advanceTimersByTimeAsync(700); const result = await pending;
    expect(result).toMatchObject({ offered: 1, sent: 1, success: 0, unsettled: 0, stoppedEarly: true });
  });

  it("aborts owned work and clears timers if scheduling itself fails", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000); const signals: AbortSignal[] = [];
    const pending = run(async (_offer, signal) => { signals.push(signal); await clock.sleep(5000, signal); return success; },
      { clock: { now: clock.now, sleep: async () => { throw new Error("Scheduling clock failed"); } } });
    await expect(pending).rejects.toThrow("Scheduling clock failed");
    expect(signals[0]!.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it("clamps percentile estimates to the exact observed maximum and reports bucket error", () => {
    for (const sample of [156.290, 0.01, 0]) {
      const histogram = createHistogram(); histogram.record(sample);
      const result = histogram.snapshot();
      expect(result).toMatchObject({ count: 1, p50Ms: sample, p95Ms: sample, p99Ms: sample, maxMs: sample });
      expect(JSON.parse(JSON.stringify(result))).toMatchObject({
        metadata: {
          estimator: "nearest-rank-logarithmic-upper-bound-clamped-to-observed-max",
          bucketError: {
            maxRelativeOverestimate: 2 ** (1 / 16) - 1,
            relativeBoundFromMs: 0.1,
            maxAbsoluteOverestimateBelowThresholdMs: 0.1,
          },
        },
      });
    }
  });

  it("reports empty histogram values and bounded upper-bound percentiles including exact max", () => {
    const histogram = createHistogram();
    expect(histogram.snapshot()).toMatchObject({ count: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null });
    for (let i = 1; i <= 100; i++) histogram.record(i);
    const result = histogram.snapshot();
    expect(result.count).toBe(100); expect(result.maxMs).toBe(100);
    for (const [observed, exact] of [[result.p50Ms!, 50], [result.p95Ms!, 95], [result.p99Ms!, 99]] as const) {
      expect(observed).toBeGreaterThanOrEqual(exact); expect(observed).toBeLessThanOrEqual(exact * 1.05);
    }
    for (const value of [-1, NaN, Infinity]) expect(() => histogram.record(value)).toThrow();
  });

  it("rejects unsafe generator settings before executing any work", async () => {
    const execute = vi.fn(async () => success);
    for (const invalid of [{ durationMs: 0 }, { durationMs: 7200001 }, { readRate: 0, mutationRate: 0 },
      { readRate: 1201 }, { mutationRate: -1 }, { maxInFlight: 513 }, { maxLagMs: -1 }, { readRate: NaN }])
      await expect(run(execute, invalid)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});
