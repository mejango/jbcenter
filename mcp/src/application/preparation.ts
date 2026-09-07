import type { Services } from '../app.js';
import type { PlanDraft } from '../domain/types.js';
import { publicError } from '../domain/errors.js';

export async function observed<T>(read: () => Promise<T>) {
  try {
    return { status: 'known' as const, value: await read() };
  } catch (error) {
    return { status: 'unknown' as const, error: publicError(error) };
  }
}

export async function preparePlan(services: Services, draft: PlanDraft) {
  const plan = services.plans.seal(draft);
  const preflight = await observed(() => services.plans.simulate({ token: plan.token, step: 0 }));
  return {
    ...plan,
    preflight,
    execution: {
      mode: 'external-wallet',
      broadcastByServer: false,
      freshSimulationRequiredBeforeSigning: true,
      steps: draft.calls.length,
      note: 'Review each step. Confirm prerequisite transactions before simulating dependent steps. Expiry is enforced by this service; the wallet must also refuse an expired plan. No wallet signature or transaction has been submitted.',
    },
  };
}
