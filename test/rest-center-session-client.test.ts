import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, parseAbi, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CenterClient, connectionForBot, type PreparedUserOperation } from "../src/rest/client/index.js";
import { encodeSafe7579Execution, legacySessionSigningPayload, verifyLegacySessionSignature } from "../src/rest/smartAccounts/accountExecution.js";
import { getUserOperationHash } from "../src/rest/userOperations/codec.js";
import { sessionBinding, sessionFixture, sessionObservation } from "./fixtures/sessions.js";
import { plan, record, target } from "./fixtures/user-operations.js";

const audience = "https://juicebox.center";
const privateKey = `0x${"37".repeat(32)}` as Hex;
const signer = privateKeyToAccount(privateKey);
function fixture(chainId = 1) {
  const now = Date.now(), f = sessionFixture(now, { chainId, sessionKey: signer.address });
  f.record.state = "active";
  f.record.observation = sessionObservation(f.record, now);
  const p = plan("session-client-plan", f.bot, f.walletBinding, now);
  p.smartAccount!.chainId = chainId;
  p.draft.calls = [{ chainId, to: target, value: "0", label: "Approved token transfer", dependsOn: [], decoded: {},
    data: encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), functionName: "transfer", args: [f.account.ownerAddress, 5n] }) }];
  const r = record(p);
  r.id = "prepared-session-operation";
  r.chainId = chainId;
  r.operation.nonce = toHex(BigInt(f.record.compiled.smartSessions.address) << 96n);
  r.operation.callData = encodeSafe7579Execution(p.draft.calls.map(c => ({ target: c.to, value: c.value, callData: c.data })));
  r.operationHash = getUserOperationHash(r.operation, r.entryPoint, chainId);
  r.session = sessionBinding(f.record);
  const signing = legacySessionSigningPayload({ operation: r.operation, chainId, entryPoint: r.entryPoint,
    smartSessions: f.record.compiled.smartSessions.address, permissionId: f.record.compiled.permissionId });
  const { actor: _actor, sender: _sender, preparationKey: _key, inputHash: _input, ...wire } = r;
  const operation: PreparedUserOperation = { ...wire, signing };
  const transport = vi.fn<typeof fetch>(async () => Response.json({ state: "pending" }));
  const center = CenterClient.fromConnection(connectionForBot(audience, f.grant, privateKey), { fetch: transport });
  return { ...f, center, transport, input: { plan: p, operation, session: f.record } };
}

describe("downloaded bot connection with activated spending permissions", () => {
  it.each([1, 10, 8453, 42161])("signs on execution network %s with one stable API account and no owner prompt", async chainId => {
    const f = fixture(chainId);
    const signature = await f.center.signSessionOperation(f.input);
    expect(await verifyLegacySessionSignature({ operation: { ...f.input.operation.operation, signature },
      chainId, entryPoint: f.input.operation.entryPoint, smartSessions: f.record.compiled.smartSessions.address,
      permissionId: f.record.compiled.permissionId, sessionKey: signer.address })).toBeDefined();
    expect(f.transport).not.toHaveBeenCalled();
    await f.center.smartAccounts().submitUserOperation(f.input.operation.id, signature, "send-this-operation-once");
    expect(f.transport).toHaveBeenCalledTimes(1);
    const [url, init] = f.transport.mock.calls[0]!;
    expect(String(url)).toContain(`/user-operations/${encodeURIComponent(f.input.operation.id)}/submissions`);
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("send-this-operation-once");
    const body = new TextDecoder().decode(init!.body as Uint8Array);
    expect(JSON.parse(body)).toEqual({ signature });
    expect(body).not.toContain(privateKey);
  });
  it("rejects another account or grant, expired authority, and changed calls before signing", async () => {
    const f = fixture(), signMessage = vi.fn(signer.signMessage);
    const center = new CenterClient({ audience, accountId: f.account.id, grantId: f.grant.id,
      signer: { ...signer, signMessage }, fetch: f.transport });
    for (const mutate of [
      (input: typeof f.input) => { input.session.compiled.grantId = "different-grant"; },
      (input: typeof f.input) => { input.session.compiled.ownerAccountId = "different-account"; },
      (input: typeof f.input) => { input.session.compiled.validUntil = 1; },
      (input: typeof f.input) => { input.operation.operation.callData = "0x1234"; },
      (input: typeof f.input) => { input.plan.draft.calls[0]!.value = "1"; },
      (input: typeof f.input) => { input.session.state = "prepared"; },
    ]) {
      const input = structuredClone(f.input); mutate(input);
      await expect(center.signSessionOperation(input)).rejects.toThrow();
    }
    expect(signMessage).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("requires a bot connection and a message-capable signer", async () => {
    const f = fixture();
    const owner = new CenterClient({ audience, accountId: f.account.id, signer });
    await expect(owner.signSessionOperation(f.input)).rejects.toMatchObject({ code: "SESSION_CONNECTION_MISMATCH" });
    const bot = new CenterClient({ audience, accountId: f.account.id, grantId: f.grant.id,
      signer: { address: signer.address, signTypedData: signer.signTypedData } });
    await expect(bot.signSessionOperation(f.input)).rejects.toMatchObject({ code: "SESSION_SIGNER_REQUIRED" });
  });
});
