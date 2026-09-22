import { describe, expect, test } from "vitest";
import { BaseError, ExecutionRevertedError, HttpRequestError, RpcRequestError } from "viem";
import { DeploymentVerificationError } from "../../src/deploymentVerifier.js";
import { RestError } from "../../src/rest/core.js";
import { RelayrResponseError } from "../../src/rest/sponsorship/provider.js";
import { ConflictError } from "../../src/store.js";
import {
  LaneError,
  laneErrorDetail,
  laneErrorMessage,
  laneEventMessage,
  laneOutcome,
} from "../../src/sponsor/chain.js";

const url = "https://mainnet.rpc.example/SUPER_SECRET";

describe("lane error messages", () => {
  test("an RPC transport failure keeps neither the key nor the URL", () => {
    const error = new HttpRequestError({
      body: { method: "eth_sendRawTransaction", params: [`0x${"ab".repeat(120)}`] },
      details: `raw body ${"cd".repeat(64)}`,
      status: 500,
      url,
    });
    const message = laneErrorMessage(error);
    expect(message).toBe("rpc request failed");
    expect(message).not.toContain("SUPER_SECRET");
    expect(message).not.toContain("http");
  });

  test("an RPC failure wrapped by a higher-level viem error is coded the same way", () => {
    const wrapped = new BaseError("Execution failed", {
      cause: new RpcRequestError({
        body: { method: "eth_call" },
        error: { code: -32000, message: `node said ${url}` },
        url,
      }),
    });
    expect(laneErrorMessage(wrapped)).toBe("rpc request failed");
  });

  test("other viem errors keep their short message, stripped of URLs and long hex", () => {
    const error = new BaseError(`Sending to ${url} with 0x${"ef".repeat(40)} failed`);
    const message = laneErrorMessage(error);
    expect(message.startsWith("BaseError: Sending to with")).toBe(true);
    expect(message).not.toContain("SUPER_SECRET");
    expect(message).not.toContain("0xef");
  });

  test("authored failures keep their text and everything else is coded", () => {
    expect(laneErrorMessage(new DeploymentVerificationError("the Create event is missing"))).toBe(
      "the Create event is missing",
    );
    expect(laneErrorMessage(new LaneError("the status does not match the stored bundle"))).toBe(
      "the status does not match the stored bundle",
    );
    expect(laneErrorMessage(new ConflictError("A different deployment"))).toBe(
      "another sender already deployed this chain",
    );
    expect(
      laneErrorMessage(
        new RelayrResponseError(new RestError(502, "RELAYR_UNAVAILABLE", `no answer from ${url}`), {
          status: 502,
          body: url,
          complete: true,
          truncated: false,
        }),
      ),
    ).toBe("relayr request failed");
    expect(laneErrorMessage(new RestError(502, "RELAYR_FUNDING_LIMIT", `over budget at ${url}`))).toBe(
      "RELAYR_FUNDING_LIMIT",
    );
    expect(laneErrorMessage(new Error(`connect ECONNREFUSED ${url}`))).toBe("Error: lane error");
    expect(laneErrorMessage("boom")).toBe("lane error");
  });

  test("a long message is capped at 300 characters", () => {
    expect(laneErrorMessage(new DeploymentVerificationError("x".repeat(900)))).toHaveLength(300);
  });
});

describe("lane outcomes", () => {
  const rpcFailure = new BaseError("Execution failed", {
    cause: new RpcRequestError({ body: { method: "eth_call" }, error: { code: -32603, message: "node down" }, url }),
  });

  test("a transient failure before any payment waits for the next claim", () => {
    for (const error of [
      new RestError(502, "SPONSORSHIP_RPC_UNAVAILABLE", "The configured RPC could not simulate."),
      new RestError(504, "RELAYR_TIMEOUT", "The execution service did not answer."),
      new RelayrResponseError(new RestError(502, "RELAYR_UNAVAILABLE", "no answer"), {
        status: 502,
        body: "",
        complete: false,
        truncated: false,
      }),
      rpcFailure,
      new LaneError("sponsor holds less than the creation fee on chain 10", "SPONSOR_UNFUNDED"),
    ])
      expect(laneOutcome(error, { paid: false })).toBe("retry");
  });

  test("a definitive failure retires the row even though nothing was paid", () => {
    for (const error of [
      new DeploymentVerificationError("the Create event is missing"),
      new ConflictError("A different deployment"),
      new LaneError("the status does not match the stored bundle"),
      new RestError(502, "RELAYR_FUNDING_LIMIT", "over budget"),
      new RelayrResponseError(new RestError(499, "RELAYR_CANCELLED", "interrupted"), {
        status: 499,
        body: "",
        complete: false,
        truncated: false,
      }),
      new BaseError("Execution reverted", { cause: new ExecutionRevertedError({}) }),
      new Error("connect ECONNREFUSED"),
      "boom",
    ])
      expect(laneOutcome(error, { paid: false })).toBe("terminal");
  });

  test("a paid bundle waits through a parse, timeout or transport failure", () => {
    for (const error of [
      new RestError(502, "RELAYR_INVALID_STATUS", "Provider status changed the stored transaction binding."),
      new RestError(504, "RELAYR_TIMEOUT", "The execution service did not answer."),
      rpcFailure,
      new Error("connect ECONNREFUSED"),
    ])
      expect(laneOutcome(error, { paid: true })).toBe("retry");
  });

  test("a paid bundle is still retired by a definitive on-chain answer", () => {
    for (const error of [
      new DeploymentVerificationError("the Create event is missing"),
      new ConflictError("A different deployment"),
      new BaseError("Execution reverted", { cause: new ExecutionRevertedError({}) }),
    ])
      expect(laneOutcome(error, { paid: true })).toBe("terminal");
  });

  test("a coded lane error shows its code on the row and its sentence in the log", () => {
    const error = new LaneError("sponsor holds less than the creation fee on chain 10 by 500 wei", "SPONSOR_UNFUNDED");
    expect(laneErrorMessage(error)).toBe("SPONSOR_UNFUNDED");
    expect(laneEventMessage(error)).toBe("sponsor holds less than the creation fee on chain 10 by 500 wei");
    expect(laneEventMessage(new Error(`connect ECONNREFUSED ${url}`))).toBe("Error: lane error");
  });

  test("only a string detail travels from a coded status failure to the operator log", () => {
    expect(laneErrorDetail(new RestError(502, "RELAYR_INVALID_STATUS", "malformed", "the body"))).toBe("the body");
    expect(laneErrorDetail(new RestError(502, "RELAYR_INVALID_STATUS", "malformed", { body: 1 }))).toBeUndefined();
    expect(laneErrorDetail(new Error("boom"))).toBeUndefined();
  });
});
