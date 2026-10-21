/// <reference lib="dom" />

/**
 * browser.ts — Browser-environment utilities for Thumbrella.
 *
 * Re-exports core types alongside helpers for working with thumbnails
 * in the browser: class toggling, data-URI access, image creation,
 * IndexedDB caching, shared Client singleton, global configuration,
 * and the `<tbr-thumb>` custom element (`TbrThumb`, `tbrSetup`).
 *
 * `element.ts` has been merged into this module -- `@thumbrella/client/browser`
 * is the single browser entry point.  The deprecated `@thumbrella/client/element`
 * npm export is a thin re-export of this module (see src/element.ts); the
 * packed CDN copy of element.js has been removed.
 */

import type { CacheBackend, ClientCache } from "./cache.js";
import { MemoryCache } from "./cache.js";
import type { Client } from "./api.js";
import { Result, Media, EncodedJpeg, Status, Source, FileKind } from "./types.js";
import { configureClients, getClient, BatchedClient, getBatchedClient } from "./batched.js";

// Re-exports — everything you need in the browser from one import

export { Client, parseConnect } from "./api.js";
export { Result, Media, EncodedJpeg, Status, Source, FileKind } from "./types.js";
export { createMemoryCache } from "./cache.js";
export type { CacheBackend, ClientCache } from "./cache.js";
export { getClient, BatchedClient, getBatchedClient };

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
  caches?: ClientCache[];
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
  configureClients(opts);
  configureClients(opts);
}

// IndexedDB cache

let _persistentCache: CacheBackend | null = null;

/**
 * Create a persistent thumbnail cache backed by IndexedDB.
 *
 * Mirrors {@link createMemoryCache} — returns a {@link CacheBackend}
 * that survives page reloads. Pass it to a Client, or use
 * {@link enablePersistentCache} to configure shared browser clients.
 *
 * @param maxMb  Maximum storage in megabytes (default 5).
 */
export function createBrowserCache(maxMb = 5): CacheBackend {
  if (!Number.isFinite(maxMb) || maxMb <= 0) {
    throw new RangeError("Browser cache size must be a positive number of megabytes");
  }
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
  _persistentCache ??= createBrowserCache(maxMb);
  const caches = _config.caches ?? [new MemoryCache()];
  if (!caches.includes(_persistentCache)) {
    configure({ caches: [...caches, _persistentCache] });
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

// Shared client + batched client (`getClient`, `BatchedClient`,
// `getBatchedClient`) live in batched.ts — they are Node-safe and are also
// re-exported by the root entry, so they must not depend on this module.
// Re-exported at the top of this file.

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
    if (typeof indexedDB === "undefined") {
      return Promise.reject(new DOMException("IndexedDB is unavailable", "NotSupportedError"));
    }
    if (typeof indexedDB === "undefined") {
      return Promise.reject(new DOMException("IndexedDB is unavailable", "NotSupportedError"));
    }
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

  const maxBytes = maxMb * 1024 * 1024;

  return {
    async get(key: string): Promise<Uint8Array | undefined> {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result as Uint8Array | undefined);
        req.onerror = () => reject(req.error);
        tx.onabort = () => reject(tx.error);
      });
    },

    async set(key: string, value: Uint8Array): Promise<void> {
      if (value.byteLength > maxBytes) {
        throw new RangeError("Media record exceeds browser cache capacity");
      }
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const entries: { key: IDBValidKey; size: number }[] = [];
        let size = value.byteLength;
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            if (cursor.key !== key) {
              const entrySize = (cursor.value as Uint8Array).byteLength;
              entries.push({ key: cursor.key, size: entrySize });
              size += entrySize;
            }
            cursor.continue();
          } else {
            for (const entry of entries) {
              if (size <= maxBytes) break;
              store.delete(entry.key);
              size -= entry.size;
            }
            store.put(value, key);
          }
        };
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },

    async remove(key: string): Promise<void> {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },

    reset(): void {
      void openDb().then(db => new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })).catch((error: unknown) => {
        console.warn("Thumbrella browser cache reset failed", error);
      });
    },
  };
}

//
// `<tbr-thumb>` custom element
//
// Previously a separate module (element.ts / element.js).  It now lives here
// so `@thumbrella/client/browser` is the single browser entry point.  The
// deprecated `@thumbrella/client/element` npm export is a thin re-export of
// this module (see src/element.ts).

// Module state

const _blobCache = new Map<number, string>();

let _booted = false;

