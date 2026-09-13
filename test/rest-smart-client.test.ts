import { afterEach, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { hashTypedData, keccak256, stringToHex, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  SignedRestClient,
  SmartAccountClient,
  assertReviewedOperation,
  newRequestNonce,
  ownerOperationSignature,
  ownerOperationSigning,
  packOwnerSignatures,
  sessionActionPlanInput,
  signSessionUserOperation,
  signWalletTypedData,
  smartBindingDocument,
  verifyWalletCreation,
  walletTypedDataDocument,
  type BindingChallenge,
  type PreparedUserOperation,
  type WalletProvider,
} from "../src/rest/client/index.js";
import {
  encodeSafe7579Execution,
  legacySessionSigningPayload,
  safe7579OwnerSigningPayload,
  verifyLegacySessionSignature,
  verifySafe7579OwnerSignature,
} from "../src/rest/smartAccounts/accountExecution.js";
import { prepareSafe7579Creation } from "../src/rest/smartAccounts/creation.js";
import { CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS } from "../src/rest/smartAccounts/manifests.js";
import { getUserOperationHash } from "../src/rest/userOperations/codec.js";
import {
  REST_AUTH_HEADERS,
  readRequestClaims,
  verifyRequestSignature,
} from "../src/rest/auth/signatures.js";
import {
  account,
  binding,
  entryPoint,
  h,
  owner,
  ownerKey,
  plan,
  record,
} from "./fixtures/user-operations.js";
import {
  sessionBinding,
  sessionFixture,
  sessionObservation,
} from "./fixtures/sessions.js";

const audience = "https://juicebox.center",
  adapter = "0x7579f2AD53b01c3D8779Fe17928e0D48885B0003" as const;
const coowner = privateKeyToAccount(`0x${"22".repeat(32)}`);
const botPrivateKey = `0x${"37".repeat(32)}` as Hex,
  bot = privateKeyToAccount(botPrivateKey);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture() {
  const now = Date.now(),
    a = account(now),
    b = binding(a, now),
    p = plan("review-plan", owner(a), b, now);
  const r = record(p);
  r.id = "prepared-operation";
  r.operation.callData = encodeSafe7579Execution(
    p.draft.calls.map((c) => ({
      target: c.to,
      value: c.value,
      callData: c.data,
    })),
  );
  r.operationHash = getUserOperationHash(r.operation, entryPoint, 1);
  const signingInput = {
    operation: r.operation,
    entryPoint,
    chainId: 1,
    safe7579: adapter,
    validAfter: String(Math.floor(r.createdAt / 1000)),
    validUntil: String(Math.floor(r.expiresAt / 1000)),
  };
  const signing = safe7579OwnerSigningPayload(signingInput);
  const {
    actor: _actor,
    sender: _sender,
    preparationKey: _key,
    inputHash: _input,
    ...wire
  } = r;
  const prepared: PreparedUserOperation = { ...wire, signing };
  return { a, b, p, prepared, signingInput, now };
}
function sessionOperation() {
  const f = fixture(),
    s = sessionFixture(f.now, { sessionKey: bot.address }).record;
  s.state = "active";
  s.observation = sessionObservation(s, f.now);
  const r = f.prepared;
  r.accountBindingId = s.compiled.bindingId;
  r.operation.sender = s.compiled.wallet;
  r.operation.nonce = toHex(BigInt(s.compiled.smartSessions.address) << 96n);
  r.operationHash = getUserOperationHash(r.operation, r.entryPoint, r.chainId);
  r.session = sessionBinding(s);
  r.signing = legacySessionSigningPayload({
    operation: r.operation,
    chainId: r.chainId,
    entryPoint: r.entryPoint,
    smartSessions: s.compiled.smartSessions.address,
    permissionId: s.compiled.permissionId,
  });
  return { ...f, session: s };
}
function provider(onSign?: () => void): WalletProvider {
  return {
    async request({ method, params }) {
      if (method === "eth_accounts") return [ownerKey.address];
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_signTypedData_v4") {
        onSign?.();
        return ownerKey.signTypedData(JSON.parse(String(params?.[1])));
      }
      throw new Error("Unexpected wallet method");
    },
  };
}

