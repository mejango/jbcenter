import { Pool } from "pg";
import type { FirstPartyApplication } from "../../firstParty.js";
import { PostgresWalletPolicyStore, type WalletPolicyActivation } from "./policyPostgres.js";

/** `node dist/src/rest/wallet/policyCli.js --expected <revision> <origin> <callbackPath> [...]`
 * replaces the whole app allowlist (activation is all-or-nothing) and prints the new revision.
 * Run inside the production container, which already holds DATABASE_URL. */
export function walletPolicyActivationFromArguments(argv: string[]): WalletPolicyActivation {
  const [flag, revision, ...pairs] = argv;
  const expectedRevision = Number(revision);
  if (flag !== "--expected" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || pairs.length === 0 || pairs.length % 2)
    throw new Error("usage: --expected <revision> <origin> <callbackPath> [<origin> <callbackPath> ...]");
  const applications: FirstPartyApplication[] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const origin = pairs[i] ?? "", path = pairs[i + 1] ?? "";
    if (!path.startsWith("/")) throw new Error(`callback for ${origin} must be a path`);
    applications.push({ origin, walletCallbacks: [origin + path] });
  }
  return { expectedRevision, nextRevision: expectedRevision + 1, configuration: { version: "center-wallet-policy-v1", applications } };
}

if (process.argv[1]?.endsWith("policyCli.js")) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10_000 });
  new PostgresWalletPolicyStore(pool).activate(walletPolicyActivationFromArguments(process.argv.slice(2)))
    .then((snapshot) => { console.log(`policy revision ${snapshot.revision}: ${snapshot.apps.map((app) => app.origin).join(", ")}`); })
    .finally(() => pool.end());
}
