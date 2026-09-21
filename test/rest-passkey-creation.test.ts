import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { concatHex, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getContractAddress,
  keccak256, parseAbi, toHex, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { preparePasskeySafe7579Creation, prepareSafe7579Creation, SAFE_CREATION_ABI, SAFE_SETUP_ABI, SAFE_141_PROXY_CREATION_CODE,
  SAFE7579_LAUNCH_SETUP_ABI, verifySafe7579CreationCall } from "../src/rest/smartAccounts/creation.js";
import { SAFE_WEBAUTHN_SIGNER_PROXY_CREATION_CODE, validatePasskeyCreationManifest } from "../src/rest/smartAccounts/passkeyCreation.js";
import type { ContractPin, SmartAccountManifest } from "../src/rest/smartAccounts/types.js";

const load = (directory: string, name: string) => {
  const bytes = readFileSync(new URL(`../src/rest/smartAccounts/stack/${directory}${name}.json`, import.meta.url));
  return { bytes, artifact: JSON.parse(bytes.toString("utf8")) };
};
const pin = (name: string): ContractPin => {
  const { artifact: a } = load("artifacts/", name);
  return { address: a.address, runtimeCodeHash: a.runtimeCodeHash,
    source: { repository: a.source.repo, commit: a.source.commit, artifactSha256: a.source.artifactSha256 } };
};
const signerPin = (name: string, address: Address): ContractPin => {
  const { artifact: a, bytes } = load("passkey/artifacts/", name);
  return { address, runtimeCodeHash: keccak256(a.deployedBytecode), source: { repository: a.source.repository,
    commit: a.source.commit, artifactSha256: createHash("sha256").update(bytes).digest("hex") } };
};
const manifest: SmartAccountManifest = {
  id: "passkey-bootstrap-local", mode: "execution-candidate", chainId: 8453,
  revision: keccak256(toHex("passkey-bootstrap-local")), safeVersion: "1.4.1",
  proxyRuntimeCodeHash: load("artifacts/", "SafeProxy").artifact.runtimeCodeHash,
  singleton: pin("SafeL2"), factory: pin("SafeProxyFactory"), safe7579: pin("Safe7579"), launchpad: pin("Safe7579Launchpad"),
  smartSessions: { ...pin("SmartSession"), generation: "legacy-validator" }, policies: [], moduleInspectorId: "local",
  ownerProfile: { version: "center-passkey-v1",
    signerFactory: signerPin("SafeWebAuthnSignerFactory", "0x1111111111111111111111111111111111111111"),
    signerSingleton: signerPin("SafeWebAuthnSignerSingleton", "0x2222222222222222222222222222222222222222"),
    p256Verifier: signerPin("FCLP256Verifier", "0x3333333333333333333333333333333333333333") },
  creationProfile: { version: "center-passkey-bootstrap-v1", multiSend: {
    address: "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526",
    runtimeCodeHash: "0x0e4f7fc66550a322d1e7688e181b75e217e662a4f3f4d6a29b22bc61217c4b77",
    source: { repository: "https://github.com/safe-global/safe-contracts", commit: "bf943f80fec5ac647159d26161446ac5d716a294",
      artifactSha256: "cdfa2bbcba64c698db975a0c332457f3ec1a0653f147ff6b5d2ee8771084961b" } } },
};
const publicKey = {
  x: "0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296" as Hex,
  y: "0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5" as Hex,
};
const recoveryOwner = "0x4444444444444444444444444444444444444444" as const;
const input = { manifest, publicKey, recoveryOwner, saltNonce: "42" };
const multiSendAbi = parseAbi(["function multiSend(bytes transactions)"]);
const signerFactoryAbi = parseAbi(["function createSigner(uint256 x,uint256 y,uint176 verifiers) returns(address)"]);
const reject = (run: () => unknown) => expect(run).toThrowError(expect.objectContaining({ code: "SMART_CREATION_UNSUPPORTED" }));
const replaceBytes = (data: Hex, start: number, bytes: Hex): Hex =>
  `${data.slice(0, 2 + start * 2)}${bytes.slice(2)}${data.slice(2 + start * 2 + bytes.length - 2)}` as Hex;

it("uses the exact source-pinned proxy bytecode and remains browser bundleable", async () => {
  expect(SAFE_WEBAUTHN_SIGNER_PROXY_CREATION_CODE).toBe(load("passkey/artifacts/", "SafeWebAuthnSignerProxy").artifact.bytecode);
  const result = await build({ entryPoints: ["src/rest/smartAccounts/creation.ts"], bundle: true, platform: "browser", write: false, logLevel: "silent" });
  expect(result.errors).toEqual([]);
});

it("prepares one atomic signer creation and empty Safe7579 setup with a fixed recovery owner", () => {
  const prepared = preparePasskeySafe7579Creation(input), bootstrap = prepared.bootstrap!;
  const p = manifest.ownerProfile!;
  const signer = getContractAddress({ from: p.signerFactory.address, opcode: "CREATE2", salt: zeroHash,
    bytecode: concatHex([load("passkey/artifacts/", "SafeWebAuthnSignerProxy").artifact.bytecode,
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint176" }],
        [p.signerSingleton.address, BigInt(publicKey.x), BigInt(publicKey.y), BigInt(p.p256Verifier.address)])]) });
  expect(prepared.owners).toEqual([signer, recoveryOwner]);
  expect(prepared.threshold).toBe(1);
  expect(bootstrap).toMatchObject({ version: "center-passkey-bootstrap-v1", signerAddress: signer, publicKey,
    verifiers: toHex(BigInt(p.p256Verifier.address), { size: 22 }) });
  expect(decodeFunctionData({ abi: signerFactoryAbi, data: bootstrap.signerFactoryData }).args)
    .toEqual([BigInt(publicKey.x), BigInt(publicKey.y), BigInt(p.p256Verifier.address)]);
  expect(decodeFunctionData({ abi: SAFE7579_LAUNCH_SETUP_ABI, data: bootstrap.launchpadData }).args)
    .toEqual([manifest.safe7579.address, [{ module: manifest.smartSessions.address, initData: "0x", moduleType: 1n }], [], 0]);
  expect(decodeFunctionData({ abi: SAFE_SETUP_ABI, data: prepared.initializer }).args)
    .toEqual([[signer, recoveryOwner], 1n, manifest.creationProfile!.multiSend.address,
      bootstrap.multiSendData, manifest.safe7579.address, zeroAddress, 0n, zeroAddress]);
  expect(verifySafe7579CreationCall(manifest, prepared.address, prepared.transaction.data)).toEqual(prepared);
  expect(preparePasskeySafe7579Creation({ ...input, saltNonce: "43" }).address).not.toBe(prepared.address);
  reject(() => verifySafe7579CreationCall(manifest, recoveryOwner, prepared.transaction.data));
});

