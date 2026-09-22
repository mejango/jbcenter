import { describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, zeroAddress, type Address, type Hex } from "viem";
import {
  decodeSafeSetupCall,
  predictSafeAddress,
  SAFE_ABI,
  SAFE_FACTORY,
  SAFE_FACTORY_CODE_HASH,
  SAFE_FALLBACK,
  SAFE_SINGLETON,
} from "../src/safe.js";
import { SAFE_FACTORY_RUNTIME } from "./fixtures/safe-factory.js";

const OWNERS: Address[] = [
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222",
];
// The Safe 1.4.1 proxy creation code, as the factory returns it.
const PROXY_CREATION_CODE =
  "0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252602281526020018061019660229139604001915050604051809103" as Hex;

function initializer(owners: readonly Address[] = OWNERS, threshold = 2n): Hex {
  return encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "setup",
    args: [owners, threshold, zeroAddress, "0x", SAFE_FALLBACK, zeroAddress, 0n, zeroAddress],
  });
}

function creation(data: Hex = initializer(), saltNonce = 7n, singleton: Address = SAFE_SINGLETON) {
  return {
    to: SAFE_FACTORY,
    data: encodeFunctionData({
      abi: SAFE_ABI,
      functionName: "createProxyWithNonce",
      args: [singleton, data, saltNonce],
    }),
  };
}

describe("safe setup calls", () => {
  it("pins the runtime of the factory the sponsor pays", () => {
    expect(keccak256(SAFE_FACTORY_RUNTIME)).toBe(SAFE_FACTORY_CODE_HASH);
  });

  it("decodes a plain Safe creation and keeps its owners, threshold and salt", () => {
    const decoded = decodeSafeSetupCall(creation());
    expect(decoded).toEqual({
      owners: OWNERS,
      threshold: 2,
      saltNonce: 7n,
      initializer: initializer(),
    });
  });

  it("refuses anything but a plain Safe creation on the canonical factory", () => {
    const other = "0x3333333333333333333333333333333333333333" as Address;
    const tooManyOwners = Array.from(
      { length: 21 },
      (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}` as Address,
    );
    expect(decodeSafeSetupCall({ ...creation(), to: other })).toBeNull();
    expect(decodeSafeSetupCall(creation(initializer(), 7n, other))).toBeNull();
    expect(decodeSafeSetupCall({ to: SAFE_FACTORY, data: "0x12345678" })).toBeNull();
    expect(decodeSafeSetupCall(creation(initializer([], 1n)))).toBeNull();
    expect(decodeSafeSetupCall(creation(initializer(OWNERS, 0n)))).toBeNull();
    expect(decodeSafeSetupCall(creation(initializer(OWNERS, 3n)))).toBeNull();
    expect(decodeSafeSetupCall(creation(initializer([OWNERS[0]!, OWNERS[0]!], 1n)))).toBeNull();
    expect(decodeSafeSetupCall(creation(initializer([zeroAddress], 1n)))).toBeNull();
    expect(decodeSafeSetupCall(creation(initializer(tooManyOwners, 1n)))).toBeNull();
    expect(
      decodeSafeSetupCall({
        to: SAFE_FACTORY,
        data: `${creation().data}00` as Hex,
      }),
    ).toBeNull();
  });

  it("refuses a Safe that is not plain", () => {
    const hooked = encodeFunctionData({
      abi: SAFE_ABI,
      functionName: "setup",
      args: [OWNERS, 1n, OWNERS[0]!, "0xdeadbeef", SAFE_FALLBACK, zeroAddress, 0n, zeroAddress],
    });
    const paid = encodeFunctionData({
      abi: SAFE_ABI,
      functionName: "setup",
      args: [OWNERS, 1n, zeroAddress, "0x", SAFE_FALLBACK, zeroAddress, 1n, zeroAddress],
    });
    const handler = encodeFunctionData({
      abi: SAFE_ABI,
      functionName: "setup",
      args: [OWNERS, 1n, zeroAddress, "0x", OWNERS[1]!, zeroAddress, 0n, zeroAddress],
    });
    expect(decodeSafeSetupCall(creation(hooked))).toBeNull();
    expect(decodeSafeSetupCall(creation(paid))).toBeNull();
    expect(decodeSafeSetupCall(creation(handler))).toBeNull();
  });

  it("predicts the same address for the same owners, threshold and salt", () => {
    const decoded = decodeSafeSetupCall(creation())!;
    const address = predictSafeAddress(decoded, PROXY_CREATION_CODE);
    expect(address).toBe(predictSafeAddress(decoded, PROXY_CREATION_CODE));
    expect(address).not.toBe(
      predictSafeAddress(decodeSafeSetupCall(creation(initializer(), 8n))!, PROXY_CREATION_CODE),
    );
    expect(address).not.toBe(
      predictSafeAddress(
        decodeSafeSetupCall(creation(initializer([OWNERS[1]!, OWNERS[0]!])))!,
        PROXY_CREATION_CODE,
      ),
    );
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
