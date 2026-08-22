import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { CentralEnv } from "./types.js";

export class Metrics {
  private requests = new Map<string, number>();
  private durationMs = 0;
  private inFlight = 0;

  middleware(): MiddlewareHandler<CentralEnv> {
    return async (c, next) => {
      const requestId = c.req.header("x-request-id")?.slice(0, 128) || randomUUID();
      const started = performance.now();
      this.inFlight += 1;
      c.set("requestId", requestId);
      c.header("X-Request-Id", requestId);
      try {
        await next();
      } finally {
        const elapsed = performance.now() - started;
        this.inFlight -= 1;
        this.durationMs += elapsed;
        const key = `${c.req.method}:${c.res.status}`;
        this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
        if (process.env.NODE_ENV !== "test") {
          console.log(
            JSON.stringify({
              level: "info",
              message: "request",
              requestId,
              method: c.req.method,
              path: c.req.path,
              status: c.res.status,
              durationMs: Math.round(elapsed * 100) / 100,
              client: c.get("client") ?? null,
              region: process.env.RAILWAY_REPLICA_REGION ?? null,
              replica: process.env.RAILWAY_REPLICA_ID ?? null,
            }),
          );
        }
      }
    };
  }

  render(): string {
    const lines = [
      "# TYPE juice_central_http_requests_total counter",
      ...[...this.requests.entries()].map(([key, count]) => {
        const [method, status] = key.split(":");
        return `juice_central_http_requests_total{method="${method}",status="${status}"} ${count}`;
      }),
      "# TYPE juice_central_http_request_duration_milliseconds_total counter",
      `juice_central_http_request_duration_milliseconds_total ${this.durationMs}`,
      "# TYPE juice_central_http_requests_in_flight gauge",
      `juice_central_http_requests_in_flight ${this.inFlight}`,
    ];
    return `${lines.join("\n")}\n`;
  }
}
