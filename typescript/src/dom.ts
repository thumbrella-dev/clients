/// <reference lib="dom" />

/**
 * dom.ts — Browser DOM coordinator for Thumbrella thumbnails.
 *
 * Scans for `[data-tbr-url]` elements inside a root container, batches them
 * into streaming requests, and updates each element as results arrive.
 *
 * Two usage modes:
 *
 *   **Light DOM** — call `initThumbnails(root)` on a container.  The
 *   coordinator scans for existing `[data-tbr-url]` elements and observes
 *   mutations so dynamically-added elements are picked up automatically.
 *
 *   **Helper** — call `createThumbMarkup(url, name)` to generate the
 *   `.tbr-wrap` inner HTML for a single thumbnail.  Use this in your own
 *   templating / component code.
 *
 * Lifecycle classes applied to each `.tbr-wrap` element:
 *
 *   tbr-paused       initial state — not yet queued
 *   tbr-offscreen    outside the viewport (added by IntersectionObserver)
 *   tbr-requested    URL has been sent to the server
 *   tbr-success      server returned a successful thumbnail
 *   tbr-failed       server could not generate a thumbnail
 *   tbr-intermediate streaming progress update
 *   tbr-overloaded   server is busy, retry later
 *   tbr-unavailable  media URL is not reachable
 */

import { Client, parseConnect } from "./client.js";
import { Status } from "./types.js";
import type { CacheBackend } from "./cache.js";
import { createMemoryCache } from "./cache.js";

// ── global configuration ──────────────────────────────────────────────────

interface ThumbDomConfig {
  /** Thumbrella connect string.  Falls back to `window.THR_CONNECT`. */
  connect?: string;
  /** Byte-level cache backends shared across all thumbnails. */
  caches?: CacheBackend[];
  /** Default lazy-load behaviour (can be overridden per element). */
  lazy?: boolean;
}

const _config: ThumbDomConfig = {};

/**
 * Configure global defaults for all Thumbrella DOM components on the page.
 *
 * Call this once, early (before any `<thumbrella-thumb>` elements or
 * `initThumbnails()` calls).  Settings can be overridden per element via
 * attributes.
 *
 * ```ts
 * Thumbnail.configure({ connect: "https://thumbrella.dev/api" });
 * ```
 */
export function configure(opts: ThumbDomConfig): void {
  if (opts.connect !== undefined) _config.connect = opts.connect;
  if (opts.caches !== undefined) _config.caches = opts.caches;
  if (opts.lazy !== undefined) _config.lazy = opts.lazy;
}

// ── persistent cache (IndexedDB) ──────────────────────────────────────────

let _persistentCache: CacheBackend | null = null;

/**
 * Enable persistent thumbnail caching via IndexedDB.
 *
 * Call this once.  Subsequent calls increase the max size if the argument
 * is larger than the current value.  The cache survives page reloads.
 *
 * @param maxMb  Maximum storage in megabytes (default 5).
 */
export function enablePersistentCache(maxMb = 5): CacheBackend {
  if (_persistentCache) return _persistentCache;
  _persistentCache = createIndexedDbCache(maxMb);
  if (_config.caches) {
    _config.caches.push(_persistentCache);
  } else {
    _config.caches = [_persistentCache];
  }
  return _persistentCache;
}

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
          // Delete oldest entries until we have room.
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
  };
}

// ── connect-string resolution ─────────────────────────────────────────────

function resolveConnect(el: HTMLElement): string | undefined {
  // 1. Per-element attribute.
  const attr = el.getAttribute("connect") || el.dataset.tbrConnect;
  if (attr) return attr;

  // 2. Nearest ancestor with data-tbr-connect.
  let parent = el.parentElement;
  while (parent) {
    const p = (parent as HTMLElement).dataset.tbrConnect;
    if (p) return p;
    parent = parent.parentElement;
  }

  // 3. Global configure() call.
  if (_config.connect) return _config.connect;

  // 4. Window fallback.
  if (typeof window !== "undefined" && (window as unknown as Record<string, string>).TBR_CONNECT) {
    return (window as unknown as Record<string, string>).TBR_CONNECT;
  }

  return undefined;
}

