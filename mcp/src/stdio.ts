#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServices } from './app.js';
import { loadConfig } from './config.js';
import { createMcpServer } from './mcp/server.js';

async function main(): Promise<void> {
  const services = await createServices(loadConfig());
  const server = createMcpServer(services);
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 256 * 1024,
  });
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= server.close().catch(() => {
      console.error('Juicebox MCP stdio shutdown failed.');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdin.once('end', stop);
  await server.connect(transport);
  console.error('Juicebox MCP stdio ready.');
}

main().catch(() => {
  console.error('Juicebox MCP startup failed. Check configuration and the knowledge bundle.');
  process.exitCode = 1;
});
