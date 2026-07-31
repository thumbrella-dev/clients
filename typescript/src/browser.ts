/// <reference lib="dom" />

/**
 * browser.ts — Browser-environment utilities for Thumbrella.
 *
 * Re-exports core types alongside helpers for working with thumbnails
 * in the browser: class toggling, data-URI access, image creation,
 * IndexedDB caching, shared Client singleton, and global configuration.
 *
 * For the one-tag custom-element setup see {@link ./element.ts}.
 */

import type { CacheBackend } from "./cache.js";
import { createMemoryCache } from "./cache.js";
import { Client, parseConnect } from "./api.js";
import { Result, Media, EncodedJpeg, Status, Source, FileKind } from "./types.js";

// Re-exports — everything you need in the browser from one import

export { Client, parseConnect } from "./api.js";
export { Result, Media, EncodedJpeg, Status, Source, FileKind } from "./types.js";
export { createMemoryCache } from "./cache.js";
export type { CacheBackend } from "./cache.js";

// Constants

/** 1x1 transparent pixel — prevents browsers from reloading the page when src="" is used. */
export const CLEAR_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Dark 5:4 SVG shown while a thumbnail is loading. */
export const PLACEHOLDER_SVG =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 4"><rect fill="#2a2d4a" width="5" height="4"/></svg>',
  );

// Global configuration

interface BrowserConfig {
  connect?: string;
  caches?: CacheBackend[];
}

const _config: BrowserConfig = {};

/**
 * Configure global defaults.
 *
 * Call once, early (before any `<tbr-thumb>` elements).
 *
 * ```ts
 * configure({ connect: "https://thumbrella.dev/api" });
 * ```
 */
export function configure(opts: BrowserConfig): void {
  if (opts.connect !== undefined) _config.connect = opts.connect;
  if (opts.caches !== undefined) _config.caches = opts.caches;
}

// IndexedDB cache

let _persistentCache: CacheBackend | null = null;

/**
 * Create a persistent thumbnail cache backed by IndexedDB.
 *
 * Mirrors {@link createMemoryCache} — returns a {@link CacheBackend}
 * that survives page reloads.  Pass it to a Client, or call this on its
 * own to push it onto the global configuration.
 *
 * @param maxMb  Maximum storage in megabytes (default 5).
 */
export function createBrowserCache(maxMb = 5): CacheBackend {
  return createIndexedDbCache(maxMb);
}

/**
 * Enable persistent thumbnail caching via IndexedDB on the global config.
 *
 * Pushes a {@link createBrowserCache IndexedDB cache} onto the global
 * configuration so it's shared by all thumbnails.  Call once — the cache
 * survives page reloads.
 *
 * @param maxMb  Maximum storage in megabytes (default 5).
 */
export function enablePersistentCache(maxMb = 5): CacheBackend {
  if (_persistentCache) return _persistentCache;
  _persistentCache = createBrowserCache(maxMb);
  if (_config.caches) {
    _config.caches.push(_persistentCache);
  } else {
    _config.caches = [_persistentCache];
  }
  return _persistentCache;
}

// Connect resolution

/**
 * Resolve the connect string for a custom element.
 *
 * Checks in order:
 * 1. The element's own `connect` attribute
 * 2. The global `TBR_CONNECT` on `window`
 * 3. `undefined`
 */
export function resolveConnect(el: HTMLElement): string | undefined {
  const attr = el.getAttribute("connect");
  if (attr) return attr;

  if (typeof window !== "undefined") {
    const global = (window as unknown as Record<string, string>).TBR_CONNECT;
    if (global) return global;
  }

  return undefined;
}

// Shared client

let _sharedClient: Client | null = null;

/**
 * Get (or create) a shared Thumbrella {@link Client} for the page.
 *
 * @param connect  Optional connect string (falls back to `window.TBR_CONNECT`).
 */
export function getClient(connect?: string): Client {
  if (!_sharedClient) {
    _sharedClient = new Client({
      connect: connect ??
        (typeof window !== "undefined"
          ? (window as unknown as Record<string, string>).TBR_CONNECT
          : undefined),
    });
  }
  return _sharedClient;
}

// Batched client — coalesces individual URL requests into batch HTTP calls

/** Maximum URLs submitted per batch request. */
const BATCH_LIMIT = 12;

/**
 * Turn a push-based callback stream into an `AsyncGenerator`.
 *
 * Call `push()` for each value and `done()` when the stream ends.
 * The returned `iter` can be consumed with `for await … of`.
 */
