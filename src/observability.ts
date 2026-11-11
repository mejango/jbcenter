import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { JbcenterEnv } from "./types.js";

export class Metrics {
  private requests = new Map<string, number>();
  private durationMs = 0;
  private inFlight = 0;
  private sponsor = { bundles: 0, paymentsWei: 0n, failures: 0 };

  /** Sponsored deploys move real money; only aggregate counts are exported. */
  observeSponsorEvent(event: { event: string; wei?: string }): void {
    if (event.event === "bundle") this.sponsor.bundles += 1;
    if (event.event === "payment") this.sponsor.paymentsWei += BigInt(event.wei ?? "0");
    if (event.event === "failed") this.sponsor.failures += 1;
  }

  middleware(): MiddlewareHandler<JbcenterEnv> {
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
              ...(c.get("errorCode") ? { code: c.get("errorCode") } : {}),
              ...(c.get("errorDetail") ? { detail: c.get("errorDetail") } : {}),
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
      "# TYPE jbcenter_http_requests_total counter",
      ...[...this.requests.entries()].map(([key, count]) => {
        const [method, status] = key.split(":");
        return `jbcenter_http_requests_total{method="${method}",status="${status}"} ${count}`;
      }),
      "# TYPE jbcenter_http_request_duration_milliseconds_total counter",
      `jbcenter_http_request_duration_milliseconds_total ${this.durationMs}`,
      "# TYPE jbcenter_http_requests_in_flight gauge",
      `jbcenter_http_requests_in_flight ${this.inFlight}`,
      "# TYPE jbcenter_sponsor_bundles_total counter",
      `jbcenter_sponsor_bundles_total ${this.sponsor.bundles}`,
      "# TYPE jbcenter_sponsor_payments_wei_total counter",
      `jbcenter_sponsor_payments_wei_total ${this.sponsor.paymentsWei}`,
      "# TYPE jbcenter_sponsor_failures_total counter",
      `jbcenter_sponsor_failures_total ${this.sponsor.failures}`,

    ];
    return `${lines.join("\n")}\n`;
  }
}
