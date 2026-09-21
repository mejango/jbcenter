import { describe, expect, it } from 'vitest';
import { uintSchema, positiveUintSchema } from '../../src/domain/schemas.js';
import { loadConfig } from '../../src/config.js';
import { resolveProjectIdentifier } from '../../src/services/identity.js';
import { ContractService } from '../../src/services/contracts.js';

describe('public boundaries', () => {
  it.each(['1.2', '1e18', '-1', '0x123', '01', ' ', '9'.repeat(79)])(
    'rejects malformed uint %s without throwing inside safeParse',
    (value) => {
      expect(uintSchema.safeParse(value).success).toBe(false);
      expect(positiveUintSchema.safeParse(value).success).toBe(false);
    },
  );
  it('preserves V6 instead of inheriting the SDK legacy version default', () => {
    expect(resolveProjectIdentifier('eth:1')).toEqual({
      kind: 'project',
      project: { chainId: 1, projectId: '1', version: 6 },
    });
    expect(
      resolveProjectIdentifier('https://juicebox.money/base:9007199254740993/activity'),
    ).toMatchObject({ project: { chainId: 8453, projectId: '9007199254740993', version: 6 } });
    expect(() => resolveProjectIdentifier('https://juicebox.money/v5/eth:1')).toThrow('V6 only');
  });
  it('keeps names ambiguous and rejects naked IDs/unknown hosts', () => {
    expect(resolveProjectIdentifier('@bananas')).toEqual({ kind: 'search', query: 'bananas' });
    expect(() => resolveProjectIdentifier('123')).toThrow('ambiguous');
    expect(() => resolveProjectIdentifier('https://attacker.example/base:123')).toThrow(
      'project URL',
    );
  });
  it('requires a stable plan secret and HTTPS public origin in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow('stable PLAN_SECRET');
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PLAN_SECRET: 'x'.repeat(32),
        PUBLIC_ORIGIN: 'http://juicebox.diy',
      }),
    ).toThrow('HTTPS');
    expect(loadConfig({ NODE_ENV: 'production', PLAN_SECRET: 'x'.repeat(32) }).publicOrigin).toBe(
      'https://juicebox.center',
    );
  });
  it('does not inherit prototype objects as contract registry entries', () => {
    expect(() => new ContractService().get('constructor')).toThrow('supported V6 ABI registry');
    expect(() => new ContractService().get('__proto__')).toThrow('supported V6 ABI registry');
  });
});
