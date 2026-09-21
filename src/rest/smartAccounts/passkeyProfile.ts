import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  concatHex, decodeFunctionResult, encodeAbiParameters, encodeFunctionData,
  getAddress, getContractAddress, isAddress, keccak256, parseAbi, toHex,
  zeroHash, type Address, type Hex,
} from "viem";
import { RestError } from "../core.js";
import { rpcHex } from "../protocol/code.js";
import type { PasskeySignerState, ContractPin, PasskeyOwnerProfile, PasskeyOwnerState, SmartAccountManifest, SmartSnapshot } from "./types.js";

const SOURCE = "https://github.com/safe-fndn/safe-modules";
const COMMIT = "dfd3b05966e727dbb7a2fdeef52e4b230f63304e";
// Exact artifacts reproduced with the source-pinned compiler by check:wallet-compatibility.
const ARTIFACT_SHA256 = {
  SafeWebAuthnSignerProxy: "72471c2985b08cb361e0f158272f3d88248fbd510f318f158c0d2023939524a0",
  SafeWebAuthnSignerFactory: "ac9585e28b510a8f705fee07ddf2f6d5568f6a083059a3cc3eb60ce0d55ea3c2",
  SafeWebAuthnSignerSingleton: "5ec6c7e6a21c62fd2d310181b9c9f28abf8dfdea1ea0c2677ae9573ad2e031d1",
  FCLP256Verifier: "cbd421df28af9002b4562e2cd136d47e802ee14a310b41e63f01617459a21adc",
} as const;
type ArtifactName = keyof typeof ARTIFACT_SHA256;
type Artifact = { bytecode: Hex; deployedBytecode: Hex; immutableReferences: Record<string, { start: number; length: number }[]> };
const ABI = parseAbi([
  "function SINGLETON() view returns(address)",
  "function getConfiguration() view returns(uint256 x,uint256 y,uint176 verifiers)",
  "function getSigner(uint256 x,uint256 y,uint176 verifiers) view returns(address)",
]);
const PRIME = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function invalid(message: string): never { throw new RestError(500, "SMART_PASSKEY_PROFILE_INVALID", message); }
function unsupported(message: string): never { throw new RestError(422, "SMART_PASSKEY_PROFILE_UNSUPPORTED", message); }
let loaded: Promise<Record<ArtifactName, Artifact>> | undefined;
function artifacts() {
  return loaded ??= Promise.all(Object.entries(ARTIFACT_SHA256).map(async ([name, expected]) => {
    const bytes = await readFile(new URL(`./stack/passkey/artifacts/${name}.json`, import.meta.url));
    if (bytes.length > 2_000_000 || createHash("sha256").update(bytes).digest("hex") !== expected)
      invalid("The passkey artifact differs from its reviewed file identity.");
    return [name, JSON.parse(bytes.toString("utf8")) as Artifact] as const;
  })).then((entries) => Object.fromEntries(entries) as Record<ArtifactName, Artifact>);
}
/** Patch only compiler-declared immutable slots in the hash-checked artifact. */
function runtime(a: Artifact, values: Record<string, bigint>): Hex {
  const bytes = Buffer.from(a.deployedBytecode.slice(2), "hex");
  if (Object.keys(values).sort().join() !== Object.keys(a.immutableReferences).sort().join())
    invalid("The immutable layout differs from its reviewed compiler artifact.");
  for (const [id, references] of Object.entries(a.immutableReferences))
    for (const ref of references) {
      if (ref.length !== 32 || ref.start < 0 || ref.start + 32 > bytes.length)
        invalid("The passkey immutable layout is outside its runtime.");
      Buffer.from(toHex(values[id]!, { size: 32 }).slice(2), "hex").copy(bytes, ref.start);
    }
  return `0x${bytes.toString("hex")}`;
}
function requirePin(pin: ContractPin, name: ArtifactName, expectedRuntime: Hex) {
  if (!pin || !isAddress(pin.address) || BigInt(pin.address) <= 1n || pin.source?.repository !== SOURCE ||
    pin.source.commit !== COMMIT || pin.source.artifactSha256 !== ARTIFACT_SHA256[name] ||
    typeof pin.runtimeCodeHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(pin.runtimeCodeHash) ||
    !same(pin.runtimeCodeHash, keccak256(expectedRuntime)))
    invalid("The passkey profile needs the exact reviewed source, artifact and runtime pins.");
}

