import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The committed catalog is what agents read; catalog:check keeps it equal to the generated schemas.
const catalog = JSON.parse(
  readFileSync(new URL('../../data/mcp-tool-catalog.json', import.meta.url), 'utf8'),
) as { tools: { name: string; inputSchema: unknown }[] };

// Inputs that carry a scaled number, a currency ID or a sentinel address.
const SCALED = new Set([
  'reservedPercent',
  'cashOutTaxRate',
  'baseCurrency',
  'weight',
  'weightCutPercent',
  'percent',
  'splitPercent',
  'maximumSplitPercent',
  'discountPercent',
  'groupId',
  'currency',
  'decimals',
  'initialIssuance',
  'issuanceCutPercent',
  'issuanceCutFrequency',
  'prepaidFeePercent',
  'token',
  'tokenToReclaim',
  'terminalToken',
  'price',
  'permissionIds',
]);

function undescribed(schema: unknown, path: string, out: string[]): void {
  if (!schema || typeof schema !== 'object') return;
  const node = schema as Record<string, unknown>;
  for (const [key, child] of Object.entries((node.properties ?? {}) as Record<string, unknown>)) {
    if (SCALED.has(key) && !(child as { description?: string }).description)
      out.push(`${path}.${key}`);
    undescribed(child, `${path}.${key}`, out);
  }
  for (const key of ['items', 'anyOf', 'oneOf', 'allOf'])
    for (const child of [node[key]].flat()) undescribed(child, path, out);
}

describe('agent-facing units', () => {
  it('describes every scaled or sentinel input on prepare, quote, model and permission tools', () => {
    const missing: string[] = [];
    for (const tool of catalog.tools)
      if (/prepare|quote|model|preview|get_permissions/.test(tool.name))
        undescribed(tool.inputSchema, tool.name, missing);
    expect(missing).toEqual([]);
  });
});
