import type { Cache } from "./cache.js";
import { MemoryCache } from "./cache.js";
import {
  type Result,
  type Thumbnail,
  Status,
  Source,
  ThumbError,
  VerifyError,
  ConnectionError,
  TimeoutError,
} from "./types.js";

// ── constants ────────────────────────────────────────────────────────────

const DEFAULT_BASE = "http://api.thumbrella.dev/";
const MAX_BACKOFF = 60_000;

// ── connect string parsing ───────────────────────────────────────────────

interface ConnectConfig {
  baseUrl: string;
  headers: Record<string, string>;
}

export function parseConnect(connect?: string): ConnectConfig {
  const raw =
    connect ||
    (typeof process !== "undefined" && process.env.TBR_CONNECT) ||
    (typeof process !== "undefined" && process.env.TBR_SERVER) ||
    DEFAULT_BASE;

  // Bearer token — no scheme.
  if (!raw.includes("://")) {
    return {
      baseUrl: DEFAULT_BASE,
      headers: { Authorization: `Bearer ${raw}` },
    };
  }

  // URL with optional fragment headers.
  const hashIdx = raw.indexOf("#");
  const base = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
  const headers: Record<string, string> = {};

  if (hashIdx >= 0) {
    for (const seg of raw.slice(hashIdx + 1).split("&")) {
      const s = seg.trim();
      if (!s) continue;
      const eq = s.indexOf("=");
      if (eq >= 0) {
        headers[s.slice(0, eq).trim()] = s.slice(eq + 1).trim();
      } else if (s.startsWith("tbr_")) {
        headers.Authorization = `Bearer ${s}`;
      } else {
        headers["x-tbr-handshake"] = s;
      }
    }
  }

  return { baseUrl: base.replace(/\/+$/, ""), headers };
}

// ── thumbnail internals ──────────────────────────────────────────────────

// Shared placeholder instances — one per unique JPEG payload.
const placeholderPool = new Map<string, { bytes: Uint8Array; key: number }>();

function decodeThumb(b64: string): Thumbnail {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return makeThumb(bytes);
}

function makeThumb(bytes: Uint8Array): Thumbnail {
  // Simple content hash for Map keying.
  let h = 0;
  for (let i = 0; i < bytes.length; i++) {
    h = ((h << 5) - h + bytes[i]) | 0;
  }
  return {
    key: h,
    bytes,
    length: bytes.length,
  };
}

// ── client ────────────────────────────────────────────────────────────────

export class Client {
  readonly baseUrl: string;
  private headers: Record<string, string>;
  private timeout: number;
  private caches: Cache[];
  private results: Map<string, Result> = new Map();
  private backoff: Map<string, { until: number; failures: number }> = new Map();

  /**
   * Create a client.
   *
   * @param connect  Connection string — URL, URL#handshake, bearer token, or
   *                 URL#Key=val custom headers.  Defaults to TBR_CONNECT env.
   * @param timeout  Request timeout in ms.
   * @param caches   Cache backends.  null = default MemoryCache(256).  [] = none.
   */
  constructor(opts?: {
    connect?: string;
    timeout?: number;
    caches?: Cache[] | null;
  }) {
    const cfg = parseConnect(opts?.connect);
    this.baseUrl = cfg.baseUrl;
    this.headers = { "User-Agent": "thumbrella-client/0.1", ...cfg.headers };
    this.timeout = opts?.timeout ?? 30_000;
    this.caches = opts?.caches === undefined ? [new MemoryCache()] : opts.caches ?? [];
  }

  // ── public API ──────────────────────────────────────────────────────────

  /** Check connectivity.  Returns this for chaining. */
  async verify(): Promise<this> {
    const path = this.baseUrl === DEFAULT_BASE ? "/token" : "/health";
    const resp = await this.request("GET", path);
    const data = (await resp.json()) as { status?: string };
    if (data?.status !== "ok") {
      throw new VerifyError(`unexpected response: ${JSON.stringify(data)}`);
    }
    return this;
  }

