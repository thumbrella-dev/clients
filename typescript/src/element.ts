/// <reference lib="dom" />

/**
 * element.ts — `<tbr-thumb>` custom element.
 *
 * A self-contained web component that renders a Thumbrella thumbnail.
 * Uses Shadow DOM for style isolation.
 *
 * ```html
 * <script type="module">
 *   import { tbrSetup } from "https://cdn.jsdelivr.net/npm/@thumbrella/client@0.3/dist/element.js";
 *   tbrSetup({ connect: "tbr_p_xxxx" });
 * </script>
 * <tbr-thumb src="https://example.com/photo.jpg"></tbr-thumb>
 * ```
 *
 * ## Attributes:
 * - `src`     — media URL to thumbnail (like `<img>`)
 * - `connect` — Thumbrella connect string (optional, inherits from ancestor / global)
 * - `lazy`    — if `"true"`, only loads when scrolled into view
 * - `alt`     — accessible label, used during loading
 *
 * ## CSS custom properties:
 * - `--tbr-shimmer`      — shimmer gradient colour
 * - `--tbr-spinner-color`— spinner accent colour
 * - `--tbr-bg`           — background colour while loading
 */

import { Client, parseConnect } from "./api.js";
import { Status, Result } from "./types.js";
import { getClient, resolveConnect } from "./browser.js";
import { CLEAR_PIXEL, PLACEHOLDER_SVG } from "./browser.js";

// Module state

const _blobCache = new Map<number, string>();

let _booted = false;

// Constructable stylesheet

const styles = new CSSStyleSheet();
styles.replaceSync(`
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

// Placeholder constants (imported from browser.ts)

//
// Exports
//

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
export class TbrThumb extends HTMLElement {
  static observedAttributes = ["src", "connect", "lazy"];

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
      if (this.#pending) {
        this.#pending = false;
      }
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
    const client = connect
      ? new Client(connect)
      : getClient();

    this.classList.add("tbr-requested");

    try {
      for await (const result of client.stream([this.#url])) {
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

  #applyIntermediate(result: import("./types.js").Result): void {
    const thumb = result.media?.thumbnail;
    if (!thumb) return;
    const isPlaceholder = !!result.media?.placeholder;
    const blobUrl = isPlaceholder
      ? cachedBlobUrl(thumb.key, thumb.bytes)
      : URL.createObjectURL(new Blob([thumb.bytes as BlobPart], { type: "image/jpeg" }));
    this.#placeholderImg.src = blobUrl;
    this.classList.add("tbr-has-intermediate");
  }

  #applyResult(result: import("./types.js").Result): void {
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
 * Activate Thumbrella on the current page.
 *
 * Registers `<tbr-thumb>`, configures global defaults, and injects CSS for
 * styles.  Call once — subsequent calls are no-ops.
 *
 * The common case is a connect string:
 * ```ts
 * import { tbrSetup } from "@thumbrella/client/element";
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
export function tbrSetup(connectOrOpts?: string | SetupConfig): void {
  if (_booted || typeof document === "undefined") return;
  _booted = true;

  const scriptDs = findScript()?.dataset ?? {};

  // Resolve connect: explicit string > opts.connect > script attribute > undefined
  const explicitConnect = typeof connectOrOpts === "string"
    ? connectOrOpts
    : connectOrOpts?.connect ?? scriptDs.tbrConnect;

  if (explicitConnect && typeof window !== "undefined") {
    (window as unknown as Record<string, string>).TBR_CONNECT = explicitConnect;
  }

  if (typeof customElements !== "undefined") {
    customElements.define("tbr-thumb", TbrThumb);
  }

  injectStyles();
}

// Convenience re-exports for bundler users who only import element.js.
export { Client, parseConnect } from "./api.js";

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
  return document.querySelector<HTMLScriptElement>("script[data-tbr-connect]");
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

// Auto-setup when loaded via <script> with data-tbr-connect
if (findScript()) {
  tbrSetup();
}