/** Unsigned deployment of the exact inspected artifacts. The factory constructor creates
 * its singleton with CREATE nonce one; that address is patched only into reviewed slots.
 * These predictions contain no observation, signer, fee authority or activation. */
export async function preparePasskeyDependencyDeployment() {
  const a = await artifacts();
  const deployer = { address: getAddress('0x4e59b44847b379578588920ca78fbf26c0b4956c'),
    // Arachnid deterministic-deployment-proxy, also pinned by prepare-session-guard.mjs.
    runtime: '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3' as Hex };
  const address = (name: ArtifactName) => getContractAddress({ from: deployer.address,
    opcode: 'CREATE2', salt: zeroHash, bytecode: a[name].bytecode });
  const factory = address('SafeWebAuthnSignerFactory');
  const singleton = getContractAddress({ from: factory, nonce: 1n });
  const pin = (name: ArtifactName, address: Address, code: Hex): ContractPin => ({ address,
    runtimeCodeHash: keccak256(code), source: { repository: SOURCE, commit: COMMIT, artifactSha256: ARTIFACT_SHA256[name] } });
  const profile: PasskeyOwnerProfile = { version: 'center-passkey-v1',
    signerFactory: pin('SafeWebAuthnSignerFactory', factory, runtime(a.SafeWebAuthnSignerFactory, { '16': BigInt(singleton) })),
    signerSingleton: pin('SafeWebAuthnSignerSingleton', singleton, a.SafeWebAuthnSignerSingleton.deployedBytecode),
    p256Verifier: pin('FCLP256Verifier', address('FCLP256Verifier'), a.FCLP256Verifier.deployedBytecode) };
  const deployments = [
    { name: 'FCLP256Verifier' as const, pin: profile.p256Verifier },
    { name: 'SafeWebAuthnSignerFactory' as const, pin: profile.signerFactory },
  ].map(item => ({ ...item, initCodeHash: keccak256(a[item.name].bytecode),
    transaction: { to: deployer.address, data: concatHex([zeroHash, a[item.name].bytecode]), value: '0' as const } }));
  return { deployer, profile, deployments };
}

async function inspectDependencies(manifest: SmartAccountManifest, snapshot: SmartSnapshot) {
  const profile = manifest.ownerProfile;
  if (!profile || profile.version !== "center-passkey-v1" || manifest.chainId !== 8453 || snapshot.evidence.chainId !== 8453)
    invalid("The experimental passkey owner profile requires its explicit version on Base.");
  const a = await artifacts();
  if (!isAddress(profile.signerSingleton?.address)) invalid("A pinned passkey singleton is required.");
  requirePin(profile.signerFactory, "SafeWebAuthnSignerFactory", runtime(a.SafeWebAuthnSignerFactory, { "16": BigInt(profile.signerSingleton.address) }));
  requirePin(profile.signerSingleton, "SafeWebAuthnSignerSingleton", a.SafeWebAuthnSignerSingleton.deployedBytecode);
  requirePin(profile.p256Verifier, "FCLP256Verifier", a.FCLP256Verifier.deployedBytecode);
  async function read(address: Address, functionName: "SINGLETON" | "getSigner" | "getConfiguration", args: readonly unknown[] = []) {
    try {
      return decodeFunctionResult({ abi: ABI, functionName,
        data: rpcHex(await snapshot.request("eth_call", [{ to: address,
          data: encodeFunctionData({ abi: ABI, functionName, args } as Parameters<typeof encodeFunctionData>[0]), gas: "0x7a120" }]), "passkey configuration") });
    } catch { unsupported("The passkey configuration could not be read at the canonical snapshot."); }
  }
  // These checks also make the standalone helper safe; every read uses the caller's same canonical
  // block, and they are independent, so they go out together rather than one round trip at a time.
  const [codeHashes, singleton] = await Promise.all([
    Promise.all([profile.signerFactory, profile.signerSingleton, profile.p256Verifier].map(async pin => {
      const code = rpcHex(await snapshot.request("eth_getCode", [pin.address]), "passkey dependency code");
      if (!same(keccak256(code), pin.runtimeCodeHash)) unsupported("A passkey dependency runtime differs from its reviewed pin.");
      return { address: getAddress(pin.address), runtimeCodeHash: keccak256(code) };
    })),
    read(profile.signerFactory.address, "SINGLETON"),
  ]);
  if (!same(String(singleton), profile.signerSingleton.address)) unsupported("The signer factory uses a different singleton.");
  return { a, profile, codeHashes, read };
}

