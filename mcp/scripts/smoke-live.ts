import { createServices } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { projectSchema } from '../src/domain/schemas.js';
import { publicError } from '../src/domain/errors.js';
import { withRequestBudget } from '../src/domain/context.js';

// Explicitly opt in to a read-only public-chain smoke check. Never loads workspace .env files.
const project = projectSchema.parse({
  chainId: Number(process.argv[2] ?? '8453'),
  projectId: process.argv[3] ?? '1',
  version: 6,
});
const services = createServices(loadConfig());
function unknowns(value: unknown, path = '$'): { path: string; error: unknown }[] {
  if (typeof value !== 'object' || value === null) return [];
  if ('status' in value && value.status === 'unknown' && 'error' in value)
    return [{ path, error: value.error }];
  return Object.entries(value).flatMap(([key, item]) => unknowns(item, `${path}.${key}`));
}
try {
  const result = await withRequestBudget(
    () => services.projects.getProject(project),
    AbortSignal.timeout(45_000),
  );
  console.log(
    JSON.stringify({
      project,
      evidence: result.evidence,
      owner: result.owner,
      controller: result.controller,
      canonicalController: result.canonicalController,
      unknownObservations: unknowns(result),
      coverage: result.coverage,
    }),
  );
  if (result.owner.status !== 'known' || result.controller.status !== 'known') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify(publicError(error)));
  process.exitCode = 1;
}
