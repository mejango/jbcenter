import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { CID } from 'multiformats/cid';
import { z } from 'zod';
import { consumeRequest } from '../domain/context.js';
import { DomainError } from '../domain/errors.js';
import { assertUnambiguousJson, canonicalJson } from '../domain/json.js';

export const MAX_PROJECT_METADATA_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 100 * 1024;
const MAX_ENVELOPE_BYTES = MAX_PROJECT_METADATA_BYTES + 4096;
const MAX_TTL_SECONDS = 600;
const PREFIX = 'jbmetadata1';
const PURPOSE = 'juicebox-v6-project-metadata-publication';
const KEY_DOMAIN = 'juicebox-mcp/project-metadata-pinning/key/v1';
const CID_ENVELOPE = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,160})$/u;

/** Match Center's supported canonical CIDv0/base32 CIDv1 representations. */
function isCanonicalCid(value: string): boolean {
  if (!CID_ENVELOPE.test(value)) return false;
  try {
    return CID.parse(value).toString() === value;
  } catch {
    return false;
  }
}

function isPublicMetadataUri(value: string): boolean {
  if (/\s|[\u0000-\u001f\u007f]/u.test(value)) return false;
  if (value.startsWith('ipfs://')) {
    const parts = value.slice('ipfs://'.length).split('/');
    return (
      value.length <= 512 + 'ipfs://'.length &&
      parts.length <= 8 &&
      isCanonicalCid(parts[0] ?? '') &&
      parts
        .slice(1)
        .every((part) => part !== '.' && part !== '..' && /^[A-Za-z0-9._~-]{1,128}$/u.test(part))
    );
  }
  if (!/^https:\/\//iu.test(value) || value.includes('\\')) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

const unicodeString = () =>
  z.string().refine((value) => Buffer.from(value, 'utf8').toString('utf8') === value, {
    message: 'Use valid Unicode text without unpaired surrogate code units.',
  });
const metadataUriSchema = unicodeString().max(2048).refine(isPublicMetadataUri, {
  message:
    'Use an absolute HTTPS URL without credentials, whitespace or backslashes, or ipfs:// followed by a real canonical CID and optional safe path. Placeholders and local files are unsupported.',
});

export const projectMetadataSchema = z
  .object({
    name: unicodeString()
      .min(1)
      .max(256)
      .refine((value) => value.trim().length > 0, 'Name must not be blank.'),
    description: unicodeString().max(MAX_PROJECT_METADATA_BYTES),
    logoUri: metadataUriSchema.optional(),
    infoUri: metadataUriSchema.optional(),
  })
  .strict();

export const prepareProjectMetadataSchema = z
  .object({
    version: z
      .literal(6)
      .describe(
        'Juicebox protocol version; this discriminator is not included in the metadata JSON.',
      ),
    metadata: z
      .preprocess((value, ctx) => {
        try {
          assertUnambiguousJson(value);
          return value;
        } catch {
          ctx.addIssue({
            code: 'custom',
            message:
              'Metadata must not contain reserved object keys. No altered review document will be produced.',
          });
          return z.NEVER;
        }
      }, projectMetadataSchema)
      .describe(
        'Complete new standard project metadata. This is not a merge with existing metadata. Images and URLs are never fetched or uploaded by this workflow.',
      ),
  })
  .strict();

export const pinProjectMetadataSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .max(MAX_TOKEN_BYTES)
      .describe(
        'Unexpired review token returned by jb_prepare_project_metadata; tokens do not establish user approval.',
      ),
    confirmPublicUpload: z
      .literal(true)
      .describe(
        'Set only after the user explicitly authorizes publishing the exact reviewed document publicly to IPFS. Publication may be permanent.',
      ),
  })
  .strict();

const timestampSchema = z
  .string()
  .datetime({ offset: false })
  .refine((value) => new Date(value).toISOString() === value);
const envelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal(PURPOSE),
    audience: z.string().min(1).max(2048),
    version: z.literal(6),
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    utf8Bytes: z.number().int().positive().max(MAX_PROJECT_METADATA_BYTES),
    metadata: projectMetadataSchema,
  })
  .strict();

type MetadataEnvelope = z.output<typeof envelopeSchema>;
export type PinProjectMetadataJson = (
  jsonText: string,
  signal?: AbortSignal,
) => Promise<{ cid: string; status: 'queued' }>;

