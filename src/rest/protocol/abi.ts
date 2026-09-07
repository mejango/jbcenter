import {
  getAddress,
  isAddress,
  type AbiFunction,
  type AbiParameter,
  type Address,
} from "viem";
import { RestError } from "../core.js";

export const MAX_UINT256 = (1n << 256n) - 1n;
const invalid = (path: string, message: string): never => {
  throw new RestError(400, "ABI_ARGUMENT_INVALID", `${path}: ${message}`);
};

export function integer(
  value: unknown,
  path: string,
  signed = false,
  bits = 256,
): bigint {
  if (
    typeof value !== "string" ||
    value.length > 79 ||
    !(signed ? /^(0|-[1-9][0-9]*|[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(
      value,
    )
  )
    return invalid(
      path,
      "Use an exact canonical decimal integer string; JSON numbers, exponents and leading zeros are not accepted.",
    );
  const n = BigInt(value);
  const minimum = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const maximum = signed
    ? (1n << BigInt(bits - 1)) - 1n
    : (1n << BigInt(bits)) - 1n;
  if (n < minimum || n > maximum)
    return invalid(
      path,
      `Value does not fit ${signed ? "int" : "uint"}${bits}.`,
    );
  return n;
}

export function address(
  value: unknown,
  path: string,
  nonzero = false,
): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: true }))
    return invalid(
      path,
      "Use a valid EVM address, with a valid checksum when mixed case.",
    );
  const result = getAddress(value);
  if (nonzero && BigInt(result) === 0n)
    return invalid(path, "Address must be nonzero.");
  return result;
}

export function canonicalType(parameter: AbiParameter): string {
  return parameter.type.startsWith("tuple")
    ? `(${("components" in parameter ? parameter.components : []).map(canonicalType).join(",")})${parameter.type.slice(5)}`
    : parameter.type;
}
export function signature(fn: AbiFunction): string {
  return `${fn.name}(${fn.inputs.map(canonicalType).join(",")})`;
}

/** ABI-driven conversion. Every integer is supplied as a decimal string, including uint8 and int24. */
export function argumentsFor(
  fn: AbiFunction,
  values: unknown,
): readonly unknown[] {
  if (!Array.isArray(values) || values.length !== fn.inputs.length)
    return invalid(
      "args",
      `Expected exactly ${fn.inputs.length} positional arguments.`,
    );
  const budget = { nodes: 0, bytes: 0 };
  function convert(
    parameter: AbiParameter,
    value: unknown,
    path: string,
    depth: number,
  ): unknown {
    if (++budget.nodes > 4096 || depth > 16)
      return invalid(
        path,
        "ABI input exceeds the bounded nesting or element budget.",
      );
    const array = /^(.*)\[([0-9]*)\]$/.exec(parameter.type);
    if (array) {
      if (
        !Array.isArray(value) ||
        value.length > 1024 ||
        (array[2] !== "" && value.length !== Number(array[2]))
      )
        return invalid(
          path,
          "Array shape or length does not match the ABI (maximum 1024 elements).",
        );
      return value.map((item, index) =>
        convert(
          { ...parameter, type: array[1]! } as AbiParameter,
          item,
          `${path}[${index}]`,
          depth + 1,
        ),
      );
    }
    if (parameter.type === "tuple") {
      if (!("components" in parameter))
        return invalid(path, "Tuple components are unavailable.");
      const fields = parameter.components;
      let positional: unknown[];
      if (Array.isArray(value)) {
        if (value.length !== fields.length)
          return invalid(path, `Tuple requires ${fields.length} fields.`);
        positional = value;
      } else {
        if (
          typeof value !== "object" ||
          value === null ||
          Object.getPrototypeOf(value) !== Object.prototype
        )
          return invalid(
            path,
            "Use a positional tuple array or an exact named tuple object.",
          );
        const names = fields.map((field) => field.name);
        if (
          names.some((name) => !name) ||
          new Set(names).size !== fields.length
        )
          return invalid(
            path,
            "Unnamed or duplicate tuple fields require positional arrays.",
          );
        const record = value as Record<string, unknown>;
        if (
          Object.keys(record).length !== fields.length ||
          names.some((name) => !Object.hasOwn(record, name!))
        )
          return invalid(
            path,
            "Tuple object must contain every ABI field exactly once and no extra fields.",
          );
        positional = names.map((name) => record[name!]);
      }
      return fields.map((field, index) =>
        convert(
          field,
          positional[index],
          `${path}.${field.name || index}`,
          depth + 1,
        ),
      );
    }
    const int = /^(u?int)([0-9]*)$/.exec(parameter.type);
    if (int) {
      const bits = int[2] ? Number(int[2]) : 256;
      if (bits < 8 || bits > 256 || bits % 8 !== 0)
        return invalid(path, "Invalid integer width in trusted ABI.");
      return integer(value, path, int[1] === "int", bits);
    }
    if (parameter.type === "address") return address(value, path);
    if (parameter.type === "bool") {
      if (typeof value !== "boolean")
        return invalid(path, "Use a JSON boolean.");
      return value;
    }
    if (parameter.type === "string") {
      if (typeof value !== "string") return invalid(path, "Use a string.");
      budget.bytes += new TextEncoder().encode(value).length;
      if (budget.bytes > 131072)
        return invalid(path, "String/bytes inputs exceed 128 KiB.");
      return value;
    }
    const bytes = /^bytes([0-9]*)$/.exec(parameter.type);
    if (bytes) {
      if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value))
        return invalid(path, "Use an even-length 0x-prefixed byte string.");
      const length = (value.length - 2) / 2;
      if (
        bytes[1] &&
        (Number(bytes[1]) < 1 ||
          Number(bytes[1]) > 32 ||
          length !== Number(bytes[1]))
      )
        return invalid(path, "Fixed bytes length does not match the ABI.");
      budget.bytes += length;
      if (budget.bytes > 131072)
        return invalid(path, "String/bytes inputs exceed 128 KiB.");
      return value.toLowerCase();
    }
    return invalid(
      path,
      `Unsupported ABI type ${parameter.type}; it is not silently coerced.`,
    );
  }
  return fn.inputs.map((parameter, index) =>
    convert(parameter, values[index], `args[${index}]`, 0),
  );
}

/** Protocol ABI numbers are exact decimal strings even when viem decodes narrow integers as JS numbers. */
export function abiJson(value: unknown): unknown {
  if (typeof value === "bigint" || typeof value === "number")
    return String(value);
  if (Array.isArray(value)) return value.map(abiJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, abiJson(item)]),
    );
  return value;
}

export function exactObject(
  value: unknown,
  keys: readonly string[],
  path: string,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid(path, "Expected a JSON object.");
  if (Object.keys(value).some((key) => !keys.includes(key)))
    return invalid(
      path,
      "Unknown input field; caller ABIs, raw calldata and upstream URLs are not accepted.",
    );
}
