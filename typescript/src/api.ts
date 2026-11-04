import type { ClientCache } from "./cache.js";
import { notifyRequest } from "./requests.js";
import {
  MemoryCache,
  mediaFromCaches,
  putAllCaches,
  removeFromCaches,
  requestIdentity,
} from "./cache.js";
import { CLIENT_MAJOR_MINOR } from "./version.js";
import type { ThumbRequest } from "./types.js";
import {
  Result,
  Media,
  EncodedJpeg,
  Status,
  Source,
  UNCACHED,
  VerifyError,
  ConnectionError,
  TimeoutError,
} from "./types.js";

//  constants 

const DEFAULT_BASE = "https://cloud.thumbrella.dev";
const MAX_BACKOFF_MS = 60_000;
const HTTP_TIMEOUT_MS = 12_000;
const BATCH_MAX_ITEMS = 12;


/**
 * Where the effective connect string came from.
 *
 * - `argument`: passed explicitly to the `Client` constructor.
 * - `env`: read from `$TBR_CONNECT` (or the `TBR_CONNECT` browser global).
 * - `default`: nothing was set, so the Thumbrella Cloud default is used.
 */
export type ConnectSource = "argument" | "env" | "default";

export function parseConnect(connect?: string): ConnectConfig {
  let raw: string;
  let source: ConnectSource;
  if (connect !== undefined) {
    raw = connect;
    source = "argument";
  } else {
    const env = envConnect();
    if (env) {
      raw = env;
      source = "env";
    } else {
      raw = DEFAULT_BASE;
      source = "default";
    }
  }

  if (!raw.trim()) {
    return { baseUrl: "", connect: raw, headers: {}, source };
  }

  // Bare value, no scheme.  Only auth tokens are valid without a URL.
  if (!raw.includes("://")) {
    if (isAuthToken(raw)) {
      return {
        baseUrl: DEFAULT_BASE,
        connect: raw,
        headers: { Authorization: `Bearer ${raw}` },
        source,
      };
    }
    throw new Error(
      "bare connect string without a URL must be an auth token (tbr_[a-z]_...)",
    );
  }

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
    } else if (isAuthToken(s)) {
      headers.Authorization = `Bearer ${s}`;
    } else {
      headers["x-tbr-handshake"] = s;
    }
  }

  return { baseUrl: urlPart.replace(/\/+$/, ""), connect: raw, headers, source };
}


//  client 

/**
 * Thumbrella API client.
 *
 * A centralized configuration for a Thumbrella server and client-side caches.
 * The connection is described by a "connect string". By default this uses the
 * `$TBR_CONNECT` environment variable.
 *
 * `stream()` is asynchronous and yields results as they complete.  Use
 * `batch()` if you need all results at once, or `thumb()` for a single URL.
 *
 * A collection of caches can be passed to the client. These are integrated
 * with each of the lookup methods to improve performance. By default the
 * client will use a single {@link MemoryCache} with the default settings.
 *
 * See https://thumbrella.dev/docs/client for full documentation.
 */
export class Client {
  readonly baseUrl: string;
  readonly connect: string;
  private headers: Record<string, string>;
  private caches: ClientCache[];
  private connectSource: ConnectSource;
  private verification: Promise<this> | undefined;

  constructor(connectOrOpts?: string | {
    connect?: string;
    caches?: ClientCache[] | null;
  }) {
    const opts = typeof connectOrOpts === "string"
      ? { connect: connectOrOpts }
      : connectOrOpts ?? {};

    const cfg = parseConnect(opts.connect);
    this.baseUrl = cfg.baseUrl;
    this.connect = cfg.connect;
    this.headers = {
      "User-Agent": `thumbrella-ts/${CLIENT_MAJOR_MINOR}`,
      ...cfg.headers,
    };
    this.connectSource = cfg.source;
    this.caches = opts.caches === undefined
      ? [new MemoryCache()]
      : [...(opts.caches ?? [])];
  }

  //  public API 

  /**
   * Check configuration and server connectivity.
   *
   * Check that the server is operational and the configuration string is
   * valid. If the connection string defines tokens or custom HTTP headers
   * those will also be validated.
   *
   * On success this returns itself, to allow method chaining.
   * An empty or whitespace-only connect string rejects without a request.
   *
   * Usage:
   * ```ts
   * const tbr = await new Client().verify();
   * const result = await tbr.thumb(url);
   * ```
   *
   * @throws {VerifyError} if the server is unreachable or misconfigured.
   */
  verify(): Promise<this> {
    if (this.verification) return this.verification;

    let verification: Promise<this>;
    verification = this.verifyOnce().finally(() => {
      if (this.verification === verification) this.verification = undefined;
    });
    this.verification = verification;
    return verification;
  }

