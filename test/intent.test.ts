import { describe, expect, it } from "vitest";
import { encodeFunctionData, zeroAddress, type Address, type Hex } from "viem";
import {
  callsForChain,
  canonicalJson,
  contentHash,
  normalizeEnvelope,
  signingMessage,
} from "../src/intent.js";
import { SAFE_ABI, SAFE_FACTORY, SAFE_FALLBACK, SAFE_SINGLETON } from "../src/safe.js";

const OWNERS: Address[] = [
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222",
];
const LAUNCH = "0x4444444444444444444444444444444444444444" as Address;

function initializer(owners: readonly Address[] = OWNERS, threshold = 2n): Hex {
  return encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "setup",
    args: [owners, threshold, zeroAddress, "0x", SAFE_FALLBACK, zeroAddress, 0n, zeroAddress],
  });
}

function setupCall(
  chainId: number,
  saltNonce = 1n,
  data = initializer(),
  singleton: Address = SAFE_SINGLETON,
) {
  return {
    chainId,
    to: SAFE_FACTORY,
    data: encodeFunctionData({
      abi: SAFE_ABI,
      functionName: "createProxyWithNonce",
      args: [singleton, data, saltNonce],
    }),
  };
}

const launchCall = (chainId: number) => ({ chainId, to: LAUNCH, data: "0x12345678" as Hex });

const envelope = (deploymentCalls: unknown[], chainIds = [8453]) => ({
  format: "juicebox.money/v1",
  deploymentVersion: "6",
  chainIds,
  deploymentCalls,
  jb: { name: "Public goods garden", chains: chainIds },
});