function signerIdentity(a: Record<ArtifactName, Artifact>, profile: PasskeyOwnerProfile, x: bigint, y: bigint, verifiers: bigint) {
  if (x < 0n || x >= PRIME || y < 0n || y >= PRIME ||
    (y * y - x * x * x + 3n * x - B) % PRIME !== 0n || verifiers !== BigInt(profile.p256Verifier.address))
    unsupported("The signer must contain a valid P256 point and exactly the reviewed FCL verifier.");
  const expectedRuntime = runtime(a.SafeWebAuthnSignerProxy, { "226": BigInt(profile.signerSingleton.address), "229": x, "232": y, "236": verifiers });
  const predicted = getContractAddress({ from: profile.signerFactory.address, opcode: "CREATE2", salt: zeroHash,
    bytecode: concatHex([a.SafeWebAuthnSignerProxy.bytecode, encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint176" }],
      [profile.signerSingleton.address, x, y, verifiers])]) });
  return { expectedRuntime, predicted };
}

/** Transaction-free predeployment check. An absent signer is predicted from reviewed artifacts;
 * an existing signer must have the exact immutable key/runtime. This proves no Safe ownership.
 */
export async function inspectPasskeyCreationSigner(input: {
  manifest: SmartAccountManifest; publicKey: { x: Hex; y: Hex }; snapshot: SmartSnapshot;
}): Promise<{ address: Address; deployed: boolean }> {
  if (!input.publicKey || !/^0x[0-9a-fA-F]{64}$/.test(input.publicKey.x) || !/^0x[0-9a-fA-F]{64}$/.test(input.publicKey.y))
    unsupported("A canonical enrolled P256 key is required.");
  const profile = input.manifest.ownerProfile, snapshot = input.snapshot;
  if (!profile || profile.version !== "center-passkey-v1") invalid("The experimental passkey owner profile requires its explicit version on Base.");
  const x = BigInt(input.publicKey.x), y = BigInt(input.publicKey.y), verifiers = BigInt(profile.p256Verifier.address);
  // The predicted signer address comes from the reviewed artifacts alone, so every read is
  // independent of the others: the dependency pins, the factory's own prediction, the prospective
  // signer's code and (if it exists) its configuration go out in one round trip.
  const { expectedRuntime, predicted } = signerIdentity(await artifacts(), profile, x, y, verifiers);
  const call = async (to: Address, functionName: "getSigner" | "getConfiguration", args: readonly unknown[] = []) => decodeFunctionResult({ abi: ABI, functionName,
    data: rpcHex(await snapshot.request("eth_call", [{ to, data: encodeFunctionData({ abi: ABI, functionName, args } as Parameters<typeof encodeFunctionData>[0]), gas: "0x7a120" }]), "passkey configuration") });
  const [, fromFactory, code, config] = await Promise.all([
    inspectDependencies(input.manifest, snapshot),
    call(profile.signerFactory.address, "getSigner", [x, y, verifiers]).catch(() => unsupported("The passkey configuration could not be read at the canonical snapshot.")),
    snapshot.request("eth_getCode", [predicted]).then(value => rpcHex(value, "prospective signer code", 49_152)),
    call(predicted, "getConfiguration").catch(() => null), // An absent signer answers nothing; only a deployed one is checked below.
  ]);
  if (!same(String(fromFactory), predicted)) unsupported("The signer factory does not return the reviewed CREATE2 address.");
  if (code !== "0x") {
    if (!same(code, expectedRuntime) || !Array.isArray(config) || config.length !== 3 ||
      config[0] !== x || config[1] !== y || config[2] !== verifiers)
      unsupported("The deployed signer does not match the enrolled key and exact immutable runtime.");
  }
  return { address: predicted, deployed: code !== "0x" };
}

/** Only accepts an opt-in server manifest and owners already read from the Safe at this snapshot.
 * One independent EOA plus one to `maximumPasskeySigners` canonical passkey signers, threshold one,
 * is the complete authority set: the primary passkey is the last contract owner in the Safe's list
 * (additions go to the head), and every other passkey signer is a device.
 */
export const maximumPasskeySigners = 6;
/** Reads, at one block and in one round trip, whether the signers of a verified passkey owner profile
 * still hold their configuration and runtime, and the recovery owner is still a plain EOA. The
 * factory, singleton and verifier are immutable deployments verified in full elsewhere. */
