import { Media } from "./types.js";

/**
 * Canonical cache key for a URL.
 *
 * HTTP(S) URLs drop the query and fragment and lowercase the scheme and host,
 * so signed variants of one object share an entry.  Other values are used
 * unchanged.
 */
function cacheKey(raw: string): string {
  const sep = raw.indexOf("://");
  if (sep < 0) return raw;

  const scheme = raw.slice(0, sep).toLowerCase();
  if (scheme !== "http" && scheme !== "https") return raw;

  // Strip fragment then query.
  let rest = raw.slice(sep + 3);
  const hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.slice(0, hash);
  const query = rest.indexOf("?");
  if (query >= 0) rest = rest.slice(0, query);

  // Lowercase the host (everything before the first path slash).
  const slash = rest.indexOf("/");
  const host = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? "" : rest.slice(slash);
  return `${scheme}://${host.toLowerCase()}${path}`;
}

/**
 * Low-level byte cache backend.
 *
 * Caches operate on raw thumbnail bytes (Uint8Array). Both sync and async
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
 * Keys are opaque strings.  {@link mediaFromCaches}, {@link putAllCaches} and
 * {@link removeFromCaches} canonicalise a raw URL once for the whole stack, so
 * implementations store the key they are given and never normalise it
 * themselves.
 *
 * See https://thumbrella.dev/docs/cache for full documentation.
 */
export interface Cache {
  /** Get media stored under `key` */
  get(key: string): Media | undefined;
  /** Store `media` under `key` */
  put(key: string, media: Media): void;
  /** Remove the entry stored under `key`. */
  remove(key: string): void;
  /** Clear all entries and reset statistics. */
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

  get(key: string): Media | undefined {
    const media = this.store.get(key);
    if (!media) {
      this._misses++;
      return undefined;
    }
    this._hits++;
    this.order = this.order.filter((u) => u !== key);
    this.order.unshift(key);
    return media;
  }

  put(key: string, media: Media): void {
    if (!key) return;
    if (this.store.has(key)) {
      this.order = this.order.filter((u) => u !== key);
    } else if (this.store.size >= this.maxItems) {
      const stale = this.order.pop();
      if (stale) this.store.delete(stale);
    }
    this.store.set(key, media);
    this.order.unshift(key);
  }

  remove(key: string): void {
    this.store.delete(key);
    this.order = this.order.filter((u) => u !== key);
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

/**
 * Get cached media for a raw URL from a stack of caches.
 *
 * The URL is canonicalised once, so every cache in the stack sees the same
 * key.  A fresh entry wins over a stale one; otherwise the first entry found
 * is returned (its `cache` token is still useful for revalidation).
 */
export function mediaFromCaches(
  caches: readonly Cache[],
  url: string,
): Media | undefined {
  const key = cacheKey(url);
  let stale: Media | undefined;
  for (const cache of caches) {
    const media = cache.get(key);
    if (!media) continue;
    if (media.isFresh()) return media;
    stale ??= media;
  }
  return stale;
}

/** Store media in every cache under the raw URL's canonical key. */
export function putAllCaches(
  caches: readonly Cache[],
  url: string,
  media: Media | null,
): void {
  if (!media) return;
  const key = cacheKey(url);
  for (const c of caches) c.put(key, media);
}

/** Remove a raw URL from every cache in a stack. */
export function removeFromCaches(caches: readonly Cache[], url: string): void {
  const key = cacheKey(url);
  for (const c of caches) c.remove(key);
}
