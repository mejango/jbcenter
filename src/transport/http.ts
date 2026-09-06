import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from '../config.js';

const MAX_BODY_BYTES = 256 * 1024;
const ALLOWED_CORS_HEADERS = new Set([
  'accept',
  'content-type',
  'mcp-protocol-version',
  'mcp-session-id',
  'last-event-id',
]);

export interface HttpOptions {
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
  /** Requests per minute, with a burst of the same size. Keys are socket IPs, never forwarded headers. */
  rateLimitPerMinute?: number;
  maxRateLimitEntries?: number;
  logger?: (message: string) => void;
}

export interface HttpRuntime {
  server: Server;
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
  activeRequests(): number;
}

function authority(value: string): { hostname: string; port?: string } | undefined {
  const match = /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(value);
  if (!match || (match[2] !== undefined && Number(match[2]) > 65535)) return undefined;
  try {
    const url = new URL(`http://${value}`);
    return {
      hostname: url.hostname.toLowerCase(),
      ...(match[2] === undefined ? {} : { port: match[2] }),
    };
  } catch {
    return undefined;
  }
}

function hasSingleHeader(req: Request, header: string): boolean {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === header) count++;
  }
  return count === 1;
}

function rpcError(res: ServerResponse, status: number, message: string, code = -32000): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }));
}

/** Bounded token buckets. Saturation rejects new keys instead of evicting live quotas. */
class RateLimiter {
  private readonly entries = new Map<string, { tokens: number; updatedAt: number }>();
  constructor(
    private readonly capacity: number,
    private readonly maxEntries: number,
  ) {}

  consume(key: string, now = performance.now()): boolean {
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxEntries) {
        for (const [candidate, value] of this.entries) {
          if (now - value.updatedAt >= 60_000) this.entries.delete(candidate);
        }
      }
      if (this.entries.size >= this.maxEntries) return false;
      entry = { tokens: this.capacity, updatedAt: now };
      this.entries.set(key, entry);
    }
    entry.tokens = Math.min(
      this.capacity,
      entry.tokens + ((now - entry.updatedAt) * this.capacity) / 60_000,
    );
    entry.updatedAt = now;
    if (entry.tokens < 1) return false;
    entry.tokens--;
    return true;
  }
}

/**
 * Every POST gets a new protocol server and transport. Services may be shared by the
 * factory, but protocol state and request cancellation must never cross clients.
 * TLS and distributed quotas belong at the ingress; forwarded headers are untrusted.
 */
