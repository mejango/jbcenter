import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, utimes, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { safeIpfsPath } from "./ipfs.js";

type StoredEntry = {
  path: string;
  size: number;
  headers: Record<string, string>;
  accessed: number;
};

export type CachedIpfsEntry = {
  size: number;
  headers: Headers;
  body(start?: number, end?: number): Promise<ReadableStream<Uint8Array>>;
};

const MAX_ENTRIES = 10_000;
const MAX_FILLS = 16;
const CACHE_HEADERS = ["content-type", "content-disposition"];
const keyFor = (path: string) => createHash("sha256").update(path).digest("hex");
function mark(response: Response, status: "MISS" | "BYPASS"): Response {
  const headers = new Headers(response.headers);
  headers.set("X-IPFS-Cache", status);
  return new Response(response.body, { status: response.status, headers });
}

/** One process owns this directory. Mount it on persistent storage across deployments. */
export class IpfsDiskCache {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly flights = new Map<string, Promise<void>>();
  private usedBytes = 0;
  private pendingBytes = 0;
  private lock = Promise.resolve();
  private readonly initialized: Promise<void>;

  constructor(private readonly options: { directory: string; maxBytes: number; maxEntryBytes: number }) {
    if (![options.maxBytes, options.maxEntryBytes].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new Error("IPFS cache limits must be positive integers");
    }
    this.initialized = this.initialize();
  }

