import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createPool } from "../src/db/postgres.js";

describe("PostgreSQL pool lifecycle", () => {
  it("handles idle and active connection failures without losing metrics or logging connection details", async () => {
    const pool = createPool("postgresql://localhost:1/unused");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => pool.emit("error", new Error("private-connection-details"))).not.toThrow();
      const client = new EventEmitter();
      pool.emit("connect", client);
      expect(() => client.emit("error", new Error("private-connection-details"))).not.toThrow();
      expect(pool.connectsSinceLast()).toBe(1);
      expect(pool.connectsSinceLast()).toBe(0);
      expect(log).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(log.mock.calls)).not.toContain("private-connection-details");
    } finally { await pool.end(); log.mockRestore(); }
  });
});
