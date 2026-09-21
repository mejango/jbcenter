import { parseAbi } from 'viem';
import { RestError } from '../core.js';
import { RELAYR_PAYMENT_ADDRESS } from './constants.js';
import { decimal, object, same, uuid } from './validation.js';

// Interface of the pinned runtime, checked by executing that exact bytecode in
// rest-relayr-payment-evm.test.ts. The older public RelayrV1.sol shares the
// prepayment selector but has a different event and is NOT this runtime's source.
export const RELAYR_PAYMENT_ABI = parseAbi([
  'function prepayment(bytes16 payment_uuid, uint40 deadline) payable',
  'event Prepayment(bytes16 indexed payment_uuid, uint256 amount, uint40 deadline)',
  'error deadlineExceeded(bytes16 payment_uuid, uint40 deadline, uint40 current_time)',
]);
export const RELAYR_PAYMENT_RECIPIENT = '0x755ff2f75a0a586ecfa2b9a3c959cb662458a105' as const;
export const RELAYR_PAYMENT_EVENT = '0xb96b060a9c075a83da0cf1f9405deeb5df21df681a762de16c3d5eaf99531cd8' as const;

/** Receipt finality and exact transaction identity are checked by the caller.
 * A provider's payment_received flag is never a substitute for this event. */
export function verifyRelayrPaymentEvent(logs: unknown, bundleUuid: string, amount: string, deadline: string): void {
  const invalid = (): never => { throw new RestError(409, 'RELAYR_PAYMENT_EVENT_INVALID', 'An exact, unique Relayr payment event is required.'); };
  if (!Array.isArray(logs) || logs.length > 1024 || !uuid(bundleUuid)) invalid();
  const value = decimal(amount, 'payment amount'), expires = decimal(deadline, 'payment deadline');
  if (expires >= 1n << 40n) invalid();
  const matching = (logs as unknown[]).filter(log => object(log) && typeof log.address === 'string'
    && same(log.address, RELAYR_PAYMENT_ADDRESS) && Array.isArray(log.topics) && log.topics[0] === RELAYR_PAYMENT_EVENT);
  const event = matching[0];
  if (matching.length !== 1 || !object(event) || event.removed === true || !Array.isArray(event.topics)
    || event.topics.length !== 2 || event.topics[1] !== `0x${bundleUuid.replaceAll('-', '').padEnd(64, '0')}`
    || event.data !== `0x${value.toString(16).padStart(64, '0')}${expires.toString(16).padStart(64, '0')}`) invalid();
}
