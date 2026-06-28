/**
 * Browser-side Thumbrella coordinator.
 *
 * Scans for `[data-tbr-url]` elements inside a root container, batches them
 * into a single streaming request, and updates each `<img>` as results arrive.
 * Placeholder images from the server share a single blob URL.
 *
 * Lifecycle classes applied to each `.tbr-wrap` element:
 *
 *   tbr-paused      initial state — not yet queued
 *   tbr-offscreen   outside the viewport (added by IntersectionObserver)
 *   tbr-requested   URL has been sent to the server
 *   tbr-success     server returned a successful thumbnail
 *   tbr-failed      server could not generate a thumbnail
 *   tbr-intermediate streaming progress update
 *   tbr-overloaded  server is busy, retry later
 *   tbr-unavailable media URL is not reachable
 */

import { Client, Status } from "@thumbrella/client";

// helpers

interface ResultLike {
  status: string;
  source?: string | null;
  kind?: string | null;
  media?: { thumbnail: { bytes: Uint8Array; key: string; length: number } } | null;
  url: string;
}

/** Shared blob URL cache for identical placeholder JPEGs. */
const _placeholderBlobs = new Map<string, string>();

function placeholderBlobUrl(key: string, bytes: Uint8Array): string {
  const cached = _placeholderBlobs.get(key);
  if (cached) return cached;
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
  _placeholderBlobs.set(key, url);
  return url;
}

function findWrap(img: HTMLElement): HTMLElement | null {
  return img.closest?.(".tbr-wrap") as HTMLElement | null;
}

/** Set the thumbnail on the first <img> (placeholder slot), leaving
 *  .tbr-final empty so the final render can still fade in. */
function applyThumbnail(el: HTMLElement, result: ResultLike): void {
  const img = el.querySelector?.("img") as HTMLImageElement | null;
  if (img && result.media?.thumbnail) {
    const { bytes, key } = result.media.thumbnail;
    const isPlaceholder = result.source === "PLACEHOLDER";
    const blobUrl = isPlaceholder
      ? placeholderBlobUrl(key, bytes)
      : URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));

    const old = img.src.startsWith("blob:") ? img.src : null;
    img.src = blobUrl;
    if (old && old !== blobUrl) URL.revokeObjectURL(old);
  }
}

function applyResult(el: HTMLElement, result: ResultLike): void {
  const wrap = findWrap(el) || el;

  // Remove lifecycle classes, add result classes.
  wrap.classList.remove("tbr-paused", "tbr-offscreen", "tbr-requested");
  wrap.classList.add("tbr-loaded", "tbr-" + result.status.toLowerCase());
  if (result.kind) wrap.classList.add("tbr-kind-" + result.kind);
  if (result.source) wrap.classList.add("tbr-source-" + result.source);

  el.dataset.tbrLoaded = "true";
  el.dataset.tbrStatus = result.status;
  if (result.kind) el.dataset.tbrKind = result.kind;
  if (result.source) el.dataset.tbrSource = result.source;

  // Update the .tbr-final image (second img) so it fades in over
  // the placeholder.  If there's only one img, fall back to that.
  const img = (el.querySelector?.(".tbr-final") as HTMLImageElement)
    || (el.querySelector?.("img") as HTMLImageElement)
    || (el instanceof HTMLImageElement ? el : null);
  if (img && result.media?.thumbnail) {
    const { bytes, key } = result.media.thumbnail;
    const isPlaceholder = result.source === "PLACEHOLDER";
    const blobUrl = isPlaceholder
      ? placeholderBlobUrl(key, bytes)
      : URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));

    const old = img.src.startsWith("blob:") ? img.src : null;
    img.src = blobUrl;
    if (old && old !== blobUrl) URL.revokeObjectURL(old);

    el.dataset.tbrBytes = String(bytes.length);

    el.dispatchEvent(new CustomEvent("tbr:loaded", {
      bubbles: true,
      detail: {
        url: result.url,
        status: result.status,
        source: result.source ?? null,
        kind: result.kind ?? null,
        duration: (result as Record<string, unknown>).duration ?? null,
        message: (result as Record<string, unknown>).message ?? null,
        bytes: bytes.length,
        placeholder: isPlaceholder,
      },
    }));
  }
}

