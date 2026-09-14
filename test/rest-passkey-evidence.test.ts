import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('binds committed passkey compatibility measurements to the current compiler, verifier and bootstrap inputs', async () => {
  const root = new URL('../src/rest/smartAccounts/stack/passkey/', import.meta.url);
  const evidence = JSON.parse(await readFile(new URL('evidence/local-compatibility.json', root), 'utf8'));
  const required = ['manifest.json', 'test/PasskeyStack.t.sol', 'compiler.mjs', 'verify.mjs', 'solc-cache.mjs',
    'foundry.toml', 'bootstrap/manifest.json', 'bootstrap/verify.mjs', 'bootstrap/foundry.toml', 'bootstrap/test/Bootstrap.t.sol'];
  expect(Object.keys(evidence.evidenceInputsSha256).sort()).toEqual(required.sort());
  for (const path of required)
    expect(evidence.evidenceInputsSha256[path], path).toBe(createHash('sha256').update(await readFile(new URL(path, root))).digest('hex'));
  expect(evidence.bootstrap.suites[0]).toMatchObject({ passed: 10, failed: 0, skipped: 0, total: 10 });
  expect(evidence.fuzzRuns).toBeGreaterThanOrEqual(256);
});
