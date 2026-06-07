import { Media } from "./types.js";

/**
 * Abstract result cache — stores Media objects, keyed by URL.
 */
export interface Cache {
  get(url: string): Media | undefined;
  put(media: Media): void;
  remove(url: string): void;
  clear(): void;
  readonly size: number;
  readonly hits: number;
  readonly misses: number;
}

/**
 * In-memory LRU-ish cache with a size limit.
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

  clear(): void {
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