// Constructable stylesheet.  Created under a typeof guard so this module stays
// importable in Node — browser.ts is re-exported by the root entry (index.ts),
// which must not touch DOM globals on import.
const styles: CSSStyleSheet | null =
  typeof CSSStyleSheet !== "undefined" ? new CSSStyleSheet() : null;
styles?.replaceSync(`
  :host {
    display: inline-block;
    position: relative;
    overflow: hidden;
    background: var(--tbr-bg, #0d1225);
    width: 250px;
    aspect-ratio: 5 / 4;
  }
  :host([hidden]) { display: none; }

  .tbr-placeholder {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    z-index: 1;
    transition: opacity 0.25s ease;
  }

  .tbr-final {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    z-index: 3;
    opacity: 0;
    transition: opacity 0.35s ease;
  }

  :host(.tbr-loaded) .tbr-final {
    opacity: 1;
  }

  /* Shimmer skeleton */

  :host(.tbr-requested) .tbr-placeholder,
  :host(.tbr-intermediate) .tbr-placeholder {
    animation: tbr-shimmer 2s ease-in-out infinite;
  }

  .tbr-shimmer {
    content: "";
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
    background: linear-gradient(
      105deg,
      var(--tbr-shimmer, rgba(255, 255, 255, 0.03)) 40%,
      rgba(255, 255, 255, 0.09) 50%,
      var(--tbr-shimmer, rgba(255, 255, 255, 0.03)) 60%
    );
    background-size: 200% 100%;
    opacity: 0;
    transition: opacity 0.2s;
  }

  :host(.tbr-requested) .tbr-shimmer,
  :host(.tbr-intermediate) .tbr-shimmer {
    opacity: 1;
    animation: tbr-sweep 2.2s ease-in-out infinite;
  }

  :host(.tbr-loaded) .tbr-shimmer {
    opacity: 0;
  }

  :host(.tbr-has-intermediate) .tbr-shimmer {
    opacity: 0;
  }

  :host(.tbr-has-intermediate) .tbr-placeholder {
    animation: none;
  }

  :host(.tbr-loaded) .tbr-placeholder {
    opacity: 0;
  }

  /* Spinner */

  .tbr-spinner {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.2s;
    z-index: 4;
  }

  .tbr-spinner::after {
    content: "";
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.15);
    border-top-color: var(--tbr-spinner-color, #7c5cff);
    border-radius: 50%;
    animation: tbr-spin 0.8s linear infinite;
  }

  :host(.tbr-requested) .tbr-spinner,
  :host(.tbr-intermediate) .tbr-spinner {
    opacity: 1;
  }

  :host(.tbr-loaded) .tbr-spinner {
    opacity: 0;
  }

  /* Keyframes */

  @keyframes tbr-shimmer {
    0%, 100% { filter: brightness(1); }
    50%      { filter: brightness(1.12); }
  }

  @keyframes tbr-sweep {
    0%   { background-position: -100% 0; }
    100% { background-position: 200% 0; }
  }

  @keyframes tbr-spin {
    to { transform: rotate(360deg); }
  }
`);

// Guard the class base so `extends HTMLElement` isn't evaluated when this
// module is imported in a non-browser environment (Node/SSR/tests).  In a
// browser `_TbrBase` is `HTMLElement`; elsewhere it's a plain empty class
// (never constructed — `TbrThumb` is browser-only).
const _TbrBase =
  typeof HTMLElement !== "undefined"
    ? HTMLElement
    : (class {} as typeof HTMLElement);

/**
 * `<tbr-thumb>` — a self-contained thumbnail element.
 *
 * Uses Shadow DOM for style encapsulation. Automatically requests a
 * thumbnail from the configured Thumbrella server when its `src` attribute
 * is set or changed.
 *
 * Fires a `tbr:loaded` custom event when the thumbnail arrives (success or
 * failure).  The event bubbles and is composed, so it crosses shadow-DOM
 * boundaries.
 *
 * Usage:
 * ```html
 * <tbr-thumb
 *   src="https://example.com/model.glb"
 *   connect="https://thumbrella.dev/api"
 *   style="width: 200px;">
 * </tbr-thumb>
 * ```
 */
export class TbrThumb extends _TbrBase {
  static observedAttributes = ["src", "connect", "lazy"];

  #shadow: ShadowRoot;
  #placeholderImg!: HTMLImageElement;
  #finalImg!: HTMLImageElement;
  #loaded = false;
  #pending = false;
  #url: string | null = null;

  /* Reflect the two URL attributes as properties.  Without these, `el.src = u`
     on a custom element only creates an expando: `attributeChangedCallback`
     never runs, nothing is requested, and the element sits empty forever. */
  get src(): string | null {
    return this.getAttribute("src");
  }

