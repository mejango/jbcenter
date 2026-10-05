import { createHash } from 'node:crypto';
import { decodeEncodedIpfsUri } from '@bananapus/nana-sdk-core';
import { CID } from 'multiformats/cid';
import { create as createDigest } from 'multiformats/hashes/digest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withRequestBudget } from '../../src/domain/context.js';
import { publicError } from '../../src/domain/errors.js';
import { canonicalJson } from '../../src/domain/json.js';
import {
  MAX_PROJECT_METADATA_BYTES,
  prepareNftMetadataSchema,
  ProjectMetadataService,
  type PinProjectMetadataJson,
} from '../../src/services/metadata.js';

const SECRET = 'nft-metadata-tests-only-secret-'.repeat(3);
const AUDIENCE = 'https://juicebox.center/mcp';
const CID_V0 = 'QmYwAPJzv5CZsnAzt8auVZRnGi6FeDxhRFPKtfFA2ux8SA';
const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const input = {
  version: 6 as const,
  metadata: {
    name: 'Squeeze tier',
    description: 'Café 🌱\n"quoted"',
    image: `ipfs://${CID_V0}/image.svg`,
    animation_url: 'https://example.org/animation',
    attributes: [{ trait_type: 'Squeeze', value: 42 }],
    properties: { files: [{ uri: 'ar://example', type: 'video/mp4' }], enabled: true },
    custom: { values: [null, false, 0, '', [], {}] },
  },
};

function service(options: Partial<ConstructorParameters<typeof ProjectMetadataService>[0]> = {}) {
  return new ProjectMetadataService({
    secret: SECRET,
    audience: AUDIENCE,
    now: () => NOW,
    ...options,
  });
}
const successfulPin = (cid = CID_V0) =>
  vi.fn<PinProjectMetadataJson>(async () => ({ cid, status: 'queued' }));

afterEach(() => vi.unstubAllGlobals());

