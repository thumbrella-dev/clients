/// <reference lib="dom" />

/**
 * element.ts — `<thumbrella-thumb>` custom element.
 *
 * A self-contained web component that renders a Thumbrella thumbnail.
 * Uses Shadow DOM for style isolation.  Imports this module to
 * auto-register the element; no additional setup required.
 *
 * ## Static-page usage:
 * ```html
 * <script type="module" src=".../element.js"></script>
 * <script>window.TBR_CONNECT = "https://thumbrella.dev/api";</script>
 * <thumbrella-thumb url="https://example.com/photo.jpg"></thumbrella-thumb>
 * ```
 *
 * ## Attributes:
 * - `url`     — media URL to thumbnail (required)
 * - `connect` — Thumbrella connect string (optional, inherits from ancestor / global)
 * - `lazy`    — if `"true"`, only loads when scrolled into view
 *
 * ## CSS custom properties:
 * - `--tbr-shimmer`      — shimmer gradient colour
 * - `--tbr-spinner-color`— spinner accent colour
 * - `--tbr-radius`       — border radius
 * - `--tbr-bg`           — background colour while loading
 */

import { Client } from "./client.js";
import { Status } from "./types.js";
import type { CacheBackend } from "./cache.js";
import { createMemoryCache } from "./cache.js";

// ── shared client singleton ───────────────────────────────────────────────

let _sharedClient: Client | null = null;
let _sharedCaches: CacheBackend[] | null = null;

function getSharedClient(): Client {
  if (!_sharedClient) {
    _sharedCaches = [createMemoryCache()];
    _sharedClient = new Client({
      connect: resolveGlobalConnect(),
      cacheBackends: _sharedCaches,
    });
  }
  return _sharedClient;
}

function resolveGlobalConnect(): string | undefined {
  if (typeof window !== "undefined") {
    return (window as unknown as Record<string, string>).TBR_CONNECT;
  }
  return undefined;
}

// ── constructable stylesheet ──────────────────────────────────────────────

