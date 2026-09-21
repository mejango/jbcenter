/** Browser-safe primitives shared by the existing signed-request client and server. */
export type BotScope = "read" | "plan" | "relay";
export const ALL_BOT_SCOPES: readonly BotScope[] = ["read", "plan", "relay"];

export class RestAuthError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = "RestAuthError";
  }
}

export function isCanonicalGrantScopes(scopes: unknown): scopes is BotScope[] {
  return Array.isArray(scopes) && scopes.length >= 1 && scopes.length <= ALL_BOT_SCOPES.length
    && ALL_BOT_SCOPES.slice(0, scopes.length).every((scope, index) => scopes[index] === scope);
}
