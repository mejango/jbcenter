import { describe, expect, it } from 'vitest';
import { RELAYR_PAYMENT_ADDRESS } from '../src/rest/sponsorship/constants.js';
import { RELAYR_PAYMENT_EVENT, verifyRelayrPaymentEvent } from '../src/rest/sponsorship/paymentContract.js';

const id = 'a0a555ff-4444-4111-aaaa-333333333333';
const event = (amount = 1000n) => ({ address: RELAYR_PAYMENT_ADDRESS as string, removed: false,
  topics: [RELAYR_PAYMENT_EVENT, `0x${id.replaceAll('-', '').padEnd(64, '0')}`],
  data: `0x${amount.toString(16).padStart(64, '0')}${900n.toString(16).padStart(64, '0')}` });
describe('untrusted Relayr receipt logs', () => {
  it.each(['foreign-address', 'removed', 'extra-topic', 'wrong-bundle', 'duplicate', 'too-many', 'missing', 'zero-for-positive'])('rejects %s', fault => {
    const log = event(); let logs: unknown[] = [log];
    if (fault === 'foreign-address') log.address = '0x1111111111111111111111111111111111111111';
    if (fault === 'removed') log.removed = true;
    if (fault === 'extra-topic') log.topics.push(RELAYR_PAYMENT_EVENT);
    if (fault === 'wrong-bundle') log.topics[1] = '0x' + '00'.repeat(32);
    if (fault === 'duplicate') logs.push(log);
    if (fault === 'too-many') logs = [log, ...Array(1024).fill({})];
    if (fault === 'missing') logs = [];
    if (fault === 'zero-for-positive') logs = [event(0n)];
    expect(() => verifyRelayrPaymentEvent(logs, id, '1000', '900')).toThrow();
  });
  it('checks the exact amount, including a legitimate zero-value event', () => {
    expect(() => verifyRelayrPaymentEvent([event()], id, '1000', '900')).not.toThrow();
    expect(() => verifyRelayrPaymentEvent([event(0n)], id, '0', '900')).not.toThrow();
  });
});
