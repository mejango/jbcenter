import { describe, expect, it } from 'vitest';
import { walletPolicyActivationFromArguments } from '../src/rest/wallet/policyCli.js';

describe('wallet policy operator command', () => {
  it('builds the next revision from origin/callback pairs', () => {
    expect(walletPolicyActivationFromArguments(['--expected', '2', 'https://homerun.money', '/center/callback', 'https://beep.biz', '/center/callback'])).toEqual({
      expectedRevision: 2, nextRevision: 3,
      configuration: { version: 'center-wallet-policy-v1', applications: [
        { origin: 'https://homerun.money', walletCallbacks: ['https://homerun.money/center/callback'] },
        { origin: 'https://beep.biz', walletCallbacks: ['https://beep.biz/center/callback'] },
      ] },
    });
  });
  it('gives a named origin a sign-in lifetime in days, at most 90, only for a listed origin', () => {
    const args = ['--expected', '2', 'https://homerun.money', '/center/callback', 'https://beep.biz', '/center/callback'];
    expect(walletPolicyActivationFromArguments([...args, '--grant-days', 'https://beep.biz=30']).configuration.applications).toEqual([
      { origin: 'https://homerun.money', walletCallbacks: ['https://homerun.money/center/callback'] },
      { origin: 'https://beep.biz', walletCallbacks: ['https://beep.biz/center/callback'], grantLifetimeSeconds: 30 * 86_400 },
    ]);
    for (const bad of ['https://beep.biz=91', 'https://beep.biz=0', 'https://beep.biz=x', 'https://other.example=30', 'beep.biz'])
      expect(() => walletPolicyActivationFromArguments([...args, '--grant-days', bad])).toThrow();
  });
  it('refuses a missing revision, unpaired arguments and callbacks outside the origin', () => {
    expect(() => walletPolicyActivationFromArguments(['https://homerun.money', '/center/callback'])).toThrow();
    expect(() => walletPolicyActivationFromArguments(['--expected', '0', 'https://homerun.money'])).toThrow();
    expect(() => walletPolicyActivationFromArguments(['--expected', '0', 'https://homerun.money', 'https://evil.example/cb'])).toThrow();
    expect(() => walletPolicyActivationFromArguments(['--expected', 'x', 'https://homerun.money', '/center/callback'])).toThrow();
  });
});
