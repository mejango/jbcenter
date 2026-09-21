import { describe, expect, test } from "vitest";
import { readSponsorPolicy, reservationWei, sponsorFamily } from "../../src/sponsor/policy.js";

describe("sponsor policy", () => {
  test("family by chain set", () => {
    expect(sponsorFamily([8453, 10])).toBe("mainnet");
    expect(sponsorFamily([84532, 11155111])).toBe("testnet");
    expect(sponsorFamily([1, 8453])).toBeNull();
    expect(sponsorFamily([8453, 84532])).toBeNull();
    expect(sponsorFamily([])).toBeNull();
  });

  test("policy from env with defaults", () => {
    const policy = readSponsorPolicy({});
    expect(policy).toEqual({
      paused: false,
      perRequesterPerDay: 5,
      dailyBudgetWei: 50_000_000_000_000_000n,
      maximumGas: 8_000_000n,
      maximumFeePerGas: 1_000_000_000n,
      confirmations: 2,
    });
    expect(readSponsorPolicy({ SPONSOR_PAUSED: "1" }).paused).toBe(true);
    expect(reservationWei(policy, 2)).toBe(2n * (8_000_000n * 1_000_000_000n + 100_000_000_000_000n));
  });
});
