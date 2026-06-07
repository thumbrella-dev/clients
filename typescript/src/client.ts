import type { Cache } from "./cache.js";
import { MemoryCache, putAllCaches } from "./cache.js";
import {
  Result,
  Media,
  EncodedJpeg,
  Status,
  Source,
  ThumbError,
  VerifyError,
  ConnectionError,
  TimeoutError,
} from "./types.js";

// ── constants ────────────────────────────────────────────────────────────

const DEFAULT_BASE = "http://api.thumbrella.dev/";
const MAX_BACKOFF_MS = 60_000;
const HTTP_TIMEOUT_MS = 12_000;

// ── global backoff ───────────────────────────────────────────────────────

const _backoff = new Map<string, { until: number; failures: number }>();

function checkBackoff(host: string): void {
  const state = _backoff.get(host);
  if (state && Date.now() < state.until) {
    throw new ConnectionError(`${host} is throttled, retry later`);
  }
}

function recordBackoff(host: string, throttled: boolean): void {
  if (throttled) {
    const state = _backoff.get(host);
    const failures = (state?.failures ?? 0) + 1;
    const delay = Math.min(2 ** failures * 1000, MAX_BACKOFF_MS);
    _backoff.set(host, { until: Date.now() + delay, failures });
  } else {
    _backoff.delete(host);
  }
}

// ── connect string parsing ───────────────────────────────────────────────

interface ConnectConfig {
  baseUrl: string;
  headers: Record<string, string>;
}

export function parseConnect(connect?: string): ConnectConfig {
  const raw = connect
    || (typeof process !== "undefined" && process.env.TBR_CONNECT)
    || DEFAULT_BASE;

  // Bearer token — no scheme.
  if (!raw.includes("://")) {
    return {
      baseUrl: DEFAULT_BASE,
      headers: { Authorization: `Bearer ${raw}` },
    };
  }

  // Split on first comma to separate URL from optional suffix.
  let urlPart = raw;
  let suffix = "";
  const comma = raw.indexOf(",");
  if (comma >= 0) {
    urlPart = raw.slice(0, comma);
    suffix = raw.slice(comma + 1);
  }

  const headers: Record<string, string> = {};
  for (const seg of suffix.split(",")) {
    const s = seg.trim();
    if (!s) continue;
    const eq = s.indexOf("=");
    if (eq >= 0) {
      headers[s.slice(0, eq).trim()] = s.slice(eq + 1).trim();
    } else {
      headers.Authorization = `Bearer ${s}`;
    }
  }

  return { baseUrl: urlPart.replace(/\/+$/, ""), headers };
}

// ── placeholder cache ────────────────────────────────────────────────────

const placeholderCache = new Map<string, Map<string, EncodedJpeg>>();

function placeholderThumb(
  serverKey: string,
  placeholder: string,
  b64: string,
): EncodedJpeg {
  let pool = placeholderCache.get(serverKey);
  if (!pool) {
    pool = new Map();
    placeholderCache.set(serverKey, pool);
  }
  const existing = pool.get(placeholder);
  if (existing) return existing;
  const blob = new EncodedJpeg({ b64 });
  pool.set(placeholder, blob);
  return blob;
}

// ── result construction ──────────────────────────────────────────────────

function mediaFromCaches(url: string, caches: readonly Cache[]): Media | undefined {
  for (const cache of caches) {
    const m = cache.get(url);
    if (m) return m;
  }
  return undefined;
}

function resultFromServer(
  item: Record<string, unknown>,
  caches: readonly Cache[],
  serverKey: string,
): Result {
  const source = item.source as string | undefined;
  const placeholder = item.placeholder as string | undefined;

  if (source === Source.NOT_MODIFIED) {
    const url = (item.url as string) ?? "";
    const media = mediaFromCaches(url, caches);
    if (media) {
      const r = new Result(item);
      r.media = media;
      putAllCaches(caches, r.media);
      return r;
    }
  }

  if (placeholder) {
    const mediaRaw = item.media as Record<string, unknown> | undefined;
    const thumbB64 = (mediaRaw?.thumbnail as string) ?? "";
    const thumb = placeholderThumb(serverKey, placeholder, thumbB64);
    const media = new Media(mediaRaw ?? {});
    media.thumbnail = thumb;
    const r = new Result(item);
    r.media = media;
    putAllCaches(caches, r.media);
    return r;
  }

  const r = new Result(item);
  putAllCaches(caches, r.media);
  return r;
}

// ── preflight ────────────────────────────────────────────────────────────

