import { createRequire } from "node:module";
import { Agent, setGlobalDispatcher } from "undici";

/**
 * Upstream calls come in bursts seconds apart (a payment's steps, a customer's taps). fetch lets
 * an idle connection go after 4 s, so most calls paid a new TCP and TLS handshake: measured from
 * production, 140 ms on a kept connection against 280–460 ms on a new one to the chain RPC.
 * Connections are kept for 45 s instead. The dispatcher is installed only when this undici is
 * the major the runtime's own fetch bundles, since the two share one global slot.
 */
export function keepUpstreamConnections(): boolean {
  const bundled = process.versions.undici?.split(".")[0];
  const installed = (createRequire(import.meta.url)("undici/package.json") as { version: string }).version.split(".")[0];
  if (!bundled || bundled !== installed) return false;
  setGlobalDispatcher(new Agent({ keepAliveTimeout: 45_000, keepAliveMaxTimeout: 45_000 }));
  return true;
}