  set src(value: string | null) {
    if (value === null) this.removeAttribute("src");
    else this.setAttribute("src", value);
  }

  get connect(): string | null {
    return this.getAttribute("connect");
  }

  set connect(value: string | null) {
    if (value === null) this.removeAttribute("connect");
    else this.setAttribute("connect", value);
  }

  constructor() {
    super();
    this.#shadow = this.attachShadow({ mode: "open" });
    this.#shadow.adoptedStyleSheets = styles ? [styles] : [];
  }

  connectedCallback(): void {
    this.#render();
    this.#load();
  }

  attributeChangedCallback(name: string, _old: string | null, newVal: string | null): void {
    if (name === "src" && newVal !== null && newVal !== this.#url) {
      this.#url = newVal;
      this.#loaded = false;
      this.#pending = false;
      this.classList.remove(
        "tbr-loaded", "tbr-requested", "tbr-intermediate",
        "tbr-has-intermediate", "tbr-success", "tbr-failed",
        "tbr-overloaded", "tbr-unavailable",
      );
      this.#render();
      this.#load();
    }
    if (name === "connect") {
      // A different server means the current image came from the wrong place.
      // Reset the lifecycle so #load() is willing to run again.
      this.#loaded = false;
      this.#pending = false;
      this.classList.remove(
        "tbr-loaded", "tbr-requested", "tbr-intermediate",
        "tbr-has-intermediate", "tbr-success", "tbr-failed",
        "tbr-overloaded", "tbr-unavailable",
      );
      this.#render();
      this.#load();
    }
  }

  // Internal DOM

  #render(): void {
    const name = this.getAttribute("alt") || this.#url || "";
    const escaped = name.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

