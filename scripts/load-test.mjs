import assert from "node:assert/strict";

const origin = process.env.LOAD_TEST_URL;
const requests = Number(process.env.LOAD_TEST_REQUESTS ?? 1_000);
const concurrency = Number(process.env.LOAD_TEST_CONCURRENCY ?? 25);

assert(origin, "LOAD_TEST_URL is required");
assert(Number.isSafeInteger(requests) && requests > 0, "LOAD_TEST_REQUESTS must be positive");
assert(
  Number.isSafeInteger(concurrency) && concurrency > 0 && concurrency <= 1_000,
  "LOAD_TEST_CONCURRENCY must be between 1 and 1000",
);

let next = 0;
let failures = 0;
const durations = [];

async function worker() {
  while (next < requests) {
    next += 1;
    const started = performance.now();
    try {
      const response = await fetch(new URL("/v1/search?limit=20", origin), {
        headers: { origin: "https://juicebox.money" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) failures += 1;
      await response.arrayBuffer();
    } catch {
      failures += 1;
    }
    durations.push(performance.now() - started);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, worker));
durations.sort((a, b) => a - b);
const percentile = (value) => durations[Math.min(durations.length - 1, Math.floor(value * durations.length))];
const result = {
  requests,
  concurrency,
  failures,
  p50Ms: Math.round(percentile(0.5) * 100) / 100,
  p95Ms: Math.round(percentile(0.95) * 100) / 100,
  maxMs: Math.round(durations.at(-1) * 100) / 100,
};
console.log(JSON.stringify(result));
if (failures) process.exitCode = 1;
