import { Media } from "./types.js";

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

  put(media: Media): void {
    const url = media.url;
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

/** Store media in all caches. */
export function putAllCaches(caches: readonly Cache[], media: Media | null): void {
  if (media) {
    for (const c of caches) c.put(media);
  }
}
