// Local integration fixture only. No production route issues or initializes app authority.
import { createServer } from "node:http";
import { Pool } from "pg";
import { createRestAuth } from "../../src/rest/auth/service.js";
import { assertRestActorActive, PostgresAccountStore } from "../../src/rest/auth/postgres.js";
import { RestAuthError } from "../../src/rest/auth/store.js";
import { RestError } from "../../src/rest/core.js";

async function main() {
  const schema = process.env.WALLET_APP_AUTH_SCHEMA;
  if (!schema || !/^wallet_app_auth_[a-f0-9]+$/.test(schema) || !process.env.TEST_DATABASE_URL || !process.connected)
    throw new Error("Disposable fixture configuration is required");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1, connectionTimeoutMillis: 3000,
    query_timeout: 5000, options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=7000` });
  const auth = createRestAuth({ store: new PostgresAccountStore(pool), audience: "https://juicebox.center" });
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    server.closeAllConnections(); server.close();
    const kill = setTimeout(() => process.exit(1), 1000);
    void pool.end().catch(() => {}).finally(() => { clearTimeout(kill); process.exitCode = 0; if (process.connected) process.disconnect(); });
  };
  pool.on("error", stop);
  const server = createServer(async (request, response) => {
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += chunk.length; if (size > 8192) throw new RestError(413, "FIXTURE_TOO_LARGE", "Fixture request is too large");
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks), target = request.url ?? "/", signal = AbortSignal.timeout(5000);
      if (!["/api/v1/accounts/me", "/fixture/claim", "/fixture/owner"].includes(target)) throw new RestError(404, "NOT_FOUND", "Unknown fixture route");
      const principal = await auth.authenticate({ headers, body, method: request.method ?? "GET", requestTarget: target,
        contentType: headers.get("content-type") ?? "", signal }, [target === "/fixture/claim" ? "plan" : "read"], target === "/fixture/owner");
      let result: unknown = { principalId: principal.principalId, grantId: principal.grantId, kind: principal.kind,
        isOwner: principal.isOwner, scopes: principal.scopes, walletApp: principal.walletApp };
      if (target === "/fixture/claim") {
        const input = JSON.parse(body.toString("utf8"));
        if (typeof input.id !== "string" || !/^[a-f0-9-]{36}$/.test(input.id) || Object.keys(input).length !== 1)
          throw new RestError(400, "INVALID_FIXTURE", "Invalid fixture claim");
        const client = await pool.connect(), actor = { accountId: principal.account.id, principalId: principal.principalId };
        try {
          await client.query("BEGIN");
          await assertRestActorActive(client, actor, ["plan"], Math.floor(Date.now() / 1000));
          await client.query("INSERT INTO wallet_app_auth_claims(id,principal_id) VALUES($1,$2)", [input.id, actor.principalId]);
          await assertRestActorActive(client, actor, ["plan"], Math.floor(Date.now() / 1000));
          await client.query("COMMIT"); result = { id: input.id, principalId: actor.principalId };
        } catch (error) { await client.query("ROLLBACK"); throw error; }
        finally { client.release(); }
      }
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result));
    } catch (error) {
      const known = error instanceof RestAuthError || error instanceof RestError;
      response.writeHead(known ? error.status : 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: known ? error.code : "FIXTURE_FAILURE" }));
    }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  const backendPid = (await pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture listener unavailable");
  process.send!({ kind: "ready", port: address.port, backendPid });
  process.once("SIGTERM", stop); process.once("disconnect", stop);
}
main().catch(() => { process.stderr.write("App auth fixture startup failed\n"); process.exit(1); });
