import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IpfsDiskCache } from "../src/ipfsCache.js";

const CID = "QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function cache(maxBytes = 1024, maxEntryBytes = 1024) {
  const directory = await mkdtemp(join(tmpdir(), "center-ipfs-cache-"));
  directories.push(directory);
  const options = { directory, maxBytes, maxEntryBytes };
  const value = new IpfsDiskCache(options);
  await value.ready();
  return { value, options };
}
const textBody = (body: ReadableStream<Uint8Array>) => new Response(body).text();

describe("persistent IPFS cache", () => {
  it("retains complete content and safe MIME headers across process restarts, including CID paths", async () => {
    const { value, options } = await cache();
    const fetcher = vi.fn(async () => new Response("artizen", { headers: { "content-type": "image/png", "set-cookie": "secret=1" } }));
    const first = await value.fetch(`${CID}/logo.png`, fetcher);
    expect(first.headers.get("x-ipfs-cache")).toBe("MISS");
    expect(await first.text()).toBe("artizen");
    const restarted = new IpfsDiskCache(options);
    await restarted.ready();
    const hit = await restarted.fetch(`${CID}/logo.png`, fetcher);
    expect(hit.headers.get("x-ipfs-cache")).toBe("HIT");
    expect(hit.headers.get("content-type")).toBe("image/png");
    expect(hit.headers.get("content-length")).toBe("7");
    expect(hit.headers.has("set-cookie")).toBe(false);
    expect(await hit.text()).toBe("artizen");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await restarted.get(`${CID}/other.png`)).toBeNull();
    const entry = await restarted.get(`${CID}/logo.png`);
    expect(await textBody(await entry!.body(2, 4))).toBe("tiz");
  });

  it("streams the first caller before completion and shares one fill with concurrent readers", async () => {
    const { value } = await cache();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } })));
    const first = await value.fetch(CID, fetcher);
    const secondPromise = value.fetch(CID, fetcher);
    const reader = first.body!.getReader();
    controller.enqueue(new TextEncoder().encode("first"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    expect(await value.get(CID)).toBeNull();
    controller.enqueue(new TextEncoder().encode("second"));
    controller.close();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("second");
    expect((await reader.read()).done).toBe(true);
    const second = await secondPromise;
    expect(await second.text()).toBe("firstsecond");
    expect(second.headers.get("x-ipfs-cache")).toBe("HIT");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("never retains failed, partial, truncated, oversized or errored responses", async () => {
    const { value, options } = await cache(20, 10);
    for (const response of [
      new Response("unavailable", { status: 429 }),
      new Response("partial", { status: 206, headers: { "content-range": "bytes 0-6/50" } }),
      new Response("partial", { headers: { "content-range": "bytes 0-6/50" } }),
      new Response("short", { headers: { "content-length": "9" } }),
      new Response("too long for entry"),
      new Response("declared too large", { headers: { "content-length": "500" } }),
    ]) {
      await (await value.fetch(CID, async () => response)).text();
      expect(await value.get(CID)).toBeNull();
    }
    const broken = await value.fetch(CID, async () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error("upstream broke")); } })));
    await expect(broken.text()).rejects.toThrow("upstream broke");
    expect(await value.get(CID)).toBeNull();
    expect(await readdir(options.directory)).toEqual([]);
  });

  it.each([false, true])("cleans cancelled fills and lets waiting callers retry (stalled cancellation: %s)", async (stalled) => {
    const { value, options } = await cache();
    const cancelled = vi.fn(() => stalled ? new Promise<void>(() => undefined) : undefined);
    const fetcher = vi.fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancelled })))
      .mockImplementation(async () => new Response("recovered"));
    const first = await value.fetch(CID, fetcher);
    const waiter = value.fetch(CID, fetcher);
    await first.body!.cancel();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(await (await waiter).text()).toBe("recovered");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await readdir(options.directory)).every((entry) => !entry.startsWith(".tmp-"))).toBe(true);
  }, 2000);

  it("evicts the least recently accessed content under the byte budget and serves already opened streams", async () => {
    const { value } = await cache(8);
    const fetcher = async () => new Response("1234");
    await (await value.fetch(`${CID}/a`, fetcher)).text();
    await (await value.fetch(`${CID}/b`, fetcher)).text();
    const old = await value.get(`${CID}/b`);
    const openBody = await old!.body();
    await value.get(`${CID}/a`);
    await (await value.fetch(`${CID}/c`, fetcher)).text();
    expect(await value.get(`${CID}/b`)).toBeNull();
    expect(await value.get(`${CID}/a`)).not.toBeNull();
    expect(await value.get(`${CID}/c`)).not.toBeNull();
    expect(await textBody(openBody)).toBe("1234");
  });

  it("accounts for in-progress fills when enforcing the shared disk budget", async () => {
    const { value } = await cache(8);
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const fetcher = async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controllers.push(controller); } }));
    const first = await value.fetch(`${CID}/a`, fetcher);
    const second = await value.fetch(`${CID}/b`, fetcher);
    const readers = [first.body!.getReader(), second.body!.getReader()];
    for (const [index, controller] of controllers.entries()) {
      controller.enqueue(new TextEncoder().encode("1234"));
      expect((await readers[index]!.read()).value).toHaveLength(4);
    }
    controllers[0]!.enqueue(new TextEncoder().encode("5678"));
    expect((await readers[0]!.read()).value).toHaveLength(4);
    controllers[0]!.close();
    expect((await readers[0]!.read()).done).toBe(true);
    expect(await value.get(`${CID}/a`)).toBeNull();
    controllers[1]!.enqueue(new TextEncoder().encode("5678"));
    expect((await readers[1]!.read()).value).toHaveLength(4);
    controllers[1]!.close();
    expect((await readers[1]!.read()).done).toBe(true);
    const retained = await value.get(`${CID}/b`);
    expect(await textBody(await retained!.body())).toBe("12345678");
  });

  it("cleans incomplete and invalid entries on restart without removing unrelated files", async () => {
    const { options } = await cache();
    const key = createHash("sha256").update(CID).digest("hex");
    await mkdir(join(options.directory, `.tmp-${key}-abc`));
    await writeFile(join(options.directory, `.tmp-${key}-abc`, "body"), "partial");
    await mkdir(join(options.directory, key));
    await writeFile(join(options.directory, key, "metadata.json"), "{}");
    await writeFile(join(options.directory, "keep.txt"), "unrelated");
    const restarted = new IpfsDiskCache(options);
    await restarted.ready();
    expect(await restarted.get(CID)).toBeNull();
    expect(await readdir(options.directory)).toEqual(["keep.txt"]);
  });

  it("continues serving upstream content when disk caching cannot start", async () => {
    const { value, options } = await cache();
    await rm(options.directory, { recursive: true });
    await writeFile(options.directory, "not a directory");
    const response = await value.fetch(CID, async () => new Response("available"));
    expect(response.headers.get("x-ipfs-cache")).toBe("BYPASS");
    expect(await response.text()).toBe("available");
  });
});
