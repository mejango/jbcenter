import {
  getAddress,
  hashTypedData,
  isAddress,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { RestAuthError, type BotScope } from "./store.js";

export const REST_AUTH_HEADERS = {
  account: "X-Juicebox-Account",
  signer: "X-Juicebox-Signer",
  grant: "X-Juicebox-Grant",
  issuedAt: "X-Juicebox-Issued-At",
  expiresAt: "X-Juicebox-Expires-At",
  nonce: "X-Juicebox-Nonce",
  signature: "X-Juicebox-Signature",
  idempotencyKey: "Idempotency-Key",
} as const;

export type SignedRequestInput = {
  method: string;
  /** Exact origin-form path and query sent on the wire; never a reserialized query. */
  requestTarget: string;
  contentType: string;
  body: Uint8Array;
  headers: Headers;
  signal?: AbortSignal;
};

export type RequestClaims = {
  accountId: string;
  signer: Address;
  grantId: string;
  method: string;
  requestTarget: string;
  contentType: string;
  bodyHash: Hex;
  issuedAt: number;
  expiresAt: number;
  nonce: Hex;
  idempotencyKey: string;
};

export type BotProof = {
  accountId: string;
  botAddress: Address;
  scopes: BotScope[];
  expiresAt: number;
  label: string;
  ownerRequestNonce: Hex;
};

const requestTypes = {
  CenterRequest: [
    { name: "audience", type: "string" },
    { name: "accountId", type: "string" },
    { name: "signer", type: "address" },
    { name: "grantId", type: "string" },
    { name: "method", type: "string" },
    { name: "requestTarget", type: "string" },
    { name: "contentType", type: "string" },
    { name: "bodyHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "bytes32" },
    { name: "idempotencyKey", type: "string" },
  ],
} as const;

const botTypes = {
  CenterBotProof: [
    { name: "audience", type: "string" },
    { name: "accountId", type: "string" },
    { name: "botAddress", type: "address" },
    { name: "scopes", type: "string[]" },
    { name: "expiresAt", type: "uint64" },
    { name: "label", type: "string" },
    { name: "ownerRequestNonce", type: "bytes32" },
  ],
} as const;

function invalid(message = "Invalid signed request"): never {
  throw new RestAuthError("INVALID_AUTH", 400, message);
}

export function validateAudience(audience: string): string {
  let parsed: URL;
  try { parsed = new URL(audience); } catch { return invalid("Invalid authentication audience"); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.protocol !== "https:" && !(parsed.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)))) {
    return invalid("Authentication audience must be HTTPS or local HTTP without credentials, query, or fragment");
  }
  return audience.replace(/\/$/, "");
}

export function accountIdFor(owner: Address, authorityChainId: number): string {
  if (!Number.isSafeInteger(authorityChainId) || authorityChainId <= 0 || typeof owner !== "string" || !isAddress(owner)) {
    return invalid("Invalid account owner or authority chain");
  }
  return `eip155:${authorityChainId}:${owner.toLowerCase()}`;
}

export function parseAccountId(accountId: string): { ownerAddress: Address; authorityChainId: number } {
  const match = /^eip155:([1-9][0-9]{0,15}):(0x[0-9a-f]{40})$/.exec(accountId);
  if (!match) return invalid("Invalid account identity");
  const authorityChainId = Number(match[1]);
  if (!Number.isSafeInteger(authorityChainId)) return invalid("Invalid authority chain");
  return { ownerAddress: getAddress(match[2]!), authorityChainId };
}

function domain(audience: string, accountId: string) {
  return {
    name: "Juicebox Center REST",
    version: "1",
    chainId: parseAccountId(accountId).authorityChainId,
    salt: keccak256(stringToHex(audience)),
  } as const;
}

export function buildRequestTypedData(audience: string, claims: RequestClaims) {
  audience = validateAudience(audience);
  return {
    domain: domain(audience, claims.accountId),
    types: requestTypes,
    primaryType: "CenterRequest" as const,
    message: {
      ...claims,
      audience,
      issuedAt: BigInt(claims.issuedAt),
      expiresAt: BigInt(claims.expiresAt),
    },
  };
}

export function buildBotProofTypedData(audience: string, proof: BotProof) {
  audience = validateAudience(audience);
  return {
    domain: domain(audience, proof.accountId),
    types: botTypes,
    primaryType: "CenterBotProof" as const,
    message: { ...proof, audience, expiresAt: BigInt(proof.expiresAt) },
  };
}