function metadataBytes(metadata: z.output<typeof projectMetadataSchema>) {
  const jsonText = canonicalJson(metadata);
  const utf8Bytes = Buffer.byteLength(jsonText, 'utf8');
  if (utf8Bytes > MAX_PROJECT_METADATA_BYTES)
    throw new DomainError(
      'METADATA_TOO_LARGE',
      'The complete canonical metadata JSON exceeds the 64 KiB UTF-8 limit. Shorten the text or URLs before preparing it.',
    );
  return {
    jsonText,
    utf8Bytes,
    contentSha256: createHash('sha256').update(jsonText, 'utf8').digest('hex'),
  };
}

/** Stateless review commitments; actual publication is an explicitly authorized external mutation. */
export class ProjectMetadataService {
  private readonly key: Buffer;
  private readonly ttlSeconds: number;
  private readonly now: () => number;
  private readonly pinJson?: PinProjectMetadataJson;
  private readonly audience: string;

  constructor(options: {
    secret: string;
    audience: string;
    pinJson?: PinProjectMetadataJson;
    ttlSeconds?: number;
    now?: () => number;
  }) {
    if (Buffer.byteLength(options.secret, 'utf8') < 32)
      throw new DomainError(
        'INVALID_CONFIG',
        'Metadata token secret must contain at least 32 bytes.',
      );
    this.ttlSeconds = options.ttlSeconds ?? 600;
    if (
      !Number.isInteger(this.ttlSeconds) ||
      this.ttlSeconds < 30 ||
      this.ttlSeconds > MAX_TTL_SECONDS
    )
      throw new DomainError('INVALID_CONFIG', 'Metadata review lifetime must be 30–600 seconds.');
    this.key = createHmac('sha256', options.secret).update(KEY_DOMAIN).digest();
    this.audience = z.string().min(1).max(2048).parse(options.audience);
    this.pinJson = options.pinJson;
    this.now = options.now ?? Date.now;
  }