describe("browser smart-wallet signing", () => {
  it("reconstructs zero-payment atomic creation and rejects an altered owner, factory, value or initializer", () => {
    const manifest = CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS[0]!;
    const request = {
      manifestId: manifest.id,
      owners: [ownerKey.address],
      threshold: 1,
      saltNonce: "7",
    };
    const creation = {
      ...prepareSafe7579Creation({ manifest, ...request }),
      evidence: {},
      deploymentConfirmed: false as const,
    };
    expect(verifyWalletCreation({ manifest, request, creation }).address).toBe(
      creation.address,
    );
    for (const changed of [
      { ...creation, address: coowner.address },
      {
        ...creation,
        transaction: { ...creation.transaction, to: coowner.address },
      },
      {
        ...creation,
        transaction: { ...creation.transaction, value: "1" as "0" },
      },
      {
        ...creation,
        transaction: {
          ...creation.transaction,
          data: `${creation.transaction.data}00` as Hex,
        },
      },
    ])
      expect(() =>
        verifyWalletCreation({ manifest, request, creation: changed }),
      ).toThrow();
    expect(() =>
      verifyWalletCreation({
        manifest,
        request: { ...request, owners: [coowner.address] },
        creation,
      }),
    ).toThrow();
  });

  it("reconstructs the service binding digest including the origin's trailing slash and Safe verifying contract", () => {
    const f = fixture(),
      request = {
        manifestId: f.b.manifestId,
        address: f.b.wallet.address,
        nonce: newRequestNonce(),
        expiresAt: Math.floor(f.now / 1000) + 600,
      };
    const typedData = {
      domain: {
        name: "Juicebox Center Smart Account",
        version: "1",
        chainId: 1,
        verifyingContract: request.address,
        salt: keccak256(stringToHex(`${audience}/`)),
      },
      types: {
        BindSmartAccount: [
          { name: "accountId", type: "string" },
          { name: "owner", type: "address" },
          { name: "stateHash", type: "bytes32" },
          { name: "nonce", type: "bytes32" },
          { name: "expiresAt", type: "uint64" },
        ],
      },
      primaryType: "BindSmartAccount",
      message: {
        accountId: f.a.id,
        owner: ownerKey.address,
        stateHash: f.b.state.stateHash,
        nonce: request.nonce,
        expiresAt: BigInt(request.expiresAt),
      },
    } as const;
    const challenge: BindingChallenge = {
      state: f.b.state,
      typedData,
      digest: hashTypedData(typedData),
    };
    const args = {
      audience,
      accountId: f.a.id,
      owner: ownerKey.address,
      request,
      challenge,
    };
    expect(hashTypedData(smartBindingDocument(args))).toBe(challenge.digest);
    expect(
      JSON.parse(
        walletTypedDataDocument(smartBindingDocument(args)),
      ).types.EIP712Domain.map((x: { name: string }) => x.name),
    ).toEqual(["name", "version", "chainId", "verifyingContract", "salt"]);
    expect(() =>
      smartBindingDocument({
        ...args,
        request: { ...request, address: coowner.address },
      }),
    ).toThrow();
    expect(() =>
      smartBindingDocument({ ...args, audience: "https://other.example" }),
    ).toThrow();
    expect(() =>
      smartBindingDocument({
        ...args,
        challenge: { ...challenge, digest: h("wrong") },
      }),
    ).toThrow();
  });

  it("uses the adapter-only SafeOp domain and verifies a real sorted 2-of-2 signature envelope", async () => {
    const f = fixture();
    f.b.state.owners = [ownerKey.address, coowner.address];
    f.b.state.threshold = 2;
    assertReviewedOperation(f.prepared, f.p);
    const payload = ownerOperationSigning({
      ...f.signingInput,
      record: f.prepared,
      binding: f.b,
    });
    const signer = provider();
    const first = await signWalletTypedData({
      provider: signer,
      address: ownerKey.address,
      chainId: 1,
      document: payload.typedData,
    });
    const second = await coowner.signTypedData(payload.typedData as never);
    const signature = await ownerOperationSignature(payload, f.b, [
      second,
      first,
    ]);
    expect(signature.length).toBe(2 + (12 + 130) * 2);
    expect(
      await verifySafe7579OwnerSignature({
        ...f.signingInput,
        operation: { ...f.prepared.operation, signature },
        owners: f.b.state.owners,
        threshold: 2,
      }),
    ).toHaveLength(2);
    const wire = JSON.parse(walletTypedDataDocument(payload.typedData));
    expect(wire.domain.verifyingContract.toLowerCase()).toBe(
      adapter.toLowerCase(),
    );
    expect(
      wire.types.EIP712Domain.map((x: { name: string }) => x.name),
    ).toEqual(["chainId", "verifyingContract"]);
    await expect(
      packOwnerSignatures({
        digest: payload.digest,
        owners: f.b.state.owners,
        threshold: 2,
        signatures: [first, first],
      }),
    ).rejects.toThrow();
    await expect(
      ownerOperationSignature(payload, f.b, [first]),
    ).rejects.toThrow();
  });

  it("discards signatures when the connection changes while the wallet signs", async () => {
    const f = fixture();
    let current = true;
    await expect(
      signWalletTypedData({
        provider: provider(() => {
          current = false;
        }),
        address: ownerKey.address,
        chainId: 1,
        document:
          f.prepared.signing.scheme === "eip712-safe7579-owner"
            ? f.prepared.signing.typedData
            : fail(),
        stillCurrent: () => current,
      }),
    ).rejects.toThrow(/changed/);
    const wrongChain = {
      request: vi.fn(async ({ method }: { method: string }) =>
        method === "eth_accounts" ? [ownerKey.address] : "0xa",
      ),
    };
    await expect(
      signWalletTypedData({
        provider: wrongChain,
        address: ownerKey.address,
        chainId: 1,
        document:
          f.signingInput &&
          safe7579OwnerSigningPayload(f.signingInput).typedData,
      }),
    ).rejects.toThrow();
    expect(
      wrongChain.request.mock.calls.some(
        ([arg]) => arg.method === "eth_signTypedData_v4",
      ),
    ).toBe(false);
  });

  it("rejects substituted plan calls even when the server recomputes its operation hash", () => {
    const f = fixture();
    const changed = structuredClone(f.prepared);
    changed.operation.callData = encodeSafe7579Execution([
      { target: coowner.address, value: "100", callData: "0x" },
    ]);
    changed.operationHash = getUserOperationHash(
      changed.operation,
      changed.entryPoint,
      changed.chainId,
    );
    expect(() => assertReviewedOperation(changed, f.p)).toThrow();
    for (const change of [
      { stepIndexes: [0, 0] },
      { stepIndexes: [-1] },
      { planCommitment: h("other") },
      { expiresAt: Date.now() - 1 },
      { state: "pending" as const },
    ])
      expect(() =>
        assertReviewedOperation({ ...f.prepared, ...change }, f.p),
      ).toThrow();
    expect(() =>
      ownerOperationSigning({
        ...f.signingInput,
        validUntil: String(Number(f.signingInput.validUntil) + 1),
        record: f.prepared,
        binding: f.b,
      }),
    ).toThrow();
  });

  it("signs raw 32-byte operation hashes with EIP191 and verifies the deployed legacy USE envelope", async () => {
    const f = sessionOperation(),
      sign = vi.fn(bot.signMessage);
    const signature = await signSessionUserOperation({
      record: f.prepared,
      session: f.session,
      signer: { address: bot.address, signMessage: sign },
    });
    expect(sign).toHaveBeenCalledWith({
      message: { raw: f.prepared.operationHash },
    });
    expect(
      await verifyLegacySessionSignature({
        operation: { ...f.prepared.operation, signature },
        chainId: 1,
        entryPoint,
        smartSessions: f.session.compiled.smartSessions.address,
        permissionId: f.session.compiled.permissionId,
        sessionKey: bot.address,
      }),
    ).toBe(bot.address);
    expect(signature.slice(0, 68)).toBe(
      `0x00${f.session.compiled.permissionId.slice(2)}`,
    );
  });

  it.each(["expired", "revoked", "stale", "prepared"] as const)(
    "refuses %s sessions before the local key signs",
    async (state) => {
      const f = sessionOperation(),
        signMessage = vi.fn(bot.signMessage);
      f.session.state = state;
      await expect(
        signSessionUserOperation({
          record: f.prepared,
          session: f.session,
          signer: { address: bot.address, signMessage },
        }),
      ).rejects.toThrow();
      expect(signMessage).not.toHaveBeenCalled();
    },
  );

  it("rejects an altered grant, key, policy, signature digest, future period or expired operation", async () => {
    for (const alter of [
      (f: ReturnType<typeof sessionOperation>) => {
        f.prepared.session!.grantId = "other";
      },
      (f: ReturnType<typeof sessionOperation>) => {
        f.prepared.session!.sessionKey = coowner.address;
      },
      (f: ReturnType<typeof sessionOperation>) => {
        f.prepared.session!.compiledHash = h("other");
      },
      (f: ReturnType<typeof sessionOperation>) => {
        f.prepared.signing.digest = h("other");
      },
      (f: ReturnType<typeof sessionOperation>) => {
        f.session.compiled.validAfter = Math.floor(Date.now() / 1000) + 300;
      },
      (f: ReturnType<typeof sessionOperation>) => {
        f.prepared.expiresAt = Date.now() - 1;
      },
    ]) {
      const f = sessionOperation();
      alter(f);
      const signMessage = vi.fn(bot.signMessage);
      await expect(
        signSessionUserOperation({
          record: f.prepared,
          session: f.session,
          signer: { address: bot.address, signMessage },
        }),
      ).rejects.toThrow();
      expect(signMessage).not.toHaveBeenCalled();
    }
  });

  it("builds V6 metadata and payment templates with exact policy identities and empty dynamic payment fields", () => {
    const metadata = sessionFixture(Date.now(), {
      emptyAllocations: true,
    }).record;
    const input = sessionActionPlanInput(metadata, {
      uri: "ipfs://bafy-public-metadata",
    });
    expect(input.calls[0]).toMatchObject({
      contractId: "@bananapus/core-v6:src/JBController.sol:JBController",
      function: "setUriOf(uint256,string)",
      value: "0",
      args: ["1", "ipfs://bafy-public-metadata"],
    });
    const payment = sessionFixture().record;
    payment.compiled.reviewedPolicy = {
      actions: [
        {
          kind: "v6-pay",
          target: adapter,
          asset: "0x000000000000000000000000000000000000EEEe",
          projectId: "42",
          beneficiary: ownerKey.address,
          perCallLimit: "10",
          minReturnedTokens: "3",
        },
      ],
    };
    const pay = sessionActionPlanInput(payment, { amount: "9" });
    expect(pay.calls[0]).toMatchObject({
      value: "9",
      function: "pay(uint256,address,uint256,address,uint256,string,bytes)",
      args: [
        "42",
        "0x000000000000000000000000000000000000EEEe",
        "9",
        ownerKey.address,
        "3",
        "",
        "0x",
      ],
    });
    expect(() => sessionActionPlanInput(payment, { amount: "11" })).toThrow();
    expect(() =>
      sessionActionPlanInput(metadata, { uri: "javascript:alert(1)" }),
    ).toThrow();
  });
});

