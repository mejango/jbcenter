import { describe, expect, it } from 'vitest';
import { runWalletPressure } from '../scripts/rest/wallet-pressure.js';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite('local synthetic-chain pressure harness', () => {
  it('runs two actual service replicas with signed reads, durable diagnostic claims and lock recovery', async () => {
    const report = await runWalletPressure({ durationMs: 1000, readRate: 4, mutationRate: 4,
      inventory: 10, faultMs: 200, maxInFlight: 16, poolMax: 2 });
    expect(report.scope).toBe('diagnostic-synthetic-chain-http-postgres');
    expect(report.productionThroughputQualified).toBe(false);
    expect(report.fixture).toMatchObject({ genuineEnrolledWallets: 2, syntheticInactiveAccountRows: 8,
      authorityMaximumAgeMs: 30_000, refreshMaxTracked: 32, refreshMaxConcurrent: 2, refreshMaxStartsPerMinute: 30 });
    expect(report.processes).toHaveLength(2);
    expect(new Set(report.processes.map((value: any) => value.pid)).size).toBe(2);
    for (const process of report.processes) {
      expect(process.cumulativeSinceStartup).toBe(true);
      for (const [key, metric] of Object.entries(process.metrics) as Array<[string, any]>) if (key !== 'worker' && metric.requests > 0) {
        expect(metric.queries).toBeGreaterThan(0);
        expect(metric.queryMs.count).toBe(metric.queries);
        expect(metric.poolWaitMs.count).toBeGreaterThan(0);
      }
    }
    expect(report.phases.map((value: any) => value.name)).toEqual(['steady', 'held-account-lock', 'recovery']);
    expect(report.correctness).toMatchObject({ unexpectedSuccesses: 0, durableClaimsMatchSuccessfulResponses: true,
      duplicateClaims: 0, childrenStopped: true, schemaRemoved: true });
    expect(report.correctness.durableClaims).toBeGreaterThan(0);
    expect(report.correctness.invalidSignatureStatus).toBe(401);
    expect(report.correctness.replayStatus).toBe(409);
    expect(report.correctness.replayAddedClaim).toBe(false);
    expect(report.fault.maxObservedLockWaiters).toBeGreaterThan(0);
    expect(report.measurementComplete).toBe(true);
    expect(report.correctnessPassed).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/postgres(?:ql)?:\/\/|privateKey|credentialId|publicKey|authenticatorData|clientDataJSON/);
  }, 30_000);
});
