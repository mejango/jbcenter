import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  validateRuntime, checkDatabase, summarizeVitest, requiredVitestSuites, verifyExecutionReport, redactOutput, runStep,
  writeObservation, captureSourceSnapshot,
} = await import(new URL("../scripts/rest/check-required-tests.mjs", import.meta.url).href);

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function report() {
  return {
    success: true,
    numTotalTests: requiredVitestSuites.length,
    numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    testResults: requiredVitestSuites.map((name: string) => ({
      name: `/repo/${name}`, status: "passed", assertionResults: [{ title: "required behavior", status: "passed" }],
    })),
  };
}

describe("release check cannot silently omit required verification", () => {
  it("pins every actual database-bearing file independently of the report fixture", async () => {
    const expected = [
      "postgres.integration.test.ts", "rest-auth-store.test.ts", "rest-sessions-postgres.integration.test.ts",
      "rest-sessions-service.test.ts", "rest-smart-account-checkpoints.test.ts", "rest-smart-account-onboarding-store.integration.test.ts",
      "rest-smart-accounts-postgres.integration.test.ts", "rest-sponsorship-postgres.integration.test.ts",
      "rest-transactions-postgres.integration.test.ts", "rest-user-operations-postgres.integration.test.ts",
      "rest-wallet-ceremonies-postgres.integration.test.ts",
    ].sort();
    const testDirectory = new URL(".", import.meta.url);
    const files = await readdir(testDirectory);
    const inventory = (await Promise.all(files.filter(file => file.endsWith(".test.ts") && file !== "rest-required-checks.test.ts")
      .map(async file => /process\.env\.TEST_DATABASE_URL/.test(await readFile(new URL(file, testDirectory), "utf8")) ? file : null)))
      .filter((file): file is string => file !== null).sort();
    expect(inventory).toEqual(expected);
    for (const file of [...inventory, "rest-wallet-webauthn.test.ts", "rest-passkey-signatures.test.ts", "rest-wallet-passkey-evm.test.ts",
      "rest-passkey-profile-evm.test.ts", "rest-passkey-onboarding.test.ts", "rest-passkey-user-operations.test.ts"]) {
      expect(requiredVitestSuites).toContain(`test/${file}`);
    }
  });

  it("fails before starting tools when Node or the explicit test database is missing", () => {
    expect(() => validateRuntime("21.7.0", "postgresql://user:password@localhost/test")).toThrow("Node.js 22");
    expect(() => validateRuntime("22.23.1", undefined)).toThrow("TEST_DATABASE_URL");
    expect(() => validateRuntime("22.23.1", " ")).toThrow("TEST_DATABASE_URL");
    expect(() => validateRuntime("22.23.1", "postgresql://user:password@localhost/test")).not.toThrow();
    expect(() => validateRuntime("22.0.0", "postgresql://user:password@localhost/test")).toThrow("22.16");
  });

  it("checks PostgreSQL 16 and transactional schema permissions, without leaving a schema", async () => {
    const client = { connect: vi.fn(), end: vi.fn(), query: vi.fn(async (sql: string) =>
      sql.startsWith("SELECT") ? { rows: [{ version: "160006" }] } : { rows: [] }) };
    await expect(checkDatabase(client)).resolves.toEqual({ major: 16, schemaPermissions: true });
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "SELECT current_setting('server_version_num') AS version", "BEGIN",
      expect.stringMatching(/^CREATE SCHEMA "center_check_[a-f0-9]+"$/), "ROLLBACK",
    ]);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("rejects other PostgreSQL versions and never includes connection failures or credentials", async () => {
    const old = { connect: vi.fn(), end: vi.fn(), query: vi.fn(async () => ({ rows: [{ version: "140019" }] })) };
    await expect(checkDatabase(old)).rejects.toThrow("PostgreSQL 16");
    const down = { connect: vi.fn(async () => { throw new Error("postgresql://user:secret@remote/private"); }), end: vi.fn() };
    await expect(checkDatabase(down)).rejects.toThrow(/^Test PostgreSQL preflight failed; use a reachable, writable PostgreSQL 16 test database\.$/);
    expect(down.end).toHaveBeenCalledOnce();
  });

  it("rejects the former green-with-skipped-database outcome", () => {
    const result = report();
    result.testResults[0].assertionResults[0].status = "pending";
    result.numPendingTests = 1;
    expect(() => summarizeVitest(result, "/repo")).toThrow("failed, skipped, todo or missing");
    try { summarizeVitest(result, "/repo"); }
    catch (error) { expect(error).toMatchObject({ suites: [{ name: requiredVitestSuites[0], total: 1, passed: 0, failed: 0, skipped: 1 }, ...report().testResults.slice(1).map((suite: { name: string }) =>
      ({ name: suite.name.slice("/repo/".length), total: 1, passed: 1, failed: 0, skipped: 0 }))] }); }
  });

  it.each(["missing", "empty", "skipped", "failed", "duplicate", "no-report"])("rejects %s required suite evidence", (failure) => {
    const result = report();
    if (failure === "missing") result.testResults.shift();
    if (failure === "empty") result.testResults[0].assertionResults = [];
    if (failure === "skipped") result.testResults[0].assertionResults[0].status = "skipped";
    if (failure === "failed") result.testResults[0].status = "failed";
    if (failure === "duplicate") result.testResults.push(result.testResults[0]);
    expect(() => summarizeVitest(failure === "no-report" ? null : result, "/repo")).toThrow();
  });

  it("keeps only per-suite counts in observation evidence, excluding test values", () => {
    const result = report();
    Object.assign(result.testResults[0].assertionResults[0], { failureMessages: ["private key or assertion"], title: "secret" });
    const suites = summarizeVitest(result, "/repo");
    expect(suites).toHaveLength(requiredVitestSuites.length);
    expect(suites[0]).toEqual({ name: requiredVitestSuites[0], total: 1, passed: 1, failed: 0, skipped: 0 });
    expect(JSON.stringify(suites)).not.toMatch(/private key|assertion|secret/);
  });

  it("also rejects missing, empty and skipped machine execution evidence", () => {
    expect(() => verifyExecutionReport(null)).toThrow();
    expect(() => verifyExecutionReport({ suites: [] })).toThrow();
    for (const counts of [{ total: 0, passed: 0, skipped: 0 }, { total: 1, passed: 0, skipped: 1 }]) {
      expect(() => verifyExecutionReport({ suites: [{ name: "execution", failed: 0, ...counts }] })).toThrow();
    }
    expect(verifyExecutionReport({ suites: [{ name: "execution", total: 1, passed: 1, failed: 0, skipped: 0, payload: "secret" }] }))
      .toEqual([{ name: "execution", total: 1, passed: 1, failed: 0, skipped: 0 }]);
  });

  it("redacts URLs and known secret environment values, including URL-decoded passwords", () => {
    const redact = redactOutput({ TEST_DATABASE_URL: "postgresql://tester:p%40ssword@localhost/test", API_TOKEN: "private-token" });
    expect(redact("postgresql://tester:p%40ssword@localhost/test p@ssword private-token")).toBe("[redacted] [redacted] [redacted]");
    const structured = redactOutput({ PINATA_JWT: "dummy-jwt-sensitive", REST_ERC4337_SPONSOR_ROUTES: JSON.stringify({ routes: [{ authorizationKey: "dummy-route-key" }] }) });
    expect(structured("dummy-jwt-sensitive dummy-route-key")).toBe("[redacted] [redacted]");
  });

  it("keeps the last complete observation when a replacement cannot be written", async () => {
    const directory = await mkdtemp(join(tmpdir(), "center-observation-"));
    directories.push(directory);
    const path = join(directory, "summary.json");
    await writeFile(path, JSON.stringify({ status: "running" }));
    await chmod(directory, 0o500);
    try {
      await expect(writeObservation(path, { status: "passed" })).rejects.toThrow();
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ status: "running" });
    } finally { await chmod(directory, 0o700); }
    await writeObservation(path, { status: "failed" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ status: "failed" });
    expect(await readdir(directory)).toEqual(["summary.json"]);
  });

  it("detects source changes even when both observations have the same dirty revision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "center-source-observation-"));
    directories.push(directory);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, stdio: "ignore" });
    git("init", "-q");
    await writeFile(join(directory, "source.txt"), "initial");
    git("add", "source.txt");
    git("-c", "user.name=Local check", "-c", "user.email=local-check@example.invalid", "commit", "-qm", "fixture");
    await writeFile(join(directory, "source.txt"), "first change");
    const before = await captureSourceSnapshot(directory);
    await writeFile(join(directory, "source.txt"), "second change");
    const after = await captureSourceSnapshot(directory);
    expect(before.revision).toBe(after.revision);
    expect(before.dirty).toBe(true);
    expect(after.dirty).toBe(true);
    expect(before.fingerprint).not.toBe(after.fingerprint);
    expect(JSON.stringify(after)).not.toContain("second change");
  });

  it("terminates a timed-out process and its hung descendants", async () => {
    const directory = await mkdtemp(join(tmpdir(), "center-check-deadline-"));
    directories.push(directory);
    const observation = { steps: [] };
    const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');
      const child=spawn(process.execPath,['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);setTimeout(()=>process.exit(0),2500)'],{stdio:'inherit'});
      fs.writeFileSync('descendant.pid',String(child.pid));setTimeout(()=>process.exit(0),2500);`;
    const started = Date.now();
    await expect(runStep("hung", process.execPath, ["-e", script], { directory, observation, cwd: directory,
      env: process.env, save: async () => {}, timeoutMs: 500 })).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(observation.steps).toMatchObject([{ name: "hung", status: "failed", timedOut: true }]);
    const pid = (await readFile(join(directory, "descendant.pid"), "utf8")).trim();
    let state = "";
    try { state = execFileSync("ps", ["-o", "stat=", "-p", pid], { encoding: "utf8" }).trim(); } catch { /* Already reaped. */ }
    expect(state === "" || state.startsWith("Z")).toBe(true);
  });

  it("handles a log write error immediately and stops the child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "center-check-log-failure-"));
    directories.push(directory);
    await mkdir(join(directory, "unwritable.log"));
    const observation = { steps: [] };
    const started = Date.now();
    await expect(runStep("unwritable", process.execPath, ["-e", "setTimeout(()=>process.exit(0),2500)"],
      { directory, observation, cwd: directory, env: process.env, save: async () => {} })).rejects.toThrow("log");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(observation.steps).toMatchObject([{ name: "unwritable", status: "failed" }]);
  });

  it("records a failed child and a subsequent passing child with sanitized logs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "center-required-check-"));
    directories.push(directory);
    const observation = { steps: [] };
    const options = { directory, observation, cwd: directory, env: { ...process.env, API_TOKEN: "private-token" }, save: async () => {} };
    await expect(runStep("red", process.execPath,
      ["-e", "process.stdout.write('private-'); process.stdout.write('token\\n'); process.exitCode = 1"], options)).rejects.toThrow("red failed");
    await runStep("green", process.execPath, ["-e", "console.log('passed')"], options);
    expect(observation.steps).toMatchObject([{ name: "red", status: "failed", exitCode: 1 }, { name: "green", status: "passed", exitCode: 0 }]);
    expect(await readFile(join(directory, "red.log"), "utf8")).toBe("[redacted]\n");
    expect(await readFile(join(directory, "green.log"), "utf8")).toBe("passed\n");
  });
});