describe("smart client HTTP boundary", () => {
  it("authenticates exact API requests with only public material and keeps submission idempotency for manual retry", async () => {
    const f = fixture(),
      requests: { path: string; body: string; key: string | null }[] = [];
    const client = new SmartAccountClient(
      new SignedRestClient({
        audience,
        accountId: f.a.id,
        signer: ownerKey,
        fetch: async (url, init) => {
          const path = String(url).slice(audience.length),
            headers = new Headers(init?.headers),
            bytes = new Uint8Array(init?.body as Uint8Array);
          const body = new TextDecoder().decode(bytes),
            key = headers.get(REST_AUTH_HEADERS.idempotencyKey);
          const claims = readRequestClaims({
            method: String(init?.method),
            requestTarget: path,
            contentType: headers.get("content-type") ?? "",
            body: bytes,
            headers,
          });
          await verifyRequestSignature(
            audience,
            claims.claims,
            claims.signature,
          );
          requests.push({ path, body, key });
          if (
            path.endsWith("/submissions") &&
            requests.filter((x) => x.path.endsWith("/submissions")).length === 1
          )
            return Response.json(
              { error: { code: "UNKNOWN" } },
              { status: 503 },
            );
          return Response.json(
            path.endsWith("creation-plans")
              ? { creation: { address: f.b.wallet.address } }
              : f.prepared,
          );
        },
      }),
    );
    expect(
      await client.prepareCreation({
        manifestId: "reviewed",
        owners: [ownerKey.address],
        threshold: 1,
        saltNonce: "3",
      }),
    ).toHaveProperty("creation.address");
    await client.prepareUserOperation({ planId: f.p.id, stepIndexes: [0] });
    const signature = `0x${"11".repeat(76)}1b` as Hex;
    await expect(
      client.submitUserOperation(f.prepared.id, signature, "publication-once"),
    ).rejects.toThrow();
    expect(requests).toHaveLength(3);
    await client.submitUserOperation(
      f.prepared.id,
      signature,
      "publication-once",
    );
    expect(requests.slice(2).map((x) => x.body)).toEqual([
      JSON.stringify({ signature }),
      JSON.stringify({ signature }),
    ]);
    expect(requests.slice(2).map((x) => x.key)).toEqual([
      "publication-once",
      "publication-once",
    ]);
    expect(requests.map((x) => x.body).join("")).not.toContain(botPrivateKey);
    expect(requests.map((x) => x.body).join("")).not.toContain("privateKey");
    expect(() => client.userOperation("../steal")).toThrow();
  });

  it("bundles the account controls separately from the deferred sign-in SDK", async () => {
    const result = await build({
      entryPoints: [
        new URL("../src/rest/web/main.ts", import.meta.url).pathname,
      ],
      bundle: true,
      external: ["./para.js"], // Match the production build: Para manages its own session storage.
      platform: "browser",
      format: "esm",
      target: "es2022",
      write: false,
      minify: true,
      logLevel: "silent",
    });
    const source = result.outputFiles[0]!.text;
    expect(source).toContain("eth_signTypedData_v4");
    expect(source).toContain("eth_sendTransaction");
    expect(source).not.toContain('from"node:');
    // Public recovery references may use localStorage. rest-wallet-recovery.test.ts rejects private keys, signatures and restored authority.
    expect(source).not.toContain("sessionStorage");
  });
});
function fail(): never {
  throw new Error("Expected owner signing fixture");
}