  prepare(input: unknown) {
    assertUnambiguousJson(input);
    const parsed = prepareProjectMetadataSchema.parse(input);
    const bytes = metadataBytes(parsed.metadata);
    const now = this.now();
    const envelope: MetadataEnvelope = {
      schemaVersion: 1,
      purpose: PURPOSE,
      audience: this.audience,
      version: 6,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlSeconds * 1000).toISOString(),
      contentSha256: bytes.contentSha256,
      utf8Bytes: bytes.utf8Bytes,
      metadata: parsed.metadata,
    };
    const payload = Buffer.from(canonicalJson(envelope), 'utf8').toString('base64url');
    const token = `${PREFIX}.${payload}.${this.signature(payload).toString('base64url')}`;
    return {
      version: 6 as const,
      token,
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
      review: {
        metadata: parsed.metadata,
        ...bytes,
        contentType: 'application/json; charset=utf-8',
        serialization:
          'Canonical JSON with sorted keys, no trailing newline, and no Unicode normalization.',
      },
      publication: {
        configured: this.pinJson !== undefined,
        uploaded: false,
        requiresExplicitUserAuthorization: true,
        tokenEstablishesAuthorization: false,
        visibility: 'public',
        removalGuaranteed: false,
        linkedContentFetched: false,
        linkedContentAvailabilityVerified: false,
        nextStep: {
          tool: 'jb_pin_project_metadata',
          instruction:
            'Show the user review.metadata and the public, potentially permanent upload consequence. After explicit authorization, pass this response’s token and confirmPublicUpload:true. Preparation alone is not approval. No wallet is needed to pin.',
        },
        availability: this.pinJson
          ? 'The integrated pinning backend is configured; publication still requires authorization and successful quota/provider checks.'
          : 'This server has no pinning backend. Connect to the hosted https://juicebox.center/mcp service and prepare the same reviewed metadata there before authorizing a pin; review tokens cannot be assumed portable between servers.',
      },
      warnings: [
        'This creates a new document containing only the displayed fields. It does not merge or preserve fields from an existing project metadata document.',
        'A logoUri references already hosted content. This workflow does not fetch, upload or pin the image itself; omit logoUri until a real image CID or HTTPS URL is available.',
        'Pinning does not launch or edit a project on-chain. Use the returned metadataUri in a separately reviewed V6 launch. Existing-project URI updates are not prepared by this workflow.',
      ],
    };
  }

  async pin(input: unknown) {
    assertUnambiguousJson(input);
    const parsed = pinProjectMetadataSchema.parse(input);
    const { envelope, bytes } = this.open(parsed.token);
    if (!this.pinJson)
      throw new DomainError(
        'NOT_CONFIGURED',
        'Public metadata pinning is not configured on this server. Prepare the same metadata through https://juicebox.center/mcp, review it, and authorize pinning there. No upload was attempted.',
      );
    const signal = consumeRequest();
    let result: Awaited<ReturnType<PinProjectMetadataJson>>;
    try {
      result = await this.pinJson(bytes.jsonText, signal);
      if (
        !result ||
        typeof result.cid !== 'string' ||
        !isCanonicalCid(result.cid) ||
        result.status !== 'queued'
      )
        throw new Error('Invalid pinning receipt.');
    } catch {
      throw new DomainError(
        'METADATA_PUBLICATION_UNVERIFIED',
        'The pinning operation did not return a valid completion receipt. Content may already be public; an automatic retry could repeat publication or consume quota. Inspect backend status before deliberately retrying.',
        {
          details: { publicUploadMayHaveOccurred: true, contentSha256: bytes.contentSha256 },
        },
      );
    }
    return {
      version: envelope.version,
      metadataUri: `ipfs://${result.cid}`,
      cid: result.cid,
      contentSha256: bytes.contentSha256,
      utf8Bytes: bytes.utf8Bytes,
      publication: {
        visibility: 'public',
        primaryUploadAcknowledged: true,
        redundancyStatus: result.status,
        removalGuaranteed: false,
        retrievedContentVerified: false,
        linkedContentFetched: false,
        onchainTransactionSubmitted: false,
      },
      launchInputs: [
        { tool: 'jb_prepare_launch', field: 'projectUri', value: `ipfs://${result.cid}` },
        { tool: 'jb_prepare_721_launch', field: 'projectUri', value: `ipfs://${result.cid}` },
        {
          tool: 'jb_prepare_revnet_deploy',
          field: 'config.description.uri',
          value: `ipfs://${result.cid}`,
        },
      ],
      nextStep:
        'Choose the intended V6 launch composition, use the indicated URI field, and complete its other typed inputs for a separate transaction review. Pinning itself has not changed any project. This workflow does not prepare existing-project URI updates.',
    };
  }

  private signature(payload: string): Buffer {
    return createHmac('sha256', this.key).update(`${PREFIX}.${payload}`, 'utf8').digest();
  }

  private open(token: string) {
    const fail = () =>
      new DomainError(
        'INVALID_METADATA_TOKEN',
        'The metadata review token is malformed, modified, or belongs to another server or workflow. Prepare the complete metadata again.',
      );
    const parts = token.split('.');
    const [prefix, payload, encodedSignature] = parts;
    if (
      parts.length !== 3 ||
      prefix !== PREFIX ||
      !payload ||
      !/^[A-Za-z0-9_-]+$/u.test(payload) ||
      !encodedSignature ||
      !/^[A-Za-z0-9_-]{43}$/u.test(encodedSignature)
    )
      throw fail();
    const signature = Buffer.from(encodedSignature, 'base64url');
    if (
      signature.length !== 32 ||
      signature.toString('base64url') !== encodedSignature ||
      !timingSafeEqual(signature, this.signature(payload))
    )
      throw fail();
    const encoded = Buffer.from(payload, 'base64url');
    if (encoded.length > MAX_ENVELOPE_BYTES || encoded.toString('base64url') !== payload)
      throw fail();
    let envelope: MetadataEnvelope;
    let bytes: ReturnType<typeof metadataBytes>;
    try {
      const jsonText = new TextDecoder('utf-8', { fatal: true }).decode(encoded);
      const value: unknown = JSON.parse(jsonText);
      assertUnambiguousJson(value);
      envelope = envelopeSchema.parse(value);
      if (canonicalJson(envelope) !== jsonText || envelope.audience !== this.audience) throw fail();
      bytes = metadataBytes(envelope.metadata);
      if (bytes.contentSha256 !== envelope.contentSha256 || bytes.utf8Bytes !== envelope.utf8Bytes)
        throw fail();
    } catch {
      throw fail();
    }
    const issuedAt = Date.parse(envelope.issuedAt);
    const expiresAt = Date.parse(envelope.expiresAt);
    const now = this.now();
    if (
      issuedAt > now ||
      expiresAt - issuedAt < 30_000 ||
      expiresAt - issuedAt > MAX_TTL_SECONDS * 1000
    )
      throw fail();
    if (expiresAt <= now)
      throw new DomainError(
        'METADATA_TOKEN_EXPIRED',
        'The metadata review expired. Prepare and review the complete document again before authorizing publication. No upload was attempted.',
      );
    return { envelope, bytes };
  }
}
