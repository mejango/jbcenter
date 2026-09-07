import { parseAbi } from "viem";
import type { SponsorshipPolicy } from "./types.js";

export const RELAYR_ORIGIN = "https://api.relayr.ba5ed.com";
export const RELAYR_PAYMENT_ADDRESS =
  "0x1c05f7841379d4393574c0ffa17908ec40ffd97d";
export const RELAYR_PAYMENT_SELECTOR = "0x103903a7";
export const RELAYR_PAYMENT_CODE_HASH =
  "0x6006b5acadb4cd60aa5c00cb844c34563e182dff83d4f4ff4fde226f7df16fa6";
export const RELAYR_NATIVE_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
export const RELAYR_MAINNET_CHAINS = [1, 10, 8453, 42161] as const;
export const RELAYR_PAYMENT_GAS = 150_000n;
export const RELAYR_LIMITS = Object.freeze({
  maximumBytes: 524_288,
  maximumCalls: 4,
  recordsPerAccount: 1000,
});
export const DEFAULT_SPONSORSHIP_POLICY: SponsorshipPolicy = {
  enabled: false,
  allowedChainIds: RELAYR_MAINNET_CHAINS,
  // This is a NEW explicit owner-reviewed execution commitment. The source
  // plan's much shorter expiry still controls when it may be published.
  requestTtlSeconds: 47 * 60 * 60,
  minimumRemainingSeconds: 30,
  maximumGas: 10_000_000n,
  maximumFundingValue: 10n ** 18n,
  confirmations: 2,
  rpcTimeoutMs: 10_000,
  providerTimeoutMs: 45_000,
};
export const FORWARD_REQUEST_TYPES = {
  ForwardRequest: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "gas", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint48" },
    { name: "data", type: "bytes" },
  ],
} as const;
export const FORWARDER_ABI = parseAbi([
  "function nonces(address owner) view returns (uint256)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function isTrustedForwarder(address forwarder) view returns (bool)",
  "function verify((address from,address to,uint256 value,uint256 gas,uint48 deadline,bytes data,bytes signature) request) view returns (bool)",
  "function execute((address from,address to,uint256 value,uint256 gas,uint48 deadline,bytes data,bytes signature) request) payable",
  "event ExecutedForwardRequest(address indexed signer,uint256 nonce,bool success)",
]);
