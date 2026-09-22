import type { JBCenterIntentInput, JBCenterJsonObject } from '@bananapus/nana-sdk-core/jbcenter';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import {
  CenterClient,
  CENTER_DEPLOY_REFUSALS,
  CENTER_INTENT_SEMANTICS,
  canonicalCenterJson,
  centerIntentMessage,
  normalizeCenterIntent,
} from '../../src/adapters/jbcenter.js';
import { keccak256, toBytes } from 'viem';
import { DomainError } from '../../src/domain/errors.js';
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
    deploys: [],
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

  it("keeps a chain's setup calls in order and refuses a fifth call", () => {
    const FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67' as const;
    const TERMINAL = '0x3333333333333333333333333333333333333333' as const;
    const calls = [
      { chainId: 8453, to: FACTORY, data: '0xaaaaaaaa' as const },
      { chainId: 1, to: TERMINAL, data: '0x12345678' as const },
      { chainId: 8453, to: FACTORY, data: '0xbbbbbbbb' as const },
      { chainId: 8453, to: TERMINAL, data: '0x12345678' as const },
    ];
    const normalized = normalizeCenterIntent({
      ...intent(),
      chainIds: [8453, 1],
      deploymentCalls: calls,
    });
    expect(normalized.deploymentCalls.map((call) => [call.chainId, call.data])).toEqual([
      [1, '0x12345678'],
      [8453, '0xaaaaaaaa'],
      [8453, '0xbbbbbbbb'],
      [8453, '0x12345678'],
    ]);
    expect(() =>
      normalizeCenterIntent({
        ...intent(),
        chainIds: [8453],
        jb: { name: 'Juice', chains: [8453] },
        deploymentCalls: [
          { chainId: 8453, to: FACTORY, data: '0xaaaaaaaa' as const },
          { chainId: 8453, to: FACTORY, data: '0xbbbbbbbb' as const },
          { chainId: 8453, to: FACTORY, data: '0xcccccccc' as const },
          { chainId: 8453, to: FACTORY, data: '0xdddddddd' as const },
          { chainId: 8453, to: TERMINAL, data: '0x12345678' as const },
        ],
      }),
    ).toThrow();
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

    // Which sender deployed a chain decides whether Center can still deploy the rest.
    const deployed = {
      ...record,
      status: 'deployed',
      deployments: [
        {
          chainId: 8453,
          projectId: '1',
          transactionHash: `0x${'11'.repeat(32)}`,
          forwarded: true,
          createdAt: '2026-09-06T00:00:00Z',
        },
      ],
    };
    request.mockResolvedValue(deployed);
    expect((await center.getIntent(ID)).deployments[0]?.forwarded).toBe(true);
    request.mockResolvedValue(record);
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
            forwarded: true,
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

const ENVELOPE = {
  format: 'juicebox.money/v1',
  deploymentVersion: '6',
  chainIds: [84532],
  deploymentCalls: [
    { chainId: 84532, to: '0x3333333333333333333333333333333333333333', data: '0x12345678' },
  ],
  jb: { v: 1, name: 'Unit', chains: [84532] },
} as const;

describe('CenterClient writes', () => {
  it('sends the normalized envelope and rejects a mismatched signature without a request', async () => {
    const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
    const hash = keccak256(toBytes(canonicalCenterJson(ENVELOPE as never)));
    const signature = await account.signMessage({ message: centerIntentMessage(hash) });
    const request = vi.fn<typeof fetchJson>().mockResolvedValue({
      id: 'a7396c7e-b13f-4ca8-9f06-96f36ab22c3a',
      status: 'undeployed',
      contentHash: hash,
      envelope: ENVELOPE,
      publisher: account.address,
      signature,
      name: 'Unit',
      description: null,
      tagline: null,
      tags: [],
      logoUri: null,
      owner: null,
      createdAt: '2026-09-21T00:00:00.000Z',
      deployments: [],
      deploys: [],
    });
    const client = new CenterClient({ baseUrl: 'https://juicebox.center', fetchJson: request });

    const intent = await client.publishIntent({
      ...ENVELOPE,
      publisher: account.address,
      signature,
    } as never);
    expect(intent.contentHash).toBe(hash);
    const [url, options] = request.mock.calls[0]!;
    expect(String(url)).toBe('https://juicebox.center/v1/intents');
    expect(options?.method).toBe('POST');

    await expect(
      client.publishIntent({
        ...ENVELOPE,
        publisher: '0x4444444444444444444444444444444444444444',
        signature,
      } as never),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('asks Center for a subset of chains and sends no chainIds when none are named', async () => {
    const page = {
      deploys: [
        {
          chainId: 8453,
          status: 'queued',
          transactionHash: null,
          bundleUuid: null,
          error: null,
          createdAt: '2026-09-22T00:00:00Z',
          updatedAt: '2026-09-22T00:00:00Z',
        },
      ],
    };
    const request = vi.fn<typeof fetchJson>().mockResolvedValue(page);
    const center = new CenterClient({ fetchJson: request });
    await expect(center.requestDeploy(ID, [8453])).resolves.toEqual(page);
    expect(request.mock.calls[0]?.[1]?.body).toEqual({ chainIds: [8453] });
    await center.requestDeploy(ID);
    expect(request.mock.calls[1]?.[1]?.body).toEqual({});
    await expect(center.requestDeploy(ID, [0])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(center.requestDeploy(ID, [])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('turns a wallet-deployed chain into a terminal refusal', async () => {
    const request = vi.fn<typeof fetchJson>().mockRejectedValue(
      new DomainError('UPSTREAM_HTTP_ERROR', 'refused', {
        details: { status: 409, code: 'mixed_sender' },
      }),
    );
    const center = new CenterClient({ fetchJson: request });
    await expect(center.requestDeploy(ID)).rejects.toMatchObject({
      code: 'NOT_SPONSORABLE',
      message: CENTER_DEPLOY_REFUSALS.MIXED_SENDER,
      retryable: false,
    });
  });
});
