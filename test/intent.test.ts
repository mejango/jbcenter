import { describe, expect, it } from "vitest";
import { canonicalJson, contentHash, normalizeEnvelope, signingMessage } from "../src/intent.js";

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

  it("requires one valid deployment call per declared chain", () => {
    expect(() =>
      normalizeEnvelope({
        format: "juicebox.money/v1",
        deploymentVersion: "6",
        chainIds: [1],
        deploymentCalls: [],
        jb: { name: "Missing commitment", chains: [1] },
      }),
    ).toThrow("exactly one");
    expect(() =>
      normalizeEnvelope({
        format: "juicebox.money/v1",
        deploymentVersion: "6",
        chainIds: [1],
        deploymentCalls: [
          { chainId: 1, to: "0x3333333333333333333333333333333333333333", data: "0x12" },
        ],
        jb: { name: "Bad calldata", chains: [1] },
      }),
    ).toThrow("contract calldata");
  });

  it("canonicalizes nested JSON without changing array order", () => {
    expect(canonicalJson({ z: [2, 1], a: { y: true, x: null } })).toBe(
      '{"a":{"x":null,"y":true},"z":[2,1]}',
    );
  });
});
