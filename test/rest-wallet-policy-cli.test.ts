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
  it('refuses a missing revision, unpaired arguments and callbacks outside the origin', () => {
    expect(() => walletPolicyActivationFromArguments(['https://homerun.money', '/center/callback'])).toThrow();
    expect(() => walletPolicyActivationFromArguments(['--expected', '0', 'https://homerun.money'])).toThrow();
    expect(() => walletPolicyActivationFromArguments(['--expected', '0', 'https://homerun.money', 'https://evil.example/cb'])).toThrow();
    expect(() => walletPolicyActivationFromArguments(['--expected', 'x', 'https://homerun.money', '/center/callback'])).toThrow();
  });
});
