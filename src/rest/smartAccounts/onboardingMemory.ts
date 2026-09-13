import type { MemoryAccountStore } from "../auth/memory.js";
import type { OnboardingStore } from "./onboarding.js";
import type { OnboardingRecord } from "./onboardingStore.js";
import type { MemorySmartAccountRegistry } from "./registry.js";

/** Test/development onboarding uses the same accounts and registry as ordinary API authentication. */
export class MemoryOnboardingStore implements OnboardingStore {
  constructor(
    private readonly accounts: MemoryAccountStore,
    private readonly registry: MemorySmartAccountRegistry,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000),
  ) {}

  finalize(input: OnboardingRecord): Promise<OnboardingRecord> {
    return this.accounts.finalizeOnboarding(input, this.registry, this.now);
  }
}
