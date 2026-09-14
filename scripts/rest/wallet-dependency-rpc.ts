import { dwellirRpcUpstreams } from '../../src/rpc.js';

/** Reuse Center's configured Dwellir endpoints. Operator qualification deliberately
 * fails closed on a Dwellir outage instead of falling back to an inconsistent public node. */
export function walletDependencyRpcUpstreams(apiKey: string | undefined) {
  return new Map([...dwellirRpcUpstreams(apiKey)].map(([chain, urls]) => [chain, [urls[0]!]]));
}