describe("project intent", () => {
  it("hashes equivalent object key orders identically", () => {
    const first = normalizeEnvelope({
      format: "juicebox.money/v1",
      deploymentVersion: "6",
      chainIds: [8453, 1],
      deploymentCalls: [
        { chainId: 8453, to: "0x3333333333333333333333333333333333333333", data: "0x12345678" },
        { chainId: 1, to: "0x4444444444444444444444444444444444444444", data: "0x87654321" },
      ],
      jb: { name: "Juice", chains: [1, 8453], nested: { b: 2, a: 1 } },
    });
    const second = normalizeEnvelope({
      jb: { nested: { a: 1, b: 2 }, chains: [1, 8453], name: "Juice" },
      chainIds: [1, 8453],
      deploymentCalls: [
        { data: "0x87654321", to: "0x4444444444444444444444444444444444444444", chainId: 1 },
        { data: "0x12345678", chainId: 8453, to: "0x3333333333333333333333333333333333333333" },
      ],
      deploymentVersion: "6",
      format: "juicebox.money/v1",
    });
    expect(contentHash(first)).toBe(contentHash(second));
    expect(signingMessage(contentHash(first))).toContain("Juice Central project intent");
  });

  it("rejects an envelope that disagrees with its .jb chains", () => {
    expect(() =>
      normalizeEnvelope({
        format: "juicebox.money/v1",
        deploymentVersion: "6",
        chainIds: [1],
        deploymentCalls: [
          { chainId: 1, to: "0x3333333333333333333333333333333333333333", data: "0x12345678" },
        ],
        jb: { name: "Wrong chain", chains: [8453] },
      }),
    ).toThrow("must match");
  });

  it("requires contract calldata in every call", () => {
    expect(() =>
      normalizeEnvelope(envelope([{ chainId: 8453, to: LAUNCH, data: "0x12" }])),
    ).toThrow("contract calldata");
  });

  it("accepts one, two and three setup calls before the launch call", () => {
    for (const count of [0, 1, 2, 3]) {
      const setup = Array.from({ length: count }, (_, index) => setupCall(8453, BigInt(index)));
      const normalized = normalizeEnvelope(envelope([...setup, launchCall(8453)]));
      expect(normalized.deploymentCalls).toHaveLength(count + 1);
      const chain = callsForChain(normalized.deploymentCalls, 8453);
      expect(chain.setup).toHaveLength(count);
      expect(chain.launch).toMatchObject({ to: LAUNCH });
      expect(chain.setup.every((call) => call.to === SAFE_FACTORY)).toBe(true);
    }
  });

  it("keeps each chain's call order while sorting chains", () => {
    const normalized = normalizeEnvelope(
      envelope(
        [
          setupCall(8453, 1n),
          setupCall(10, 3n),
          setupCall(8453, 2n),
          launchCall(8453),
          launchCall(10),
        ],
        [10, 8453],
      ),
    );
    expect(normalized.deploymentCalls.map((call) => call.chainId)).toEqual([
      10, 10, 8453, 8453, 8453,
    ]);
    expect(callsForChain(normalized.deploymentCalls, 10).setup.map((call) => call.data)).toEqual([
      setupCall(10, 3n).data.toLowerCase(),
    ]);
    expect(callsForChain(normalized.deploymentCalls, 8453).setup.map((call) => call.data)).toEqual([
      setupCall(8453, 1n).data.toLowerCase(),
      setupCall(8453, 2n).data.toLowerCase(),
    ]);
    expect(callsForChain(normalized.deploymentCalls, 8453).launch).toMatchObject({ to: LAUNCH });
  });

  it("names the call index it refuses", () => {
    const other = "0x3333333333333333333333333333333333333333" as Address;
    expect(() =>
      normalizeEnvelope(
        envelope([{ chainId: 8453, to: other, data: "0x12345678" }, launchCall(8453)]),
      ),
    ).toThrow("deploymentCalls[0].to must be the canonical Safe proxy factory");
    expect(() =>
      normalizeEnvelope(envelope([setupCall(8453, 1n, initializer(), other), launchCall(8453)])),
    ).toThrow("deploymentCalls[0].data must create a plain Safe");
    expect(() =>
      normalizeEnvelope(envelope([setupCall(8453, 1n, initializer(OWNERS, 3n)), launchCall(8453)])),
    ).toThrow("deploymentCalls[0].data must create a plain Safe");
    expect(() =>
      normalizeEnvelope(
        envelope([setupCall(8453, 1n), launchCall(8453), setupCall(8453, 2n), setupCall(8453, 3n)]),
      ),
    ).toThrow("deploymentCalls[1].to must be the canonical Safe proxy factory");
  });

  it("refuses a fifth call on one chain and a chain with no call", () => {
    expect(() =>
      normalizeEnvelope(
        envelope([
          setupCall(8453, 1n),
          setupCall(8453, 2n),
          setupCall(8453, 3n),
          setupCall(8453, 4n),
          launchCall(8453),
        ]),
      ),
    ).toThrow("deploymentCalls must contain 1 to 4 calls for each chainId");
    expect(() => normalizeEnvelope(envelope([], [8453]))).toThrow(
      "deploymentCalls must contain 1 to 4 calls for each chainId",
    );
    expect(() =>
      normalizeEnvelope(envelope([setupCall(8453, 1n), launchCall(8453)], [10, 8453])),
    ).toThrow("deploymentCalls must contain 1 to 4 calls for each chainId");
  });

  it("refuses a setup call repeated on one chain and allows it on another", () => {
    expect(() =>
      normalizeEnvelope(envelope([setupCall(8453, 1n), setupCall(8453, 1n), launchCall(8453)])),
    ).toThrow("deploymentCalls[1] repeats a setup call on its chain");
    const normalized = normalizeEnvelope(
      envelope(
        [setupCall(8453, 1n), setupCall(10, 1n), launchCall(8453), launchCall(10)],
        [10, 8453],
      ),
    );
    expect(callsForChain(normalized.deploymentCalls, 8453).setup).toHaveLength(1);
    expect(callsForChain(normalized.deploymentCalls, 10).setup).toHaveLength(1);
  });

  it("hashes the setup calls with the rest of the envelope", () => {
    const first = normalizeEnvelope(envelope([setupCall(8453, 1n), launchCall(8453)]));
    const second = normalizeEnvelope(envelope([setupCall(8453, 2n), launchCall(8453)]));
    const single = normalizeEnvelope(envelope([launchCall(8453)]));
    expect(contentHash(first)).not.toBe(contentHash(second));
    expect(contentHash(first)).not.toBe(contentHash(single));
  });

  it("canonicalizes nested JSON without changing array order", () => {
    expect(canonicalJson({ z: [2, 1], a: { y: true, x: null } })).toBe(
      '{"a":{"x":null,"y":true},"z":[2,1]}',
    );
  });
});
