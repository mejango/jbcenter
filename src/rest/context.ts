import { AsyncLocalStorage } from "node:async_hooks";
import type { RestPrincipal, SignedRequestInput } from "./auth/index.js";

export interface RestRequestContext {
  signal: AbortSignal;
  authority?: { principal: RestPrincipal; input: SignedRequestInput };
  ownerApprovals: Map<number, unknown>;
  sponsorshipOwnerApproval?: unknown;
}
const requests = new AsyncLocalStorage<RestRequestContext>();

/** Async request state belongs to the current request, never to a shared service instance. */
export function withRestRequest<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  return requests.run({ signal, ownerApprovals: new Map() }, work);
}
export function restRequest(): RestRequestContext | undefined {
  return requests.getStore();
}
export function setRestAuthority(
  principal: RestPrincipal,
  input: SignedRequestInput,
): void {
  const context = requests.getStore();
  if (!context)
    throw new Error("REST authorization requires an active request context");
  context.authority = { principal, input };
}
export function setOwnerApproval(stepIndex: number, approval: unknown): void {
  const context = requests.getStore();
  if (!context)
    throw new Error("Owner approval requires an active request context");
  context.ownerApprovals.set(stepIndex, approval);
}
export function setSponsorshipOwnerApproval(approval: unknown): void {
  const context = requests.getStore();
  if (!context)
    throw new Error("Owner approval requires an active request context");
  context.sponsorshipOwnerApproval = approval;
}
