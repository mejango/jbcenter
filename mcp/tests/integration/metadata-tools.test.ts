import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServices } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { createMetadataTools } from '../../src/mcp/metadata-tools.js';
import { ProjectMetadataService } from '../../src/services/metadata.js';

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
    services.metadata = new ProjectMetadataService({
      secret: SECRET,
      audience: 'https://juicebox.center/mcp',
      pinJson,
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
    ).toEqual(['jb_pin_project_metadata']);
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
  });
});
