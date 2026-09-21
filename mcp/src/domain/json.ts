import { DomainError } from './errors.js';

export function jsonSafe<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    ),
  );
}

/** Zod's object parsers may discard reserved object keys. Reject rather than alter commitments. */
export function assertUnambiguousJson(value: unknown): void {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 50_000 || item.depth > 64)
      throw new DomainError('JSON_LIMIT_EXCEEDED', 'JSON exceeds the supported structural limits.');
    if (item.value === null || typeof item.value !== 'object') continue;
    for (const [key, child] of Object.entries(item.value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key))
        throw new DomainError(
          'RESERVED_JSON_KEY',
          'Reserved JSON object keys are unsupported. No modified payload or commitment was produced.',
        );
      pending.push({ value: child, depth: item.depth + 1 });
    }
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object' && value !== null) {
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v))
        .join(',') +
      '}'
    );
  }
  throw new DomainError('INVALID_JSON', 'Value cannot be represented as canonical JSON.');
}
