import { jbUrn } from '@bananapus/nana-sdk-core';
import { projectSchema } from '../domain/schemas.js';
import { DomainError } from '../domain/errors.js';
import type { ProjectRef } from '../domain/types.js';

/** Resolve identifiers locally; this function never fetches a user-supplied URL. */
export function resolveProjectIdentifier(
  input: string,
): { kind: 'project'; project: ProjectRef } | { kind: 'search'; query: string } {
  let value = input.trim();
  if (!value || value.length > 2048)
    throw new DomainError(
      'INVALID_PROJECT_IDENTIFIER',
      'Provide a project URL, a V6 chain:project ID, or a project name.',
    );
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      ![
        'juicebox.money',
        'www.juicebox.money',
        'revnet.money',
        'www.revnet.money',
        'dev.juicebox.money',
        'dev.revnet.money',
      ].includes(url.hostname)
    )
      throw new DomainError(
        'UNSUPPORTED_PROJECT_URL',
        'Use a Juicebox Money or Revnet Money project URL, or an explicit V6 chain:project ID.',
      );
    let parts: string[];
    try {
      parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      throw new DomainError(
        'INVALID_PROJECT_IDENTIFIER',
        'The project URL contains malformed encoding.',
      );
    }
    if (/^v\d+$/.test(parts[0] ?? '')) {
      if (parts[0] !== 'v6')
        throw new DomainError('UNSUPPORTED_VERSION', 'This server operates on Juicebox V6 only.');
      parts.shift();
    }
    value = parts[0] ?? '';
    if (!value)
      throw new DomainError('INVALID_PROJECT_IDENTIFIER', 'This URL does not identify a project.');
  }
  if (value.startsWith('v') && /^v\d+:/.test(value) && !value.startsWith('v6:'))
    throw new DomainError('UNSUPPORTED_VERSION', 'This server operates on Juicebox V6 only.');
  if (value.includes(':')) {
    // SDK's legacy default is V4. Always supply an explicit V6 prefix here.
    const urn = value.startsWith('v6:') ? value : `v6:${value}`;
    const parsed = jbUrn(urn);
    if (parsed?.version === 6)
      return {
        kind: 'project',
        project: projectSchema.parse({
          chainId: parsed.chainId,
          projectId: parsed.projectId.toString(),
          version: 6,
        }),
      };
    const numeric = /^v6:([0-9]+):([1-9][0-9]*)$/.exec(urn);
    if (numeric) {
      const result = projectSchema.safeParse({
        chainId: Number(numeric[1]),
        projectId: numeric[2],
        version: 6,
      });
      if (result.success) return { kind: 'project', project: result.data };
    }
    throw new DomainError(
      'INVALID_PROJECT_IDENTIFIER',
      'Use a supported chain slug or chain ID followed by a positive decimal project ID.',
    );
  }
  if (/^[0-9]+$/.test(value))
    throw new DomainError(
      'AMBIGUOUS_PROJECT',
      'A project ID alone is ambiguous. Include its chain, for example base:123.',
    );
  return { kind: 'search', query: value.replace(/^@/, '').slice(0, 200) };
}
