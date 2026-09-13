import type { Pool } from "pg";
import {
  databaseNow,
  enrollAccountInTransaction,
  getGrant,
  registerBotInTransaction,
} from "../auth/postgres.js";
import { accountStoreLimits, RestAuthError, type AccountStoreLimits, type AccountStoreOptions } from "../auth/store.js";
import { RestError } from "../core.js";
import type { OnboardingStore } from "./onboarding.js";
import { assertOnboardingLive, assertOnboardingRecord, sameOnboardingGrant, type OnboardingRecord } from "./onboardingStore.js";
import { bindSmartAccountInTransaction } from "./postgres.js";
import { stable } from "./service.js";

/** One owner consent commits enrollment, the binding and its exact API grant together. */
export class PostgresOnboardingStore implements OnboardingStore {
  private readonly limits: AccountStoreLimits;

  constructor(private readonly pool: Pool, options: AccountStoreOptions = {}) {
    this.limits = accountStoreLimits(options);
  }

  async finalize(input: OnboardingRecord): Promise<OnboardingRecord> {
    // Snapshot caller-owned objects before the first await so signed fields cannot change while locking.
    const record = structuredClone(input);
    assertOnboardingRecord(record);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Shared enrollment lock precedes the account row lock, matching ordinary account enrollment.
      const account = await enrollAccountInTransaction(client, record.account, this.limits);
      const now = await databaseNow(client);
      assertOnboardingLive(record, now);
      const { binding, replayed } = await bindSmartAccountInTransaction(client, record.binding, now);
      let grant;
      if (replayed) {
        grant = await getGrant(client, record.grant.id);
        if (!grant || !sameOnboardingGrant(grant, record.grant, now)
          || stable(binding.authorization) !== stable(record.binding.authorization)) {
          throw new RestError(409, "SMART_ONBOARDING_REPLAY", "A missing, changed, expired or revoked browser API grant cannot be restored by a previous setup approval.");
        }
      } else {
        try {
          grant = await registerBotInTransaction(client, record.grant, this.limits);
        } catch (error) {
          // This helper's only storage cap is the immutable per-account grant history.
          if (error instanceof RestAuthError && error.code === "STORAGE_LIMIT")
            throw new RestError(429, "SMART_ONBOARDING_GRANT_LIMIT", "Account browser API grant history limit exceeded.");
          throw error;
        }
      }
      const result = { account, binding, grant };
      // An authorization that expires during I/O must roll back every write.
      assertOnboardingLive(result, await databaseNow(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
