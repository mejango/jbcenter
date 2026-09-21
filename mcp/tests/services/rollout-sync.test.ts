import { describe, expect, it } from 'vitest';
import { assertExecutedReceipt } from '../../scripts/sync-rollout.js';

describe('executed rollout deployment boundary', () => {
  it('requires a successful, mined receipt before publishing a deployment address', () => {
    const receipt = {
      status: '0x1',
      blockNumber: '0x123',
      transactionHash: `0x${'12'.repeat(32)}`,
      blockHash: `0x${'ab'.repeat(32)}`,
    };
    expect(() => assertExecutedReceipt(receipt, 'deployments/sepolia/Example.json')).not.toThrow();
    for (const invalid of [
      undefined,
      {},
      { ...receipt, status: '0x0' },
      { ...receipt, status: undefined },
      { ...receipt, blockNumber: '0x0' },
      { ...receipt, blockHash: undefined },
      { ...receipt, transactionHash: `0x${'00'.repeat(32)}` },
    ]) {
      expect(() => assertExecutedReceipt(invalid, 'proposal.json')).toThrow(
        'no successful execution receipt',
      );
    }
  });
});
