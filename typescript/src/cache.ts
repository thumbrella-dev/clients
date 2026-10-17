import { Media } from "./types.js";

const AUTH_PARAMS = new Set([
  "auth", "authorization", "token", "access_token", "auth_token",
  "api_key", "apikey", "signature", "sig", "credential", "security_token",
  "expires", "expiry", "awsaccesskeyid", "googleaccessid", "policy", "key-pair-id",
]);
const SAS_PARAMS = new Set([
  "sv", "ss", "srt", "sp", "se", "st", "spr", "sip", "sr", "si",
  "skoid", "sktid", "skt", "ske", "sks", "skv", "saoid", "suoid", "scid",
]);

/**
 * Stable HTTP cache identity, without fragments or signing credentials.
 * Non-authentication query parameters (including their order) are preserved.
 * Local paths, non-HTTP URLs and malformed URLs are left unchanged.
 */
export function canonicalUrl(raw: string): string {
  if (!/^https?:\/\//i.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    if (error instanceof TypeError) return raw;
    throw error;
  }
  url.hash = "";
  const keys = [...url.searchParams.keys()];
  const sas = keys.some((key) => key.toLowerCase() === "sig");
  for (const key of keys) {
    const lower = key.toLowerCase();
    if (AUTH_PARAMS.has(lower) || lower.startsWith("x-amz-")
      || lower.startsWith("x-goog-") || (sas && SAS_PARAMS.has(lower))) {
      url.searchParams.delete(key);
    }
  }
  url.search = url.searchParams.toString();
  return url.href;
}

/**
 * Low-level byte cache backend.
 *
 * Caches operate on bytes (Uint8Array). The client serializes complete media
 * records, including thumbnail bytes and freshness metadata. Both sync and async
 * backends are supported — the caller always `await`s the result.
 *
 * Any object with matching `get`/`set` methods satisfies this interface
 * via structural typing — no need to `implement` or subclass.
 *
 * Usage:
 * ```ts
 * const cache: CacheBackend = createMemoryCache({ max: 500, ttl: 300_000 });
 * ```
 */
export interface CacheBackend {
  get(key: string): Uint8Array | undefined | Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): unknown | Promise<unknown>;
  /** Clear all cached entries and reset statistics. */
  reset(): void;
}

/** A media cache or a sync/async byte storage backend. */
export type ClientCache = Cache | CacheBackend;

// Inline LRU

interface LruEntry {
  value: Uint8Array;
  expires: number;
}

/**
 * Create an in-memory LRU cache for raw thumbnail bytes.
 *
 * A small, dependency-free LRU with TTL eviction.  The returned object
 * satisfies {@link CacheBackend} and can be passed directly to the DOM
 * coordinator, the web component, or a custom setup.
 *
 * Defaults: 500 entries, 5-minute TTL.
 */
export function createMemoryCache(
  opts?: { max?: number; ttl?: number },
): CacheBackend {
  const max = opts?.max ?? 500;
  const ttl = opts?.ttl ?? 300_000;
  const map = new Map<string, LruEntry>();
  const order: string[] = [];

  return {
    get(key: string): Uint8Array | undefined {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expires) {
        map.delete(key);
        const idx = order.indexOf(key);
        if (idx >= 0) order.splice(idx, 1);
        return undefined;
      }
      // Bump to front (LRU).
      const idx = order.indexOf(key);
      if (idx >= 0) order.splice(idx, 1);
      order.unshift(key);
      return entry.value;
    },

    set(key: string, value: Uint8Array): void {
      if (map.has(key)) {
        const idx = order.indexOf(key);
        if (idx >= 0) order.splice(idx, 1);
      } else if (map.size >= max) {
        const stale = order.pop();
        if (stale) map.delete(stale);
      }
      map.set(key, { value, expires: Date.now() + ttl });
      order.unshift(key);
    },

    reset(): void {
      map.clear();
      order.length = 0;
    },
  };
}

/**
 * Abstract base for result caches.
 *
 * Caches are passed to the {@link Client} when constructed. Each client works
 * with a stack of cache objects, and will use a small {@link MemoryCache}
 * by default.
 *
 * The caches offer limited management methods and simple statistics tracking
 * (`hits` / `misses`). A cache can be used with multiple clients at the
 * same time.
 *
 * See https://thumbrella.dev/docs/cache for full documentation.
 */
