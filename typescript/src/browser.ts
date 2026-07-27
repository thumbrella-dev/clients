/// <reference lib="dom" />

/**
 * browser.ts — One-tag Thumbrella setup for the browser.
 *
 * Drop this single script tag onto any page and you're ready to use
 * `<tbr-thumb>` elements everywhere:
 *
 * ```html
 * <script async src="https://cdn.jsdelivr.net/npm/@thumbrella/client@0.3/dist/browser.js"
 *   data-tbr-connect="tbr_p_xxxx"
 *   data-tbr-cache="mem">
 * </script>
 *
 * <tbr-thumb src="https://example.com/photo.jpg" style="width:200px;height:150px"></tbr-thumb>
 * ```
 *
 * ## Script attributes (set on the `<script>` tag itself)
 *
 * | Attribute            | Description                                              |
 * |----------------------|----------------------------------------------------------|
 * | `data-tbr-connect`   | Thumbrella connect string — publishable token or base URL |
 * | `data-tbr-cache`     | Cache config: `mem` (defaults) or `mem:<entries>:<ttlMs>` |
 * | `data-tbr-persist`   | If set, enable IndexedDB persistent cache (value = max MB) |
 *
 * ## Custom element (`<tbr-thumb>`)
 *
 * | Attribute | Description                            |
 * |-----------|----------------------------------------|
 * | `src`     | Media URL to thumbnail (alias for `url`) |
 * | `url`     | Media URL to thumbnail                  |
 * | `connect` | Per-element connect override            |
 * | `lazy`    | `"true"` to load only when in viewport  |
 * | `alt`     | Accessible label for the thumbnail      |
 *
 * ## CSS custom properties
 *
 * | Property               | Default                    |
 * |------------------------|----------------------------|
 * | `--tbr-radius`         | `14px`                     |
 * | `--tbr-bg`             | `#0d1225`                  |
 * | `--tbr-shimmer`        | `rgba(255,255,255,0.03)`   |
 * | `--tbr-spinner-color`  | `#7c5cff`                  |
 */

import { configure, initThumbnails, enablePersistentCache, createThumbMarkup } from "./dom.js";
import { define, ThumbrellaThumb } from "./element.js";
import { Client, parseConnect } from "./client.js";
import { createMemoryCache } from "./cache.js";
import type { CacheBackend } from "./cache.js";

// ── Read config from the <script> tag that loaded us ─────────────────────

const currentScript: HTMLScriptElement | null =
  (typeof document !== "undefined" && document.currentScript) as HTMLScriptElement | null;
const ds = currentScript?.dataset ?? {};

// 1. Connect string — set global fallback so all elements inherit it.
const connect = ds.tbrConnect;
if (connect && typeof window !== "undefined") {
  (window as unknown as Record<string, string>).TBR_CONNECT = connect;
}

// 2. Cache config.
//    "mem"            → defaults (500 entries, 5 min TTL)
//    "mem:500:300000" → custom max entries + TTL in ms
const cacheRaw = ds.tbrCache ?? "";
const caches: CacheBackend[] = [];

if (!cacheRaw || cacheRaw.startsWith("mem")) {
  const parts = cacheRaw.split(":");
  const max = parts[1] ? parseInt(parts[1], 10) : 500;
  const ttl = parts[2] ? parseInt(parts[2], 10) : 300_000;
  caches.push(createMemoryCache({ max, ttl }));
}

// 3. Persistent IndexedDB cache (opt-in).
//    data-tbr-persist    → 5 MB default
//    data-tbr-persist="20" → 20 MB
if (ds.tbrPersist !== undefined) {
  const mb = parseInt(ds.tbrPersist, 10) || 5;
  enablePersistentCache(mb);
}

// 4. Apply global configuration so every element inherits these.
configure({ connect, caches });

// ── <tbr-thumb> — short alias with `src` mirroring ───────────────────────

let _aliasRegistered = false;

