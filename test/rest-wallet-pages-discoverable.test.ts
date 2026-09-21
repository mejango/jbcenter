import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Every passkey prompt on the account pages is discoverable. Center pins the expected
 * credential server-side on each approval, and an allow list only lets iOS refuse a passkey it
 * cannot preselect ("Passkey cannot be used to sign in"), which stopped the first iPhone signup. */
describe("wallet pages prompt for a discoverable passkey", () => {
  it("never sends an allow list from any served page", () => {
    for (const page of ["wallet", "walletSignup", "walletRecoveryJourney", "walletPayment"]) {
      const source = readFileSync(new URL(`../src/rest/web/${page}.ts`, import.meta.url), "utf8");
      expect(source, page).not.toContain("allow" + "Credentials");
    }
  });
});
