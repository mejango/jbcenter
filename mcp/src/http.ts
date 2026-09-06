import { createServices } from './app.js';
import { loadConfig } from './config.js';
import { createMcpServer } from './mcp/server.js';
import { createHttpServer } from './transport/http.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const services = await createServices(config);
  const runtime = createHttpServer(config, () => createMcpServer(services), {
    logger: (message) => console.error(message),
  });
  const address = await runtime.listen();
  console.error(`Juicebox MCP listening on ${config.host}:${address.port}/mcp`);
  const stop = () => {
    void runtime.close().catch(() => {
      console.error('Juicebox MCP shutdown failed.');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch(() => {
  // Exceptions from upstream clients can contain credential-bearing URLs.
  console.error(
    'Juicebox MCP startup failed. Check configuration, PLAN_SECRET, and the knowledge bundle.',
  );
  process.exitCode = 1;
});