const styles = new CSSStyleSheet();
styles.replaceSync(`
  :host {
    display: inline-block;
    position: relative;
    overflow: hidden;
    border-radius: var(--tbr-radius, 14px);
    background: var(--tbr-bg, #0d1225);
    width: 100%;
    height: 100%;
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

  /* ── shimmer skeleton ──────────────────────────────── */

  :host(.tbr-requested) .tbr-placeholder,
  :host(.tbr-intermediate) .tbr-placeholder {
    animation: tbr-shimmer 2s ease-in-out infinite;
  }

  .shimmer {
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

  :host(.tbr-requested) .shimmer,
  :host(.tbr-intermediate) .shimmer {
    opacity: 1;
    animation: tbr-sweep 2.2s ease-in-out infinite;
  }

  :host(.tbr-loaded) .shimmer {
    opacity: 0;
  }

  :host(.tbr-has-intermediate) .shimmer {
    opacity: 0;
  }

  :host(.tbr-has-intermediate) .tbr-placeholder {
    animation: none;
  }

  :host(.tbr-loaded) .tbr-placeholder {
    opacity: 0;
  }

  /* ── spinner ──────────────────────────────────────── */

  .spinner {
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

  .spinner::after {
    content: "";
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.15);
    border-top-color: var(--tbr-spinner-color, #7c5cff);
    border-radius: 50%;
    animation: tbr-spin 0.8s linear infinite;
  }

  :host(.tbr-requested) .spinner,
  :host(.tbr-intermediate) .spinner {
    opacity: 1;
  }

  :host(.tbr-loaded) .spinner {
    opacity: 0;
  }

  /* ── keyframes ────────────────────────────────────── */

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

// ── constants ─────────────────────────────────────────────────────────────

const PLACEHOLDER_SVG =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3"><rect fill="#2a2d4a" width="4" height="3"/></svg>',
  );

const CLEAR_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

// ── blob URL cache ────────────────────────────────────────────────────────

const _blobCache = new Map<number, string>();

function cachedBlobUrl(key: number, bytes: Uint8Array): string {
  const existing = _blobCache.get(key);
  if (existing) return existing;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
  _blobCache.set(key, url);
  return url;
}

// ── custom element ────────────────────────────────────────────────────────

const TAG_NAME = "thumbrella-thumb";

/**
 * `<thumbrella-thumb>` — a self-contained thumbnail element.
 *
 * Uses Shadow DOM for style encapsulation. Automatically requests a
 * thumbnail from the configured Thumbrella server when its `url` attribute
 * is set or changed.
 *
 * Fires a `tbr:loaded` custom event when the thumbnail arrives (success or
 * failure).  The event bubbles and is composed, so it crosses shadow-DOM
 * boundaries.
 *
 * Usage:
 * ```html
 * <thumbrella-thumb
 *   url="https://example.com/model.glb"
 *   connect="https://thumbrella.dev/api"
 *   style="width: 200px; height: 150px;"
 * ></thumbrella-thumb>
 * ```
 */
export class ThumbrellaThumb extends HTMLElement {
  static observedAttributes = ["url", "connect", "lazy"];

  #shadow: ShadowRoot;
  #placeholderImg!: HTMLImageElement;
  #finalImg!: HTMLImageElement;
  #loaded = false;
  #pending = false;
  #url: string | null = null;

  constructor() {
    super();
    this.#shadow = this.attachShadow({ mode: "open" });
    this.#shadow.adoptedStyleSheets = [styles];
  }

  connectedCallback(): void {
    this.#render();
    this.#load();
  }

  attributeChangedCallback(name: string, _old: string | null, newVal: string | null): void {
    if (name === "url" && newVal !== this.#url) {
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
      // If the connect string changes, invalidate any pending request.
      if (this.#pending) {
        this.#pending = false;
      }
      this.#load();
    }
  }

  // ── internal DOM ──────────────────────────────────────────────────────

  #render(): void {
    const name = this.getAttribute("alt") || this.#url || "";
    const escaped = name.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

    this.#shadow.innerHTML = `
      <img class="tbr-placeholder" src="${PLACEHOLDER_SVG}" alt="${escaped}" loading="lazy" decoding="async" />
      <img class="tbr-final" src="${CLEAR_PIXEL}" alt="" loading="lazy" decoding="async" />
      <div class="shimmer" aria-hidden="true"></div>
      <div class="spinner" aria-hidden="true"></div>
    `;

    this.#placeholderImg = this.#shadow.querySelector(".tbr-placeholder")!;
    this.#finalImg = this.#shadow.querySelector(".tbr-final")!;
  }

  // ── loading ───────────────────────────────────────────────────────────

  async #load(): Promise<void> {
    if (!this.isConnected || !this.#url || this.#loaded || this.#pending) return;
    this.#pending = true;

    const connect = this.#resolveConnect();
    const client = connect
      ? new Client({ connect, cacheBackends: _sharedCaches ?? undefined })
      : getSharedClient();

    const allCaches = client.cacheBackends;

    // 1. Check byte-level caches.
    const cacheKey = `tbr:${this.#url}`;
    for (const cache of allCaches) {
      const hit = await cache.get(cacheKey);
      if (hit) {
        const blobUrl = URL.createObjectURL(new Blob([hit as BlobPart], { type: "image/jpeg" }));
        this.#finalImg.src = blobUrl;
        this.classList.add("tbr-loaded", "tbr-success", "tbr-source-cache");
        this.#loaded = true;
        this.#pending = false;
        this.dispatchEvent(
          new CustomEvent("tbr:loaded", {
            bubbles: true,
            composed: true,
            detail: { url: this.#url, status: "success", source: "cache", bytes: hit.length, placeholder: false },
          }),
        );
        return;
      }
    }

    // 2. Request from server.
    this.classList.add("tbr-requested");

    try {
      for await (const result of client.stream([this.#url])) {
        // Handle intermediate (streaming preview).
        if (result.status === Status.INTERMEDIATE) {
          this.classList.add("tbr-intermediate");
          this.#applyIntermediate(result);
          continue;
        }

        // Handle final result.
        if (result.status === Status.SUCCESS && result.media?.thumbnail) {
          const bytes = result.media.thumbnail.bytes;
          // Store in caches.
          for (const cache of allCaches) {
            try { await cache.set(cacheKey, bytes); } catch { /* best-effort */ }
          }
        }

        this.#applyResult(result);
      }
    } catch {
      this.classList.add("tbr-loaded", "tbr-unavailable");
      this.#loaded = true;
    }

    this.#pending = false;
  }

  #applyIntermediate(result: import("./types.js").Result): void {
    const thumb = result.media?.thumbnail;
    if (!thumb) return;
    const isPlaceholder = result.source === "placeholder";
    const blobUrl = isPlaceholder
      ? cachedBlobUrl(thumb.key, thumb.bytes)
      : URL.createObjectURL(new Blob([thumb.bytes as BlobPart], { type: "image/jpeg" }));
    this.#placeholderImg.src = blobUrl;
    this.classList.add("tbr-has-intermediate");
  }

  #applyResult(result: import("./types.js").Result): void {
    this.classList.remove("tbr-requested");
    this.classList.add("tbr-loaded", "tbr-" + result.status.toLowerCase());
    if (result.source) this.classList.add("tbr-source-" + result.source);

    this.#loaded = true;

    const thumb = result.media?.thumbnail;
    if (thumb) {
      const { bytes, key } = thumb;
      const isPlaceholder = result.source === "placeholder";
      const blobUrl = isPlaceholder
        ? cachedBlobUrl(key, bytes)
        : URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
      this.#finalImg.src = blobUrl;
    }

    this.dispatchEvent(
      new CustomEvent("tbr:loaded", {
        bubbles: true,
        composed: true,
        detail: {
          url: result.url,
          status: result.status,
          source: result.source ?? null,
          kind: result.media?.kind ?? null,
          duration: result.duration ?? null,
          message: result.message ?? null,
          bytes: thumb?.bytes.length ?? 0,
          placeholder: result.source === "placeholder",
        },
      }),
    );
  }

  // ── connect resolution ────────────────────────────────────────────────

  #resolveConnect(): string | undefined {
    // 1. Own attribute.
    const attr = this.getAttribute("connect");
    if (attr) return attr;

    // 2. Nearest ancestor with data-tbr-connect.
    let parent = this.parentElement;
    while (parent) {
      const p = (parent as HTMLElement).dataset.tbrConnect;
      if (p) return p;
      if (parent instanceof ShadowRoot) {
        parent = parent.host.parentElement;
      } else {
        parent = parent.parentElement;
      }
    }

    // 3. Global.
    return resolveGlobalConnect();
  }
}

// ── auto-register ─────────────────────────────────────────────────────────

let _registered = false;

/**
 * Register the `<thumbrella-thumb>` custom element.
 *
 * Called automatically when this module is imported.  Safe to call
 * multiple times — subsequent calls are no-ops.
 */
export function define(): void {
  if (_registered) return;
  if (typeof customElements === "undefined") return;
  customElements.define(TAG_NAME, ThumbrellaThumb);
  _registered = true;
}

// Auto-register on import.
define();
