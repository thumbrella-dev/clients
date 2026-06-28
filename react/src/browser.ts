#!/usr/bin/env node
/**
 * Browser-side Thumbrella coordinator — framework-agnostic.
 *
 * Works with React, Astro, Vue, or plain HTML.  Scans a root element for
 * `.tbr-wrap[data-tbr-url]` children, batches them through a streaming
 * request, and updates each `<img>` as results arrive.
 */

import { Client, Status } from "@thumbrella/client";

// ── helpers ────────────────────────────────────────────────────────────

interface ResultLike {
  status: string;
  source?: string | null;
  kind?: string | null;
  media?: { thumbnail: { bytes: Uint8Array; key: string; length: number } } | null;
  url: string;
}

const _placeholderBlobs = new Map<string, string>();

function placeholderBlobUrl(key: string, bytes: Uint8Array): string {
  const cached = _placeholderBlobs.get(key);
  if (cached) return cached;
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
  _placeholderBlobs.set(key, url);
  return url;
}

function applyThumbnail(el: HTMLElement, result: ResultLike): void {
  const img = el.querySelector?.("img") as HTMLImageElement | null;
  if (img && result.media?.thumbnail) {
    const { bytes, key } = result.media.thumbnail;
    const isPlaceholder = result.source === "PLACEHOLDER";
    const url = isPlaceholder
      ? placeholderBlobUrl(key, bytes)
      : URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    const old = img.src.startsWith("blob:") ? img.src : null;
    img.src = url;
    if (old && old !== url) URL.revokeObjectURL(old);
  }
}

function applyResult(el: HTMLElement, result: ResultLike): void {
  const wrap = el.closest?.(".tbr-wrap") as HTMLElement || el;

  wrap.classList.remove("tbr-paused", "tbr-offscreen", "tbr-requested");
  wrap.classList.add("tbr-loaded", "tbr-" + result.status.toLowerCase());
  if (result.kind) wrap.classList.add("tbr-kind-" + result.kind);
  if (result.source) wrap.classList.add("tbr-source-" + result.source);

  wrap.dataset.tbrLoaded = "true";
  wrap.dataset.tbrStatus = result.status;
  if (result.kind) wrap.dataset.tbrKind = result.kind;
  if (result.source) wrap.dataset.tbrSource = result.source;

  const img = (el.querySelector?.(".tbr-final") as HTMLImageElement)
    || (el.querySelector?.("img") as HTMLImageElement)
    || (el instanceof HTMLImageElement ? el : null);
  if (img && result.media?.thumbnail) {
    const { bytes, key } = result.media.thumbnail;
    const isPlaceholder = result.source === "PLACEHOLDER";
    const url = isPlaceholder
      ? placeholderBlobUrl(key, bytes)
      : URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    const old = img.src.startsWith("blob:") ? img.src : null;
    img.src = url;
    if (old && old !== url) URL.revokeObjectURL(old);

    wrap.dataset.tbrBytes = String(bytes.length);

    wrap.dispatchEvent(new CustomEvent("tbr:loaded", {
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

function shouldLazy(el: HTMLElement, parentLazy: boolean): boolean {
  if (el.dataset.tbrLazy === "true") return true;
  if (el.dataset.tbrLazy === "false") return false;
  return parentLazy;
}

// ── public API ─────────────────────────────────────────────────────────

let _initCount = 0;

export function initThumbnails(
  root: HTMLElement,
  connect?: string,
  lazyLoad?: boolean,
): () => void {
  if (root.dataset.tbrInit) return () => {};
  root.dataset.tbrInit = "true";

  const tbr = new Client(connect ? { connect } : undefined);
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let io: IntersectionObserver | null = null;

  if (_initCount++ === 0) {
    console.debug("[thumbrella] connected to " + tbr.baseUrl);
  }

  if (lazyLoad) {
    io = new IntersectionObserver((entries) => {
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

  async function flush(): Promise<void> {
    if (pending) return;

    const allWraps = root.querySelectorAll<HTMLElement>(
      ".tbr-wrap[data-tbr-url]:not([data-tbr-loaded])",
    );
    const visible: HTMLElement[] = [];
    for (const wrap of allWraps) {
      if (shouldLazy(wrap, lazyLoad) && wrap.classList.contains("tbr-offscreen")) continue;
      wrap.classList.add("tbr-paused");
      visible.push(wrap);
    }
    if (!visible.length) return;

    pending = true;

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

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 80);
  }

  const mo = new MutationObserver((mutations) => {
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

  if (io) {
    root.querySelectorAll(".tbr-wrap[data-tbr-url]").forEach((wrap) => {
      wrap.classList.add("tbr-offscreen");
      io!.observe(wrap);
    });
  }

  schedule();

  // Return a cleanup function for React useEffect.
  return () => {
    mo.disconnect();
    if (io) io.disconnect();
    if (timer) clearTimeout(timer);
  };
}
