import { getAddress, keccak256, type Address, type Hex } from "viem";
import type { CodeRecord } from "../contracts/types.js";
import { RestError } from "../core.js";

export function rpcHex(value: unknown, label: string, maxBytes = 262144): Hex {
  if (
    typeof value !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) ||
    value.length > maxBytes * 2 + 2
  )
    throw new RestError(
      502,
      "RPC_DATA_INVALID",
      `${label} was not a bounded byte string.`,
    );
  return value.toLowerCase() as Hex;
}

/** Only exact, immutable implementation-address minimal proxies are recognized. */
export function cloneImplementation(
  code: Hex,
): {
  standard: "erc-1167" | "solady-libclone";
  implementation: Address;
} | null {
  const erc =
    /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(
      code,
    );
  if (erc)
    return { standard: "erc-1167", implementation: getAddress(`0x${erc[1]}`) };
  const solady =
    /^0x3d3d3d3d363d3d37363d73([0-9a-f]{40})5af43d3d93803e602a57fd5bf3$/i.exec(
      code,
    );
  return solady
    ? {
        standard: "solady-libclone",
        implementation: getAddress(`0x${solady[1]}`),
      }
    : null;
}

/** No guessed masks, Solidity metadata stripping, PUSH32 heuristics, or arbitrary proxy resolution. */
export function verifyRuntime(code: Hex, template: CodeRecord) {
  if (code === "0x")
    throw new RestError(
      422,
      "DEPLOYMENT_CODE_MISSING",
      "No runtime code exists at the observed canonical block.",
    );
  if (
    keccak256(template.runtimeTemplate) !== template.runtimeTemplateKeccak256 ||
    (template.runtimeTemplate.length - 2) / 2 !==
      template.runtimeTemplateByteLength
  )
    throw new RestError(
      500,
      "CATALOG_CODE_INVALID",
      "The catalog runtime template does not match its recorded hash and length.",
    );
  const runtimeCodeHash = keccak256(code);
  if (runtimeCodeHash === template.runtimeTemplateKeccak256)
    return {
      mode: "exact-runtime-template" as const,
      runtimeCodeHash,
      runtimeByteLength: (code.length - 2) / 2,
      templateCodeId: template.id,
      immutableValues: [],
    };
  if (code.length !== template.runtimeTemplate.length)
    throw new RestError(
      422,
      "RUNTIME_CODE_MISMATCH",
      "The runtime length does not match the published contract template.",
      { runtimeCodeHash },
    );
  if (
    template.immutableReferences === null ||
    template.linkReferences === null ||
    template.compilerEvidence === null
  )
    throw new RestError(
      422,
      "RUNTIME_PROOF_UNAVAILABLE",
      "The runtime differs from its compiler template and exact compiler immutable/link references are unavailable.",
      { templateCodeId: template.id, runtimeCodeHash },
    );
  if (template.linkReferences.length > 0)
    throw new RestError(
      422,
      "LINKED_RUNTIME_UNSUPPORTED",
      "Linked library runtime needs independently verified library-address bindings; it is not accepted using a masked template.",
    );
  const actual = Buffer.from(code.slice(2), "hex");
  const expected = Buffer.from(template.runtimeTemplate.slice(2), "hex");
  const immutableValues = template.immutableReferences.map((span) => {
    if (
      !Number.isSafeInteger(span.start) ||
      !Number.isSafeInteger(span.length) ||
      span.start < 0 ||
      span.length < 1 ||
      span.start + span.length > actual.length
    )
      throw new RestError(
        500,
        "CATALOG_CODE_INVALID",
        "Invalid compiler immutable reference.",
      );
    const value =
      `0x${actual.subarray(span.start, span.start + span.length).toString("hex")}` as Hex;
    actual.fill(0, span.start, span.start + span.length);
    expected.fill(0, span.start, span.start + span.length);
    return { ...span, value };
  });
  if (!actual.equals(expected))
    throw new RestError(
      422,
      "RUNTIME_CODE_MISMATCH",
      "The runtime differs outside compiler-declared immutable locations.",
      { runtimeCodeHash, templateCodeId: template.id },
    );
  return {
    mode: "compiler-template-with-observed-immutables" as const,
    runtimeCodeHash,
    runtimeByteLength: actual.length,
    templateCodeId: template.id,
    immutableValues,
    compilerEvidence: template.compilerEvidence,
  };
}
