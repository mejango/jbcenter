import { Pool } from "pg";
import type { FirstPartyApplication } from "../../firstParty.js";
import { PostgresWalletPolicyStore, type WalletPolicyActivation } from "./policyPostgres.js";

/** `node dist/src/rest/wallet/policyCli.js --expected <revision> <origin> <callbackPath> [...] [--grant-days <origin>=<days> ...]`
 * replaces the whole app allowlist (activation is all-or-nothing) and prints the new revision.
 * An origin without `--grant-days` keeps an hour-long sign-in; the ceiling is 90 days.
 * Run inside the production container, which already holds DATABASE_URL. */
export function walletPolicyActivationFromArguments(argv: string[]): WalletPolicyActivation {
  const [flag, revision, ...rest] = argv;
  const expectedRevision = Number(revision);
  const days = new Map<string, number>(), pairs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== "--grant-days") { pairs.push(rest[i]!); continue; }
    const [origin, value] = (rest[++i] ?? "").split("=");
    const count = Number(value);
    if (!origin || !Number.isInteger(count) || count < 1 || count > 90) throw new Error("--grant-days takes <origin>=<1..90>");
    days.set(origin, count);
  }
  if (flag !== "--expected" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || pairs.length === 0 || pairs.length % 2)
    throw new Error("usage: --expected <revision> <origin> <callbackPath> [<origin> <callbackPath> ...] [--grant-days <origin>=<days> ...]");
  const applications: FirstPartyApplication[] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const origin = pairs[i] ?? "", path = pairs[i + 1] ?? "";
    if (!path.startsWith("/")) throw new Error(`callback for ${origin} must be a path`);
    const lifetime = days.get(origin);
    applications.push({ origin, walletCallbacks: [origin + path], ...(lifetime ? { grantLifetimeSeconds: lifetime * 86_400 } : {}) });
  }
  if ([...days.keys()].some(origin => !applications.some(app => app.origin === origin))) throw new Error("--grant-days names an origin not in the list");
  return { expectedRevision, nextRevision: expectedRevision + 1, configuration: { version: "center-wallet-policy-v1", applications } };
}

if (process.argv[1]?.endsWith("policyCli.js")) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10_000 });
  new PostgresWalletPolicyStore(pool).activate(walletPolicyActivationFromArguments(process.argv.slice(2)))
    .then((snapshot) => { console.log(`policy revision ${snapshot.revision}: ${snapshot.apps.map((app) => app.origin).join(", ")}`); })
    .finally(() => pool.end());
}
