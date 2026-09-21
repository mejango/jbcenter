import { describe, expect, test } from "vitest";
import { BaseError, HttpRequestError, RpcRequestError } from "viem";
import { DeploymentVerificationError } from "../../src/deploymentVerifier.js";
import { RestError } from "../../src/rest/core.js";
import { RelayrResponseError } from "../../src/rest/sponsorship/provider.js";
import { ConflictError } from "../../src/store.js";
import { LaneError, laneErrorMessage } from "../../src/sponsor/chain.js";

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
