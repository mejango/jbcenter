import { RestError } from "../core.js";
import type { Hex } from "viem";
import type {
  SmartAccountBinding,
  VerifiedSmartAccountRegistry,
} from "./types.js";

/** Deterministic bounded test/development adapter. Production must supply durable transactional storage. */
export class MemorySmartAccountRegistry
  implements VerifiedSmartAccountRegistry
{
  private readonly records = new Map<string, SmartAccountBinding>();
  private readonly nonces = new Map<string, Hex>();
  constructor(
    private readonly maximumBindings = 1000,
    private readonly maximumNonces = 10000,
  ) {}
  async bind(record: SmartAccountBinding) {
    const key = `${record.ownerAccountId}:${record.id}`;
    const nonce = `${record.ownerAccountId}:${record.authorization.nonce.toLowerCase()}`;
    const used = this.nonces.get(nonce);
    if (used && used !== record.authorization.digest)
      throw new RestError(
        409,
        "SMART_BINDING_NONCE_REPLAY",
        "The owner binding nonce was already used for another authorization.",
      );
    if (used) {
      const current = this.records.get(key);
      if (
        !current ||
        current.authorization.digest !== record.authorization.digest
      )
        throw new RestError(
          409,
          "SMART_BINDING_REVOKED",
          "A revoked or superseded authorization cannot restore an account binding.",
        );
      return structuredClone(current);
    }
    if (
      (!this.records.has(key) && this.records.size >= this.maximumBindings) ||
      this.nonces.size >= this.maximumNonces
    )
      throw new RestError(
        503,
        "SMART_REGISTRY_CAPACITY",
        "The bounded development registry is full.",
      );
    this.nonces.set(nonce, record.authorization.digest);
    this.records.set(key, structuredClone(record));
    return structuredClone(record);
  }
  async get(ownerAccountId: string, id: Hex) {
    const record = this.records.get(`${ownerAccountId}:${id}`);
    return record ? structuredClone(record) : undefined;
  }
  async revoke(ownerAccountId: string, id: Hex) {
    this.records.delete(`${ownerAccountId}:${id}`);
  }
  async list(ownerAccountId: string) {
    return [...this.records.values()]
      .filter((record) => record.ownerAccountId === ownerAccountId)
      .map((record) => structuredClone(record));
  }
}
