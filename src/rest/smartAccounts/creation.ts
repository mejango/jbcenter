import {
  concatHex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  isAddress,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { RestError } from "../core.js";
import type { SmartAccountManifest } from "./types.js";

/** Official Safe 1.4.1 artifact, safe-contracts bf943f80fec5ac647159d26161446ac5d716a294.
 * Keeping the creation bytes here makes address prediction browser-safe and independent of RPC. */
export const SAFE_141_PROXY_CREATION_CODE =
  "0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101c46022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f7669646564" as Hex;
export const SAFE_CREATION_ABI = parseAbi([
  "function createProxyWithNonce(address singleton,bytes initializer,uint256 saltNonce) returns(address proxy)",
  "event ProxyCreation(address indexed proxy,address singleton)",
]);
export const SAFE_SETUP_ABI = parseAbi([
  "function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)",
]);
export const SAFE7579_LAUNCH_SETUP_ABI = parseAbi([
  "function addSafe7579(address safe7579,(address module,bytes initData,uint256 moduleType)[] modules,address[] attesters,uint8 threshold)",
]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function invalid(): never {
  throw new RestError(
    422,
    "SMART_CREATION_UNSUPPORTED",
    "Use the reviewed atomic Safe 1.4.1 setup with an empty SmartSession validator and no payment.",
  );
}

/** Pure preparation only. The owner signs and funds the factory transaction in their wallet. */
export function prepareSafe7579Creation(input: {
  manifest: SmartAccountManifest;
  owners: readonly Address[];
  threshold: number;
  saltNonce: string;
}) {
  const { manifest: m } = input;
  if (
    m.safeVersion !== "1.4.1" ||
    m.smartSessions.generation !== "legacy-validator" ||
    m.safe7579.source.commit !== "f22a194148ff087f0c16125e530512e59794e188" ||
    !Array.isArray(input.owners) ||
    input.owners.length < 1 ||
    input.owners.length > 16 ||
    Array.from({ length: input.owners.length }, (_, i) => i).some(
      (i) =>
        !Object.hasOwn(input.owners, i) ||
        !isAddress(input.owners[i]!) ||
        BigInt(input.owners[i]!) <= 1n,
    ) ||
    new Set(input.owners.map((a) => a.toLowerCase())).size !==
      input.owners.length ||
    !Number.isSafeInteger(input.threshold) ||
    input.threshold < 1 ||
    input.threshold > input.owners.length ||
    typeof input.saltNonce !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(input.saltNonce) ||
    input.saltNonce.length > 78 ||
    BigInt(input.saltNonce) >= 1n << 256n
  )
    invalid();
  const owners = input.owners.map((a) => getAddress(a));
  const adapterSetup = encodeFunctionData({
    abi: SAFE7579_LAUNCH_SETUP_ABI,
    functionName: "addSafe7579",
    args: [
      m.safe7579.address,
      [{ module: m.smartSessions.address, initData: "0x", moduleType: 1n }],
      [],
      0,
    ],
  });
  const initializer = encodeFunctionData({
    abi: SAFE_SETUP_ABI,
    functionName: "setup",
    args: [
      owners,
      BigInt(input.threshold),
      m.launchpad.address,
      adapterSetup,
      m.safe7579.address,
      zeroAddress,
      0n,
      zeroAddress,
    ],
  });
  const initializerHash = keccak256(initializer);
  const salt = keccak256(
    concatHex([
      initializerHash,
      encodeAbiParameters([{ type: "uint256" }], [BigInt(input.saltNonce)]),
    ]),
  );
  const bytecode = concatHex([
    SAFE_141_PROXY_CREATION_CODE,
    encodeAbiParameters([{ type: "address" }], [m.singleton.address]),
  ]);
  const address = getContractAddress({
    from: m.factory.address,
    opcode: "CREATE2",
    salt,
    bytecode,
  });
  return {
    chainId: m.chainId,
    manifestId: m.id,
    manifestRevision: m.revision,
    address,
    owners,
    threshold: input.threshold,
    saltNonce: input.saltNonce,
    initializer,
    initializerHash,
    transaction: {
      to: m.factory.address,
      value: "0" as const,
      data: encodeFunctionData({
        abi: SAFE_CREATION_ABI,
        functionName: "createProxyWithNonce",
        args: [m.singleton.address, initializer, BigInt(input.saltNonce)],
      }),
    },
    initialAuthority: {
      validator: m.smartSessions.address,
      enabledSessions: 0,
      executors: [],
      hooks: [],
      fallbacks: [],
      registryEnforced: false as const,
    },
  };
}

/** Canonical round-trip validation rejects arbitrary launchpad init data, hidden calls and payments. */
export function verifySafe7579CreationCall(
  manifest: SmartAccountManifest,
  account: Address,
  data: Hex,
) {
  try {
    const factory = decodeFunctionData({ abi: SAFE_CREATION_ABI, data });
    if (
      factory.functionName !== "createProxyWithNonce" ||
      !same(factory.args[0], manifest.singleton.address)
    )
      invalid();
    const setup = decodeFunctionData({
      abi: SAFE_SETUP_ABI,
      data: factory.args[1],
    });
    const prepared = prepareSafe7579Creation({
      manifest,
      owners: setup.args[0],
      threshold: Number(setup.args[1]),
      saltNonce: String(factory.args[2]),
    });
    if (
      !same(prepared.address, account) ||
      !same(prepared.transaction.data, data)
    )
      invalid();
    return prepared;
  } catch (error) {
    if (error instanceof RestError) throw error;
    return invalid();
  }
}