// ── shared client ─────────────────────────────────────────────────────────

let _sharedClient: Client | null = null;

function sharedClient(): Client {
  if (!_sharedClient) {
    _sharedClient = new Client({
      connect: _config.connect ??
        (typeof window !== "undefined"
          ? (window as unknown as Record<string, string>).TBR_CONNECT
          : undefined),
      cacheBackends: _config.caches?.length
        ? _config.caches
        : [createMemoryCache()],
    });
  }
  return _sharedClient;
}

// ── placeholder blob URL cache ────────────────────────────────────────────

const _placeholderBlobs = new Map<number, string>();

function placeholderBlobUrl(key: number, bytes: Uint8Array): string {
  const cached = _placeholderBlobs.get(key);
  if (cached) return cached;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
  _placeholderBlobs.set(key, url);
  return url;
}

// ── DOM helpers ───────────────────────────────────────────────────────────

function findWrap(el: Element): Element | null {
  return el.closest?.(".tbr-wrap") ?? null;
}

/**
 * Apply an intermediate (streaming preview) thumbnail to the placeholder image.
 */
function applyThumbnail(el: Element, result: import("./types.js").Result): void {
  const placeholderImg = el.querySelector?.<HTMLImageElement>(".tbr-placeholder");
  if (!placeholderImg) return;
  const thumb = result.media?.thumbnail;
  if (!thumb) return;

  const isPlaceholder = result.source === "placeholder";
  const blobUrl = isPlaceholder
    ? placeholderBlobUrl(thumb.key, thumb.bytes)
    : URL.createObjectURL(new Blob([thumb.bytes as BlobPart], { type: "image/jpeg" }));

  const old = placeholderImg.src.startsWith("blob:") ? placeholderImg.src : null;
  placeholderImg.src = blobUrl;
  if (old && old !== blobUrl) URL.revokeObjectURL(old);

  const wrap = findWrap(el) ?? el;
  wrap.classList.add("tbr-has-intermediate");
}

function applyResult(el: Element, result: import("./types.js").Result): void {
  const wrap = findWrap(el) ?? el;
  if (!wrap) return;

  wrap.classList.remove("tbr-paused", "tbr-offscreen", "tbr-requested");
  wrap.classList.add("tbr-loaded", "tbr-" + result.status.toLowerCase());
  if (result.source) wrap.classList.add("tbr-source-" + result.source);
  if (result.media?.kind) wrap.classList.add("tbr-kind-" + result.media.kind);

  const htmlEl = el as HTMLElement;
  htmlEl.dataset.tbrLoaded = "true";
  htmlEl.dataset.tbrStatus = result.status;
  if (result.source) htmlEl.dataset.tbrSource = result.source;
  if (result.media?.kind) htmlEl.dataset.tbrKind = result.media.kind;

  const img =
    el.querySelector?.<HTMLImageElement>(".tbr-final") ??
    el.querySelector?.<HTMLImageElement>("img") ??
    (el instanceof HTMLImageElement ? el : null);

  if (img && result.media?.thumbnail) {
    const { bytes, key } = result.media.thumbnail;
    const isPlaceholder = result.source === "placeholder";
    const blobUrl = isPlaceholder
      ? placeholderBlobUrl(key, bytes)
      : URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/jpeg" }));

    const old = img.src.startsWith("blob:") ? img.src : null;
    img.src = blobUrl;
    if (old && old !== blobUrl) URL.revokeObjectURL(old);

    htmlEl.dataset.tbrBytes = String(bytes.length);

    el.dispatchEvent(
      new CustomEvent("tbr:loaded", {
        bubbles: true,
        detail: {
          url: result.url,
          status: result.status,
          source: result.source ?? null,
          kind: result.media.kind ?? null,
          duration: result.duration ?? null,
          message: result.message ?? null,
          bytes: bytes.length,
          placeholder: isPlaceholder,
        },
      }),
    );
  }
}

// ── lazy-load ─────────────────────────────────────────────────────────────