function createAsyncQueue<T>(): {
  push: (item: T) => void;
  done: () => void;
  iter: AsyncIterableIterator<T>;
} {
  const buffer: T[] = [];
  let waiter: ((v: IteratorResult<T>) => void) | null = null;
  let finished = false;

  const iter: AsyncIterableIterator<T> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(): Promise<IteratorResult<T>> {
      if (buffer.length > 0) {
        return { value: buffer.shift()!, done: false };
      }
      if (finished) {
        return { value: undefined as unknown as T, done: true };
      }
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    async return(
      value?: T | undefined,
    ): Promise<IteratorResult<T>> {
      finished = true;
      return { value: value as T, done: true };
    },
    async throw(
      e?: unknown,
    ): Promise<IteratorResult<T>> {
      finished = true;
      throw e;
    },
  };

  return {
    push(item: T) {
      if (waiter) {
        waiter({ value: item, done: false });
        waiter = null;
      } else {
        buffer.push(item);
      }
    },
    done() {
      finished = true;
      if (waiter) {
        waiter({ value: undefined as unknown as T, done: true });
        waiter = null;
      }
    },
    iter,
  };
}

/**
 * A {@link Client} wrapper that coalesces individual
 * {@link streamUrl} calls into batched HTTP requests.
 *
 * URLs submitted within the same microtask/macrotask boundary are
 * queued together and dispatched as a single `/batch` call.  Each
 * call site receives an independent `AsyncGenerator` that yields only
 * results for its own URL.
 *
 * ```ts
 * const bc = getBatchedClient("https://thumbrella.dev/api");
 * for await (const r of bc.streamUrl("https://example.com/a.jpg")) {
 *   console.log(r.status);
 * }
 * ```
 */
export class BatchedClient {
  readonly #client: Client;
  #pending = new Map<
    string,
    ReturnType<typeof createAsyncQueue<Result>>
  >();
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(client: Client) {
    this.#client = client;
  }

  /** The underlying (unbatched) {@link Client}. */
  get client(): Client {
    return this.#client;
  }

  /**
   * Stream results for a single URL.
   *
   * The URL is queued internally.  When the flush timer fires all
   * queued URLs are submitted together via {@link Client.stream}.
   * Results are routed back to the per-URL async generator returned
   * here.
   */
  streamUrl(url: string): AsyncIterableIterator<Result> {
    const existing = this.#pending.get(url);
    if (existing) return existing.iter;

    const q = createAsyncQueue<Result>();
    this.#pending.set(url, q);
    this.#scheduleFlush();
    return q.iter;
  }

  #scheduleFlush(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => this.#flush(), 0);
  }

  async #flush(): Promise<void> {
    this.#timer = null;

    const entries = [...this.#pending.entries()];
    if (entries.length === 0) return;
    this.#pending.clear();

    for (let i = 0; i < entries.length; i += BATCH_LIMIT) {
      const batch = entries.slice(i, i + BATCH_LIMIT);
      const urlMap = new Map(batch);

      try {
        for await (const result of this.#client.stream(
          batch.map(([u]) => u),
        )) {
          const q = urlMap.get(result.url);
          if (!q) continue;
          q.push(result);
          if (result.status !== Status.INTERMEDIATE) {
            q.done();
          }
        }
      } catch {
        for (const [url, q] of batch) {
          q.push(Result.clientFail(url, "batch request failed"));
          q.done();
        }
      }

      // Safety net — ensure every queue is closed
      for (const [, q] of batch) {
        q.done();
      }
    }
  }
}

// Singleton batched clients (keyed by connect string)

const _batchedClients = new Map<string, BatchedClient>();

/**
 * Get (or create) a shared {@link BatchedClient} for the page.
 *
 * Calls with the same `connect` return the same instance, so every
 * `<tbr-thumb>` element that shares a connect string also shares the
 * batching queue.
 *
 * @param connect  Optional connect string (falls back to `window.TBR_CONNECT`).
 */
export function getBatchedClient(connect?: string): BatchedClient {
  const key = connect || "__default__";
  let bc = _batchedClients.get(key);
  if (!bc) {
    bc = new BatchedClient(getClient(connect));
    _batchedClients.set(key, bc);
  }
  return bc;
}

// Markup & classes

const _TBR_CLASSES = [
  "tbr-loaded", "tbr-requested", "tbr-intermediate",
  "tbr-has-intermediate", "tbr-success", "tbr-failed",
  "tbr-overloaded", "tbr-unavailable", "tbr-offscreen",
];

/**
 * Apply lifecycle state classes from a {@link Result} to a DOM element.
 *
 * Removes all existing `tbr-*` classes first, then sets
 * `tbr-loaded` plus the status-specific class (`tbr-success`,
 * `tbr-failed`, etc.).
 */
export function applyResultClasses(el: HTMLElement, result: Result): void {
  el.classList.remove(..._TBR_CLASSES);
  el.classList.add("tbr-loaded", "tbr-" + result.status.toLowerCase());
}

// Image helpers

