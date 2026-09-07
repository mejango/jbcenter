import { afterEach, expect, it, vi } from "vitest";
import { toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  SignedRestClient,
  type PreparedUserOperation,
} from "../src/rest/client/index.js";
import { accountsPage } from "../src/rest/web/page.js";
import { installSmartWalletUI } from "../src/rest/web/smartSessions.js";
import {
  encodeSafe7579Execution,
  legacySessionSigningPayload,
  safe7579OwnerSigningPayload,
  verifyLegacySessionSignature,
  verifySafe7579OwnerSignature,
} from "../src/rest/smartAccounts/accountExecution.js";
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

/** Small event/field harness. Runs the actual browser controller and real signatures without a browser dependency. */
class Field extends EventTarget {
  value = "";
  textContent = "";
  hidden = false;
  disabled = false;
  checked = false;
  files: { size: number; text(): Promise<string> }[] = [];
  children: Field[] = [];
  constructor(readonly id = "") {
    super();
  }
  append(child: Field) {
    this.children.push(child);
    if (!this.value) this.value = child.value;
  }
  replaceChildren() {
    this.children = [];
    this.value = "";
  }
  scrollIntoView() {}
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function harness(options: {
  sessions?: { activationReady: boolean; configuredChainIds: number[] } | null;
} = {}) {
  let sessionCapabilities = options.sessions === undefined
    ? { activationReady: true, configuredChainIds: [1] }
    : options.sessions;
  const nodes = new Map(
    [...accountsPage().matchAll(/\bid="([^"]+)"/g)].map((x) => [
      x[1]!,
      new Field(x[1]),
    ]),
  );
  const field = (id: string) => {
    const result = nodes.get(id);
    if (!result) throw new Error(`Missing actual page field ${id}`);
    return result;
  };
  vi.stubGlobal("document", {
    getElementById: (id: string) => field(id),
    createElement: () => new Field(),
  });
  field("operation-authority").value = "owner";
  field("operation-steps").value = "0";
  field("operation-name").value = "contract_calls";
  field("operation-input").value = "{}";
  const now = Date.now(),
    a = account(now),
    b = binding(a, now),
    p = plan("web-plan", owner(a), b, now);
  const botPrivateKey = `0x${"49".repeat(32)}` as Hex,
    bot = privateKeyToAccount(botPrivateKey);
  let s = sessionFixture(now, { sessionKey: bot.address }).record;
  s.state = "active";
  s.observation = sessionObservation(s, now);
  const manifest = {
    ...CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS[0]!,
    id: b.manifestId,
    chainId: 1,
    revision: b.state.manifestRevision,
    entryPoint: {
      ...CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS[0]!.safe7579,
      address: entryPoint,
      version: "0.7" as const,
    },
  };
  let prepared: PreparedUserOperation | undefined,
    holdPreparation: Promise<void> | undefined;
  const requests: { path: string; body: string; grant: string | null }[] = [],
    signatures: Hex[] = [],
    errors: unknown[] = [];
  const transport: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname,
      headers = new Headers(init?.headers),
      bytes = new Uint8Array(init?.body as Uint8Array),
      body = new TextDecoder().decode(bytes);
    requests.push({ path, body, grant: headers.get(REST_AUTH_HEADERS.grant) });
    if (path === "/api/v1/capabilities")
      return Response.json({
        smartAccounts: {
          deployments: [
            { manifestId: "other-chain", chainId: 10 },
            { manifestId: b.manifestId, chainId: 1, manifest },
          ],
          requirements: [],
        },
        ...(sessionCapabilities ? { sessions: sessionCapabilities } : {}),
        userOperations: {
          preparation: true,
          relay: true,
          providers: [
            { chainId: 1, providerId: "synthetic", paymasterConfigured: true },
          ],
        },
      });
    const auth = readRequestClaims({
      method: String(init?.method),
      requestTarget: path,
      headers,
      contentType: headers.get("content-type") ?? "",
      body: bytes,
    });
    await verifyRequestSignature(
      "https://juicebox.center",
      auth.claims,
      auth.signature,
    );
    if (path === `/api/v1/smart-accounts/bindings/${b.id}`)
      return Response.json(b);
    if (path === `/api/v1/smart-accounts/bindings/${b.id}/plans`)
      return Response.json(p);
    if (path.endsWith("/quota"))
      return Response.json({ state: s.state, counters: [] });
    if (path.startsWith("/api/v1/smart-accounts/sessions/"))
      return Response.json(s);
    if (path === "/api/v1/user-operations") {
      const request = JSON.parse(body),
        r = record(p);
      r.id = "web-operation";
      r.operation.callData = encodeSafe7579Execution(
        p.draft.calls.map((c) => ({
          target: c.to,
          value: c.value,
          callData: c.data,
        })),
      );
      if (request.sessionId) {
        r.session = sessionBinding(s);
        r.operation.nonce = toHex(
          BigInt(s.compiled.smartSessions.address) << 96n,
        );
      }
      r.operationHash = getUserOperationHash(r.operation, entryPoint, 1);
      const signing = request.sessionId
        ? legacySessionSigningPayload({
            operation: r.operation,
            chainId: 1,
            entryPoint,
            smartSessions: s.compiled.smartSessions.address,
            permissionId: s.compiled.permissionId,
          })
        : safe7579OwnerSigningPayload({
            operation: r.operation,
            chainId: 1,
            entryPoint,
            safe7579: manifest.safe7579.address,
            validAfter: String(Math.floor(r.createdAt / 1000)),
            validUntil: String(Math.floor(r.expiresAt / 1000)),
          });
      const {
        actor: _a,
        sender: _s,
        preparationKey: _k,
        inputHash: _h,
        ...wire
      } = r;
      prepared = { ...wire, signing };
      if (holdPreparation) await holdPreparation;
      return Response.json(prepared);
    }
    if (path.endsWith("/submissions")) {
      const signature = JSON.parse(body).signature as Hex;
      signatures.push(signature);
      if (prepared!.session)
        await verifyLegacySessionSignature({
          operation: { ...prepared!.operation, signature },
          chainId: 1,
          entryPoint,
          smartSessions: s.compiled.smartSessions.address,
          permissionId: s.compiled.permissionId,
          sessionKey: bot.address,
        });
      else
        await verifySafe7579OwnerSignature({
          operation: { ...prepared!.operation, signature },
          chainId: 1,
          entryPoint,
          safe7579: manifest.safe7579.address,
          validAfter: String(Math.floor(prepared!.createdAt / 1000)),
          validUntil: String(Math.floor(prepared!.expiresAt / 1000)),
          owners: b.state.owners,
          threshold: b.state.threshold,
        });
      return Response.json({ ...prepared, state: "pending" });
    }
    if (path === "/api/v1/user-operations/web-operation")
      return Response.json({ ...prepared, state: "confirmed" });
    throw new Error(`Unexpected path ${path}`);
  };
  vi.stubGlobal("fetch", transport);
  const walletRequests: string[] = [];
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      walletRequests.push(method);
      if (method === "eth_accounts") return [ownerKey.address];
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_signTypedData_v4")
        return ownerKey.signTypedData(JSON.parse(String(params?.[1])));
      throw new Error(`Unexpected wallet request ${method}`);
    },
  };
  const connection = {
    provider,
    owner: ownerKey.address,
    chainId: 1,
    accountId: a.id,
    client: new SignedRestClient({
      audience: "https://juicebox.center",
      accountId: a.id,
      signer: ownerKey,
      fetch: transport,
    }),
  };
  let running: Promise<void> = Promise.resolve();
  const ui = installSmartWalletUI({
    audience: "https://juicebox.center",
    connection: () => connection,
    run: (action) => {
      running = action().catch((e) => {
        errors.push(e);
      });
      return running;
    },
    status: () => {},
  });
  const click = async (id: string) => {
    field(id).dispatchEvent(new Event("click"));
    await running;
  };
  const change = async (id: string) => {
    field(id).dispatchEvent(new Event("change"));
    await running;
  };
  await ui.accountReady(true);
  expect(field("smart-manifest").value).toBe(b.manifestId);
  expect(walletRequests).toEqual([]);
  field("smart-binding-id").value = b.id;
  await click("smart-bind-load");
  if (sessionCapabilities?.activationReady && sessionCapabilities.configuredChainIds.includes(1)) {
    field("session-id").value = s.id;
    await click("session-refresh");
  }
  expect(errors).toEqual([]);
  return {
    ui,
    field,
    click,
    change,
    errors,
    requests,
    signatures,
    walletRequests,
    botPrivateKey,
    bot,
    nodes,
    session: () => s,
    setSession: (next: typeof s) => {
      s = next;
    },
    hold: (promise: Promise<void>) => {
      holdPreparation = promise;
    },
    idle: () => running,
    setCapabilities: (next: typeof sessionCapabilities) => { sessionCapabilities = next; },
  };
}