  ready(): Promise<void> { return this.initialized; }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await action(); } finally { release(); }
  }

  private async initialize(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true });
    const found: Array<[string, StoredEntry]> = [];
    for (const item of await readdir(this.options.directory, { withFileTypes: true })) {
      // This is a dedicated cache directory; do not touch unrelated files.
      if (!/^(?:[a-f0-9]{64}|\.tmp-[a-f0-9]{64}-[a-f0-9]+)$/u.test(item.name)) continue;
      const directory = join(this.options.directory, item.name);
      try {
        if (!item.isDirectory() || item.name.startsWith(".tmp-")) throw new Error("incomplete entry");
        const metadataPath = join(directory, "metadata.json");
        if ((await stat(metadataPath)).size > 4096) throw new Error("invalid metadata");
        const entry = JSON.parse(await readFile(metadataPath, "utf8")) as StoredEntry;
        const body = await stat(join(directory, "body"));
        if (typeof entry.path !== "string" || safeIpfsPath(entry.path) !== entry.path ||
          keyFor(entry.path) !== item.name || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
          entry.size > this.options.maxEntryBytes || entry.size > this.options.maxBytes ||
          !body.isFile() || body.size !== entry.size || !entry.headers ||
          Object.entries(entry.headers).some(([key, value]) => !CACHE_HEADERS.includes(key) || typeof value !== "string")) {
          throw new Error("invalid entry");
        }
        new Headers(entry.headers);
        entry.accessed = (await stat(directory)).mtimeMs;
        found.push([item.name, entry]);
      } catch {
        await rm(directory, { recursive: true, force: true });
      }
    }
    for (const [key, entry] of found.sort((a, b) => a[1].accessed - b[1].accessed)) {
      this.entries.set(key, entry);
      this.usedBytes += entry.size;
    }
    await this.makeRoom(0);
  }

  private async remove(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    // Open file streams remain valid on Unix after removal.
    await rm(join(this.options.directory, key), { recursive: true, force: true });
    this.entries.delete(key);
    this.usedBytes -= entry.size;
  }

  private async makeRoom(bytes: number, addingEntry = false): Promise<boolean> {
    // ponytail: at most 10,000 entries; Map insertion order is the LRU queue.
    while (this.entries.size && (this.usedBytes + this.pendingBytes + bytes > this.options.maxBytes ||
      this.entries.size + Number(addingEntry) > MAX_ENTRIES)) {
      await this.remove(this.entries.keys().next().value!);
    }
    return this.usedBytes + this.pendingBytes + bytes <= this.options.maxBytes;
  }

  async get(path: string): Promise<CachedIpfsEntry | null> {
    await this.ready();
    if (safeIpfsPath(path) !== path) return null;
    const key = keyFor(path);
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    const now = Date.now();
    if (now - entry.accessed > 60_000) {
      entry.accessed = now;
      void utimes(join(this.options.directory, key), now / 1000, now / 1000).catch(() => undefined);
    }
    return {
      size: entry.size,
      headers: new Headers(entry.headers),
      body: async (start = 0, end = entry.size - 1) => {
        if (!entry.size) return new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
        const file = await open(join(this.options.directory, key, "body"), "r");
        return Readable.toWeb(file.createReadStream({ start, end, autoClose: true })) as ReadableStream<Uint8Array>;
      },
    };
  }

  /** The fetcher supplies an already validated, bounded response with safe headers. */
  async fetch(path: string, fetcher: () => Promise<Response>, signal?: AbortSignal): Promise<Response> {
    await this.ready();
    if (safeIpfsPath(path) !== path) return mark(await fetcher(), "BYPASS");
    const key = keyFor(path);
    for (;;) {
      signal?.throwIfAborted();
      const cached = await this.get(path);
      if (cached) {
        try {
          const headers = new Headers(cached.headers);
          headers.set("content-length", String(cached.size));
          headers.set("X-IPFS-Cache", "HIT");
          return new Response(await cached.body(), { headers });
        } catch {
          await this.exclusive(() => this.remove(key));
        }
      }
      const flight = this.flights.get(key);
      if (flight) {
        if (!signal) { await flight; continue; }
        let abort!: () => void;
        try {
          await Promise.race([flight, new Promise<never>((_resolve, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          })]);
        } finally { signal.removeEventListener("abort", abort); }
        continue;
      }
      if (this.flights.size >= MAX_FILLS) return mark(await fetcher(), "BYPASS");
      let settle!: () => void;
      this.flights.set(key, new Promise<void>((resolve) => { settle = resolve; }));
      const done = () => { this.flights.delete(key); settle(); };
      try {
        const response = await fetcher();
        if (response.status !== 200 || response.headers.has("content-range") || !response.body) {
          done();
          return mark(response, "BYPASS");
        }
        const declared = response.headers.get("content-length");
        const expected = declared === null ? null : Number(declared);
        if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0 ||
          expected > this.options.maxEntryBytes || expected > this.options.maxBytes)) {
          done();
          return mark(response, "BYPASS");
        }
        return await this.retain(path, key, response, expected, done, signal);
      } catch (error) {
        done();
        throw error;
      }
    }
  }

  private async retain(path: string, key: string, response: Response, expected: number | null, done: () => void, signal?: AbortSignal): Promise<Response> {
    const directory = join(this.options.directory, `.tmp-${key}-${randomBytes(8).toString("hex")}`);
    let file: FileHandle;
    try {
      await mkdir(directory);
      file = await open(join(directory, "body"), "wx");
    } catch {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      done();
      return mark(response, "BYPASS");
    }
    const reader = response.body!.getReader();
    const headers: Record<string, string> = {};
    for (const name of CACHE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null && value.length <= 1024) headers[name] = value;
    }
    let bytes = 0;
    let reserved = 0;
    let retaining = true;
    let cancelled = false;
    let aborted = false;
    let writing = Promise.resolve();
    let finishing: Promise<void> | undefined;
    const discard = async () => {
      retaining = false;
      await file.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      this.pendingBytes -= reserved;
      reserved = 0;
    };
    const finish = (complete: boolean): Promise<void> => finishing ??= (async () => {
      try {
        await writing;
        if (complete && retaining && !cancelled && !aborted && (expected === null || expected === bytes)) {
          await file.sync();
          await file.close();
          const entry: StoredEntry = { path, size: bytes, headers, accessed: Date.now() };
          await writeFile(join(directory, "metadata.json"), JSON.stringify(entry), { flag: "wx" });
          await this.exclusive(async () => {
            await this.makeRoom(0, true);
            await rename(directory, join(this.options.directory, key));
            this.pendingBytes -= reserved;
            reserved = 0;
            this.usedBytes += bytes;
            this.entries.set(key, entry);
          });
        } else {
          await discard();
        }
      } catch {
        await discard();
      } finally {
        signal?.removeEventListener("abort", abort);
        done();
      }
    })();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
      pull: async (controller) => {
        try {
          const chunk = await reader.read();
          if (cancelled || aborted) return;
          if (chunk.done) {
            await finish(true);
            reader.releaseLock();
            controller.close();
            return;
          }
          bytes += chunk.value.byteLength;
          if (retaining) {
            writing = (async () => {
              try {
                if (bytes > this.options.maxEntryBytes || bytes > this.options.maxBytes) { await discard(); return; }
                const allowed = await this.exclusive(async () => {
                  if (!await this.makeRoom(chunk.value.byteLength)) return false;
                  this.pendingBytes += chunk.value.byteLength;
                  reserved += chunk.value.byteLength;
                  return true;
                });
                if (!allowed) { await discard(); return; }
                await file.writeFile(chunk.value);
              } catch { await discard(); }
            })();
            await writing;
          }
          if (!cancelled && !aborted) controller.enqueue(chunk.value);
        } catch (error) {
          await reader.cancel(error).catch(() => undefined);
          await finish(false);
          if (!cancelled) controller.error(error);
        }
      },
      cancel: async (reason) => {
        cancelled = true;
        await reader.cancel(reason).catch(() => undefined);
        await finish(false);
      },
    }, { highWaterMark: 0 });
    const abort = () => {
      aborted = true;
      // Cancelling the reader also releases a TransformStream blocked on downstream backpressure.
      void reader.cancel(signal!.reason).catch(() => undefined);
      void finish(false).then(() => { if (!cancelled) streamController.error(signal!.reason); });
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    // Upstream deadlines must release the fill even when a slow client stops pulling.
    void reader.closed.catch(async (error) => {
      await finish(false);
      if (!cancelled) streamController.error(error);
    });
    const resultHeaders = new Headers(response.headers);
    resultHeaders.set("X-IPFS-Cache", "MISS");
    return new Response(body, { status: response.status, headers: resultHeaders });
  }
}
