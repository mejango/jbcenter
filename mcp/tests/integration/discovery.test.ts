import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JBCenterSearchPage } from '@bananapus/nana-sdk-core/jbcenter';
import { createServices, type Services } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createMcpServer } from '../../src/mcp/server.js';

function intent(deploymentVersion: string): JBCenterSearchPage['items'][number] {
  return {
    source: 'jbcenter',
    status: 'undeployed',
    intentId: '12345678-1234-4123-8123-123456789abc',
    contentHash: `0x${'11'.repeat(32)}`,
    format: 'juicebox.money/v1',
    deploymentVersion,
    chainIds: [8453],
    publisher: '0x1111111111111111111111111111111111111111',
    createdAt: '2026-09-06T12:00:00.000Z',
    name: `Version ${deploymentVersion}`,
    description: null,
    tagline: null,
    tags: [],
    logoUri: null,
    owner: null,
  };
}

describe('V6-only discovery through MCP', () => {
  let server: McpServer;
  let client: Client;
  let services: Services;

  beforeEach(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Offline discovery tests must not use the network.');
      }),
    );
    services = createServices(
      loadConfig({
        PLAN_SECRET: 'test-only-secret-'.repeat(4),
        BENDYSTRAW_MAINNET_URL: 'https://indexer.example/graphql',
      }),
    );
    server = createMcpServer(services);
    client = new Client({ name: 'v6-discovery-test', version: '1.0.0' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client?.close();
    await server?.close();
    vi.unstubAllGlobals();
  });

  it('filters mixed Center versions without claiming its total count is a V6 total', async () => {
    const page = {
      items: [intent('4'), intent('6'), intent('5')],
      totalCount: 47,
      nextCursor: '3',
    };
    const search = vi.spyOn(services.center, 'search').mockResolvedValue(page);
    vi.spyOn(services.bendystraw, 'searchProjects').mockResolvedValue({
      items: [],
      totalCount: 0,
      pageInfo: { endCursor: null, hasNextPage: false },
    });

    const result = await client.callTool({
      name: 'jb_search_projects',
      arguments: { query: 'Example', limit: 3, intentCursor: '0' },
    });

    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: {
        undeployed: {
          status: 'known',
          value: {
            items: [intent('6')],
            totalCount: null,
            nextCursor: '3',
            pagination: {
              cursorScope: 'upstream-all-deployment-versions',
              totalCountStatus: 'unknown-after-version-filter',
              upstreamTotalCount: 47,
              upstreamPageItemCount: 3,
              excludedNonV6ItemCount: 2,
              returnedV6ItemCount: 1,
            },
          },
        },
      },
    });
    expect(search).toHaveBeenCalledExactlyOnceWith({ query: 'Example', limit: 3, cursor: '0' });
    expect(page.items).toEqual([intent('4'), intent('6'), intent('5')]);
    expect(JSON.stringify(result)).not.toContain('Version 4');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves continuation through empty filtered pages instead of hiding later V6 intents', async () => {
    const search = vi
      .spyOn(services.center, 'search')
      .mockResolvedValueOnce({ items: [intent('4')], totalCount: 2, nextCursor: '1' })
      .mockResolvedValueOnce({ items: [intent('6')], totalCount: 2, nextCursor: null });
    vi.spyOn(services.bendystraw, 'searchProjects').mockResolvedValue({
      items: [],
      totalCount: 0,
      pageInfo: { endCursor: null, hasNextPage: false },
    });

    const first = await client.callTool({ name: 'jb_search_projects', arguments: { limit: 1 } });
    expect(first.structuredContent).toMatchObject({
      data: {
        undeployed: { value: { items: [], totalCount: null, nextCursor: '1' } },
      },
    });
    const second = await client.callTool({
      name: 'jb_search_projects',
      arguments: { limit: 1, intentCursor: '1' },
    });
    expect(second.structuredContent).toMatchObject({
      data: {
        undeployed: { value: { items: [intent('6')], totalCount: null, nextCursor: null } },
      },
    });
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1]?.[0]).toMatchObject({ cursor: '1', limit: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'v4:base:1',
    'v5:base:1',
    'https://juicebox.money/v4/eth:1',
    'https://juicebox.money/v4:eth:1',
    'https://revnet.money/v4/base:1',
    'https://juicebox.money/v2/p/example',
  ])('rejects an explicit older project identity: %s', async (input) => {
    const result = await client.callTool({ name: 'jb_resolve_project', arguments: { input } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_VERSION' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['eth:1', 1],
    ['8453:1', 8453],
    ['https://revnet.money/base:1', 8453],
  ])(
    'resolves versionless identifiers to V6 without the SDK V4 fallback: %s',
    async (input, chainId) => {
      const result = await client.callTool({ name: 'jb_resolve_project', arguments: { input } });
      expect(result.structuredContent).toMatchObject({
        ok: true,
        data: {
          kind: 'project',
          project: { chainId, projectId: '1', version: 6 },
          existenceVerified: false,
        },
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('requires explicit V6 in the indexed name search rather than the SDK default version', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        data: {
          projects: {
            items: [],
            totalCount: 0,
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      }),
    );
    const result = await client.callTool({
      name: 'jb_resolve_project',
      arguments: { input: '@example' },
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: { kind: 'candidates', selectionRequired: true },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)) as {
      variables: { where: { AND: unknown[] } };
    };
    expect(request.variables.where.AND).toContainEqual({ version: 6 });
  });
});