it("drives owner plan, local SafeOp approval, submission and canonical status through the browser controller", async () => {
  const f = await harness({ sessions: { activationReady: false, configuredChainIds: [] } });
  expect(f.field("session-section").hidden).toBe(true);
  expect(f.field("session-nav").hidden).toBe(true);
  expect(f.field("session-fields").disabled).toBe(true);
  expect(f.field("operation-authority-label").hidden).toBe(true);
  expect(f.field("operation-authority").disabled).toBe(true);
  expect(f.field("operation-owner-signatures-label").hidden).toBe(true);
  expect(f.field("operation-fields").disabled).toBe(false);
  await f.click("operation-plan");
  await f.click("operation-prepare");
  await f.click("operation-sign");
  await f.click("operation-submit");
  expect(f.errors).toEqual([]);
  expect(f.signatures).toHaveLength(1);
  expect(f.field("operation-submit").disabled).toBe(true);
  expect(f.field("operation-result").textContent).toContain("pending");
  await f.click("operation-status");
  expect(f.field("operation-result").textContent).toContain("confirmed");
  expect(
    f.requests.filter((x) => x.path.endsWith("/submissions")),
  ).toHaveLength(1);
  expect(f.requests.some((x) => x.path.includes("/sessions/"))).toBe(false);
  expect(f.walletRequests.filter((method) => method === "eth_signTypedData_v4")).toHaveLength(1);
});

