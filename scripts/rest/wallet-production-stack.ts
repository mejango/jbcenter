import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRestRpc } from '../../src/rest/rpc.js';
import { RestError } from '../../src/rest/core.js';
import { inspectBaseWalletProductionStack } from '../../src/rest/wallet/productionStack.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output' || !args[1]) {
  throw new Error('Usage: npm run wallet:production-stack -- --output /absolute/path/stack.json');
}
const output = resolve(args[1]);
const rpc = createRestRpc({ upstreams: new Map([[8453, ['https://juicebox.center/v1/rpc/8453']]]) });
try {
  const observation = await inspectBaseWalletProductionStack({ rpc });
  await writeFile(output, JSON.stringify(observation, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: observation.status, manifestId: observation.manifest.id,
    manifestRevision: observation.manifest.revision, evidence: observation.evidence,
    missing: observation.missing.map(({ name, address, estimatedGas }) => ({ name, address, estimatedGas })),
    dispatchEnabled: observation.dispatchEnabled, output }));
} catch (error) {
  if (error instanceof RestError) console.error(JSON.stringify({ code: error.code }));
  console.error('Production dependency check failed. Verify canonical RPC availability and the output path; no transaction was signed or sent.');
  process.exitCode = 1;
}