describe('NFT metadata review and publication', () => {
  it('preserves all NFT fields and publishes exactly the immutable reviewed bytes', async () => {
    const pinJson = successfulPin();
    const metadataService = service({ pinJson });
    const prepared = metadataService.prepareNft(input);
    const expected = canonicalJson(input.metadata);
    expect(prepared.review.metadata).toEqual(input.metadata);
    expect(prepared.review.jsonText).toBe(expected);
    expect(prepared.review.utf8Bytes).toBe(Buffer.byteLength(expected));
    expect(prepared.review.contentSha256).toBe(createHash('sha256').update(expected).digest('hex'));
    expect(prepared.publication.nextStep.tool).toBe('jb_pin_nft_metadata');
    expect(prepared.publication.tokenEstablishesAuthorization).toBe(false);
    prepared.review.metadata.name = 'Unreviewed edit';
    const result = await metadataService.pinNft({
      token: prepared.token,
      confirmPublicUpload: true,
    });
    expect(pinJson).toHaveBeenCalledExactlyOnceWith(expected, undefined);
    expect(result).toMatchObject({
      cid: CID_V0,
      metadataUri: `ipfs://${CID_V0}`,
      contentSha256: prepared.review.contentSha256,
      utf8Bytes: prepared.review.utf8Bytes,
      publication: {
        primaryUploadAcknowledged: true,
        redundancyStatus: 'queued',
        retrievedContentVerified: false,
        linkedContentFetched: false,
        onchainTransactionSubmitted: false,
      },
      tierEncoding: { supported: true, cidV0: CID_V0 },
    });
    expect(result.tierEncoding.supported).toBe(true);
    if (result.tierEncoding.supported)
      expect(decodeEncodedIpfsUri(result.tierEncoding.encodedIpfsUri)).toBe(CID_V0);
  });

  it('does not impose project fields, drop extensions, fetch URLs or render active content', async () => {
    const fetch = vi.fn(() => {
      throw new Error('No network authorized.');
    });
    vi.stubGlobal('fetch', fetch);
    const pinJson = successfulPin();
    const metadataService = service({ pinJson });
    const metadata = {
      image: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
      animation_url: 'https://127.0.0.1/private',
      external_url: 'javascript:alert(1)',
      image_data: '<svg><script>untrusted</script></svg>',
      custom: { 'extension/name': 'ar://some-other-format' },
    };
    const prepared = metadataService.prepareNft({ version: 6, metadata });
    expect(prepared.review.metadata).toEqual(metadata);
    expect(prepared.warnings.join(' ')).toContain('not fetched, rendered');
    await metadataService.pinNft({ token: prepared.token, confirmPublicUpload: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(pinJson).toHaveBeenCalledExactlyOnceWith(canonicalJson(metadata), undefined);
    expect(metadataService.prepareNft({ version: 6, metadata: {} }).review.jsonText).toBe('{}');
  });

  it('binds project and NFT review tokens to separate purposes, even for identical documents', async () => {
    const pinJson = successfulPin();
    const metadataService = service({ pinJson });
    const shared = { version: 6, metadata: { name: 'A', description: 'B' } };
    const project = metadataService.prepare(shared);
    const nft = metadataService.prepareNft(shared);
    expect(project.review.jsonText).toBe(nft.review.jsonText);
    expect(project.token).not.toBe(nft.token);
    await expect(
      metadataService.pinNft({ token: project.token, confirmPublicUpload: true }),
    ).rejects.toMatchObject({ code: 'INVALID_METADATA_TOKEN' });
    await expect(
      metadataService.pin({ token: nft.token, confirmPublicUpload: true }),
    ).rejects.toMatchObject({ code: 'INVALID_METADATA_TOKEN' });
    expect(pinJson).not.toHaveBeenCalled();
  });

  it('rejects token tampering, wrong audience and secret, expiry and future issuance before upload', async () => {
    const pinJson = successfulPin();
    const metadataService = service({ pinJson });
    const { token } = metadataService.prepareNft(input);
    const [prefix, payload, signature] = token.split('.') as [string, string, string];
    const envelope = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    envelope.metadata.attributes[0].value = 100;
    for (const invalid of [
      `${prefix}.${Buffer.from(canonicalJson(envelope)).toString('base64url')}.${signature}`,
      `${prefix}.${payload}.${'A'.repeat(43)}`,
      `${prefix}.${payload}=.${signature}`,
      `jbplan1.${payload}.${signature}`,
      `${token}.extra`,
    ])
      await expect(
        metadataService.pinNft({ token: invalid, confirmPublicUpload: true }),
      ).rejects.toMatchObject({ code: 'INVALID_METADATA_TOKEN' });
    for (const options of [
      { secret: SECRET + 'other' },
      { audience: 'https://other.example/mcp' },
      { now: () => NOW - 1 },
    ])
      await expect(
        service({ pinJson, ...options }).pinNft({ token, confirmPublicUpload: true }),
      ).rejects.toMatchObject({ code: 'INVALID_METADATA_TOKEN' });
    await expect(
      service({ pinJson, now: () => NOW + 600_000 }).pinNft({ token, confirmPublicUpload: true }),
    ).rejects.toMatchObject({ code: 'METADATA_TOKEN_EXPIRED' });
    expect(pinJson).not.toHaveBeenCalled();
  });

  it.each([null, [], 'text', 42, true])('requires a JSON object as root: %j', (metadata) => {
    expect(() => service().prepareNft({ version: 6, metadata })).toThrow();
  });

  it('requires explicit V6 and explicit public upload authorization, with no replacement document', async () => {
    const pinJson = successfulPin();
    const metadataService = service({ pinJson });
    for (const invalid of [
      { metadata: input.metadata },
      { ...input, version: 5 },
      { ...input, unexpected: true },
    ])
      expect(() => metadataService.prepareNft(invalid)).toThrow();
    const { token } = metadataService.prepareNft(input);
    for (const invalid of [
      { token },
      { token, confirmPublicUpload: false },
      { token, confirmPublicUpload: 'true' },
      { token, confirmPublicUpload: true, metadata: input.metadata },
    ])
      await expect(metadataService.pinNft(invalid)).rejects.toThrow();
    expect(pinJson).not.toHaveBeenCalled();
  });

  it('rejects non-JSON values, hidden or reserved keys and unpaired Unicode without modifying them', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const arrayWithExtra = Object.assign([1], { extra: true });
    const hidden = Object.defineProperty({}, 'hidden', { value: 'not serialized' });
    const accessor = Object.defineProperty({}, 'getter', {
      get: () => 'not plain',
      enumerable: true,
    });
    for (const bad of [
      undefined,
      NaN,
      Infinity,
      -Infinity,
      1n,
      () => 1,
      Symbol('value'),
      new Date(),
      new Map(),
      new (class {
        value = 1;
      })(),
      { [Symbol('key')]: 'hidden' },
      hidden,
      accessor,
      arrayWithExtra,
      new Array(2),
      cyclic,
      { bad: '\ud800' },
      { '\udfff': 'bad key' },
      JSON.parse('{"__proto__":{"hidden":1}}'),
      { constructor: 'reserved' },
      { prototype: 'reserved' },
    ]) {
      const candidate = { version: 6, metadata: { attributes: [bad] } };
      expect(() => service().prepareNft(candidate)).toThrow();
      expect(prepareNftMetadataSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it('enforces the shared depth guard and exact canonical UTF-8 limit', async () => {
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 65; index++) deep = { child: deep };
    expect(() => service().prepareNft({ version: 6, metadata: deep })).toThrow(
      expect.objectContaining({ code: 'JSON_LIMIT_EXCEEDED' }),
    );
    expect(() =>
      service().prepareNft({ version: 6, metadata: { text: '🌱'.repeat(16_384) } }),
    ).toThrow(expect.objectContaining({ code: 'METADATA_TOO_LARGE' }));
    const metadata = {
      text: 'x'.repeat(MAX_PROJECT_METADATA_BYTES - Buffer.byteLength('{"text":""}')),
    };
    const pinJson = successfulPin();
    const metadataService = service({ pinJson });
    const prepared = metadataService.prepareNft({ version: 6, metadata });
    expect(prepared.review.utf8Bytes).toBe(MAX_PROJECT_METADATA_BYTES);
    await metadataService.pinNft({ token: prepared.token, confirmPublicUpload: true });
    expect(pinJson).toHaveBeenCalledExactlyOnceWith(prepared.review.jsonText, undefined);
    expect(() =>
      metadataService.prepareNft({ version: 6, metadata: { text: metadata.text + 'x' } }),
    ).toThrow(expect.objectContaining({ code: 'METADATA_TOO_LARGE' }));
  });

  it('normalizes a compatible CIDv1 for tier encoding while retaining the original publication CID', async () => {
    const cid = CID.parse(CID_V0).toV1().toString();
    const metadataService = service({ pinJson: successfulPin(cid) });
    const { token } = metadataService.prepareNft(input);
    const result = await metadataService.pinNft({ token, confirmPublicUpload: true });
    expect(result).toMatchObject({
      cid,
      metadataUri: `ipfs://${cid}`,
      tierEncoding: { supported: true, cidV0: CID_V0 },
    });
  });

  it.each([
    CID.createV1(0x55, CID.parse(CID_V0).multihash).toString(),
    CID.createV1(0x70, createDigest(0x13, new Uint8Array(64).fill(1))).toString(),
    CID.createV1(0x70, createDigest(0x12, new Uint8Array(31).fill(1))).toString(),
    CID.createV0(createDigest(0x12, new Uint8Array(32))).toString(),
  ])('keeps the public receipt for CID incompatible with static tier encoding: %s', async (cid) => {
    const metadataService = service({ pinJson: successfulPin(cid) });
    const { token } = metadataService.prepareNft(input);
    const result = await metadataService.pinNft({ token, confirmPublicUpload: true });
    expect(result).toMatchObject({
      cid,
      metadataUri: `ipfs://${cid}`,
      publication: { primaryUploadAcknowledged: true },
      tierEncoding: { supported: false, reason: expect.any(String) },
    });
    expect(result.tierEncoding).not.toHaveProperty('encodedIpfsUri');
  });

  it('reports unconfigured and ambiguous publication without provider details or false rollback claims', async () => {
    const notConfigured = service();
    const prepared = notConfigured.prepareNft(input);
    expect(prepared.publication.configured).toBe(false);
    await expect(
      notConfigured.pinNft({ token: prepared.token, confirmPublicUpload: true }),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    for (const pinJson of [
      async () => {
        throw new Error('https://user:secret@provider.example/private');
      },
      async () => ({ cid: 'not-a-cid', status: 'queued' as const }),
      async () => ({ cid: CID_V0, status: 'pinned' }),
    ]) {
      const metadataService = service({ pinJson: pinJson as PinProjectMetadataJson });
      const { token } = metadataService.prepareNft(input);
      const error = await metadataService
        .pinNft({ token, confirmPublicUpload: true })
        .catch(publicError);
      expect(error).toMatchObject({
        code: 'METADATA_PUBLICATION_UNVERIFIED',
        retryable: false,
        details: { publicUploadMayHaveOccurred: true },
      });
      expect(JSON.stringify(error)).not.toContain('private');
      expect(JSON.stringify(error)).not.toContain('user:secret');
    }
  });

  it('shares the pin backend and request budget with project metadata, including cancellation', async () => {
    const pinJson = successfulPin();
    const metadataService = service({ pinJson });
    const nft = metadataService.prepareNft(input);
    const project = metadataService.prepare({
      version: 6,
      metadata: { name: 'A', description: 'B' },
    });
    const controller = new AbortController();
    await withRequestBudget(
      async () => {
        await metadataService.pin({ token: project.token, confirmPublicUpload: true });
        await expect(
          metadataService.pinNft({ token: nft.token, confirmPublicUpload: true }),
        ).rejects.toMatchObject({ code: 'REQUEST_BUDGET_EXCEEDED' });
      },
      controller.signal,
      1,
    );
    expect(pinJson).toHaveBeenCalledTimes(1);
    pinJson.mockClear();
    controller.abort();
    await expect(
      withRequestBudget(
        () => metadataService.pinNft({ token: nft.token, confirmPublicUpload: true }),
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(pinJson).not.toHaveBeenCalled();
  });
});
