import type { JBCenterIntentInput, JBCenterJsonObject } from '@bananapus/nana-sdk-core/jbcenter';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { CenterClient, CENTER_INTENT_SEMANTICS } from '../../src/adapters/jbcenter.js';
import type { fetchJson } from '../../src/adapters/http.js';

const ID = 'b0a555ff-4444-4111-aaaa-333333333333';
// Public, throwaway cryptographic test vector. Never used for network transactions.
const publisher = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const intent = (): JBCenterIntentInput => ({
  format: 'juicebox.money/v1',
  deploymentVersion: '6',
  chainIds: [8453, 1],
  deploymentCalls: [
    { chainId: 8453, to: '0x3333333333333333333333333333333333333333', data: '0x12345678' },
    { chainId: 1, to: '0x4444444444444444444444444444444444444444', data: '0x87654321' },
  ],
  jb: { name: 'Juice', chains: [1, 8453], nested: { b: 2, a: 1 } },
});
const metadata = {
  name: 'Juice',
  description: 'untrusted description',
  tagline: null,
  tags: [],
  logoUri: null,
  owner: null,
};
async function signedIntent() {
  const prepared = await new CenterClient().prepareIntent(intent());
  return {
    ...metadata,
    id: ID,
    status: 'undeployed',
    ...prepared,
    publisher: publisher.address,
    signature: await publisher.signMessage({ message: prepared.message }),
    createdAt: '2026-09-06T00:00:00Z',
    deployments: [],
  };
}