it.each([
  ["missing creation profile", (m: SmartAccountManifest) => { delete m.creationProfile; }],
  ["unknown creation profile", (m: SmartAccountManifest) => { (m.creationProfile as any).version = "other"; }],
  ["missing owner profile", (m: SmartAccountManifest) => { delete m.ownerProfile; }],
  ["other owner profile", (m: SmartAccountManifest) => { (m.ownerProfile as any).version = "other"; }],
  ["zero signer factory", (m: SmartAccountManifest) => { m.ownerProfile!.signerFactory.address = zeroAddress; }],
  ["invalid signer singleton", (m: SmartAccountManifest) => { m.ownerProfile!.signerSingleton.address = "0x01" as Address; }],
  ["zero P256 verifier", (m: SmartAccountManifest) => { m.ownerProfile!.p256Verifier.address = zeroAddress; }],
  ["other chain", (m: SmartAccountManifest) => { m.chainId = 1; }],
  ["other Safe version", (m: SmartAccountManifest) => { (m as any).safeVersion = "1.5.0"; }],
  ["other sessions generation", (m: SmartAccountManifest) => { m.smartSessions.generation = "emissary"; }],
  ["other Safe7579 commit", (m: SmartAccountManifest) => { m.safe7579.source.commit = "f".repeat(40); }],
  ["other MultiSend", (m: SmartAccountManifest) => { m.creationProfile!.multiSend.address = recoveryOwner; }],
  ["malformed MultiSend address", (m: SmartAccountManifest) => { m.creationProfile!.multiSend.address = m.creationProfile!.multiSend.address.replace("0x", "0X") as Address; }],
  ["other MultiSend source", (m: SmartAccountManifest) => { m.creationProfile!.multiSend.source.repository += "-other"; }],
  ["other MultiSend commit", (m: SmartAccountManifest) => { m.creationProfile!.multiSend.source.commit = "f".repeat(40); }],
  ["other MultiSend artifact", (m: SmartAccountManifest) => { m.creationProfile!.multiSend.source.artifactSha256 = "f".repeat(64); }],
  ["other MultiSend runtime", (m: SmartAccountManifest) => { m.creationProfile!.multiSend.runtimeCodeHash = zeroHash; }],
] as const)("rejects unsupported manifest: %s", (_, mutate) => {
  const m = structuredClone(manifest); mutate(m);
  reject(() => validatePasskeyCreationManifest(m));
  reject(() => preparePasskeySafe7579Creation({ ...input, manifest: m }));
});