// lazy-load detection

function shouldLazy(el: HTMLElement, parentLazy: boolean): boolean {
  // Per-element override takes precedence.
  if (el.dataset.tbrLazy === "true") return true;
  if (el.dataset.tbrLazy === "false") return false;
  return parentLazy;
}

// main

let _initCount = 0;

export function initThumbnails(
  root: HTMLElement,
  connect?: string,
  lazyLoad?: boolean,
): void {
  if (root.dataset.tbrInit) return;
  root.dataset.tbrInit = "true";

  const tbr = new Client(connect ? { connect } : undefined);
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  if (_initCount++ === 0) {
    console.debug("[thumbrella] connected to " + tbr.baseUrl);
  }

  // IntersectionObserver for lazy loading
  let io: IntersectionObserver | null = null;
  if (lazyLoad) {
    io = new IntersectionObserver(function (entries) {
      for (const entry of entries) {
        const wrap = entry.target as HTMLElement;
        if (entry.isIntersecting) {
          wrap.classList.remove("tbr-offscreen");
        } else {
          wrap.classList.add("tbr-offscreen");
        }
      }
      schedule();
    }, { rootMargin: "200px" });
  }

  // batch processor
  async function flush(): Promise<void> {
    if (pending) return;

    // Collect unloaded wraps that are not offscreen (or if lazy is off).
    const allWraps = root.querySelectorAll<HTMLElement>(
      ".tbr-wrap[data-tbr-url]:not([data-tbr-loaded])",
    );
    const visible: HTMLElement[] = [];
    for (const wrap of allWraps) {
      const itemLazy = shouldLazy(wrap, lazyLoad);
      if (itemLazy && wrap.classList.contains("tbr-offscreen")) continue;
      // Mark as paused (not yet sent) then requested.
      wrap.classList.add("tbr-paused");
      visible.push(wrap);
    }
    if (!visible.length) return;

    pending = true;

    // Deduplicate URLs.
    const urlMap = new Map<string, HTMLElement[]>();
    for (const wrap of visible) {
      const url = wrap.dataset.tbrUrl!;
      if (!urlMap.has(url)) urlMap.set(url, []);
      urlMap.get(url)!.push(wrap);
      wrap.classList.remove("tbr-paused");
      wrap.classList.add("tbr-requested");
    }

    const urls = [...urlMap.keys()];

    try {
      for await (const result of tbr.stream(urls)) {
        if (result.status === Status.INTERMEDIATE) {
          const matches = urlMap.get(result.url);
          if (matches) {
            for (const wrap of matches) {
              wrap.classList.add("tbr-intermediate");
              applyThumbnail(wrap, result as unknown as ResultLike);
            }
          }
          continue;
        }
        const matches = urlMap.get(result.url);
        if (!matches) continue;
        for (const wrap of matches) {
          if (wrap.dataset.tbrLoaded) continue;
          applyResult(wrap, result as unknown as ResultLike);
        }
      }
    } finally {
      pending = false;
      schedule();
    }
  }

  // schedule (debounced)
  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 80);
  }

  // mutation observer
  const mo = new MutationObserver(function (mutations) {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches?.("[data-tbr-url]") || node.querySelector?.("[data-tbr-url]")) {
          schedule();
          return;
        }
      }
    }
  });

  mo.observe(root, { childList: true, subtree: true });

  // initialise
  // Observe existing wraps for lazy-load.
  if (io) {
    root.querySelectorAll(".tbr-wrap[data-tbr-url]").forEach(function (wrap) {
      wrap.classList.add("tbr-offscreen");
      io!.observe(wrap);
    });
  }

  schedule();
}

