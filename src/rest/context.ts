import { AsyncLocalStorage } from "node:async_hooks";

export interface RestRequestContext {
  signal: AbortSignal;
}
const requests = new AsyncLocalStorage<RestRequestContext>();

/** Cancellation belongs to the current request, never to a shared service instance. */
export function withRestRequest<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  return requests.run({ signal }, work);
}
export function restRequest(): RestRequestContext | undefined {
  return requests.getStore();
}
/** Shared observations may outlive the requesting connection. */
export function detachedFromRequest<T>(work: () => Promise<T>): Promise<T> {
  return requests.exit(work);
}
