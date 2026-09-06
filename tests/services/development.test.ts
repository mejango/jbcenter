import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDevelopmentBundle,
  DEVELOPMENT_FEATURES,
  DevelopmentService,
  developmentBundleSchema,
  integrationInputSchema,
  referenceInputSchema,
} from '../../src/services/development.js';

const bundlePath = fileURLToPath(new URL('../../data/development.json', import.meta.url));
const rawBundle = () => JSON.parse(readFileSync(bundlePath, 'utf8'));
const tempPaths: string[] = [];
const fixture = (content: unknown) => {
  const directory = mkdtempSync(join(tmpdir(), 'juicebox-development-'));
  tempPaths.push(directory);
  const path = join(directory, 'bundle.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
};
afterEach(() => {
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('DevelopmentService', () => {
  it('serves all three webclients and verified SDK provenance without a workspace checkout', () => {
    const service = new DevelopmentService({ path: fixture(rawBundle()) });
    const catalog = service.catalog();
    expect(catalog.features.map((feature) => feature.id)).toEqual([...DEVELOPMENT_FEATURES]);
    expect(new Set(catalog.references.map((reference) => reference.source.repository))).toEqual(
      new Set(['juicescan', 'juicebox-money', 'revnet-money', 'juice-sdk-v4']),
    );
    expect(catalog.publicOrigin).toBe('https://juicebox.diy');
    expect(catalog.referenceOnly).toBe(true);
    for (const reference of catalog.references) {
      expect(reference.source.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(reference.source.fileSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(typeof reference.source.fileDirty).toBe('boolean');
      expect(reference.source.spdxLicenseIdentifier).not.toBe('');
      expect(reference.source.path).not.toMatch(/(?:^|\/)\.env/);
      expect(reference.source.upstreamUrl).toContain(`/blob/${reference.source.commit}/`);
    }
  });

  it('reconstructs exact source with bounded pagination and verifiable source lines/hash', () => {
    const service = new DevelopmentService();
    const id = 'sdk.pay';
    const source = rawBundle().references.find((reference: { id: string }) => reference.id === id);
    let text = '';
    let offset: number | null = 0;
    while (offset !== null) {
      const page = service.getReference(id, { offset, limit: 333 });
      expect(page.text.length).toBeLessThanOrEqual(333);
      expect(page.pageStartLine).toBe(source.text.slice(0, offset).split('\n').length);
      expect(page.paginationUnit).toBe('UTF-16 code units');
      text += page.text;
      offset = page.nextOffset;
    }
    expect(text).toBe(source.text);
    expect(createHash('sha256').update(text).digest('hex')).toBe(source.source.fileSha256);
    expect(service.getReference(id, { offset: text.length }).text).toBe('');
    expect(() => service.getReference(id, { offset: text.length + 1 })).toThrow(/offset/);
  });

  it('attributes a trailing newline to its included line instead of the next page', () => {
    const service = new DevelopmentService();
    const text = service.getReference('sdk.pay').text;
    const firstLineLength = text.indexOf('\n') + 1;
    expect(firstLineLength).toBeGreaterThan(0);
    const first = service.getReference('sdk.pay', { limit: firstLineLength });
    expect(first.text.endsWith('\n')).toBe(true);
    expect(first.pageStartLine).toBe(1);
    expect(first.pageEndLine).toBe(1);
    const second = service.getReference('sdk.pay', { offset: firstLineLength, limit: 1 });
    expect(second.pageStartLine).toBe(2);
    expect(second.pageEndLine).toBe(2);
    const empty = service.getReference('sdk.pay', { offset: first.totalCharacters });
    expect(empty.text).toBe('');
    expect(empty.pageEndLine).toBe(empty.pageStartLine);
  });

  it('resolves feature dependencies and actual read/build/prove entry points for a full Revnet app', () => {
    const service = new DevelopmentService();
    const plan = service.planIntegration({
      framework: 'react',
      projectType: 'revnet',
      chainIds: [1, 8453],
      features: [...DEVELOPMENT_FEATURES],
    });
    expect(new Set(plan.features.map((feature) => feature.id)).size).toBe(
      DEVELOPMENT_FEATURES.length,
    );
    expect(plan.chainScope).toEqual([
      { chainId: 1, deploymentStatus: 'requires-live-verification' },
      { chainId: 8453, deploymentStatus: 'requires-live-verification' },
    ]);
    for (const feature of plan.features) {
      expect(new Set(feature.actions.map((action) => action.phase))).toEqual(
        new Set(['read', 'build', 'prove']),
      );
      for (const dependency of feature.dependsOn)
        expect(plan.features.findIndex((candidate) => candidate.id === dependency)).toBeLessThan(
          plan.features.findIndex((candidate) => candidate.id === feature.id),
        );
      for (const action of feature.actions)
        for (const entry of action.bindings) {
          const reference = service.getReference(entry.referenceId);
          expect(reference.exports).toContain(entry.symbol);
        }
      for (const testId of feature.testIds) expect(service.getReference(testId).kind).toBe('test');
    }
    expect(plan.sdkImports).toContainEqual({
      referenceId: 'sdk.pay',
      symbol: 'buildPayTx',
      importFrom: '@bananapus/nana-sdk-core/v6',
    });
    expect(plan.sdkImports).toContainEqual({
      referenceId: 'sdk.center',
      symbol: 'JBCenterClient',
      importFrom: '@bananapus/nana-sdk-core/jbcenter',
    });
    expect(plan.warnings.join(' ')).toContain('not standalone copy-paste');
  });

  it('adds review and data dependencies, prioritizes vanilla examples, and does not invent deployment availability', () => {
    const service = new DevelopmentService({ publicOrigin: 'https://juicebox.tools' });
    const plan = service.planIntegration({
      framework: 'vanilla',
      projectType: 'project',
      chainIds: [84532],
      features: ['721-storefront'],
    });
    expect(plan.addedDependencies).toEqual(
      expect.arrayContaining(['payments', 'review-pipeline', 'metadata-center', 'indexed-queries']),
    );
    expect(plan.publicOrigin).toBe('https://juicebox.tools');
    expect(plan.chainScope[0]?.deploymentStatus).toBe('requires-live-verification');
    const firstReact = plan.references.findIndex((reference) => reference.framework === 'react');
    expect(
      plan.references.slice(firstReact).every((reference) => reference.framework === 'react'),
    ).toBe(true);
    expect(
      plan.features.find((feature) => feature.id === '721-storefront')?.constraints.join(' '),
    ).toContain('denominator 200');
    expect(() =>
      service.planIntegration({
        framework: 'vanilla',
        projectType: 'project',
        chainIds: [1],
        features: ['revnet-loans'],
      }),
    ).toThrow(/requires projectType revnet/);
  });

  it('rejects unknown features, invalid chains, traversal and unbounded requests', () => {
    const service = new DevelopmentService();
    const request = {
      framework: 'react',
      projectType: 'project',
      features: ['payments'],
      chainIds: [1],
    };
    expect(
      integrationInputSchema.safeParse({ ...request, features: ['magic-free-money'] }).success,
    ).toBe(false);
    expect(integrationInputSchema.safeParse({ ...request, chainIds: [137] }).success).toBe(false);
    expect(integrationInputSchema.safeParse({ ...request, chainIds: [1, 1] }).success).toBe(false);
    expect(
      integrationInputSchema.safeParse({ ...request, features: ['payments', 'payments'] }).success,
    ).toBe(false);
    expect(() => service.getReference('../../.env')).toThrow();
    expect(() => service.getReference('unknown')).toThrow(/Unknown/);
    expect(referenceInputSchema.safeParse({ id: 'sdk.pay', offset: -1 }).success).toBe(false);
    expect(referenceInputSchema.safeParse({ id: 'sdk.pay', limit: 24_001 }).success).toBe(false);
    expect(() => service.getReference('sdk.pay', { limit: 0 })).toThrow();
  });

  it('rejects tampered bundle source, hashes, line provenance, references and cyclic dependencies', () => {
    const text = rawBundle();
    text.references[0].text += '\nmalicious changed content';
    expect(() => new DevelopmentService({ path: fixture(text) })).toThrow(/SHA256|fingerprint/);
    const lines = rawBundle();
    lines.references[0].source.endLine++;
    expect(developmentBundleSchema.safeParse(lines).success).toBe(false);
    const missing = rawBundle();
    missing.features[0].sourceIds.push('unknown');
    expect(() => createDevelopmentBundle(missing.references, missing.features)).toThrow(
      /reference/,
    );
    const binding = rawBundle();
    binding.features[0].actions[0].bindings[0].symbol = 'fabricatedFunction';
    expect(() => createDevelopmentBundle(binding.references, binding.features)).toThrow(
      /Unverified entry point/,
    );
    const cyclic = rawBundle();
    cyclic.features[0].dependsOn.push(cyclic.features[0].id);
    expect(() => createDevelopmentBundle(cyclic.references, cyclic.features)).toThrow(/Cyclic/);
  });

  it('builds a canonical fingerprint and isolates callers from internal mutable data', () => {
    const original = rawBundle();
    const parsed = developmentBundleSchema.parse(original);
    const again = createDevelopmentBundle(
      [...parsed.references].reverse(),
      [...parsed.features].reverse(),
    );
    expect(again.bundleId).toBe(parsed.bundleId);
    expect(again).toEqual(parsed);
    const service = new DevelopmentService();
    const before = service.catalog();
    before.references[0]!.source.path = 'changed';
    before.features[0]!.dependsOn.push('payments');
    const reference = service.getReference('sdk.pay');
    reference.exports.push('invented');
    expect(service.catalog()).not.toEqual(before);
    expect(service.getReference('sdk.pay').exports).not.toContain('invented');
    expect(
      () => new DevelopmentService({ publicOrigin: 'https://user:secret@example.com' }),
    ).toThrow(/origin/);
    expect(() => new DevelopmentService({ publicOrigin: 'https://example.com/path' })).toThrow(
      /origin/,
    );
  });
});