function preflightUrls(
  urls: string[],
  caches: readonly Cache[],
): { done: Map<string, Result>; stale: { url: string; cache?: string }[] } {
  const done = new Map<string, Result>();
  const stale: { url: string; cache?: string }[] = [];

  for (const url of urls) {
    if (!url || !url.includes("://")) {
      done.set(url, Result.clientFail(url, "invalid URL"));
      continue;
    }

    let fresh = false;
    for (const cache of caches) {
      const media = cache.get(url);
      if (media?.isFresh()) {
        done.set(
          url,
          new Result({ url, status: Status.SUCCESS, source: Source.CACHE }),
        );
        // Attach the cached media.
        done.get(url)!.media = media;
        fresh = true;
        break;
      }
    }
    if (fresh) continue;

    const item: { url: string; cache?: string } = { url };
    for (const cache of caches) {
      const media = cache.get(url);
      if (media?.cache) {
        item.cache = media.cache;
        break;
      }
    }
    stale.push(item);
  }

  return { done, stale };
}

// ── client ────────────────────────────────────────────────────────────────

export class Client {
  readonly baseUrl: string;
  private headers: Record<string, string>;
  private caches: Cache[];

  constructor(opts?: {
    connect?: string;
    caches?: Cache[] | null;
  }) {
    const cfg = parseConnect(opts?.connect);
    this.baseUrl = cfg.baseUrl;
    this.headers = { "User-Agent": "thumbrella-ts/0.1", ...cfg.headers };
    this.caches = opts?.caches === undefined
      ? [new MemoryCache()]
      : opts?.caches ?? [];
  }

  // ── public API ──────────────────────────────────────────────────────────

  async verify(): Promise<this> {
    const path = this.baseUrl === DEFAULT_BASE ? "/token" : "/health";
    const resp = await this.request("GET", path);
    const data = (await resp.json()) as { status?: string };
    if (data?.status !== "ok") {
      throw new VerifyError(`unexpected response: ${JSON.stringify(data)}`);
    }
    return this;
  }

  async thumb(url: string): Promise<Result> {
    const [result] = await this.batch([url]);
    return result.verify();
  }

  async batch(urls: string[]): Promise<Result[]> {
    const collected = new Map<string, Result>();
    for await (const r of this.stream(urls)) {
      if (r.status !== Status.INTERMEDIATE) {
        collected.set(r.url, r);
      }
    }
    return urls.map((u) => collected.get(u) ?? Result.clientFail(u, "no result"));
  }

  async *stream(urls: string[]): AsyncGenerator<Result> {
    const { done, stale } = preflightUrls(urls, this.caches);

    for (const url of urls) {
      const r = done.get(url);
      if (r) yield r;
    }

    if (stale.length === 0) return;

    const host = new URL(this.baseUrl).hostname;
    checkBackoff(host);

    const pending = new Set(stale.map((s) => s.url));
    const body = JSON.stringify({ items: stale });
    const url = `${this.baseUrl}/batch`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          ...this.headers,
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      recordBackoff(host, resp.status === 429 || resp.status === 503);

      if (!resp.ok || !resp.body) {
        for (const url of pending) {
          yield Result.clientFail(url, `stream error (${resp.status})`);
        }
        return;
      }

      const reader = resp.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
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
            const envelope = JSON.parse(trimmed) as Record<string, unknown>;
            const kind = envelope.type as string | undefined;
            const resultData = envelope.result as Record<string, unknown> | undefined;
            if (!resultData || (kind !== "item.intermediate" && kind !== "item.result")) {
              continue;
            }
            const itemUrl = resultData.url as string | undefined;
            if (itemUrl && kind === "item.result") {
              pending.delete(itemUrl);
            }
            yield resultFromServer(resultData, this.caches, this.baseUrl);
          } catch {
            // skip malformed lines
          }
        }
      }
      if (buffer.trim()) {
        try {
          const envelope = JSON.parse(buffer.trim());
          const resultData = envelope.result as Record<string, unknown> | undefined;
          if (resultData && (envelope.type === "item.intermediate" || envelope.type === "item.result")) {
            const itemUrl = resultData.url as string | undefined;
            if (itemUrl) pending.delete(itemUrl);
            yield resultFromServer(resultData, this.caches, this.baseUrl);
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // stream interrupted
    } finally {
      clearTimeout(timeoutId);
    }

    for (const url of pending) {
      yield Result.clientFail(url, "stream connection lost");
    }
  }

  // ── HTTP ────────────────────────────────────────────────────────────────

  async request(
    method: string,
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const req = this.buildRequest(method, path, init);
    return this.execute(req);
  }

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

  private async execute(req: Request): Promise<Response> {
    const host = new URL(req.url).hostname;
    checkBackoff(host);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

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

    recordBackoff(host, resp.status === 429 || resp.status === 503);
    return resp;
  }

  get cachesList(): readonly Cache[] {
    return this.caches;
  }

  clearCaches(): void {
    for (const c of this.caches) c.clear();
  }
}
