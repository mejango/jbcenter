// Local-only service fixture; these unauthenticated commands and crash barriers have no production route.
import { createServer } from "node:http";
import { Pool } from "pg";
import { RestError } from "../../src/rest/core.js";
import { PostgresWalletEnrollmentStore } from "../../src/rest/wallet/enrollmentPostgres.js";

const schema = process.env.WALLET_ENROLLMENT_TEST_SCHEMA;
if (!schema || !/^rest_wallet_enrollment_[a-f0-9]+$/.test(schema)) throw new Error("A disposable enrollment schema is required");
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 1 });
const options = JSON.parse(process.env.WALLET_ENROLLMENT_TEST_OPTIONS ?? "{}");
const server = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) { raw += String(chunk); if (raw.length > 131_072) throw new Error("Fixture request too large"); }
    const body = JSON.parse(raw), connection = Object.create(pool) as Pool;
    // Pool.query uses callback-style connect internally; retain the real pool for unlocked reads.
    connection.query = pool.query.bind(pool);
    connection.connect = (async () => {
      const client = await pool.connect(), query = client.query.bind(client);
      return new Proxy(client, { get(target, property) {
        if (property !== "query") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
        return async (...args: any[]) => {
          const result = await (query as any)(...args), sql = typeof args[0] === "string" ? args[0] : "";
          if ((body.barrier === "after-candidate" && sql.includes("UPDATE rest_wallet_enrollments SET state='awaiting_possession'"))
            || (body.barrier === "after-mapping" && sql.includes("INSERT INTO rest_wallet_credentials"))
            || (body.barrier === "after-commit" && sql === "COMMIT")) {
            process.send?.({ kind: "barrier", pid: process.pid });
            await new Promise<void>(() => {});
          }
          return result;
        };
      } });
    }) as Pool["connect"];
    const store = new PostgresWalletEnrollmentStore(connection, options);
    const decode = (value: string) => Buffer.from(value, "base64url");
    const result = body.action === "begin" ? await store.begin(body.intent)
      : body.action === "candidate" ? await store.acceptRegistration(body.id, { ...body.response,
        rawId: decode(body.response.rawId), clientDataJSON: decode(body.response.clientDataJSON), attestationObject: decode(body.response.attestationObject) })
      : body.action === "finalize" ? await store.finalize(body.id, { ...body.proof, assertion: { ...body.proof.assertion,
        authenticatorData: decode(body.proof.assertion.authenticatorData), clientDataJSON: decode(body.proof.assertion.clientDataJSON), signature: decode(body.proof.assertion.signature) } })
      : body.action === "cleanup" ? await store.cleanup(body.limit)
      : body.action === "get" ? await store.get(body.id) : null;
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result));
  } catch (error) {
    const pg = error && typeof error === "object" ? error as { code?: unknown; constraint?: unknown } : {};
    const diagnostic = {
      ...(typeof pg.code === "string" && /^[0-9A-Z]{5}$/.test(pg.code) ? { databaseCode: pg.code } : {}),
      ...(typeof pg.constraint === "string" && /^[a-z0-9_]{1,128}$/.test(pg.constraint) ? { constraint: pg.constraint } : {}),
    };
    if (!(error instanceof RestError)) process.send?.({ kind: "fixture-error", ...diagnostic });
    response.writeHead(error instanceof RestError ? error.status : 500, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: error instanceof RestError ? error.code : "FIXTURE_ERROR", ...diagnostic }));
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") process.send?.({ kind: "ready", port: address.port, pid: process.pid });
});