it.each([
  { publicKey: { ...publicKey, x: "0x01" as Hex } },
  { publicKey: { ...publicKey, y: zeroHash } },
  { publicKey: { x: "0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff" as Hex, y: publicKey.y } },
  { recoveryOwner: zeroAddress },
  { recoveryOwner: "0x0000000000000000000000000000000000000001" as Address },
  { saltNonce: "01" }, { saltNonce: "-1" }, { saltNonce: String(1n << 256n) },
])("rejects malformed key, recovery authority or salt: %j", (change) => {
  reject(() => preparePasskeySafe7579Creation({ ...input, ...change }));
});

it("rejects a signer that is also its own recovery owner, and cannot silently use legacy creation", () => {
  const signer = preparePasskeySafe7579Creation(input).bootstrap!.signerAddress;
  reject(() => preparePasskeySafe7579Creation({ ...input, recoveryOwner: signer }));
  reject(() => prepareSafe7579Creation({ manifest, owners: [recoveryOwner], threshold: 1, saltNonce: "42" }));
  const legacy = structuredClone(manifest); delete legacy.creationProfile; delete legacy.ownerProfile;
  const prepared = prepareSafe7579Creation({ manifest: legacy, owners: [recoveryOwner], threshold: 1, saltNonce: "42" });
  expect(prepared).not.toHaveProperty("bootstrap");
  expect(verifySafe7579CreationCall(legacy, prepared.address, prepared.transaction.data)).toEqual(prepared);
  reject(() => verifySafe7579CreationCall(manifest, prepared.address, prepared.transaction.data));
});

it("rejects every hidden operation, altered authority, payment, padding and trailing byte", () => {
  const prepared = preparePasskeySafe7579Creation(input);
  const setup = decodeFunctionData({ abi: SAFE_SETUP_ABI, data: prepared.initializer });
  const packed = decodeFunctionData({ abi: multiSendAbi, data: prepared.bootstrap!.multiSendData }).args[0];
  const firstLength = 85 + 100;
  // Use each attack's actual CREATE2 address so address mismatch cannot mask a permissive parser.
  const verifyAttack = (data: Hex) => {
    const decoded = decodeFunctionData({ abi: SAFE_CREATION_ABI, data });
    const address = getContractAddress({ from: manifest.factory.address, opcode: "CREATE2",
      salt: keccak256(concatHex([keccak256(decoded.args[1]), encodeAbiParameters([{ type: "uint256" }], [decoded.args[2]])])),
      bytecode: concatHex([SAFE_141_PROXY_CREATION_CODE, encodeAbiParameters([{ type: "address" }], [decoded.args[0]])]) });
    reject(() => verifySafe7579CreationCall(manifest, address, data));
  };
  const factory = (initializer: Hex) => encodeFunctionData({ abi: SAFE_CREATION_ABI, functionName: "createProxyWithNonce",
    args: [manifest.singleton.address, initializer, BigInt(input.saltNonce)] });
  const withPacked = (data: Hex) => {
    const args = [...setup.args] as unknown as Parameters<typeof encodeFunctionData<typeof SAFE_SETUP_ABI, "setup">>[0]["args"];
    return factory(encodeFunctionData({ abi: SAFE_SETUP_ABI, functionName: "setup",
      args: [args[0], args[1], args[2], encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [data] }), ...args.slice(4)] as any }));
  };
  const packedAttacks: Hex[] = [
    replaceBytes(packed, 0, "0x01"), replaceBytes(packed, 1, recoveryOwner),
    replaceBytes(packed, 21, toHex(1n, { size: 32 })), replaceBytes(packed, 53, toHex(101n, { size: 32 })),
    replaceBytes(packed, 85 + 4 + 64, toHex(0n, { size: 32 })),
    replaceBytes(packed, firstLength, "0x00"), replaceBytes(packed, firstLength + 1, recoveryOwner),
    replaceBytes(packed, firstLength + 21, toHex(1n, { size: 32 })),
    concatHex([packed, "0x00"]), concatHex([packed, packed]), packed.slice(0, -2) as Hex,
  ];
  for (const data of packedAttacks) verifyAttack(withPacked(data));
  for (const [index, value] of [[0, [recoveryOwner, prepared.owners[0]]], [1, 2n], [2, manifest.launchpad.address],
    [4, recoveryOwner], [5, recoveryOwner], [6, 1n], [7, recoveryOwner]] as const) {
    const args: any[] = [...setup.args]; args[index] = value;
    verifyAttack(factory(encodeFunctionData({ abi: SAFE_SETUP_ABI, functionName: "setup", args: args as any })));
  }
  verifyAttack(concatHex([prepared.transaction.data, "0x00"]));
  verifyAttack(factory(concatHex([prepared.initializer, "0x00"])));
  const paddingOffset = 4 + 32 * 3 + 32 + (prepared.initializer.length - 2) / 2;
  verifyAttack(replaceBytes(prepared.transaction.data, paddingOffset, "0x01"));
});
