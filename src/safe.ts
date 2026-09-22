import {
  concatHex,
  decodeFunctionData,
  encodeFunctionData,
  encodePacked,
  getAddress,
  getContractAddress,
  isAddressEqual,
  keccak256,
  parseAbi,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

/** Canonical Safe 1.4.1, from safe-global/safe-deployments. A fixed factory, singleton
 * and initializer give the same address on every chain, so a Safe and the project it
 * owns can be created in either order. */
export const SAFE_FACTORY = getAddress("0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67");
export const SAFE_SINGLETON = getAddress("0x41675C099F32341bf84BFc5382aF534df5C7461a");
export const SAFE_FALLBACK = getAddress("0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99");
/** The factory's own runtime, checked on each chain before the sponsor pays it. */
export const SAFE_FACTORY_CODE_HASH: Hex =
  "0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317";

export const MAX_SAFE_OWNERS = 20;
/** The launch call plus at most three Safes for one chain. */
export const MAX_CALLS_PER_CHAIN = 4;

export const SAFE_ABI = parseAbi([
  "function proxyCreationCode() pure returns (bytes)",
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)",
]);

export type SafeSetup = {
  owners: Address[];
  threshold: number;
  saltNonce: bigint;
  initializer: Hex;
};

/** The one call the sponsor pays for before a launch: a plain Safe 1.4.1 proxy with
 * owners, a threshold and the canonical fallback handler. Anything else is null. */
export function decodeSafeSetupCall(call: { to: Address; data: Hex }): SafeSetup | null {
  if (!isAddressEqual(call.to, SAFE_FACTORY)) return null;
  let singleton: Address;
  let initializer: Hex;
  let saltNonce: bigint;
  try {
    const decoded = decodeFunctionData({ abi: SAFE_ABI, data: call.data });
    if (decoded.functionName !== "createProxyWithNonce") return null;
    [singleton, initializer, saltNonce] = decoded.args;
  } catch {
    return null;
  }
  if (!isAddressEqual(singleton, SAFE_SINGLETON)) return null;
  // Exact encoding only: trailing or padded bytes are a different signed call.
  const canonical = encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "createProxyWithNonce",
    args: [singleton, initializer, saltNonce],
  });
  if (canonical.toLowerCase() !== call.data.toLowerCase()) return null;
  let args: readonly [readonly Address[], bigint, Address, Hex, Address, Address, bigint, Address];
  try {
    const decoded = decodeFunctionData({ abi: SAFE_ABI, data: initializer });
    if (decoded.functionName !== "setup") return null;
    args = decoded.args;
  } catch {
    return null;
  }
  const [owners, threshold, to, data, fallbackHandler, paymentToken, payment, paymentReceiver] =
    args;
  if (owners.length < 1 || owners.length > MAX_SAFE_OWNERS) return null;
  if (owners.some((owner) => BigInt(owner) === 0n)) return null;
  if (new Set(owners.map((owner) => owner.toLowerCase())).size !== owners.length) return null;
  if (threshold < 1n || threshold > BigInt(owners.length)) return null;
  if (!isAddressEqual(to, zeroAddress) || data !== "0x") return null;
  if (!isAddressEqual(fallbackHandler, SAFE_FALLBACK)) return null;
  if (!isAddressEqual(paymentToken, zeroAddress)) return null;
  if (payment !== 0n || !isAddressEqual(paymentReceiver, zeroAddress)) return null;
  if (
    encodeFunctionData({ abi: SAFE_ABI, functionName: "setup", args }).toLowerCase() !==
    initializer.toLowerCase()
  )
    return null;
  return {
    owners: owners.map((owner) => getAddress(owner)),
    threshold: Number(threshold),
    saltNonce,
    initializer,
  };
}

/** The factory's CREATE2 address for this exact initializer and salt. */
export function predictSafeAddress(setup: SafeSetup, proxyCreationCode: Hex): Address {
  return getContractAddress({
    opcode: "CREATE2",
    from: SAFE_FACTORY,
    salt: keccak256(
      encodePacked(["bytes32", "uint256"], [keccak256(setup.initializer), setup.saltNonce]),
    ),
    bytecode: concatHex([proxyCreationCode, toHex(BigInt(SAFE_SINGLETON), { size: 32 })]),
  });
}
