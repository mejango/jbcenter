import { PUBLICNODE_RPC_URLS } from '../../src/rpc.js';

// Operator-only endpoint selection. On 2026-09-14 PublicNode Sepolia returned
// height 0xb299ca for requested 0xb299cb. The installed viem Sepolia default
// returned the requested block and passed the full EIP-1898/canonical inspection.
// Never relax block-number/hash equality to accommodate a provider mismatch.
export const WALLET_DEPENDENCY_RPC_URLS: Readonly<Record<number, string>> = Object.freeze({
  ...PUBLICNODE_RPC_URLS,
  11155111: 'https://11155111.rpc.thirdweb.com',
});
