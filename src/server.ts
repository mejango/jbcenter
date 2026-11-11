import { getRequestListener } from "@hono/node-server";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { HttpHandler } from "@juicebox/mcp/host";

export interface CenterServerOptions {
  port: number;
  hostname?: string;
  shutdownGraceMs?: number;
}

export interface CenterServer {
  server: Server;
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
}

/** One listener owns both protocols; neither framework consumes the other's request streams. */
export function createCenterServer(
  fetch: Parameters<typeof getRequestListener>[0],
  mcp: HttpHandler,
  options: CenterServerOptions,
): CenterServer {
  const grace = options.shutdownGraceMs ?? 25_000;
  if (!Number.isSafeInteger(grace) || grace < 1 || grace > 300_000) {
    throw new Error("Shutdown grace must be a positive bounded integer");
  }
  const center = getRequestListener(fetch, { overrideGlobalObjects: false });
  let draining = false;
  let closing: Promise<void> | undefined;
  let closingMcp: Promise<void> | undefined;
  const disposeMcp = () => {
    closingMcp ??= Promise.resolve().then(() => mcp.close());
    return closingMcp;
  };
  const server = createServer(
    {
      maxHeaderSize: 16 * 1024,
      headersTimeout: 10_000,
      // Center streams large media uploads. MCP enforces its own shorter body/operation deadlines.
      requestTimeout: 300_000,
      keepAliveTimeout: 5_000,
    },
    (request, response) => {
      response.once("finish", () => {
        if (!draining) return;
        // Finish listeners can run before Node marks the socket idle. Check on the
        // next event-loop turn so completed keep-alive requests do not consume the grace period.
        setImmediate(() => server.closeIdleConnections());
      });
      const path = (request.url ?? "/").split("?", 1)[0]!;
      if (path === "/mcp" || path.startsWith("/mcp/")) {
        mcp.handler(request, response);
        return;
      }
      if (draining) {
        response.writeHead(503, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "close",
          "Retry-After": "1",
        });
        response.end(
          JSON.stringify({ error: { code: "draining", message: "Server is shutting down" } }),
        );
        return;
      }
      void center(request, response);
    },
  );
  server.maxHeadersCount = 100;
  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        if (draining) return reject(new Error("A closed server cannot be restarted"));
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(options.port, options.hostname ?? "0.0.0.0", () => {
          server.off("error", onError);
          resolve(server.address() as AddressInfo);
        });
      }),
    close: () => {
      if (closing) return closing;
      draining = true;
      mcp.beginDrain();
      closing = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          // The listener-close callback below reports any disposal failure. Attach
          // a handler now so a fast rejection cannot become an unhandled rejection.
          void disposeMcp().catch(() => {});
          server.closeAllConnections();
        }, grace);
        timeout.unref();
        server.close((error) => {
          clearTimeout(timeout);
          void disposeMcp().then(() => {
            if (error && "code" in error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
            else resolve();
          }, reject);
        });
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}
