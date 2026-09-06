import { createHash, createHmac } from 'node:crypto';
import { CID as ParsedCid } from 'multiformats/cid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withRequestBudget } from '../../src/domain/context.js';
import { publicError } from '../../src/domain/errors.js';
import { canonicalJson } from '../../src/domain/json.js';
import {
  ProjectMetadataService,
  type PinProjectMetadataJson,
} from '../../src/services/metadata.js';

const SECRET = 'metadata-tests-only-secret-'.repeat(3);
const AUDIENCE = 'https://juicebox.center/mcp';
const CID = 'QmYwAPJzv5CZsnAzt8auVZRnGi6FeDxhRFPKtfFA2ux8SA';
const NOW = Date.parse('2026-09-06T12:00:00.000Z');
const input = {
  version: 6 as const,
  metadata: { name: 'A new project', description: 'A complete reviewed description.' },
};
function service(
  options: {
    pinJson?: PinProjectMetadataJson;
    now?: () => number;
    audience?: string;
    secret?: string;
  } = {},
) {
  return new ProjectMetadataService({
    secret: SECRET,
    audience: AUDIENCE,
    now: () => NOW,
    ...options,
  });
}
const successfulPin = () =>
  vi.fn<PinProjectMetadataJson>(async () => ({ cid: CID, status: 'queued' }));

afterEach(() => vi.unstubAllGlobals());

