import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServices } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { createMetadataTools } from '../../src/mcp/metadata-tools.js';
import { ProjectMetadataService, type PinProjectLogo } from '../../src/services/metadata.js';

const SECRET = 'metadata-protocol-tests-only-'.repeat(3);
const CID = 'QmYwAPJzv5CZsnAzt8auVZRnGi6FeDxhRFPKtfFA2ux8SA';
let client: Client | undefined;
let server: McpServer | undefined;
afterEach(async () => {
  await client?.close();
  await server?.close();
});

describe('metadata MCP publication boundary', () => {
  it('marks only explicit publication as a non-idempotent write and explains public authorization', () => {
    const tools = createMetadataTools(
      new ProjectMetadataService({ secret: SECRET, audience: 'test-metadata' }),
    );
    const prepare = tools.find((tool) => tool.name === 'jb_prepare_project_metadata')!;
    const pin = tools.find((tool) => tool.name === 'jb_pin_project_metadata')!;
    expect(prepare.annotations?.readOnlyHint).not.toBe(false);
    expect(pin.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    expect(pin.description).toContain('explicit user authorization');
    expect(pin.description).toContain('prepare token alone is not approval');
    expect(() =>
      prepare.schema.parse({ version: 4, metadata: { name: 'A', description: 'B' } }),
    ).toThrow();
    expect(() => pin.schema.parse({ token: 'anything', confirmPublicUpload: false })).toThrow();
  });

  it('rejects reserved metadata keys before a tool parser can silently remove them', async () => {
    const prepare = createMetadataTools(
      new ProjectMetadataService({ secret: SECRET, audience: 'test-metadata' }),
    )[0]!;
    await expect(
      prepare.run({
        version: 6,
        metadata: JSON.parse('{"name":"A","description":"B","__proto__":{"unexpected":1}}'),
      }),
    ).rejects.toThrow();
  });

  it('advertises real write annotations and round-trips exact reviewed bytes over the official MCP protocol', async () => {
    const services = createServices(
      loadConfig({ PLAN_SECRET: SECRET, PUBLIC_ORIGIN: 'https://juicebox.center' }),
    );
    const pinJson = vi.fn(async (_jsonText: string) => ({ cid: CID, status: 'queued' as const }));
    const pinLogo = vi.fn(async () => ({ cid: CID, status: 'queued' as const }));
    services.metadata = new ProjectMetadataService({
      secret: SECRET,
      audience: 'https://juicebox.center/mcp',
      pinJson,
      pinLogo,
    });
    server = createMcpServer(services);
    client = new Client({ name: 'metadata-test', version: '1.0.0' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    expect(
      listed.tools.find((tool) => tool.name === 'jb_pin_project_metadata')?.annotations,
    ).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    expect(
      listed.tools.find((tool) => tool.name === 'jb_prepare_project_metadata')?.annotations
        ?.readOnlyHint,
    ).toBe(true);
    expect(
      listed.tools
        .filter((tool) => tool.annotations?.readOnlyHint === false)
        .map((tool) => tool.name),
    ).toEqual([
      'jb_pin_project_logo',
      'jb_pin_project_metadata',
      'jb_publish_intent',
      'jb_deploy_intent',
    ]);
    const prepared = await client.callTool({
      name: 'jb_prepare_project_metadata',
      arguments: {
        version: 6,
        metadata: { name: 'Test 🌱', description: 'An explicitly reviewed public document.' },
      },
    });
    expect(prepared.isError).not.toBe(true);
    const data = (
      prepared.structuredContent as { data: { token: string; review: { jsonText: string } } }
    ).data;
    expect(pinJson).not.toHaveBeenCalled();
    const rejected = await client.callTool({
      name: 'jb_pin_project_metadata',
      arguments: { token: data.token, confirmPublicUpload: false },
    });
    expect(rejected.isError).toBe(true);
    const pinned = await client.callTool({
      name: 'jb_pin_project_metadata',
      arguments: { token: data.token, confirmPublicUpload: true },
    });
    expect(pinned.structuredContent).toMatchObject({
      ok: true,
      data: { metadataUri: `ipfs://${CID}`, version: 6 },
    });
    expect(pinJson.mock.calls[0]?.[0]).toBe(data.review.jsonText);
    const logo = await client.callTool({
      name: 'jb_pin_project_logo',
      arguments: { contentType: 'image/png', imageBase64: PNG_1X1, confirmPublicUpload: true },
    });
    expect(logo.structuredContent).toMatchObject({
      ok: true,
      data: { logoUri: `ipfs://${CID}`, contentType: 'image/png' },
    });
    expect(pinLogo).toHaveBeenCalledOnce();
  });
});

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const svg = (markup: string) => Buffer.from(markup, 'utf8').toString('base64');

describe('logo pinning', () => {
  const service = (pinLogo?: ReturnType<typeof vi.fn>) =>
    new ProjectMetadataService({
      secret: SECRET,
      audience: 'https://example.test/mcp',
      ...(pinLogo ? { pinLogo: pinLogo as never } : {}),
    });

  it('accepts only ipfs:// logos in metadata and points HTTPS at the logo tool', () => {
    const prepare = createMetadataTools(service())[1]!;
    expect(prepare.name).toBe('jb_prepare_project_metadata');
    const base = { version: 6, metadata: { name: 'A', description: 'B' } };
    expect(() =>
      prepare.schema.parse({ ...base, metadata: { ...base.metadata, logoUri: `ipfs://${CID}` } }),
    ).not.toThrow();
    expect(() =>
      prepare.schema.parse({
        ...base,
        metadata: { ...base.metadata, logoUri: 'https://example.test/logo.png' },
      }),
    ).toThrow(/jb_pin_project_logo/u);
    expect(() =>
      prepare.schema.parse({
        ...base,
        metadata: { ...base.metadata, infoUri: 'https://example.test' },
      }),
    ).not.toThrow();
  });

  it('pins sniffed bytes and returns the ipfs:// logoUri without any domain', async () => {
    const pinLogo = vi.fn(async () => ({ cid: CID, status: 'queued' as const }));
    const result = await service(pinLogo).pinLogo({
      contentType: 'image/png',
      imageBase64: PNG_1X1,
      confirmPublicUpload: true,
    });
    expect(result).toMatchObject({
      logoUri: `ipfs://${CID}`,
      contentType: 'image/png',
      bytes: Buffer.from(PNG_1X1, 'base64').length,
      nextStep: { field: 'metadata.logoUri', value: `ipfs://${CID}` },
    });
    expect(JSON.stringify(result)).not.toContain('example.test');
    const [image] = pinLogo.mock.calls[0] as unknown as [
      { bytes: Uint8Array; contentType: string; filename: string },
    ];
    expect(Buffer.from(image.bytes).toString('base64')).toBe(PNG_1X1);
    expect(image).toMatchObject({ contentType: 'image/png', filename: 'logo.png' });
  });

  it('rejects mismatched types, active SVG, non-canonical base64 and oversize images before upload', async () => {
    const pinLogo = vi.fn(async () => ({ cid: CID, status: 'queued' as const }));
    const attempt = (input: Record<string, unknown>) =>
      service(pinLogo).pinLogo({ confirmPublicUpload: true, ...input });
    await expect(attempt({ contentType: 'image/gif', imageBase64: PNG_1X1 })).rejects.toThrow(
      /match the declared type/u,
    );
    await expect(
      attempt({
        contentType: 'image/svg+xml',
        imageBase64: svg('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
      }),
    ).rejects.toThrow(/inert/u);
    await expect(
      attempt({
        contentType: 'image/svg+xml',
        imageBase64: svg('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'),
      }),
    ).resolves.toMatchObject({ contentType: 'image/svg+xml' });
    await expect(attempt({ contentType: 'image/png', imageBase64: 'iVBORw0K' })).rejects.toThrow();
    await expect(
      attempt({ contentType: 'image/png', imageBase64: `${PNG_1X1.slice(0, -2)}=A` }),
    ).rejects.toThrow();
    const oversize = Buffer.concat([
      Buffer.from(PNG_1X1, 'base64'),
      Buffer.alloc(1024 * 1024),
    ]).toString('base64');
    await expect(attempt({ contentType: 'image/png', imageBase64: oversize })).rejects.toThrow();
    expect(pinLogo).toHaveBeenCalledTimes(1);
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:script>window.active=true</s:script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:foreignObject/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:u\\72l(https://example.invalid/image)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect style="background-image:image-set(\'https://example.invalid/image\' 1x)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="u&#114;l(https://example.invalid/image)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="u\\72l(https://example.invalid/image)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="u&#92;72l(https://example.invalid/image)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a><animate attributeName="href" values="javascript:alert(1)"/></a></svg>',
    '<svg xmlns="http://www.w3.org/1999/xhtml"><form action="https://example.invalid"/></svg>',
  ])('rejects active SVG encodings and namespaces before publication: %s', async (markup) => {
    const pinLogo = vi.fn(async () => ({ cid: CID, status: 'queued' as const }));
    await expect(
      service(pinLogo).pinLogo({
        contentType: 'image/svg+xml',
        imageBase64: svg(markup),
        confirmPublicUpload: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    expect(pinLogo).not.toHaveBeenCalled();
  });

  it('retains passive SVG shapes, text references and namespace-qualified groups unchanged', async () => {
    const pinLogo = vi.fn<PinProjectLogo>(async () => ({ cid: CID, status: 'queued' }));
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:g><path style="fill:red;stroke:#fff" d="M0 0h10v10z"/><text>&#74;uice &amp; friends</text></s:g></svg>';
    await service(pinLogo).pinLogo({
      contentType: 'image/svg+xml',
      imageBase64: svg(markup),
      confirmPublicUpload: true,
    });
    expect(pinLogo.mock.calls[0]?.[0].bytes).toEqual(Buffer.from(markup));
  });

  it('reports an unverified publication instead of a fabricated CID', async () => {
    const pinLogo = vi.fn(async () => ({ cid: 'nope', status: 'queued' as const }));
    await expect(
      service(pinLogo).pinLogo({
        contentType: 'image/png',
        imageBase64: PNG_1X1,
        confirmPublicUpload: true,
      }),
    ).rejects.toMatchObject({ code: 'LOGO_PUBLICATION_UNVERIFIED' });
    await expect(
      service().pinLogo({
        contentType: 'image/png',
        imageBase64: PNG_1X1,
        confirmPublicUpload: true,
      }),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });
});