it.each([null, { activationReady: true, configuredChainIds: [10] }])(
  "does not offer delegated wallet authority without readiness on the connected chain: %j",
  async (sessions) => {
    const f = await harness({ sessions });
    expect(f.field("session-section").hidden).toBe(true);
    f.field("operation-authority").value = "session";
    await f.change("operation-authority");
    expect(f.field("operation-authority").value).toBe("owner");
    expect(f.field("session-key-fields").hidden).toBe(true);
    const before = f.requests.length;
    await f.click("session-prepare");
    expect(f.errors).toHaveLength(1);
    expect(f.requests).toHaveLength(before);
  },
);

it("clears delegated signatures when hosted activation is withdrawn", async () => {
  const f = await harness();
  f.field("operation-authority").value = "session";
  await f.change("operation-authority");
  f.field("session-key-file").files = [{
    size: 256,
    text: async () => JSON.stringify({
      format: "juicebox-center-bot-key-v1",
      botAddress: f.bot.address,
      privateKey: f.botPrivateKey,
    }),
  }];
  await f.change("session-key-file");
  await f.click("operation-plan");
  await f.click("operation-prepare");
  await f.click("operation-sign");
  expect(f.field("operation-submit").disabled).toBe(false);
  f.setCapabilities({ activationReady: false, configuredChainIds: [] });
  await f.click("smart-discover");
  expect(f.field("operation-submit").disabled).toBe(true);
  expect(f.field("operation-authority").value).toBe("owner");
  expect(f.field("operation-session-template").hidden).toBe(true);
  await f.click("operation-submit");
  expect(f.signatures).toHaveLength(0);
});

