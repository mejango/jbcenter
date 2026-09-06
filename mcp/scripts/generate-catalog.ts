import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServices } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createMcpServer } from '../src/mcp/server.js';
import { capabilityCatalog } from '../src/mcp/capabilities.js';

const services = createServices(
  loadConfig({
    PUBLIC_ORIGIN: 'https://juicebox.center',
    PLAN_SECRET: 'catalog-generation-only-never-an-execution-secret',
  }),
);
const server = createMcpServer(services);
const client = new Client({ name: 'catalog-generator', version: '1.0.0' });
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
try {
  const { tools } = await client.listTools();
  const capabilitiesResult = await client.callTool({ name: 'jb_list_capabilities', arguments: {} });
  const capabilities = (
    capabilitiesResult.structuredContent as { data: ReturnType<typeof capabilityCatalog> }
  ).data;
  const data =
    JSON.stringify({ name: 'juicebox-mcp', version: '0.1.0', tools, capabilities }, null, 2) + '\n';
  const lines = [
    '# MCP tool catalog',
    '',
    'Generated from the real MCP server with the official MCP client. Regenerate with `npm run catalog:generate`; `--check` detects drift. Input and output JSON schemas are in [`data/mcp-tool-catalog.json`](../data/mcp-tool-catalog.json).',
    '',
    'For user goals, tool sequences, external handoffs and completion evidence, see the [user journeys](USER_JOURNEYS.md).',
    '',
    `${tools.length} V6-only tools are registered. They provide public reads, pure computations, unsigned plan preparation, receipt verification, and explicitly approved publication of reviewed project metadata through the integrated Center backend. No tool signs or broadcasts transactions.`,
    '',
    '`jb_prepare_project_metadata` returns the exact canonical JSON, SHA256 and an expiring review token. `jb_pin_project_metadata` uploads only that reviewed document after explicit public-upload authorization. This is a public mutation; a review token is not user approval. The workflow creates new standard project metadata and does not upload images, merge existing documents, or update project URIs on-chain.',
    '',
    'Every tool returns a structured envelope `{schemaVersion, observedAt, ok, data|error}`. Exact amounts use integer strings. Per-tool source coverage and execution limits remain in the returned domain data.',
    '',
  ];
  for (const family of capabilities.families) {
    lines.push(`## ${family.title}`, '', '| Tool | Behavior |', '|---|---|');
    for (const tool of family.tools)
      lines.push(`| \`${tool.name}\` | ${tool.description.replaceAll('|', '\\|')} |`);
    lines.push(
      '',
      ...family.limits.map((limit) => `- ${limit}`),
      '',
      `Source areas: ${family.references.join(', ')}.`,
      '',
    );
  }
  lines.push(
    '## Discovery, resources and prompts',
    '',
    '`jb_list_capabilities` returns these families and their current limits.',
    '',
    '- `juicebox://capabilities`: organized tool coverage.',
    '- `juicebox://contracts`: pinned SDK ABI and deployment inventory.',
    '- `juicebox://sources`: source bundle fingerprint and category counts.',
    '- `juicebox://reference/{id}/{offset}`: paginated source text with provenance.',
    '- `juicebox://development/{id}/{offset}`: paginated webclient/SDK source example.',
    '',
    'Prompts: `inspect-project`, `review-contribution`, `design-project`, and `build-webclient`.',
    '',
    '## Coverage distinctions',
    '',
    'The source bundles expose complete first-party contract information for the selected V6 repositories. Operational tools cover the explicitly registered workflows above. An ABI or source reference does not imply that every contract method has a dedicated financial-planning adapter. Unsupported custom compositions are reported explicitly, and no stub tool claims to implement them.',
    '',
    'Current execution boundaries include custom controllers/hooks, partial buyback swaps, positive NFT-tier split forwarding, and nested Safe/Relayr receipt proof. Source references and webclient plans document those surfaces for development without pretending a generic simulation fully models them.',
    '',
  );
  for (const [path, content] of [
    ['data/mcp-tool-catalog.json', data],
    ['docs/TOOLS.md', lines.join('\n')],
  ] as const) {
    const target = fileURLToPath(new URL(`../${path}`, import.meta.url));
    if (process.argv.includes('--check')) {
      if ((await readFile(target, 'utf8')) !== content)
        throw new Error(`${path} is stale. Run npm run catalog:generate.`);
    } else await writeFile(target, content);
  }
  console.log(
    `${process.argv.includes('--check') ? 'Verified' : 'Generated'} ${tools.length} MCP tools across ${capabilities.families.length} capability families.`,
  );
} finally {
  await client.close();
  await server.close();
}