function shouldLazy(el: HTMLElement, parentLazy: boolean): boolean {
  if (el.dataset.tbrLazy === "true") return true;
  if (el.dataset.tbrLazy === "false") return false;
  return parentLazy;
}

// ── lazy observer (shared across all initThumbnails calls) ─────────────

let _observer: IntersectionObserver | null = null;

// ── main ──────────────────────────────────────────────────────────────────

interface InitOptions {
  /** Thumbrella connect string. */
  connect?: string;
  /** Only load thumbnails when scrolled into view. */
  lazy?: boolean;
}

/**
 * Initialise the Thumbrella coordinator on a root element.
 *
 * Scans for child elements with `[data-tbr-url]` and streams thumbnails
 * from the configured Thumbrella server.  Dynamically-added elements are
 * picked up via a `MutationObserver`.
 *
 * Returns a cleanup function that disconnects the observer.
 *
 * ```ts
 * import { initThumbnails } from "@thumbrella/client/dom";
 * const cleanup = initThumbnails(document.getElementById("gallery"));
 * ```
 */
export function initThumbnails(
  root: HTMLElement,
  opts?: InitOptions,
): () => void {
  if (root.dataset.tbrInit) return () => {};
  root.dataset.tbrInit = "true";

  const lazy = opts?.lazy ?? _config.lazy ?? false;
  const client = sharedClient();
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function scan() {
    if (pending) return;
    pending = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush(root, client).finally(() => {
        pending = false;
      });
    }, 50);
  }

  const mo = new MutationObserver(() => scan());
  mo.observe(root, { childList: true, subtree: true });

  // Lazy-load observer (one shared across all initThumbnails calls).
  if (lazy && !_observer) {
    _observer = new IntersectionObserver(
      (entries) => {
        let needsScan = false;
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          if (entry.isIntersecting) {
            el.classList.remove("tbr-offscreen");
            needsScan = true;
          } else {
            el.classList.add("tbr-offscreen");
          }
        }
        if (needsScan) scan();
      },
      { rootMargin: "200px" },
    );
  }

  // Register elements for lazy observation.
  if (lazy && _observer) {
    const observeRecursive = (node: Node) => {
      if (node instanceof HTMLElement && node.dataset.tbrUrl) {
        _observer!.observe(node);
      }
      node.childNodes.forEach(observeRecursive);
    };
    observeRecursive(root);
    mo.observe(root, { childList: true, subtree: true });
  }

  scan();

  return () => mo.disconnect();
}

async function flush(root: HTMLElement, client: Client): Promise<void> {
  const all = Array.from(
    root.querySelectorAll<HTMLElement>("[data-tbr-url]"),
  );

  // Collect URLs needing fresh thumbnails.
  const targets: { el: HTMLElement; url: string; connect?: string }[] = [];
  const cachedResults: { el: HTMLElement; bytes: Uint8Array }[] = [];

  for (const el of all) {
    if (el.dataset.tbrLoaded === "true") continue;
    const url = el.dataset.tbrUrl;
    if (!url) continue;

    // Check byte-level caches first (in-memory + IndexedDB).
    const caches = client.cacheBackends;
    let found = false;
    for (const cache of caches) {
      const hit = await cache.get(cacheKey(url));
      if (hit) {
        cachedResults.push({ el, bytes: hit });
        found = true;
        break;
      }
    }
    if (found) {
      el.classList.add("tbr-requested");
      continue;
    }

    targets.push({ el, url, connect: resolveConnect(el) });
  }

  // Apply cached results immediately.
  for (const { el, bytes } of cachedResults) {
    applyCachedResult(el, bytes);
  }

  if (targets.length === 0) return;

  // Group targets by connect string — most pages use only one.
  const groups = new Map<string | undefined, typeof targets>();
  for (const t of targets) {
    const key = t.connect ?? client.baseUrl;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(t);
  }

  for (const [connect, group] of groups) {
    const c = connect && connect !== client.baseUrl
      ? new Client({ connect, cacheBackends: client.cacheBackends })
      : client;

    const urlMap = new Map<string, HTMLElement[]>();
    for (const { el, url } of group) {
      el.classList.add("tbr-requested");
      let arr = urlMap.get(url);
      if (!arr) {
        arr = [];
        urlMap.set(url, arr);
      }
      arr.push(el);
    }

    try {
      for await (const result of c.stream(Array.from(urlMap.keys()))) {
        const els = urlMap.get(result.url);
        if (!els) continue;

        // Store successful thumbnails in byte-level caches.
        if (result.status === Status.SUCCESS && result.media?.thumbnail) {
          const bytes = result.media.thumbnail.bytes;
          const key = cacheKey(result.url);
          for (const cache of c.cacheBackends) {
            try { await cache.set(key, bytes); } catch { /* best-effort */ }
          }
        }

        if (result.status === Status.INTERMEDIATE) {
          for (const el of els) {
            el.classList.add("tbr-intermediate");
            applyThumbnail(el, result);
          }
        } else {
          for (const el of els) {
            applyResult(el, result);
          }
        }
      }
    } catch {
      for (const els of urlMap.values()) {
        for (const el of els) {
          el.classList.add("tbr-unavailable");
          el.dataset.tbrLoaded = "true";
          el.dataset.tbrStatus = "unavailable";
        }
      }
    }
  }
}

