import { AsyncLocalStorage } from 'node:async_hooks';
import { DomainError } from './errors.js';

interface RequestContext {
  remaining: number;
  signal?: AbortSignal;
}
const context = new AsyncLocalStorage<RequestContext>();

export function withRequestBudget<T>(
  work: () => Promise<T>,
  signal?: AbortSignal,
  requests = 128,
): Promise<T> {
  return context.run({ remaining: requests, signal }, work);
}

export function consumeRequest(): AbortSignal | undefined {
  const current = context.getStore();
  if (current) {
    if (current.signal?.aborted) throw new DomainError('CANCELLED', 'The request was cancelled.');
    if (--current.remaining < 0)
      throw new DomainError(
        'REQUEST_BUDGET_EXCEEDED',
        'This operation exceeded its upstream request budget. Narrow the query or request a smaller page.',
      );
  }
  return current?.signal;
}