export async function passkeyOwnerProfileHolds(input: { profile: PasskeyOwnerState; snapshot: SmartSnapshot }): Promise<boolean> {
  const { profile, snapshot } = input;
  const signers = [...(profile.devices ?? []), profile.signer];
  const call = (address: Address) => snapshot.request("eth_call", [{ to: address,
    data: encodeFunctionData({ abi: ABI, functionName: "getConfiguration" }), gas: "0x7a120" }]);
  const [configurations, codes, recovery] = await Promise.all([
    Promise.all(signers.map((signer) => call(signer.address))),
    Promise.all(signers.map((signer) => snapshot.request("eth_getCode", [signer.address]))),
    snapshot.request("eth_getCode", [profile.recoveryOwner.address]),
  ]);
  if (rpcHex(recovery, "owner code") !== "0x") return false;
  return signers.every((signer, index) => {
    const config = decodeFunctionResult({ abi: ABI, functionName: "getConfiguration", data: rpcHex(configurations[index], "passkey configuration") });
    if (!Array.isArray(config) || config.length !== 3 || config.some((v) => typeof v !== "bigint")) return false;
    const [x, y, verifiers] = config as [bigint, bigint, bigint];
    return toHex(x, { size: 32 }) === signer.x && toHex(y, { size: 32 }) === signer.y && toHex(verifiers, { size: 22 }) === signer.verifiers
      && keccak256(rpcHex(codes[index], "signer code")) === signer.runtimeCodeHash;
  });
}
export async function inspectPasskeyOwnerProfile(input: {
  manifest: SmartAccountManifest; owners: readonly Address[]; threshold: number; snapshot: SmartSnapshot;
}): Promise<{ ownerProfile: PasskeyOwnerState; codeHashes: { address: Address; runtimeCodeHash: Hex }[] }> {
  const { manifest, snapshot, owners } = input;
  if (!manifest.ownerProfile || manifest.ownerProfile.version !== "center-passkey-v1" || manifest.chainId !== 8453 || snapshot.evidence.chainId !== 8453)
    invalid("The experimental passkey owner profile requires its explicit version on Base.");
  if (input.threshold !== 1 || owners.length < 2 || owners.length > maximumPasskeySigners + 1 || owners.some((a) => !isAddress(a) || BigInt(a) <= 1n)
    || new Set(owners.map((a) => a.toLowerCase())).size !== owners.length)
    unsupported("The passkey pilot requires at least one passkey signer and one independent EOA, with threshold one.");
  const [{ a, profile, codeHashes, read }, observed] = await Promise.all([inspectDependencies(manifest, snapshot),
    Promise.all(owners.map(async (address) => ({ address: getAddress(address),
      code: rpcHex(await snapshot.request("eth_getCode", [address]), "owner code") })))]);
  const eoa = observed.filter((o) => o.code === "0x"), contracts = observed.filter((o) => o.code !== "0x");
  if (eoa.length !== 1 || contracts.length < 1)
    unsupported("The recovery owner must be an independent EOA without delegated or contract code.");
  const signers: PasskeySignerState[] = await Promise.all(contracts.map(async (signer) => {
    const config = await read(signer.address, "getConfiguration");
    if (!Array.isArray(config) || config.length !== 3 || config.some((v) => typeof v !== "bigint"))
      unsupported("The signer configuration is malformed.");
    const [x, y, verifiers] = config as [bigint, bigint, bigint];
    const { expectedRuntime, predicted } = signerIdentity(a, profile, x, y, verifiers);
    if (!same(signer.code, expectedRuntime) || !same(signer.address, predicted) ||
      !same(String(await read(profile.signerFactory.address, "getSigner", [x, y, verifiers])), predicted))
      unsupported("The passkey signer differs from the canonical factory address or immutable runtime.");
    const runtimeCodeHash = keccak256(signer.code);
    codeHashes.push({ address: signer.address, runtimeCodeHash });
    return { address: signer.address, kind: "contract" as const, x: toHex(x, { size: 32 }), y: toHex(y, { size: 32 }),
      verifiers: toHex(verifiers, { size: 22 }), runtimeCodeHash };
  }));
  const signer = signers[signers.length - 1]!, devices = signers.slice(0, -1);
  return { ownerProfile: { version: profile.version, signer, recoveryOwner: { address: eoa[0]!.address, kind: "ecdsa" },
    ...(devices.length ? { devices } : {}) }, codeHashes };
}