it("keeps the imported key local, authenticates with its bot grant, and clears stale signatures when switching sessions", async () => {
  const f = await harness();
  f.field("operation-authority").value = "session";
  await f.change("operation-authority");
  f.field("session-key-file").files = [
    {
      size: 256,
      text: async () =>
        JSON.stringify({
          format: "juicebox-center-bot-key-v1",
          botAddress: f.bot.address,
          privateKey: f.botPrivateKey,
        }),
    },
  ];
  await f.change("session-key-file");
  await f.click("operation-plan");
  await f.click("operation-prepare");
  await f.click("operation-sign");
  expect(f.errors).toEqual([]);
  expect(f.field("operation-submit").disabled).toBe(false);
  const operationRequest = f.requests.find(
    (x) => x.path === "/api/v1/user-operations",
  )!;
  expect(operationRequest.grant).toBe(f.session().compiled.grantId);
  expect(f.requests.map((x) => x.body).join("")).not.toContain(f.botPrivateKey);
  expect(
    [...f.nodes.values()].map((x) => x.textContent + x.value).join(""),
  ).not.toContain(f.botPrivateKey);
  const replacement = sessionFixture(Date.now(), {
    sessionKey: f.bot.address,
    generation: "2",
  }).record;
  replacement.state = "active";
  f.setSession(replacement);
  f.field("session-id").value = replacement.id;
  await f.click("session-refresh");
  expect(f.errors).toEqual([]);
  expect(f.field("operation-submit").disabled).toBe(true);
  await f.click("operation-submit");
  expect(f.signatures).toHaveLength(0);
});

it("submits the session's real EIP191 USE signature and allows expired sessions to be explicitly retired", async () => {
  const f = await harness();
  f.field("operation-authority").value = "session";
  await f.change("operation-authority");
  f.field("session-key-file").files = [
    {
      size: 256,
      text: async () =>
        JSON.stringify({
          format: "juicebox-center-bot-key-v1",
          botAddress: f.bot.address,
          privateKey: f.botPrivateKey,
        }),
    },
  ];
  await f.change("session-key-file");
  await f.click("operation-plan");
  await f.click("operation-prepare");
  await f.click("operation-sign");
  await f.click("operation-submit");
  expect(f.errors).toEqual([]);
  expect(f.signatures).toHaveLength(1);
  expect(f.signatures[0]!.slice(0, 68)).toBe(
    `0x00${f.session().compiled.permissionId.slice(2)}`,
  );
  f.setSession({ ...f.session(), state: "expired" });
  await f.click("session-refresh");
  expect(f.field("session-revoke").disabled).toBe(false);
  expect(f.field("operation-submit").disabled).toBe(true);
});

it("discards a prepared operation if authority changes while its request is pending", async () => {
  const f = await harness();
  await f.click("operation-plan");
  let release!: () => void;
  f.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  f.field("operation-prepare").dispatchEvent(new Event("click"));
  // Wait for the signed preparation to reach the controlled HTTP boundary.
  for (
    let i = 0;
    i < 50 && !f.requests.some((x) => x.path === "/api/v1/user-operations");
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(f.requests.some((x) => x.path === "/api/v1/user-operations")).toBe(
    true,
  );
  f.field("operation-authority").value = "session";
  f.field("operation-authority").dispatchEvent(new Event("change"));
  release();
  await f.idle();
  expect(f.errors).toHaveLength(1);
  expect(f.field("operation-sign").disabled).toBe(true);
  expect(f.signatures).toHaveLength(0);
});