function registerAlias(): void {
  if (_aliasRegistered || typeof customElements === "undefined") return;

  // Subclass that mirrors `src` ↔ `url` so HTML authors can use the
  // more natural `src` attribute (like <img>).  `url` still works too.
  class TbrThumb extends ThumbrellaThumb {
    static override observedAttributes = ["src", "url", "connect", "lazy"];

    attributeChangedCallback(name: string, oldVal: string | null, newVal: string | null): void {
      if (name === "src") {
        // Mirror to `url` so the parent class picks it up.
        if (newVal !== null) {
          this.setAttribute("url", newVal);
        }
      } else {
        super.attributeChangedCallback(name, oldVal, newVal);
      }
    }
  }

  customElements.define("tbr-thumb", TbrThumb);
  _aliasRegistered = true;
}

// ── Inject light-DOM styles ───────────────────────────────────────────────

function injectLightDomStyles(): void {
  if (typeof document === "undefined") return;
  const id = "tbr-light-dom-styles";
  if (document.getElementById(id)) return;

  const style = document.createElement("style");
  style.id = id;
  // language=CSS
  style.textContent = `
/* Thumbrella light-DOM styles (auto-injected by browser.js).
   Only needed when using initThumbnails() — the <tbr-thumb> custom element
   uses Shadow DOM and does not depend on these rules. */
.tbr-wrap {
  display: block;
  position: relative;
  overflow: hidden;
  border-radius: var(--tbr-radius, 14px);
  background: var(--tbr-bg, #0d1225);
}
.tbr-wrap img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.tbr-placeholder { z-index: 1; transition: opacity 0.25s ease; }
.tbr-final { z-index: 3; opacity: 0; transition: opacity 0.35s ease; }
.tbr-loaded .tbr-final { opacity: 1; }
.tbr-requested .tbr-placeholder,
.tbr-intermediate .tbr-placeholder {
  animation: tbr-shimmer 2s ease-in-out infinite;
}
.tbr-wrap::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  background: linear-gradient(
    105deg,
    var(--tbr-shimmer, rgba(255,255,255,0.03)) 40%,
    rgba(255,255,255,0.09) 50%,
    var(--tbr-shimmer, rgba(255,255,255,0.03)) 60%
  );
  background-size: 200% 100%;
  opacity: 0;
  transition: opacity 0.2s;
}
.tbr-requested::before,
.tbr-intermediate::before { opacity: 1; animation: tbr-sweep 2.2s ease-in-out infinite; }
.tbr-loaded::before, .tbr-has-intermediate::before { opacity: 0; }
.tbr-has-intermediate .tbr-placeholder { animation: none; }
.tbr-loaded .tbr-placeholder { opacity: 0; }
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
  border: 2px solid rgba(255,255,255,0.15);
  border-top-color: var(--tbr-spinner-color, #7c5cff);
  border-radius: 50%;
  animation: tbr-spin 0.8s linear infinite;
}
.tbr-requested .tbr-spinner,
.tbr-intermediate .tbr-spinner { opacity: 1; }
.tbr-loaded .tbr-spinner { opacity: 0; }
@keyframes tbr-shimmer {
  0%, 100% { filter: brightness(1); }
  50% { filter: brightness(1.12); }
}
@keyframes tbr-sweep {
  0% { background-position: -100% 0; }
  100% { background-position: 200% 0; }
}
@keyframes tbr-spin {
  to { transform: rotate(360deg); }
}`;

  document.head.appendChild(style);
}

// ── Boot ──────────────────────────────────────────────────────────────────

function boot(): void {
  if (typeof document === "undefined") return;

  // 1. Ensure the canonical <thumbrella-thumb> element is registered.
  //    (element.ts calls define() on import, but we call it again for safety;
  //     it's a no-op after the first registration.)
  define();

  // 2. Register the shorter <tbr-thumb> alias.
  registerAlias();

  // 3. Inject light-DOM styles for initThumbnails() users.
  injectLightDomStyles();
}

boot();

// ── Public API (window.__TBR__) ───────────────────────────────────────────

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__TBR__ = {
    configure,
    initThumbnails,
    createThumbMarkup,
    Client,
    parseConnect,
    createMemoryCache,
    enablePersistentCache,
  };
}

// Re-export for consumers that `import` this module.
export {
  configure,
  initThumbnails,
  enablePersistentCache,
  createThumbMarkup,
  Client,
  parseConnect,
  createMemoryCache,
  ThumbrellaThumb,
  define,
};
