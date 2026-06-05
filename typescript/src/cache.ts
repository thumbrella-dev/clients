import type { Result } from "./types.js";

/**
 * Abstract result cache — reduce server round-trips for repeated URLs.
 */
export interface Cache {
  get(url: string): Result | undefined;
  put(result: Result): void;
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
  private store: Map<string, Result> = new Map();
  private order: string[] = [];
  private _hits = 0;
  private _misses = 0;

  constructor(maxItems = 256) {
    this.maxItems = maxItems;
  }

  get(url: string): Result | undefined {
    const result = this.store.get(url);
    if (!result) {
      this._misses++;
      return undefined;
    }
    this._hits++;
    this.order = this.order.filter((u) => u !== url);
    this.order.unshift(url);
    return result;
  }

  put(result: Result): void {
    const { url } = result;
    if (this.store.has(url)) {
      this.order = this.order.filter((u) => u !== url);
    } else if (this.store.size >= this.maxItems) {
      const stale = this.order.pop();
      if (stale) this.store.delete(stale);
    }
    this.store.set(url, result);
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

  get size(): number {
    return this.store.size;
  }
  get hits(): number {
    return this._hits;
  }
  get misses(): number {
    return this._misses;
  }
}