export function createHttpServer(
  config: Config,
  factory: () => McpServer,
  options: HttpOptions = {},
): HttpRuntime {
  const log = options.logger ?? (() => {});
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const shutdownGraceMs = options.shutdownGraceMs ?? 10_000;
  const rateLimitPerMinute = options.rateLimitPerMinute ?? 120;
  const maxRateLimitEntries = options.maxRateLimitEntries ?? 10_000;
  for (const value of [
    requestTimeoutMs,
    shutdownGraceMs,
    rateLimitPerMinute,
    maxRateLimitEntries,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error('HTTP limits must be positive safe integers.');
  }
  const hosts = config.allowedHosts.map((value) => {
    const parsed = authority(value);
    if (!parsed) throw new Error('ALLOWED_HOSTS contains an invalid host authority.');
    return parsed;
  });
  const origins = new Set(config.allowedOrigins);
  const limiter = new RateLimiter(rateLimitPerMinute, maxRateLimitEntries);
  const active = new Map<Response, { cancel: () => Promise<void>; finish: () => Promise<void> }>();
  const cleanups = new Set<Promise<void>>();
  let draining = false;
  let closing: Promise<void> | undefined;
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', false);

  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const host = typeof req.headers.host === 'string' ? authority(req.headers.host) : undefined;
    if (
      !hasSingleHeader(req, 'host') ||
      !host ||
      !hosts.some(
        (allowed) =>
          allowed.hostname === host.hostname &&
          (allowed.port === undefined || allowed.port === host.port),
      )
    ) {
      rpcError(res, 403, 'Host is not allowed.');
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!hasSingleHeader(req, 'origin') || !origins.has(origin)) {
        rpcError(res, 403, 'Origin is not allowed.');
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Protocol-Version, Retry-After');
    }
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'alive' });
  });
  app.get('/readyz', (_req, res) => {
    res.status(draining ? 503 : 200).json({
      status: draining ? 'draining' : 'ready',
      scope: 'local_configuration_and_services',
      upstreamHealth: 'not_checked',
    });
  });
  app.get('/', (_req, res) => {
    res.json({
      name: 'Juicebox MCP',
      transport: 'streamable-http',
      endpoint: '/mcp',
      stateful: false,
    });
  });

  app.options('/mcp', (req, res) => {
    const method = req.headers['access-control-request-method'];
    const requestedHeaders = req.headers['access-control-request-headers'];
    const headers =
      typeof requestedHeaders === 'string'
        ? requestedHeaders
            .toLowerCase()
            .split(',')
            .map((value) => value.trim())
        : [];
    if (
      !req.headers.origin ||
      method !== 'POST' ||
      headers.some((value) => !ALLOWED_CORS_HEADERS.has(value))
    ) {
      rpcError(res, 403, 'CORS preflight is not allowed.');
      return;
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', [...ALLOWED_CORS_HEADERS].join(', '));
    res.setHeader('Access-Control-Max-Age', '600');
    res.status(204).end();
  });

  // Apply limits before buffering the JSON body. A slow uploader occupies a slot too.
  app.post(
    '/mcp',
    (req, res, next) => {
      if (draining || active.size >= config.maxConcurrentRequests) {
        res.setHeader('Retry-After', '1');
        rpcError(res, 503, draining ? 'Server is shutting down.' : 'Server is at capacity.');
        return;
      }
      if (!limiter.consume(req.socket.remoteAddress ?? 'unknown')) {
        res.setHeader('Retry-After', '60');
        rpcError(res, 429, 'Request rate limit exceeded.');
        return;
      }
      if (!req.is('application/json')) {
        rpcError(res, 415, 'Content-Type must be application/json.');
        return;
      }
      const scope = {
        cancel: async () => {},
        finish: async () => {
          if (!active.delete(res)) return;
          clearTimeout(timeout);
          req.off('aborted', onClose);
          res.off('close', onClose);
          res.off('finish', onClose);
          const cleanup = scope.cancel().catch(() => log('MCP request cleanup failed.'));
          cleanups.add(cleanup);
          try {
            await cleanup;
          } finally {
            cleanups.delete(cleanup);
          }
        },
      };
      const onClose = () => {
        void scope.finish();
      };
      const timeout = setTimeout(() => {
        rpcError(res, 504, 'Request deadline exceeded.');
        void scope.finish();
      }, requestTimeoutMs);
      timeout.unref();
      active.set(res, scope);
      req.once('aborted', onClose);
      res.once('close', onClose);
      res.once('finish', onClose);
      next();
    },
    express.json({ limit: MAX_BODY_BYTES, strict: true, inflate: false }),
    async (req, res) => {
      const scope = active.get(res);
      if (!scope || res.destroyed || res.writableEnded) return;
      // The SDK retains legacy batching support. Reject batches so one accepted
      // HTTP request cannot fan out into unbounded concurrent tool invocations.
      if (Array.isArray(req.body)) {
        rpcError(
          res,
          400,
          'JSON-RPC batches are not supported. Send one message per request.',
          -32600,
        );
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      let mcp: McpServer | undefined;
      scope.cancel = async () => {
        if (mcp) await mcp.close();
        else await transport.close();
      };
      try {
        mcp = factory();
        await mcp.connect(transport);
        if (!active.has(res)) {
          await mcp.close();
          return;
        }
        await transport.handleRequest(req, res, req.body);
      } catch {
        log('MCP HTTP request failed.');
        rpcError(res, 500, 'Internal server error.', -32603);
        await scope.finish();
      }
    },
  );

  app.all('/mcp', (_req, res) => {
    res.setHeader('Allow', 'POST, OPTIONS');
    rpcError(res, 405, 'Method not allowed. This server uses stateless POST requests.');
  });
  app.use((_req, res) => {
    rpcError(res, 404, 'Not found.');
  });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const type = error && typeof error === 'object' && 'type' in error ? error.type : undefined;
    if (type === 'entity.too.large') rpcError(res, 413, 'Request body exceeds 256 KiB.');
    else if (type === 'encoding.unsupported' || type === 'charset.unsupported')
      rpcError(res, 415, 'Unsupported request encoding.');
    else if (type === 'entity.parse.failed' || type === 'request.size.invalid')
      rpcError(res, 400, 'Invalid JSON request body.', -32700);
    else {
      log('MCP HTTP middleware failed.');
      rpcError(res, 500, 'Internal server error.', -32603);
    }
    if (!res.writableEnded && res.headersSent) res.destroy();
  };
  app.use(errors);

  const server = createServer(
    {
      maxHeaderSize: 16 * 1024,
      requestTimeout: 15_000,
      headersTimeout: 10_000,
      keepAliveTimeout: 5_000,
    },
    app,
  );
  server.maxHeadersCount = 100;
  return {
    server,
    activeRequests: () => active.size,
    listen: () =>
      new Promise((resolve, reject) => {
        if (draining) {
          reject(new Error('A closed HTTP runtime cannot be restarted.'));
          return;
        }
        const onError = (error: Error) => {
          reject(error);
        };
        server.once('error', onError);
        server.listen(config.port, config.host, () => {
          server.off('error', onError);
          resolve(server.address() as AddressInfo);
        });
      }),
    close: () => {
      if (closing) return closing;
      draining = true;
      closing = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          for (const [res, scope] of active) {
            res.destroy();
            void scope.finish();
          }
          server.closeAllConnections();
        }, shutdownGraceMs);
        timeout.unref();
        server.close((error) => {
          clearTimeout(timeout);
          Promise.all(
            [...active.values()].map((scope) => scope.finish()).concat([...cleanups]),
          ).then(() => {
            if (error && 'code' in error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
            else resolve();
          }, reject);
        });
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}
