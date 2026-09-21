import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { encode } from "cbor2";
import { keccak256, toHex, type Address, type Hex, type TypedData, type TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ContractPin, SmartAccountManifest } from "../../src/rest/smartAccounts/types.js";
import type { WalletRegistrationResponse } from "../../src/rest/wallet/registration.js";
import type { WalletAssertion } from "../../src/rest/wallet/webauthn.js";

const hex = (bytes: Uint8Array): Hex => `0x${Buffer.from(bytes).toString("hex")}`;
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest();

type CeremonyFixture = {
  challenge: Hex;
  rpId: string;
  origin: string;
  userHandle: string;
  backupEligible?: boolean;
  backedUp?: boolean;
  signCount?: number;
  /** A ceremony run inside a frame on this top origin (a cross-origin assertion). */
  topOrigin?: string;
};

function authenticatorPrefix(input: CeremonyFixture, registration: boolean): Buffer {
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(input.signCount ?? 0);
  const backupEligible = input.backupEligible ?? true;
  const backedUp = input.backedUp ?? backupEligible;
  const flags = 0x05 | (registration ? 0x40 : 0) | (backupEligible ? 0x08 : 0) | (backedUp ? 0x10 : 0);
  return Buffer.concat([sha256(input.rpId), Buffer.from([flags]), counter]);
}

function clientData(input: CeremonyFixture, type: "webauthn.create" | "webauthn.get"): Buffer {
  return Buffer.from(JSON.stringify({
    type, challenge: Buffer.from(input.challenge.slice(2), "hex").toString("base64url"),
    origin: input.origin, ...(input.topOrigin ? { crossOrigin: true, topOrigin: input.topOrigin } : { crossOrigin: false }),
  }));
}

/** Test-only none-attestation producer. The private key stays in memory; a separate get proves possession. */
export function createRegistration(input: CeremonyFixture & { credentialId?: string; key?: KeyObject }): {
  response: WalletRegistrationResponse;
  key: KeyObject;
  publicKey: { x: Hex; y: Hex };
  credentialId: string;
  userHandle: string;
} {
  const key = input.key ?? generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  const jwk = createPublicKey(key).export({ format: "jwk" });
  const x = Buffer.from(jwk.x!, "base64url"), y = Buffer.from(jwk.y!, "base64url");
  const credentialId = input.credentialId ?? randomBytes(32).toString("base64url");
  const rawId = Buffer.from(credentialId, "base64url");
  const length = Buffer.alloc(2); length.writeUInt16BE(rawId.length);
  const cose = encode(new Map<number, unknown>([
    [1, 2], [3, -7], [-1, 1], [-2, Uint8Array.from(x)], [-3, Uint8Array.from(y)],
  ]));
  const authData = Buffer.concat([
    authenticatorPrefix(input, true), Buffer.from("01020304050607080102030405060708", "hex"), length, rawId, cose,
  ]);
  return {
    response: {
      type: "public-key", credentialId, rawId, clientDataJSON: clientData(input, "webauthn.create"),
      attestationObject: encode(new Map<string, unknown>([
        ["fmt", "none"], ["attStmt", new Map()], ["authData", Uint8Array.from(authData)],
      ])),
    },
    key, publicKey: { x: hex(x), y: hex(y) }, credentialId, userHandle: input.userHandle,
  };
}

/** Produces a genuine DER P-256 assertion over authenticatorData || SHA256(clientDataJSON). */
export function signGet(input: CeremonyFixture & { credentialId: string; key: KeyObject }): WalletAssertion {
  const authenticatorData = authenticatorPrefix(input, false);
  const clientDataJSON = clientData(input, "webauthn.get");
  return {
    credentialId: input.credentialId, userHandle: input.userHandle, authenticatorData, clientDataJSON,
    signature: sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), input.key),
  };
}

/** Publicly known deterministic fixture key; this account must never hold real funds. */
export const enrollmentBackupAccount = privateKeyToAccount(`0x${"11".repeat(32)}`);

export function signBackupProof<
  const typedData extends TypedData | Record<string, unknown>,
  primaryType extends keyof typedData | "EIP712Domain" = keyof typedData,
>(document: TypedDataDefinition<typedData, primaryType>, account = enrollmentBackupAccount): Promise<Hex> {
  return account.signTypedData(document);
}

const load = (directory: string, name: string) => {
  const bytes = readFileSync(new URL(`../../src/rest/smartAccounts/stack/${directory}${name}.json`, import.meta.url));
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

/** Public source-pinned local fixture; its placeholder signer addresses are not deployment evidence. */
export const enrollmentManifest: SmartAccountManifest = {
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
