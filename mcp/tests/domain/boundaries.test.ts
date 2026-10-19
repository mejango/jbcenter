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