export function newRequestNonce(): Hex {
  return toHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

function required(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (!value) throw new RestAuthError("AUTH_REQUIRED", 401, "Signed request headers are required");
  return value;
}

function timestamp(value: string): number {
  if (!/^[1-9][0-9]{0,12}$/.test(value)) return invalid("Invalid signature timestamp");
  const result = Number(value);
  if (!Number.isSafeInteger(result)) return invalid("Invalid signature timestamp");
  return result;
}

export function readRequestClaims(input: SignedRequestInput): { claims: RequestClaims; signature: Hex } {
  const { headers } = input;
  const accountId = required(headers, REST_AUTH_HEADERS.account);
  parseAccountId(accountId);
  const signer = required(headers, REST_AUTH_HEADERS.signer);
  if (!isAddress(signer)) return invalid("Invalid request signer");
  const grantId = headers.get(REST_AUTH_HEADERS.grant) ?? "";
  if (grantId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(grantId)) {
    return invalid("Invalid bot grant identifier");
  }
  const nonce = required(headers, REST_AUTH_HEADERS.nonce);
  if (!/^0x[0-9a-f]{64}$/.test(nonce)) return invalid("Signature nonce must be 32 random bytes");
  const signature = required(headers, REST_AUTH_HEADERS.signature);
  // Contract-wallet signatures can be variable length; the verifier owns interpretation.
  if (!/^0x(?:[0-9a-fA-F]{2}){1,8192}$/.test(signature)) return invalid("Invalid signature encoding");
  const idempotencyKey = headers.get(REST_AUTH_HEADERS.idempotencyKey) ?? "";
  if (idempotencyKey && !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) return invalid("Invalid idempotency key");
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(input.method)) return invalid("Invalid HTTP method");
  if (input.requestTarget.length > 4096 || !/^\/[\x21-\x7e]*$/.test(input.requestTarget) ||
      /[#\\]/.test(input.requestTarget) || /%(?![0-9a-fA-F]{2})/.test(input.requestTarget)) {
    return invalid("Invalid HTTP request target");
  }
  if (input.contentType.length > 256 || /[\r\n\0]/.test(input.contentType) ||
      input.contentType !== (headers.get("content-type") ?? "")) return invalid("Invalid content type");
  return {
    signature: signature as Hex,
    claims: {
      accountId, signer: getAddress(signer), grantId,
      method: input.method, requestTarget: input.requestTarget, contentType: input.contentType,
      bodyHash: keccak256(input.body),
      issuedAt: timestamp(required(headers, REST_AUTH_HEADERS.issuedAt)),
      expiresAt: timestamp(required(headers, REST_AUTH_HEADERS.expiresAt)),
      nonce: nonce as Hex, idempotencyKey,
    },
  };
}

export type ContractOwnerVerifier = (input: {
  ownerAddress: Address;
  authorityChainId: number;
  digest: Hex;
  signature: Hex;
  signal: AbortSignal;
}) => Promise<boolean>;

export async function verifyRequestSignature(
  audience: string,
  claims: RequestClaims,
  signature: Hex,
  verifyContractOwner?: ContractOwnerVerifier,
  requestSignal?: AbortSignal,
): Promise<void> {
  if (requestSignal?.aborted) throw new RestAuthError("REQUEST_ABORTED", 408, "Signature verification was interrupted");
  const typedData = buildRequestTypedData(audience, claims);
  try {
    const recovered = await recoverTypedDataAddress({ ...typedData, signature });
    if (recovered.toLowerCase() === claims.signer.toLowerCase()) return;
  } catch { /* A contract owner may use an EIP-1271 signature. */ }
  const owner = parseAccountId(claims.accountId);
  if (!claims.grantId && claims.signer.toLowerCase() === owner.ownerAddress.toLowerCase() && verifyContractOwner) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, 5_000);
    requestSignal?.addEventListener("abort", abort, { once: true });
    let abortListener: (() => void) | undefined;
    try {
      if (requestSignal?.aborted) controller.abort();
      if (controller.signal.aborted) throw new Error("Contract signature verification interrupted");
      const interrupted = new Promise<never>((_, reject) => {
        abortListener = () => reject(new Error("Contract signature verification interrupted"));
        controller.signal.addEventListener("abort", abortListener, { once: true });
      });
      const result = await Promise.race([
        verifyContractOwner({ ...owner, digest: hashTypedData(typedData), signature, signal: controller.signal }),
        interrupted,
      ]);
      if (result && !controller.signal.aborted) return;
    } catch { /* RPC/verifier failures must never authorize a request. */ }
    finally {
      clearTimeout(timer);
      requestSignal?.removeEventListener("abort", abort);
      if (abortListener) controller.signal.removeEventListener("abort", abortListener);
      controller.abort();
    }
  }
  throw new RestAuthError("INVALID_SIGNATURE", 401, "Request signature is invalid");
}

export async function verifyBotProof(audience: string, proof: BotProof, signature: Hex): Promise<void> {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new RestAuthError("INVALID_BOT_PROOF", 400, "Bot must prove possession of an EOA private key");
  }
  try {
    const recovered = await recoverTypedDataAddress({ ...buildBotProofTypedData(audience, proof), signature });
    if (recovered.toLowerCase() === proof.botAddress.toLowerCase()) return;
  } catch { /* Safe error below; never return signature material. */ }
  throw new RestAuthError("INVALID_BOT_PROOF", 400, "Bot proof does not match the registration");
}