const _placeholderBlobs = new Map<number, string>();

/**
 * Return the "thumbnail unavailable" placeholder JPEG as a data URI.
 *
 * This is the same image embedded in every {@link Result} that fails —
 * useful when you need to show the failed state manually.
 */
export function failedPlaceholderDataUri(): string {
  return `data:image/jpeg;base64,${_FAILED_B64}`;
}

/**
 * Return a base64 data URI for the thumbnail inside a {@link Media}
 * object, or `null` if the media has no thumbnail data.
 */
export function mediaDataUri(media: Media | null): string | null {
  const thumb = media?.thumbnail;
  if (!thumb || thumb.length === 0) return null;
  return `data:image/jpeg;base64,${btoa(String.fromCharCode(...thumb.bytes))}`;
}

/**
 * Create an `<img>` element from a Media object's thumbnail.
 *
 * Returns `null` if the media has no thumbnail data.  When the media
 * represents a shared placeholder image, the blob URL is cached so
 * every call returns the same `<img>` resource.
 *
 * ```ts
 * const img = createThumbImg(result.media);
 * if (img) container.appendChild(img);
 * ```
 */
export function createThumbImg(media: Media | null): HTMLImageElement | null {
  const thumb = media?.thumbnail;
  if (!thumb || thumb.length === 0) return null;

  // Shared placeholder image — cache the blob URL so every call for
  // the same placeholder reuses one `<img>` resource.
  if (media!.placeholder) {
    const cached = _placeholderBlobs.get(thumb.key);
    const img = document.createElement("img");
    if (cached) {
      img.src = cached;
      return img;
    }
    const blobUrl = URL.createObjectURL(
      new Blob([thumb.bytes as BlobPart], { type: "image/jpeg" }),
    );
    _placeholderBlobs.set(thumb.key, blobUrl);
    img.src = blobUrl;
    return img;
  }

  const img = document.createElement("img");
  const blobUrl = URL.createObjectURL(
    new Blob([thumb.bytes as BlobPart], { type: "image/jpeg" }),
  );
  img.src = blobUrl;
  img.addEventListener("load", () => URL.revokeObjectURL(blobUrl), { once: true });
  return img;
}

// Internal helpers

// Embedded "thumbnail unavailable" placeholder JPEG (250x200).
const _FAILED_B64 =
  "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" +
  "0FoLQWgtBaC0FoDQWgNBaA0BoDQGggAIED//2Q==";

function createIndexedDbCache(maxMb: number): CacheBackend {
  const DB_NAME = "thumbrella-cache";
  const STORE_NAME = "thumbnails";

  let dbPromise: Promise<IDBDatabase> | null = null;

  function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE_NAME);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function estimateSize(): Promise<number> {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    let size = 0;
    return new Promise((resolve) => {
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          size += (cursor.value as Uint8Array).byteLength;
          cursor.continue();
        } else {
          resolve(size);
        }
      };
      cursorReq.onerror = () => resolve(size);
    });
  }

  async function evict(db: IDBDatabase, needed: number): Promise<void> {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const keys: string[] = [];
    return new Promise((resolve) => {
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          keys.push(cursor.key as string);
          cursor.continue();
        } else {
          let freed = 0;
          for (const key of keys) {
            if (freed >= needed) break;
            const val = (cursor as unknown as { value?: Uint8Array })?.value;
            if (val) freed += val.byteLength;
            store.delete(key);
          }
          resolve();
        }
      };
      cursorReq.onerror = () => resolve();
    });
  }

  const maxBytes = maxMb * 1024 * 1024;

  return {
    async get(key: string): Promise<Uint8Array | undefined> {
      try {
        const db = await openDb();
        return new Promise((resolve) => {
          const tx = db.transaction(STORE_NAME, "readonly");
          const req = tx.objectStore(STORE_NAME).get(key);
          req.onsuccess = () => resolve(req.result as Uint8Array | undefined);
          req.onerror = () => resolve(undefined);
        });
      } catch {
        return undefined;
      }
    },

    async set(key: string, value: Uint8Array): Promise<void> {
      try {
        const db = await openDb();
        const currentSize = await estimateSize();
        if (currentSize + value.byteLength > maxBytes) {
          await evict(db, currentSize + value.byteLength - maxBytes);
        }
        return new Promise((resolve) => {
          const tx = db.transaction(STORE_NAME, "readwrite");
          tx.objectStore(STORE_NAME).put(value, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        });
      } catch {
        // Silently fail — caching is best-effort.
      }
    },

    reset(): void {
      try {
        openDb().then(db => {
          const tx = db.transaction(STORE_NAME, "readwrite");
          tx.objectStore(STORE_NAME).clear();
        }).catch(() => {});
      } catch { /* best-effort */ }
    },
  };
}