export interface Cache {
  /** Get the possible cached media for a URL. */
  get(url: string): Media | undefined;
  /** Store cached media for a URL. */
  put(media: Media): void;
  /** Remove possible cached media for a URL. */
  remove(url: string): void;
  /** Clear all cached URLs and reset statistics. */
  reset(): void;
  /** Number of cached entries. */
  readonly size: number;
  /** Number of cache hits since creation or last reset. */
  readonly hits: number;
  /** Number of cache misses since creation or last reset. */
  readonly misses: number;
}

/**
 * A small temporary cache for the current process.
 *
 * The default cache stores a small amount of thumbnails in memory. Nothing
 * is stored after the cache is removed.
 *
 * Each Thumbrella {@link Client} works with a stack of cache objects, assigned
 * at construction time. By default the client creates and uses this
 * `MemoryCache` with the default arguments.
 *
 * This cache uses an LRU strategy to keep the number of thumbnails within
 * the specified `maxItems` limit.
 *
 * Most thumbnails will use approximately 5 KB worth of data each.
 *
 * Usage:
 * ```ts
 * const cache = new MemoryCache(100);
 * const tbr = new Client({ caches: [cache] });
 * ```
 */
export class MemoryCache implements Cache {
  private maxItems: number;
  private store = new Map<string, Media>();
  private order: string[] = [];
  private _hits = 0;
  private _misses = 0;

  constructor(maxItems = 256) {
    this.maxItems = maxItems;
  }

  get(url: string): Media | undefined {
    url = canonicalUrl(url);
    const media = this.store.get(url);
    if (!media) {
      this._misses++;
      return undefined;
    }
    this._hits++;
    this.order = this.order.filter((u) => u !== url);
    this.order.unshift(url);
    return media;
  }

  put(media: Media, cacheUrl = media.url): void {
    const url = canonicalUrl(cacheUrl);
    if (!url) return;
    if (this.store.has(url)) {
      this.order = this.order.filter((u) => u !== url);
    } else if (this.store.size >= this.maxItems) {
      const stale = this.order.pop();
      if (stale) this.store.delete(stale);
    }
    this.store.set(url, media);
    this.order.unshift(url);
  }

  remove(url: string): void {
    url = canonicalUrl(url);
    this.store.delete(url);
    this.order = this.order.filter((u) => u !== url);
  }

  reset(): void {
    this.store.clear();
    this.order = [];
    this._hits = 0;
    this._misses = 0;
  }

  get size(): number { return this.store.size; }
  get hits(): number { return this._hits; }
  get misses(): number { return this._misses; }
}

/** Read media using a canonical key from either cache API. */
export async function getCachedMedia(cache: ClientCache, url: string): Promise<Media | undefined> {
  try {
    const value = await cache.get(canonicalUrl(url));
    if (value === undefined || value instanceof Media) return value;
    return new Media(JSON.parse(new TextDecoder().decode(value)) as Record<string, unknown>);
  } catch (error) {
    if (!(error instanceof DOMException || error instanceof SyntaxError)) throw error;
    console.warn("Thumbrella cache read failed", error);
    return undefined;
  }
}

/** Store media in all caches, keyed by the original request URL when supplied. */
export async function putAllCaches(
  caches: readonly ClientCache[],
  media: Media | null,
  url = media?.url ?? "",
): Promise<void> {
  if (media) {
    const key = canonicalUrl(url);
    const cached = media.url === key ? media : Object.assign(new Media({}), media, { url: key });
    let bytes: Uint8Array | undefined;
    for (const c of caches) {
      if (c instanceof MemoryCache) {
        c.put(media, key);
      } else if ("put" in c) {
        c.put(cached);
      } else {
        bytes ??= new TextEncoder().encode(JSON.stringify({
          url: key,
          mime: media.mime,
          file_size: media.fileSize,
          kind: media.kind,
          extension: media.extension,
          properties: media.properties,
          cache: media.cache,
          placeholder: media.placeholder,
          thumbnail: btoa(Array.from(media.thumbnail.bytes, (b) => String.fromCharCode(b)).join("")),
        }));
        try {
          await c.set(key, bytes);
        } catch (error) {
          if (!(error instanceof DOMException || error instanceof RangeError)) throw error;
          console.warn("Thumbrella cache write failed", error);
        }
      }
    }
  }
}
