import { describe, expect, it } from 'vitest';
import { verifyRelayrPaymentReference } from '../src/rest/sponsorship/stack/relayr/verify.mjs';

describe('Relayr payment executable equivalence', () => {
  it('rebuilds the independently reconstructed source with the pinned compiler and compares every executable byte', async () => {
    const result = await verifyRelayrPaymentReference();
    expect(result).toMatchObject({ executableMatches: true, upstreamSourceVerified: false,
      runtimeHash: '0x6006b5acadb4cd60aa5c00cb844c34563e182dff83d4f4ff4fde226f7df16fa6' });
  });
});