  private async verifyOnce(): Promise<this> {
    if (!this.connect.trim()) throw new VerifyError("Connection string is empty");
    const resp = await this.request("GET", "/health");
    if (!resp.ok) {
      const statusText = resp.statusText ? ` ${resp.statusText.toLowerCase()}` : "";
      throw new VerifyError(
        `Connect server not responding (${resp.status}${statusText})`,
      );
    }
    let data: { status?: string; thumbrella?: number; token?: boolean };
    try {
      data = (await resp.json()) as { status?: string; thumbrella?: number; token?: boolean };
    } catch {
      throw new VerifyError("Connect is not a thumbrella server");
    }
    if (data?.thumbrella === undefined) {
      throw new VerifyError("Connect is not a thumbrella server");
    }
    if (data?.status !== "ok") {
      throw new VerifyError(`Connect unexpected response: ${JSON.stringify(data)}`);
    }
    if (data?.token === false) {
      throw new VerifyError(
        this.headers.Authorization
          ? "Thumbrella connect token is invalid"
          : this.missingTokenMessage(),
      );
    }
    return this;
  }

  /**
   * Explain why a token is missing, based on where the connect string came
   * from.  This points at the actual problem and how to fix it, instead of a
   * bare "requires a token" message.
   */
  private missingTokenMessage(): string {
    switch (this.connectSource) {
      case "default":
        return "Connection string $TBR_CONNECT is not defined "
          + "(set to server URL or Thumbrella Cloud token)";
      case "env":
        return "Connection string $TBR_CONNECT does not include a token "
          + "(Thumbrella Cloud requires one)";
      default:
        return "Connect string does not include a token "
          + "(Thumbrella Cloud requires one)";
    }
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
  async thumb(request: ThumbRequest): Promise<Result> {
    const [result] = await this.batch([request]);
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
  async batch(requests: readonly ThumbRequest[]): Promise<Result[]> {
    const resolved = requests.map(resolveRequest);
    const collected = new Map<string, Result>();
    for await (const r of this.stream(requests)) {
      if (r.status !== Status.INTERMEDIATE) {
        collected.set(resultIdentity(r), r);
        // Older servers omit `key`; remember the echoed URL as a fallback.
        collected.set(r.url, r);
      }
    }
    return resolved.map((r) =>
      collected.get(r.identity) ?? collected.get(r.url)
        ?? Result.clientFail(r.url, "no result", r.identity)
    );
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
   * URLs are automatically split into chunks of {@link BATCH_MAX_ITEMS}
   * to respect the server's per-request limit.
   *
   * See https://thumbrella.dev/docs/api/batch.html for server details.
   */
  async *stream(requests: readonly ThumbRequest[]): AsyncGenerator<Result> {
    // Split into server-sized chunks.
    for (let i = 0; i < requests.length; i += BATCH_MAX_ITEMS) {
      const chunk = requests.slice(i, i + BATCH_MAX_ITEMS);
      yield* this._streamChunk(chunk);
    }
  }

  /** Internal: stream a single chunk of at most BATCH_MAX_ITEMS requests. */
  private async *_streamChunk(requests: readonly ThumbRequest[]): AsyncGenerator<Result> {
    const resolved = requests.map(resolveRequest);
    const { done, stale } = await preflightUrls(resolved, this.caches);

    for (const request of resolved) {
      const r = done.get(request.identity);
      if (r) yield r;
    }

    if (stale.length === 0) return;

    const host = resolveHost(this.baseUrl);
    checkBackoff(host);

    const pending = new Map<string, ResolvedRequest>();
    for (const item of stale) pending.set(item.request.identity, item.request);
    const body = JSON.stringify({ items: stale.map((item) => item.wire) });
    const url = `${this.baseUrl}/batch`;
    try {
      notifyRequest(this, stale.map((item) => item.request.url));
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          ...this.headers,
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        body,
      });

      recordBackoff(host, resp.status === 429 || resp.status === 503);

      if (!resp.ok || !resp.body) {
        for (const request of pending.values()) {
          yield Result.clientFail(request.url, `stream error (${resp.status})`, request.identity);
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
          const resultData = parseBatchLine(trimmed);
          if (!resultData) continue;
          const itemUrl = resultData.url as string | undefined;
          const pendingRequest = findPending(
            pending,
            String(resultData.key ?? itemUrl ?? ""),
            itemUrl,
          );
          const cacheEnabled = pendingRequest ? !pendingRequest.noCache : true;
          const result = await resultFromServer(
            resultData, this.caches, this.baseUrl, url, cacheEnabled,
          );
          // Only a terminal result completes a request. Intermediate results
          // must not remove it from `pending`, otherwise an interrupted stream
          // leaves that element stuck in the loading state forever.
          if (itemUrl && resultData.status !== Status.INTERMEDIATE) {
            settlePending(pending, result, itemUrl);
          }
          yield result;
        }
      }
      if (buffer.trim()) {
        const resultData = parseBatchLine(buffer.trim());
        if (resultData) {
          const itemUrl = resultData.url as string | undefined;
          const pendingRequest = findPending(
            pending,
            String(resultData.key ?? itemUrl ?? ""),
            itemUrl,
          );
          const cacheEnabled = pendingRequest ? !pendingRequest.noCache : true;
          const result = await resultFromServer(
            resultData, this.caches, this.baseUrl, url, cacheEnabled,
          );
          if (itemUrl && resultData.status !== Status.INTERMEDIATE) {
            settlePending(pending, result, itemUrl);
          }
          yield result;
        }
      }
    } catch (error) {
      for (const request of pending.values()) {
        yield Result.clientFail(
          request.url,
          `stream connection lost: ${error}`,
          request.identity,
        );
      }
      pending.clear();
    }

    for (const request of pending.values()) {
      yield Result.clientFail(request.url, "stream connection lost", request.identity);
    }
  }

  //  HTTP 

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
    const host = resolveHost(req.url);
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

  get cachesList(): readonly ClientCache[] {
    return this.caches;
  }

  /** Replace the cache stack used by this client. */
  setCaches(caches: readonly ClientCache[]): void {
    this.caches = [...caches];
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

//
// Internal helpers
//

interface ConnectConfig {
  baseUrl: string;
  connect: string;
  headers: Record<string, string>;
  source: ConnectSource;
}

/** A request value flattened into the URL, optional key, and identity. */
interface ResolvedRequest {
  url: string;
  key?: string;
  identity: string;
  /** True when the caller supplied the `uncached` sentinel. */
  noCache: boolean;
  /** Base wire item, including any future per-request fields. */
  wire: WireItem;
}

/** Wire shape accepted by the server's `/batch` items array. */
interface WireItem {
  url: string;
  key?: string;
  cache?: string;
  [field: string]: unknown;
}

/**
 * Flatten a public request value.
 *
 * A caller-supplied key is used verbatim as the cache identity; otherwise the
 * canonical URL is used, matching the server.  Unknown fields are retained on
 * the wire item so future server options need no client change.
 */
function resolveRequest(request: ThumbRequest): ResolvedRequest {
  if (typeof request === "string") {
    return {
      url: request,
      identity: requestIdentity(request),
      noCache: false,
      wire: { url: request },
    };
  }
  const { key: rawKey, cache: rawCache, ...rest } = request;
  const key = rawKey?.trim() || undefined;
  const wire: WireItem = { ...rest, url: request.url };
  if (key) wire.key = key;
  else delete wire.key;
  if (typeof rawCache === "string") wire.cache = rawCache;
  else delete wire.cache;
  return {
    url: request.url,
    key,
    identity: requestIdentity(request.url, key),
    noCache: isUncached(rawCache),
    wire,
  };
}

/** True when the caller passed the `uncached` sentinel (trimmed, case-insensitive). */
function isUncached(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === UNCACHED;
}

/** Effective identity of a result, tolerating older servers without `key`. */
function resultIdentity(result: Result): string {
  return result.key || result.url;
}

/** Find the pending request matching a server result, if still pending. */
function findPending(
  pending: Map<string, ResolvedRequest>,
  identity: string,
  itemUrl: string | undefined,
): ResolvedRequest | undefined {
  const byIdentity = pending.get(identity);
  if (byIdentity) return byIdentity;
  if (!itemUrl) return undefined;
  for (const request of pending.values()) {
    if (request.url === itemUrl) return request;
  }
  return undefined;
}

/**
 * Remove a completed request from the pending map.
 *
 * New servers echo the request key, so identity matching is exact.  Older
 * servers omit it, so fall back to the echoed URL.
 */
function settlePending(
  pending: Map<string, ResolvedRequest>,
  result: Result,
  itemUrl: string,
): void {
  const request = findPending(pending, resultIdentity(result), itemUrl);
  if (request) pending.delete(request.identity);
}

/**
 * Read the ambient connect string from the environment.
 *
 * Checks the Node `$TBR_CONNECT` environment variable first, then the
 * `TBR_CONNECT` global when running in a browser.
 */
function envConnect(): string | undefined {
  if (typeof process !== "undefined" && process.env.TBR_CONNECT) {
    return process.env.TBR_CONNECT;
  }
  if (typeof window !== "undefined") {
    const global = (window as unknown as Record<string, string>).TBR_CONNECT;
    if (global) return global;
  }
  return undefined;
}

/** True when a value looks like a Thumbrella auth token (`tbr_[a-z]_` prefix). */
function isAuthToken(s: string): boolean {
  return /^tbr_[a-z]_/.test(s);
}

function resolveHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "local";
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

function isAbsolutePath(s: string): boolean {
  if (s.startsWith("/")) return true;
  if (s.startsWith("\\")) return true;
  return /^[a-zA-Z]:[/\\]/.test(s);
}

async function preflightUrls(
  requests: readonly ResolvedRequest[],
  caches: readonly ClientCache[],
): Promise<{
  done: Map<string, Result>;
  stale: { request: ResolvedRequest; wire: WireItem }[];
}> {
  const done = new Map<string, Result>();
  const stale: { request: ResolvedRequest; wire: WireItem }[] = [];

  for (const request of requests) {
    if (!request.url || (!request.url.includes("://") && !isAbsolutePath(request.url))) {
      done.set(request.identity, Result.clientFail(request.url, "invalid URL", request.identity));
      continue;
    }

    // "uncached" opts out of the client cache entirely; still send it.
    if (request.noCache) {
      stale.push({ request, wire: { ...request.wire } });
      continue;
    }

    const media = await mediaFromCaches(caches, request.url, request.key);
    if (media?.isFresh()) {
      const result = new Result({
        key: request.identity,
        url: request.url,
        status: Status.SUCCESS,
        source: Source.CACHE,
      });
      result.media = media;
      done.set(request.identity, result);
      continue;
    }

    // Stale - must go to server.  Future per-request fields ride along.  A
    // caller-supplied cache token wins over the client's internal token.
    const wire: WireItem = { ...request.wire };
    if (wire.cache === undefined && media?.cache) wire.cache = media.cache;
    stale.push({ request, wire });
  }

  return { done, stale };
}

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

/** Validate that a parsed JSON object is a streaming result (must have url + status). */
function parseBatchLine(line: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (typeof parsed === "object" && parsed !== null && "url" in parsed && "status" in parsed
    && typeof parsed.url === "string" && typeof parsed.status === "string") {
    return parsed;
  }
  return null;
}

async function resultFromServer(
  item: Record<string, unknown>,
  caches: readonly ClientCache[],
  serverKey: string,
  requestUrl: string,
  cacheEnabled = true,
): Promise<Result> {
  const r = new Result(item);
  if (r.pin !== null) {
    try {
      r.pin = new URL(r.pin, requestUrl).href;
    } catch (error) {
      return Result.clientFail(r.url, `invalid pin URL: ${error}`);
    }
  }
  const source = item.source as string | undefined;
  const placeholder = item.placeholder as string | undefined;
  const key = r.key || undefined;

  if (source === Source.NOT_MODIFIED) {
    const url = (item.url as string) ?? "";
    const media = cacheEnabled ? await mediaFromCaches(caches, url, key) : undefined;
    if (media) {
      const renewedCache = (item.media as Record<string, unknown> | undefined)?.cache;
      if (typeof renewedCache === "string") media.cache = renewedCache;
      r.media = media;
      if (renewedCache === "") {
        await removeFromCaches(caches, r.url, key);
      } else {
        await putAllCaches(caches, r.url, r.media, key);
      }
    }
    return r;
  }

  if (placeholder) {
    const mediaRaw = item.media as Record<string, unknown> | undefined;
    const thumbB64 = (mediaRaw?.thumbnail as string) ?? "";
    const thumb = placeholderThumb(serverKey, placeholder, thumbB64);
    const media = new Media(mediaRaw ?? {});
    media.thumbnail = thumb;
    media.placeholder = placeholder;
    r.media = media;
  }

  if (cacheEnabled && r.status !== Status.INTERMEDIATE) {
    // Intermediates are progress frames, not answers.  Caching one would let a
    // placeholder replace a final result.
    await putAllCaches(caches, r.url, r.media, key);
  }
  return r;
}


const _backoff = new Map<string, { until: number; failures: number }>();

function checkBackoff(host: string): void {
  const state = _backoff.get(host);
  if (state && Date.now() < state.until) {
    throw new ConnectionError(`${host} is throttled, retry later`);
  }
}
