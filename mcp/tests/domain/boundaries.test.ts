import { describe, expect, it } from 'vitest';
import {
  positiveUintSchema,
  projectSchema,
  smallUintSchema,
  uintSchema,
} from '../../src/domain/schemas.js';
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
  it('takes amounts only as strings, since JSON parsing rounds a number before any check sees it', () => {
    // 1.0000000000000001 and 9007199254740990.5 parse to integers; only the string keeps the digits.
    for (const value of [0, 86400, 1.0000000000000001, 9007199254740990.5, -0, 1e3]) {
      for (const schema of [uintSchema, positiveUintSchema]) {
        const result = schema.safeParse(value);
        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.message).toContain('base-10 integer string');
      }
    }
    expect(uintSchema.parse('9007199254740993')).toBe('9007199254740993');
  });
  it('accepts safe-integer JSON numbers only for bounded fields, never for IDs', () => {
    expect(smallUintSchema.parse(0)).toBe('0');
    expect(smallUintSchema.parse(86400)).toBe('86400');
    expect(smallUintSchema.parse(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
    expect(smallUintSchema.parse('9007199254740993')).toBe('9007199254740993');
    // IDs have ranges past 2^53, where JSON parsing has already rounded 9007199254740990.5 to an integer.
    for (const projectId of [7, 9007199254740990.5])
      expect(
        projectSchema.safeParse({ chainId: 1, projectId }).error?.issues[0]?.message,
      ).toContain('base-10 integer string');
    expect(projectSchema.parse({ chainId: 1, projectId: '7' }).projectId).toBe('7');
    for (const value of [2 ** 53, 1e21, 1.5, -1]) {
      const result = smallUintSchema.safeParse(value);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain(
        'Send larger or exact values as a base-10 string',
      );
    }
    expect(smallUintSchema.safeParse(Number.NaN).success).toBe(false);
    expect(uintSchema.safeParse('1.5').error?.issues[0]?.message).toContain(
      'base-10 integer string',
    );
  });
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
  it('knows the canonical JBDeadline hooks and CCIP sucker deployers, and lists names on a miss', () => {
    const contracts = new ContractService();
    expect(contracts.get('JBDeadline3Days', 1, 'DURATION')).toMatchObject({
      address: '0xcda708c98fbdd15a7ff7f0c5c50f9371ca52c78f',
      abi: [{ name: 'DURATION' }],
    });
    // Same addresses as nana-suckers-v6 deployments/base/JBCCIPSuckerDeployer__{OP,ETH}.json.
    expect(contracts.get('JBCCIPSuckerDeployer', 8453)).toMatchObject({
      addressByPeerChainId: {
        '1': '0x3955fec11fe15f0be4dfa2b0153feef55d55e1ee',
        '10': '0x8f6f0a70939997310309d7ab66b1b199faafe7f0',
      },
    });
    expect(() => contracts.get('JBDeadline')).toThrow(/Known names: .*JBDeadline3Days/);
  });
});
