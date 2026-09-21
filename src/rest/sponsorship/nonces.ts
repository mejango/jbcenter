import { RELAYR_LIMITS } from './constants.js';
import type { PreparedForwardRequest } from './types.js';
import { decimal, fail } from './validation.js';

export interface ForwardNonceKey {
  chainId: number;
  forwarder: string;
  sender: string;
  nonce: string;
}

const address = /^0x[0-9a-fA-F]{40}$/;
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Global onchain identity: API account, principal and plan IDs are deliberately absent. */
export function forwardNonceId(key: ForwardNonceKey): string {
  return JSON.stringify([key.chainId, key.forwarder, key.sender, key.nonce]);
}

/** Validate before mutation and sort shared keys so concurrent SQL claims acquire them consistently. */
export function forwardNonceKeys(requests: readonly PreparedForwardRequest[]): ForwardNonceKey[] {
  if (
    !Array.isArray(requests) ||
    requests.length < 1 ||
    requests.length > RELAYR_LIMITS.maximumCalls
  ) {
    fail('INVALID_SPONSORSHIP_RECORD', 'Invalid forwarding nonce reservations.', 400);
  }
  const keys = requests.map((request): ForwardNonceKey => {
    if (
      !Number.isSafeInteger(request.chainId) ||
      request.chainId <= 0 ||
      typeof request.forwarder !== 'string' ||
      !address.test(request.forwarder) ||
      typeof request.message?.from !== 'string' ||
      !address.test(request.message.from)
    ) {
      fail('INVALID_SPONSORSHIP_RECORD', 'Invalid forwarding nonce identity.', 400);
    }
    return {
      chainId: request.chainId,
      forwarder: request.forwarder.toLowerCase(),
      sender: request.message.from.toLowerCase(),
      nonce: decimal(request.message.nonce, 'forwarding nonce').toString(),
    };
  });
  if (new Set(keys.map(forwardNonceId)).size !== keys.length) {
    fail(
      'INVALID_SPONSORSHIP_RECORD',
      'A preparation cannot repeat the same forwarding nonce.',
      400,
    );
  }
  return keys.sort(
    (a, b) =>
      a.chainId - b.chainId ||
      compareText(a.forwarder, b.forwarder) ||
      compareText(a.sender, b.sender) ||
      compareText(a.nonce, b.nonce),
  );
}

export function forwardNonceConflict(): never {
  return fail(
    'FORWARD_NONCE_CONFLICT',
    'A forwarding nonce is permanently bound to another sponsorship preparation.',
    409,
  );
}