  /** Fetch a thumbnail for a single URL.  Throws on failure. */
  async thumb(url: string): Promise<Result> {
    const [result] = await this.batch([url]);
    if (result.status !== Status.SUCCESS) {
      throw new ThumbError(
        `thumbnail failed for ${url}: ${result.status}` +
          (result.message ? ` — ${result.message}` : ""),
      );
    }
    return result;
  }

  /** Fetch thumbnails for multiple URLs in one request. */
  async batch(urls: string[]): Promise<Result[]> {
    const results = urls.map((u) => this.getOrCreate(u));

    const fetchIndices: number[] = [];
    const items: { url: string; cache?: string }[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      for (const cache of this.caches) {
        const cached = cache.get(r.url);
        if (cached && cached !== r) this.copyResult(cached, r);
      }
      if (r.isFresh()) {
        r.source = Source.CLIENT;
        continue;
      }
      fetchIndices.push(i);
      const item: { url: string; cache?: string } = { url: r.url };
      if (r.cache) item.cache = r.cache;
      items.push(item);
    }

    if (!items.length) return results;

    let body: { items?: Record<string, unknown>[] };
    try {
      const resp = await this.request("POST", "/batch", {
        body: JSON.stringify({ items }),
        headers: { "Content-Type": "application/json" },
      });
      body = (await resp.json()) as { items?: Record<string, unknown>[] };
    } catch (err) {
      if (err instanceof ConnectionError || err instanceof TimeoutError) {
        for (const i of fetchIndices) {
          setClientError(results[i], "server unreachable");
        }
        return results;
      }
      throw err;
    }

    for (let i = 0; i < results.length; i++) {
      const item = body.items?.[i];
      if (item) {
        updateFromJson(results[i], item);
        for (const cache of this.caches) cache.put(results[i]);
      }
    }
    return results;
  }

  /** Stream thumbnail results as they complete. */
  async *stream(urls: string[]): AsyncGenerator<Result> {
    const results = urls.map((u) => this.getOrCreate(u));
    const urlMap = new Map(results.map((r) => [r.url, r]));

    const items = urls.map((url, i) => {
      const r = results[i];
      return r.cache && r.isFresh()
        ? { url, cache: r.cache }
        : { url };
    });

    const req = this.buildRequest("POST", "/batch", {
      body: JSON.stringify({ items }),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
      },
    });