describe('V6 metadata review and public publication', () => {
  it('prepares complete deterministic reviewed bytes without fetching or pinning linked content', () => {
    const pinJson = successfulPin();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('No network is authorized during preparation.');
      }),
    );
    const metadata = {
      infoUri: 'https://example.org/a#about',
      logoUri: `ipfs://${CID}/logo.svg`,
      description: 'Café 🌱\n"quoted" \\',
      name: '  Juíce  ',
    };
    const prepared = service({ pinJson }).prepare({ version: 6, metadata });
    const expected =
      '{"description":"Café 🌱\\n\\"quoted\\" \\\\","infoUri":"https://example.org/a#about","logoUri":"ipfs://' +
      CID +
      '/logo.svg","name":"  Juíce  "}';
    expect(prepared.review.jsonText).toBe(expected);
    expect(prepared.review.metadata).toEqual(metadata);
    expect(prepared.review.utf8Bytes).toBe(Buffer.byteLength(expected, 'utf8'));
    expect(prepared.review.utf8Bytes).toBeGreaterThan(expected.length);
    expect(prepared.review.contentSha256).toBe(
      createHash('sha256').update(expected, 'utf8').digest('hex'),
    );
    expect(prepared.publication).toMatchObject({
      configured: true,
      uploaded: false,
      requiresExplicitUserAuthorization: true,
      tokenEstablishesAuthorization: false,
      linkedContentFetched: false,
    });
    expect(JSON.parse(expected)).not.toHaveProperty('version');
    expect(pinJson).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('publishes exactly reviewed bytes and reports queued redundancy without claiming on-chain changes', async () => {
    const pinJson = successfulPin();
    const metadataService = service({ pinJson });
    const prepared = metadataService.prepare(input);
    prepared.review.metadata.name = 'A later UI edit';
    const result = await metadataService.pin({ token: prepared.token, confirmPublicUpload: true });
    expect(pinJson).toHaveBeenCalledExactlyOnceWith(prepared.review.jsonText, undefined);
    expect(result).toMatchObject({
      version: 6,
      cid: CID,
      metadataUri: `ipfs://${CID}`,
      contentSha256: prepared.review.contentSha256,
      utf8Bytes: prepared.review.utf8Bytes,
      publication: {
        primaryUploadAcknowledged: true,
        redundancyStatus: 'queued',
        retrievedContentVerified: false,
        linkedContentFetched: false,
        onchainTransactionSubmitted: false,
      },
    });
  });

  it('accepts equivalent key ordering without changing content commitment', () => {
    const metadataService = service();
    const first = metadataService.prepare(input);
    const second = metadataService.prepare({
      metadata: { description: input.metadata.description, name: input.metadata.name },
      version: 6,
    });
    expect(first.token).toBe(second.token);
    expect(first.review).toEqual(second.review);
  });

  it('accepts actual canonical CIDv1 references and pinning receipts', async () => {
    const cid = ParsedCid.parse(CID).toV1().toString();
    const metadataService = service({ pinJson: async () => ({ cid, status: 'queued' }) });
    const prepared = metadataService.prepare({
      ...input,
      metadata: { ...input.metadata, logoUri: `ipfs://${cid}/logo.svg` },
    });
    expect(
      (await metadataService.pin({ token: prepared.token, confirmPublicUpload: true })).metadataUri,
    ).toBe(`ipfs://${cid}`);
  });

  it('requires explicit V6 and refuses unsupported or reserved metadata fields', () => {
    const metadataService = service();
    for (const invalid of [
      { ...input, version: 4 },
      { metadata: input.metadata },
      { ...input, metadata: { ...input.metadata, archived: true } },
      { ...input, metadata: { ...input.metadata, version: 6 } },
      { ...input, metadata: JSON.parse('{"name":"A","description":"B","__proto__":{"hidden":1}}') },
    ])
      expect(() => metadataService.prepare(invalid)).toThrow();
  });

  it.each([
    'ipfs://<IMAGE_CID>',
    'ipfs://Qm' + '1'.repeat(44),
    `ipfs://${CID}/../logo.png`,
    `ipfs://${CID}/a?x=1`,
    'https://user:secret@example.org/logo.png',
    'https://example.org/ bad.png',
    'https://example.org\\@attacker.example/a',
    'javascript:alert(1)',
    'data:image/png;base64,aGVsbG8=',
    'file:///tmp/logo.png',
    'http://example.org/logo.png',
    'https://',
  ])('rejects malformed, active, local or credential-bearing URI %s', (logoUri) => {
    expect(() =>
      service().prepare({ ...input, metadata: { ...input.metadata, logoUri } }),
    ).toThrow();
  });

  it('enforces actual serialized UTF-8 byte size rather than JavaScript character count', () => {
    expect(() =>
      service().prepare({ ...input, metadata: { name: 'A', description: '🌱'.repeat(16384) } }),
    ).toThrow(expect.objectContaining({ code: 'METADATA_TOO_LARGE' }));
    const valid = service().prepare({
      ...input,
      metadata: { name: 'A', description: '🌱'.repeat(16000) },
    });
    expect(valid.review.utf8Bytes).toBeLessThanOrEqual(65536);
    expect(valid.review.jsonText.length).toBeLessThan(valid.review.utf8Bytes);
    expect(() =>
      service().prepare({ ...input, metadata: { name: '\ud800', description: '' } }),
    ).toThrow();
  });

  it('requires a true explicit publication confirmation and accepts no replacement document at pin time', async () => {
    const pinJson = successfulPin();
    const metadataService = service({ pinJson });
    const { token } = metadataService.prepare(input);
    for (const invalid of [
      { token },
      { token, confirmPublicUpload: false },
      { token, confirmPublicUpload: 'true' },
      { token, confirmPublicUpload: true, metadata: input.metadata },
    ])
      await expect(metadataService.pin(invalid)).rejects.toThrow();
    expect(pinJson).not.toHaveBeenCalled();
  });

  it('rejects content, signature, prefix and base64 changes before publication', async () => {
    const pinJson = successfulPin();
    const metadataService = service({ pinJson });
    const { token } = metadataService.prepare(input);
    const [prefix, payload, signature] = token.split('.') as [string, string, string];
    const envelope = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    envelope.metadata.name = 'An unreviewed name';
    const alteredPayload = Buffer.from(canonicalJson(envelope)).toString('base64url');
    for (const invalid of [
      `${prefix}.${alteredPayload}.${signature}`,
      `${prefix}.${payload}.${'A'.repeat(43)}`,
      `jbplan1.${payload}.${signature}`,
      `${token}.extra`,
      `${prefix}.${payload}=.${signature}`,
    ])
      await expect(
        metadataService.pin({ token: invalid, confirmPublicUpload: true }),
      ).rejects.toMatchObject({ code: 'INVALID_METADATA_TOKEN' });
    expect(pinJson).not.toHaveBeenCalled();
  });

  it('binds tokens to the server audience and secret and domain-separates them from plan-secret signatures', async () => {
    const pinJson = successfulPin();
    const { token } = service().prepare(input);
    for (const other of [
      service({ pinJson, secret: SECRET + 'different' }),
      service({ pinJson, audience: 'https://another.example/mcp' }),
    ])
      await expect(other.pin({ token, confirmPublicUpload: true })).rejects.toMatchObject({
        code: 'INVALID_METADATA_TOKEN',
      });
    const [prefix, payload] = token.split('.') as [string, string];
    const rawSecretSignature = createHmac('sha256', SECRET)
      .update(`${prefix}.${payload}`)
      .digest('base64url');
    await expect(
      service({ pinJson }).pin({
        token: `${prefix}.${payload}.${rawSecretSignature}`,
        confirmPublicUpload: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_METADATA_TOKEN' });
    expect(pinJson).not.toHaveBeenCalled();
  });

  it('expires at the exact review deadline and rejects future-issued tokens', async () => {
    let clock = NOW;
    const pinJson = successfulPin();
    const metadataService = new ProjectMetadataService({
      secret: SECRET,
      audience: AUDIENCE,
      ttlSeconds: 30,
      now: () => clock,
      pinJson,
    });
    const { token } = metadataService.prepare(input);
    clock = NOW + 30_000;
    await expect(metadataService.pin({ token, confirmPublicUpload: true })).rejects.toMatchObject({
      code: 'METADATA_TOKEN_EXPIRED',
    });
    clock = NOW - 1;
    await expect(metadataService.pin({ token, confirmPublicUpload: true })).rejects.toMatchObject({
      code: 'INVALID_METADATA_TOKEN',
    });
    expect(pinJson).not.toHaveBeenCalled();
  });

  it('reports missing backend configuration with an actionable hosted workflow', async () => {
    const metadataService = service();
    const prepared = metadataService.prepare(input);
    expect(prepared.publication.configured).toBe(false);
    expect(prepared.publication.availability).toContain('https://juicebox.center/mcp');
    await expect(
      metadataService.pin({ token: prepared.token, confirmPublicUpload: true }),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('does not leak provider details or promise rollback when publication fails partway through', async () => {
    const metadataService = service({
      pinJson: async () => {
        throw new Error('https://user:secret@provider.example?token=private');
      },
    });
    const { token } = metadataService.prepare(input);
    const error = await metadataService
      .pin({ token, confirmPublicUpload: true })
      .catch(publicError);
    expect(error).toMatchObject({
      code: 'METADATA_PUBLICATION_UNVERIFIED',
      retryable: false,
      details: { publicUploadMayHaveOccurred: true },
    });
    expect(JSON.stringify(error)).not.toContain('private');
    expect(JSON.stringify(error)).not.toContain('user:secret');
  });

  it.each([
    { cid: 'not-a-cid', status: 'queued' },
    { cid: CID, status: 'pinned' },
    { cid: `${CID}/file`, status: 'queued' },
  ])('refuses an invalid publication receipt: %j', async (receipt) => {
    const metadataService = service({
      pinJson: async () => receipt as Awaited<ReturnType<PinProjectMetadataJson>>,
    });
    const { token } = metadataService.prepare(input);
    await expect(metadataService.pin({ token, confirmPublicUpload: true })).rejects.toMatchObject({
      code: 'METADATA_PUBLICATION_UNVERIFIED',
      details: { publicUploadMayHaveOccurred: true },
    });
  });

  it('shares the upstream budget and cancellation context and never starts an already canceled upload', async () => {
    const pinJson = successfulPin();
    const metadataService = service({ pinJson });
    const { token } = metadataService.prepare(input);
    const controller = new AbortController();
    await withRequestBudget(
      () => metadataService.pin({ token, confirmPublicUpload: true }),
      controller.signal,
      1,
    );
    expect(pinJson).toHaveBeenCalledWith(expect.any(String), controller.signal);
    pinJson.mockClear();
    controller.abort();
    await expect(
      withRequestBudget(
        () => metadataService.pin({ token, confirmPublicUpload: true }),
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(
      withRequestBudget(
        () => metadataService.pin({ token, confirmPublicUpload: true }),
        undefined,
        0,
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_BUDGET_EXCEEDED' });
    expect(pinJson).not.toHaveBeenCalled();
  });

  it('does not claim replay protection and republishes only the same sealed document when deliberately called again', async () => {
    const pinJson = successfulPin();
    const metadataService = service({ pinJson });
    const prepared = metadataService.prepare(input);
    await metadataService.pin({ token: prepared.token, confirmPublicUpload: true });
    await metadataService.pin({ token: prepared.token, confirmPublicUpload: true });
    expect(pinJson).toHaveBeenCalledTimes(2);
    expect(pinJson.mock.calls[0]).toEqual(pinJson.mock.calls[1]);
  });

  it('rejects unsafe secret and review-lifetime configuration', () => {
    expect(() => service({ secret: 'short' })).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG' }),
    );
    for (const ttlSeconds of [29, 601, 1.5])
      expect(
        () => new ProjectMetadataService({ secret: SECRET, audience: AUDIENCE, ttlSeconds }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});