// ── apply cached bytes to DOM ─────────────────────────────────────────────

function applyCachedResult(el: HTMLElement, bytes: Uint8Array): void {
  const img =
    el.querySelector?.<HTMLImageElement>(".tbr-final") ??
    el.querySelector?.<HTMLImageElement>("img") ??
    (el instanceof HTMLImageElement ? el : null);

  if (img) {
    const blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
    const old = img.src.startsWith("blob:") ? img.src : null;
    img.src = blobUrl;
    if (old && old !== blobUrl) URL.revokeObjectURL(old);
  }

  const wrap = findWrap(el) ?? el;
  wrap.classList.remove("tbr-paused", "tbr-offscreen", "tbr-requested");
  wrap.classList.add("tbr-loaded", "tbr-success", "tbr-source-cache");
  el.dataset.tbrLoaded = "true";
  el.dataset.tbrStatus = "success";
  el.dataset.tbrSource = "cache";
  el.dataset.tbrBytes = String(bytes.length);

  el.dispatchEvent(
    new CustomEvent("tbr:loaded", {
      bubbles: true,
      detail: {
        url: el.dataset.tbrUrl ?? "",
        status: "success",
        source: "cache",
        kind: null,
        duration: null,
        message: null,
        bytes: bytes.length,
        placeholder: false,
      },
    }),
  );
}

// ── cache key ─────────────────────────────────────────────────────────────

function cacheKey(url: string): string {
  return `tbr:${url}`;
}

// ── Markup helper ─────────────────────────────────────────────────────────

/** 1×1 transparent pixel — prevents browsers from treating empty `src=""` as "load page URL". */
const CLEAR_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const PLACEHOLDER_SVG =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3"><rect fill="#2a2d4a" width="4" height="3"/></svg>',
  );

/**
 * Generate the inner HTML for a `.tbr-wrap` thumbnail element.
 *
 * Returns a string you can assign to `innerHTML` or use in a template.
 * The returned markup contains:
 * - `.tbr-placeholder` — a tiny SVG shown until the real thumbnail arrives
 * - `.tbr-final`      — the final thumbnail image, fades in on load
 * - `.tbr-spinner`    — animated spinner, visible during loading
 *
 * ```ts
 * el.innerHTML = createThumbMarkup("https://example.com/photo.jpg", "photo.jpg");
 * el.classList.add("tbr-wrap");
 * el.dataset.tbrUrl = "https://example.com/photo.jpg";
 * ```
 */
export function createThumbMarkup(url: string, name: string): string {
  const escapedName = name.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `
    <img class="tbr-placeholder" src="${PLACEHOLDER_SVG}" alt="${escapedName}" loading="lazy" decoding="async" />
    <img class="tbr-final" src="${CLEAR_PIXEL}" alt="" loading="lazy" decoding="async" />
    <div class="tbr-spinner" aria-hidden="true"></div>`;
}