describe('Center intent commitment and read boundary', () => {
  it('matches the current Center source protocol fixture without a network mutation', async () => {
    const request = vi.fn<typeof fetchJson>();
    const center = new CenterClient({ fetchJson: request });
    const prepared = await center.prepareIntent(intent());
    // Obtained by running extensions/jbcenter/src/intent.ts normalizeEnvelope/contentHash/signingMessage
    // against the exact fixture above; independent of this adapter's implementation.
    expect(prepared.contentHash).toBe(
      '0x34a3273b9f26f0e87077e0e2c50c0b7bc7d0d1a2099fbdce96252ada1393b64c',
    );
    expect(prepared.message).toBe(
      'Juice Central project intent\nVersion: 1\nContent hash: 0x34a3273b9f26f0e87077e0e2c50c0b7bc7d0d1a2099fbdce96252ada1393b64c',
    );
    expect(prepared.envelope.chainIds).toEqual([1, 8453]);
    expect(prepared.envelope.deploymentCalls.map((call) => call.chainId)).toEqual([1, 8453]);
    expect(request).not.toHaveBeenCalled();
    expect(CENTER_INTENT_SEMANTICS.preparedIntent).toContain('does not sign, publish');
  });

  it('commits exact calldata while preserving semantic key-order equivalence', async () => {
    const center = new CenterClient();
    const original = intent();
    const reordered = {
      ...intent(),
      jb: { nested: { a: 1, b: 2 }, chains: [1, 8453], name: 'Juice' },
    };
    expect((await center.prepareIntent(original)).contentHash).toBe(
      (await center.prepareIntent(reordered)).contentHash,
    );
    const changed = intent();
    changed.deploymentCalls[0]!.data = '0x12345679';
    expect((await center.prepareIntent(original)).contentHash).not.toBe(
      (await center.prepareIntent(changed)).contentHash,
    );
    expect(original.chainIds).toEqual([8453, 1]);
  });

  it('preserves literal JSON prototype keys in the commitment without polluting objects', async () => {
    const jb = JSON.parse('{"__proto__":{"polluted":true},"name":"Juice"}') as JBCenterJsonObject;
    const prepared = await new CenterClient().prepareIntent({ ...intent(), jb });
    expect(Object.keys(prepared.envelope.jb)).toContain('__proto__');
    expect(JSON.stringify(prepared.envelope.jb)).toContain('"__proto__"');
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it.each([
    () => ({ ...intent(), chainIds: [1, 1] }),
    () => ({ ...intent(), deploymentCalls: [] }),
    () => ({ ...intent(), jb: { chains: [8453] } }),
    () => ({ ...intent(), jb: { app: 'revnet.money', data: { chainIds: [8453] } } }),
    () => ({
      ...intent(),
      deploymentCalls: intent().deploymentCalls.map((call) => ({ ...call, chainId: 1 })),
    }),
    () => ({
      ...intent(),
      deploymentCalls: intent().deploymentCalls.map((call) => ({ ...call, data: '0x12' as const })),
    }),
    () => ({ ...intent(), format: 'arbitrary path' }),
  ])('rejects malformed chain or deployment commitments', async (makeIntent) => {
    await expect(new CenterClient().prepareIntent(makeIntent())).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects oversized, cyclic, and non-JSON payloads before committing', async () => {
    const center = new CenterClient();
    await expect(
      center.prepareIntent({ ...intent(), jb: { text: 'x'.repeat(1024 * 1024) } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const cyclic: JBCenterJsonObject = {};
    cyclic.self = cyclic;
    await expect(center.prepareIntent({ ...intent(), jb: cyclic })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      center.prepareIntent({ ...intent(), jb: { invalid: Number.NaN } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const deep: JBCenterJsonObject = {};
    let node = deep;
    for (let i = 0; i < 66; i++) {
      const child = {};
      node.child = child;
      node = child;
    }
    await expect(center.prepareIntent({ ...intent(), jb: deep })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('verifies a fetched intent hash and publisher signature without elevating metadata to authority', async () => {
    const record = await signedIntent();
    const request = vi.fn<typeof fetchJson>().mockResolvedValue(record);
    const center = new CenterClient({ fetchJson: request });
    const fetched = await center.getIntent(ID);
    expect(fetched.publisher).toBe(publisher.address);
    expect(fetched.description).toBe('untrusted description');
    expect(request.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(CENTER_INTENT_SEMANTICS.signature).toContain('not project safety');
  });

  it('rejects substituted IDs, calldata, signatures, and deployment chain records', async () => {
    const record = await signedIntent();
    const request = vi.fn<typeof fetchJson>();
    const center = new CenterClient({ fetchJson: request });
    for (const invalid of [
      { ...record, id: 'b0a555ff-4444-4111-aaaa-333333333334' },
      {
        ...record,
        envelope: { ...record.envelope, jb: { ...record.envelope.jb, name: 'Substituted' } },
      },
      { ...record, publisher: '0x3333333333333333333333333333333333333333' },
      { ...record, signature: `0x${'11'.repeat(65)}` },
      {
        ...record,
        status: 'deployed',
        deployments: [
          {
            chainId: 10,
            projectId: '1',
            transactionHash: `0x${'11'.repeat(32)}`,
            createdAt: '2026-09-06T00:00:00Z',
          },
        ],
      },
      { ...record, status: 'deployed', deployments: [] },
    ]) {
      request.mockResolvedValue(invalid);
      await expect(center.getIntent(ID)).rejects.toMatchObject({
        code: 'UPSTREAM_INVALID_RESPONSE',
      });
    }
  });

  it('bounds search, encodes its query, uses the real numeric cursor, and never supplies an Origin by default', async () => {
    const request = vi
      .fn<typeof fetchJson>()
      .mockResolvedValue({ items: [], totalCount: 0, nextCursor: null });
    const center = new CenterClient({ baseUrl: 'https://center.example/', fetchJson: request });
    await center.search({ query: 'Juice & tea', limit: 10, cursor: '20' });
    const url = new URL(String(request.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/v1/search');
    expect(url.searchParams.get('q')).toBe('Juice & tea');
    expect(url.searchParams.get('cursor')).toBe('20');
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({ accept: 'application/json' });
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      timeoutMs: 15_000,
      maxBytes: 2 * 1024 * 1024,
    });
    await expect(center.search({ cursor: 'arbitraryOpaque' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(center.search({ limit: 101 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(center.getIntent('../v1/pins/json')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('keeps operator-configured integration headers out of the tool arguments', async () => {
    const request = vi
      .fn<typeof fetchJson>()
      .mockResolvedValue({ items: [], totalCount: 0, nextCursor: null });
    const headers = { Origin: 'https://authorized.operator.example' };
    const center = new CenterClient({ headers, fetchJson: request });
    headers.Origin = 'https://mutated.example';
    await center.search();
    expect(request.mock.calls[0]?.[1]?.headers?.Origin).toBe('https://authorized.operator.example');
  });

  it('discards unknown upstream exceptions without disclosing credentials or forging success', async () => {
    const request = vi
      .fn<typeof fetchJson>()
      .mockRejectedValue(new Error('secret integration token: retry by publishing'));
    const center = new CenterClient({ fetchJson: request });
    await expect(center.search()).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      retryable: true,
    });
    await expect(center.search()).rejects.not.toThrow('secret integration token');
  });
});