    this.#shadow.innerHTML = `
      <img class="tbr-placeholder" src="${PLACEHOLDER_SVG}" alt="${escaped}" loading="lazy" decoding="async" />
      <img class="tbr-final" src="${CLEAR_PIXEL}" alt="" loading="lazy" decoding="async" />
      <div class="tbr-shimmer" aria-hidden="true"></div>
      <div class="tbr-spinner" aria-hidden="true"></div>
    `;

    this.#placeholderImg = this.#shadow.querySelector(".tbr-placeholder")!;
    this.#finalImg = this.#shadow.querySelector(".tbr-final")!;
  }

  // Loading

  async #load(): Promise<void> {
    if (!this.isConnected || !this.#url || this.#loaded || this.#pending) return;
    this.#pending = true;

    const connect = resolveConnect(this);

    // An unparseable connect string throws in the Client constructor.  Fail
    // this element rather than leaving an unhandled rejection and a blank box.
    let batched: BatchedClient;
    try {
      batched = getBatchedClient(connect);
    } catch (err) {
      this.#pending = false;
      this.#applyResult(Result.clientFail(
        this.#url,
        err instanceof Error ? err.message : "invalid connect string",
      ));
      return;
    }

    this.classList.add("tbr-requested");

    try {
      for await (const result of batched.streamUrl(this.#url)) {
        if (result.status === Status.INTERMEDIATE) {
          this.classList.add("tbr-intermediate");
          this.#applyIntermediate(result);
          continue;
        }

        this.#applyResult(result);
      }
    } catch {
      this.#applyResult(Result.clientFail(this.#url!, "server unreachable"));
    }

    this.#pending = false;
  }

  #applyIntermediate(result: Result): void {
    const thumb = result.media?.thumbnail;
    if (!thumb) return;
    const isPlaceholder = !!result.media?.placeholder;
    const blobUrl = isPlaceholder
      ? cachedBlobUrl(thumb.key, thumb.bytes)
      : URL.createObjectURL(new Blob([thumb.bytes as BlobPart], { type: "image/jpeg" }));
    this.#placeholderImg.src = blobUrl;
    this.classList.add("tbr-has-intermediate");
  }

  #applyResult(result: Result): void {
    this.classList.remove("tbr-requested");
    this.classList.add("tbr-loaded", "tbr-" + result.status.toLowerCase());
    this.#loaded = true;

    const thumb = result.media?.thumbnail;
    if (thumb) {
      const { bytes, key } = thumb;
      const isPlaceholder = !!result.media?.placeholder;
      const blobUrl = isPlaceholder
        ? cachedBlobUrl(key, bytes)
        : URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
      this.#finalImg.src = blobUrl;
    }

    this.dispatchEvent(
      new CustomEvent("tbr:loaded", {
        bubbles: true,
        composed: true,
        detail: { result },
      }),
    );
  }

  // Connect resolution

  #resolveConnect(): string | undefined {
    return resolveConnect(this);
  }
}

/** Configuration for {@link tbrSetup} (full form — use when you need `persist`). */
export interface SetupConfig {
  connect?: string;
  persist?: number | boolean;
}

/**
 * Activate Thumbrella on the current page, and return the {@link Client} it
 * points at.
 *
 * Registers `<tbr-thumb>`, configures global defaults, and injects CSS for
 * styles.  The page setup itself happens once — subsequent calls only move the
 * connect string — but every call returns the client for that connect string,
 * so a caller can do `tbrSetup(connect).verify()`.
 *
 * The common case is a connect string:
 * ```ts
 * import { tbrSetup } from "@thumbrella/client/browser";
 * tbrSetup("https://thumbrella.dev/api");
 * ```
 *
 * For IndexedDB persistence, pass a config object instead:
 * ```ts
 * tbrSetup({ connect: "https://thumbrella.dev/api", persist: 10 });
 * ```
 *
 * With no arguments, reads `data-tbr-connect` and `data-tbr-persist` from
 * the loading `<script>` tag if present.
 */
export function tbrSetup(connectOrOpts?: string | SetupConfig | null): Client {
  const scriptDs = findScript()?.dataset ?? {};

  // Resolve the next connect string, but only when the caller actually
  // supplied one: a no-argument call must not reset a configured page.
  let next: string | undefined;
  if (typeof connectOrOpts === "string") next = connectOrOpts;
  else if (connectOrOpts === null) next = "";
  else if (connectOrOpts?.connect !== undefined) next = connectOrOpts.connect;
  else if (!_booted) next = scriptDs.tbrConnect;

  // Repeating the same value is a no-op.  A different value affects only
  // requests made from now on: mounted elements keep their iterator and the
  // batch already in flight keeps running.  Existing caches are untouched and
  // shared by every connect string (see getClient).
  if (next !== undefined && typeof window !== "undefined") {
    const w = window as unknown as Record<string, string>;
    if (w.TBR_CONNECT !== next) w.TBR_CONNECT = next;
  }

  // Make sure the shared clients have a cache stack before the first request.
  // Leave the default (the shared MemoryCache) alone unless the page has
  // explicitly configured caches or asked for persistence.
  if (_config.caches !== undefined) {
    configure({ connect: next, caches: _config.caches });
  } else {
    configure({ connect: next });
  }

  const persist = typeof connectOrOpts === "object" && connectOrOpts !== null
    ? connectOrOpts.persist ?? scriptDs.tbrPersist
    : scriptDs.tbrPersist;
  if (
    persist !== undefined && persist !== false && persist !== "false"
    && persist !== 0 && persist !== "0"
  ) {
    const maxMb = persist === true || persist === "" || persist === "true"
      ? 5
      : Number(persist);
    if (!Number.isFinite(maxMb) || maxMb <= 0) {
      throw new RangeError(
        "tbrSetup persist must be a positive number of megabytes or a boolean",
      );
    }
    enablePersistentCache(maxMb);
  }

  if (typeof document !== "undefined" && !_booted) {
    _booted = true;

    if (typeof customElements !== "undefined") {
      customElements.define("tbr-thumb", TbrThumb);
    }

    injectStyles();
  }

  // getClient falls back to window.TBR_CONNECT, which is the value set above.
  return getClient(next);
}

//
// Internal helpers
//

function cachedBlobUrl(key: number, bytes: Uint8Array): string {
  const existing = _blobCache.get(key);
  if (existing) return existing;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
  _blobCache.set(key, url);
  return url;
}

function findScript(): HTMLScriptElement | null {
  if (typeof document === "undefined") return null;
  if (document.currentScript) return document.currentScript as HTMLScriptElement;
  return document.querySelector<HTMLScriptElement>("script[data-tbr-connect], script[data-tbr-persist]");
}

function injectStyles(): void {
  if (typeof document === "undefined") return;
  const id = "tbr-light-dom-styles";
  if (document.getElementById(id)) return;

  const style = document.createElement("style");
  style.id = id;
  // language=CSS
  style.textContent = `
.tbr-kit {
  display: block;
  position: relative;
  overflow: hidden;
  background: var(--tbr-bg, #0d1225);
  width: 250px;
  aspect-ratio: 5 / 4;
}
.tbr-kit img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.tbr-placeholder { z-index: 1; }
.tbr-final { z-index: 3; opacity: 0; transition: opacity 0.35s ease; }
.tbr-loaded .tbr-final { opacity: 1; }
.tbr-loaded .tbr-placeholder { opacity: 0; }`;

  document.head.appendChild(style);
}
