import { getRequestListener, type HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { createServer, request as nodeRequest, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  accountIdFor, buildRequestTypedData, createRestAuth, MemoryAccountStore,
  newRequestNonce, readSignedRequest, REST_AUTH_HEADERS as H,
  RestAuthError, type RequestClaims,
} from "../src/rest/auth/index.js";

const owner = privateKeyToAccount(`0x${"04".padStart(64, "0")}`);
const accountId = accountIdFor(owner.address, 1);
const audience = "https://juicebox.center";
const now = 1_900_000_000;
const servers = new Set<Server>();

afterEach(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  servers.clear();
});

async function headers(target: string, method = "GET", body = new Uint8Array()) {
  const claims: RequestClaims = {
    accountId, signer: owner.address, grantId: "", method, requestTarget: target,
    contentType: "application/json", bodyHash: keccak256(body),
    issuedAt: now, expiresAt: now + 60, nonce: newRequestNonce(), idempotencyKey: "",
  };
  return new Headers({
    [H.account]: accountId, [H.signer]: owner.address, [H.issuedAt]: String(now),
    [H.expiresAt]: String(now + 60), [H.nonce]: claims.nonce,
    [H.signature]: await owner.signTypedData(buildRequestTypedData(audience, claims)),
    "content-type": "application/json",
  });
}

async function start() {
  const store = new MemoryAccountStore();
  const auth = createRestAuth({ store, audience, now: () => now });
  const body = new TextEncoder().encode("{}");
  await auth.enroll({
    method: "POST", requestTarget: "/api/v1/accounts/enroll", contentType: "application/json", body,
    headers: await headers("/api/v1/accounts/enroll", "POST", body),
  });
  const app = new Hono<{ Bindings: HttpBindings }>();
  app.onError((error, context) => context.json({ code: error instanceof RestAuthError ? error.code : "INTERNAL_ERROR" }, error instanceof RestAuthError ? error.status as 400 : 500));
  app.get("/api/v1/protected", async (context) => {
    const input = await readSignedRequest(context.req.raw, context.env.incoming.url!);
    const principal = await auth.authenticate(input);
    return context.json({ accountId: principal.account.id, requestTarget: input.requestTarget });
  });
  const server = createServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }));
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local test server address");
  return address.port;
}

function send(port: number, path: string, signedHeaders: Headers): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = nodeRequest({ host: "127.0.0.1", port, path, headers: Object.fromEntries(signedHeaders), method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      response.once("error", reject);
    });
    request.once("error", reject);
    request.end();
  });
}

describe("raw Node signed request binding", () => {
  it("retains query bytes, duplicates, and dot segments through the Hono binding", async () => {
    const port = await start();
    const path = "/api/v1/ignored/../protected?value=%2f&value=+&space=%20";
    const response = await send(port, path, await headers(path));
    expect(response).toEqual({ status: 200, body: { accountId, requestTarget: path } });
  });

  it("rejects a signature for a normalized URL sent with different raw bytes", async () => {
    const port = await start();
    const signature = await headers("/api/v1/protected?value=%2f&value=+");
    const changedPath = await send(port, "/api/v1/ignored/../protected?value=%2f&value=+", signature);
    expect(changedPath).toMatchObject({ status: 401, body: { code: "INVALID_SIGNATURE" } });
    const changedQuery = await send(port, "/api/v1/protected?value=%2F&value=%20", signature);
    expect(changedQuery).toMatchObject({ status: 401, body: { code: "INVALID_SIGNATURE" } });
  });
});