    const streamUrls = new Set(items.map((it) => it.url));
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const resp = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!resp.ok || !resp.body) {
        for (const url of streamUrls) {
          const r = urlMap.get(url);
          if (r) {
            setClientError(r, `stream error (${resp.status})`);
            yield r;
          }
        }
        return;
      }

      const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            yield* this.dispatchStreamEvent(trimmed, urlMap);
          } catch {
            // malformed event — skip
          }
        }
      }
      if (buffer.trim()) {
        try {
          yield* this.dispatchStreamEvent(buffer.trim(), urlMap);
        } catch {
          // ignore
        }
      }
    } catch (err) {
      for (const url of streamUrls) {
        const r = urlMap.get(url);
        if (r) {
          setClientError(r, "stream connection lost");
          yield r;
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Low-level HTTP request — build + execute in one call. */
  async request(
    method: string,
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const req = this.buildRequest(method, path, init);
    return this.execute(req);
  }

  /** Build a Request object without executing it. */
  buildRequest(method: string, path: string, init?: RequestInit): Request {
    const url = `${this.baseUrl}${path}`;
    const headers = new Headers(this.headers);
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers)) {
        headers.set(k, v);
      }
    }
    return new Request(url, { ...init, method, headers });
  }

  /** Execute a prepared Request with backoff. */
  private async execute(req: Request): Promise<Response> {
    const host = new URL(req.url).hostname;
    const state = this.backoff.get(host);
    if (state && Date.now() < state.until) {
      await new Promise((r) => setTimeout(r, state.until - Date.now()));
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    let resp: Response;
    try {
      resp = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if ((err as Error).name === "AbortError") {
        throw new TimeoutError(`request to ${host} timed out`);
      }
      throw new ConnectionError(`could not connect to ${host}: ${err}`);
    }
    clearTimeout(timeoutId);

    if (resp.status === 429 || resp.status === 503) {
      const failures = (state?.failures ?? 0) + 1;
      const delay = Math.min(2 ** failures * 1000, MAX_BACKOFF);
      this.backoff.set(host, { until: Date.now() + delay, failures });
    } else if (resp.ok) {
      this.backoff.delete(host);
    }

    return resp;
  }

  get cachesList(): readonly Cache[] {
    return this.caches;
  }

  clearCaches(): void {
    for (const c of this.caches) c.clear();
  }

  // ── internal ────────────────────────────────────────────────────────────

  private getOrCreate(url: string): Result {
    const existing = this.results.get(url);
    if (existing) return existing;
    const r = createResult(url);
    this.results.set(url, r);
    return r;
  }

  private *dispatchStreamEvent(
    line: string,
    urlMap: Map<string, Result>,
  ): Generator<Result> {
    const event = JSON.parse(line) as {
      type?: string;
      result?: Record<string, unknown>;
      url?: string;
      error?: string;
    };

    if (event.type === "item.result") {
      const item = event.result;
      if (item) {
        const url = item.url as string;
        const result = urlMap.get(url);
        if (result && item.status !== "intermediate") {
          updateFromJson(result, item);
          for (const cache of this.caches) cache.put(result);
          yield result;
        } else if (result) {
          yield result;
        }
      }
    } else if (event.type === "item.error") {
      const result = urlMap.get(event.url ?? "");
      if (result) {
        setClientError(result, event.error ?? "stream error");
        yield result;
      }
    }
  }

  private copyResult(src: Result, dst: Result): void {
    if (src === dst) return;
    dst.status = src.status;
    dst.sourceStatus = src.sourceStatus;
    dst.duration = src.duration;
    dst.downloadSize = src.downloadSize;
    dst.message = src.message;
    dst.strategy = src.strategy;
    dst.placeholder = src.placeholder;
    dst.mime = src.mime;
    dst.fileSize = src.fileSize;
    dst.kind = src.kind;
    dst.extension = src.extension;
    dst.properties = { ...src.properties };
    dst.cache = src.cache;
    dst.source = src.source;
    dst.thumbnail = src.thumbnail;
    dst.raw = { ...src.raw };
  }
}

// ── result helpers ────────────────────────────────────────────────────────

function createResult(url: string): Result {
  const thumb = makeThumb(new Uint8Array(0));
  return {
    url,
    status: Status.CLIENT_ERROR,
    sourceStatus: null,
    duration: 0,
    downloadSize: 0,
    message: null,
    strategy: null,
    placeholder: null,
    mime: null,
    fileSize: null,
    kind: null,
    extension: null,
    properties: {},
    cache: null,
    source: null,
    thumbnail: thumb,
    raw: {},
    isFresh() {
      if (!this.cache) return false;
      const colon = this.cache.indexOf(":");
      if (colon < 0) return false;
      const epoch = parseInt(this.cache.slice(0, colon), 16);
      return epoch > 0 && epoch > Date.now() / 1000;
    },
    isSuccess() {
      return this.status === Status.SUCCESS;
    },
  };
}

function updateFromJson(r: Result, raw: Record<string, unknown>): void {
  r.raw = raw;
  r.status = (raw.status as string) ?? Status.CLIENT_ERROR;
  r.sourceStatus = (raw.source_status as number) ?? null;
  r.duration = (raw.duration as number) ?? 0;
  r.downloadSize = (raw.download_size as number) ?? 0;
  r.message = (raw.message as string) ?? null;
  r.strategy = (raw.strategy as string) ?? null;
  r.placeholder = (raw.placeholder as string) ?? null;
  r.mime = (raw.mime as string) ?? null;
  r.fileSize = (raw.file_size as number) ?? null;
  r.kind = (raw.kind as string) ?? null;
  r.extension = (raw.extension as string) ?? null;
  r.properties = (raw.properties as Record<string, unknown>) ?? {};
  r.cache = (raw.cache as string) ?? null;
  r.source = (raw.source as string) ?? null;

  const thumb = raw.thumbnail as string | undefined;
  if (thumb) {
    r.thumbnail = decodeThumb(thumb);
  }
}

function setClientError(r: Result, message: string): void {
  r.status = Status.CLIENT_ERROR;
  r.message = message;
}
