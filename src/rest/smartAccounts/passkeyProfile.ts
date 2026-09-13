import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  concatHex, decodeFunctionResult, encodeAbiParameters, encodeFunctionData,
  getAddress, getContractAddress, isAddress, keccak256, parseAbi, toHex,
  zeroHash, type Address, type Hex,
} from "viem";
import { RestError } from "../core.js";
import { rpcHex } from "../protocol/code.js";
import type { ContractPin, PasskeyOwnerState, SmartAccountManifest, SmartSnapshot } from "./types.js";

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

/** Only accepts an opt-in server manifest and owners already read from the Safe at this snapshot.
 * Exactly one immutable passkey plus one independent EOA is the pilot's complete authority set.
 */
export async function inspectPasskeyOwnerProfile(input: {
  manifest: SmartAccountManifest; owners: readonly Address[]; threshold: number; snapshot: SmartSnapshot;
}): Promise<{ ownerProfile: PasskeyOwnerState; codeHashes: { address: Address; runtimeCodeHash: Hex }[] }> {
  const { manifest, snapshot, owners } = input, profile = manifest.ownerProfile;
  if (!profile || profile.version !== "center-passkey-v1" || manifest.chainId !== 8453 || snapshot.evidence.chainId !== 8453)
    invalid("The experimental passkey owner profile requires its explicit version on Base.");
  if (input.threshold !== 1 || owners.length !== 2 || owners.some((a) => !isAddress(a) || BigInt(a) <= 1n) || same(owners[0]!, owners[1]!))
    unsupported("The passkey pilot requires exactly one passkey signer and one independent EOA, with threshold one.");
  const a = await artifacts();
  if (!isAddress(profile.signerSingleton?.address)) invalid("A pinned passkey singleton is required.");
  requirePin(profile.signerFactory, "SafeWebAuthnSignerFactory", runtime(a.SafeWebAuthnSignerFactory, { "16": BigInt(profile.signerSingleton.address) }));
  requirePin(profile.signerSingleton, "SafeWebAuthnSignerSingleton", a.SafeWebAuthnSignerSingleton.deployedBytecode);
  requirePin(profile.p256Verifier, "FCLP256Verifier", a.FCLP256Verifier.deployedBytecode);
  const codeHashes: { address: Address; runtimeCodeHash: Hex }[] = [];
  // These checks also make the standalone helper safe; every read uses the caller's same canonical block.
  for (const pin of [profile.signerFactory, profile.signerSingleton, profile.p256Verifier]) {
    const code = rpcHex(await snapshot.request("eth_getCode", [pin.address]), "passkey dependency code");
    if (!same(keccak256(code), pin.runtimeCodeHash)) unsupported("A passkey dependency runtime differs from its reviewed pin.");
    codeHashes.push({ address: getAddress(pin.address), runtimeCodeHash: keccak256(code) });
  }
  async function read(address: Address, functionName: "SINGLETON" | "getSigner" | "getConfiguration", args: readonly unknown[] = []) {
    try {
      return decodeFunctionResult({ abi: ABI, functionName,
        data: rpcHex(await snapshot.request("eth_call", [{ to: address,
          data: encodeFunctionData({ abi: ABI, functionName, args } as Parameters<typeof encodeFunctionData>[0]), gas: "0x7a120" }]), "passkey configuration") });
    } catch { unsupported("The passkey configuration could not be read at the canonical snapshot."); }
  }
  if (!same(String(await read(profile.signerFactory.address, "SINGLETON")), profile.signerSingleton.address))
    unsupported("The signer factory uses a different singleton.");
  const observed = await Promise.all(owners.map(async (address) => ({ address: getAddress(address),
    code: rpcHex(await snapshot.request("eth_getCode", [address]), "owner code") })));
  const eoa = observed.filter((o) => o.code === "0x"), contracts = observed.filter((o) => o.code !== "0x");
  if (eoa.length !== 1 || contracts.length !== 1)
    unsupported("The recovery owner must be an independent EOA without delegated or contract code.");
  const signer = contracts[0]!;
  const config = await read(signer.address, "getConfiguration");
  if (!Array.isArray(config) || config.length !== 3 || config.some((v) => typeof v !== "bigint"))
    unsupported("The signer configuration is malformed.");
  const [x, y, verifiers] = config as [bigint, bigint, bigint];
  if (x < 0n || x >= PRIME || y < 0n || y >= PRIME ||
    (y * y - x * x * x + 3n * x - B) % PRIME !== 0n || verifiers !== BigInt(profile.p256Verifier.address))
    unsupported("The signer must contain a valid P256 point and exactly the reviewed FCL verifier.");
  const expectedRuntime = runtime(a.SafeWebAuthnSignerProxy, { "226": BigInt(profile.signerSingleton.address), "229": x, "232": y, "236": verifiers });
  const predicted = getContractAddress({ from: profile.signerFactory.address, opcode: "CREATE2", salt: zeroHash,
    bytecode: concatHex([a.SafeWebAuthnSignerProxy.bytecode, encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint176" }],
      [profile.signerSingleton.address, x, y, verifiers])]) });
  if (!same(signer.code, expectedRuntime) || !same(signer.address, predicted) ||
    !same(String(await read(profile.signerFactory.address, "getSigner", [x, y, verifiers])), predicted))
    unsupported("The passkey signer differs from the canonical factory address or immutable runtime.");
  const runtimeCodeHash = keccak256(signer.code);
  codeHashes.push({ address: signer.address, runtimeCodeHash });
  return { ownerProfile: { version: profile.version, signer: { address: signer.address, kind: "contract",
    x: toHex(x, { size: 32 }), y: toHex(y, { size: 32 }), verifiers: toHex(verifiers, { size: 22 }), runtimeCodeHash },
    recoveryOwner: { address: eoa[0]!.address, kind: "ecdsa" } }, codeHashes };
}
