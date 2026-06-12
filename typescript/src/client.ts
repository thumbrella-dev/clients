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

/**
 * Thumbrella API client.
 *
 * A centralized configuration for a Thumbrella server and client-side caches.
 * The connection is described by a "connect string". By default this uses the
 * `$TBR_CONNECT` environment variable.
 *
 * Most thumbnails will be handled in batches with the {@link batch} or
 * {@link stream} methods. These will return (or iterate) a set of
 * {@link Result} objects, which can individually succeed, fail, or reuse
 * cached contents. All result objects will have a placeholder or failure
 * image, even if one could not be rendered.
 *
 * `stream()` is asynchronous and yields results as they complete.
 *
 * Creating the client makes no immediate connection to the server. When a
 * connection is misconfigured calls will still provide {@link Result} objects
 * with incomplete results. Use {@link verify} to ensure the configuration is
 * good, which will throw if there are server-side or client-side issues.
 *
 * A collection of caches can be passed to the client. These are integrated
 * with each of the lookup methods to improve performance. By default the
 * client will use a single {@link MemoryCache} with the default settings.
 * A client can also be created with no caching by explicitly passing an
 * empty array for the `caches` option.
 *
 * See https://thumbrella.dev/docs/client for full documentation.
 */
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

  /**
   * Check configuration and server connectivity.
   *
   * Check that the server is operational and the configuration string is
   * valid. If the connection string defines tokens or custom HTTP headers
   * those will also be validated.
   *
   * On success this returns itself, to allow method chaining.
   *
   * Usage:
   * ```ts
   * const tbr = await new Client().verify();
   * const result = await tbr.thumb(url);
   * ```
   *
   * @throws {VerifyError} if the server is unreachable or misconfigured.
   */
  async verify(): Promise<this> {
    const path = this.baseUrl === DEFAULT_BASE ? "/token" : "/health";
    const resp = await this.request("GET", path);
    const data = (await resp.json()) as { status?: string };
    if (data?.status !== "ok") {
      throw new VerifyError(`unexpected response: ${JSON.stringify(data)}`);
    }
    return this;
  }

  /**
   * Get a single URL result and fail if unsuccessful.
   *
   * This is a shortcut to regular {@link batch} for simple use cases. If
   * there is any problem generating a thumbnail this will result in an
   * exception, instead of a placeholder {@link Result}.
   *
   * Individual results can get the same effect by using {@link Result.verify}.
   *
   * This call waits for the result to complete before returning.
   *
   * See https://thumbrella.dev/docs/api/batch.html for server details.
   *
   * @throws {ThumbError} if the server returned an error for this URL.
   */
  async thumb(url: string): Promise<Result> {
    const [result] = await this.batch([url]);
    return result.verify();
  }

  /**
   * Generate multiple thumbnail results.
   *
   * Generate a list of {@link Result} objects for the given URLs. The returned
   * results are provided in the same order as the input URLs.
   *
   * This call waits for all results to complete before returning. For
   * incremental results, see the {@link stream} method.
   *
   * This call won't throw exceptions. On errors, results will be marked
   * with a failure status, but will still contain placeholder thumbnails.
   *
   * See https://thumbrella.dev/docs/api/batch.html for server details.
   */
  async batch(urls: string[]): Promise<Result[]> {
    const collected = new Map<string, Result>();
    for await (const r of this.stream(urls)) {
      if (r.status !== Status.INTERMEDIATE) {
        collected.set(r.url, r);
      }
    }
    return urls.map((u) => collected.get(u) ?? Result.clientFail(u, "no result"));
  }

  /**
   * Stream multiple thumbnail results as they complete.
   *
   * This efficiently provides thumbnail results as they become available.
   * Media that requires longer rendering can receive intermediate updates
   * and placeholders as they are processed.
   *
   * Every URL will receive at least one result in the iterator, on success
   * or failure. Some media also receives intermediate results as the
   * thumbnail is processed. That can be determined with
   * `result.status === Status.INTERMEDIATE`.
   *
   * See https://thumbrella.dev/docs/api/batch.html for server details.
   */
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

  /**
   * Reset all attached caches.
   *
   * The cache reset is intended to clear the cache contents and reset
   * statistics and tracking information.
   */
  resetCaches(): void {
    for (const c of this.caches) c.reset();
  }
}
