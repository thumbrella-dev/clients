/**
 * Client-side thumbnail coordinator — injected once per page.
 *
 * Finds all `[data-tbr-url]` elements, batches them into a single
 * streaming request, and updates each element as results arrive.
 */

import { Client, Status } from "@thumbrella/client";

interface LoadedDetail {
  url: string;
  status: string;
  kind: string | null;
  source: string | null;
  bytes: number;
}

// ── public API ───────────────────────────────────────────────────────────

/**
 * Scan the page for thumbnail elements and start loading them.
 * Idempotent — safe to call multiple times.
 */
export async function initThumbnails(
  connect?: string,
): Promise<void> {
  const elements = document.querySelectorAll<HTMLElement>("[data-tbr-url]");
  if (!elements.length) return;

  const tbr = new Client({ connect });
  const urlMap = new Map<string, HTMLElement[]>();

  for (const el of elements) {
    if (el.dataset.tbrLoaded) continue;
    const url = el.dataset.tbrUrl!;
    if (!urlMap.has(url)) urlMap.set(url, []);
    urlMap.get(url)!.push(el);
  }

  if (!urlMap.size) return;

  // One-time startup log.
  const g = globalThis as Record<string, unknown>;
  if (!g.__tbr_init_logged) {
    g.__tbr_init_logged = true;
    console.debug(`[thumbrella] connected to ${tbr.baseUrl}`);
  }

  const urls = [...urlMap.keys()];

  try {
    for await (const result of tbr.stream(urls)) {
      const els = urlMap.get(result.url);
      if (!els) continue;
      if (result.status === Status.INTERMEDIATE) continue;

      for (const el of els) {
        applyResult(el, result as unknown as LoadedDetail);
      }
    }
  } catch {
    console.warn("[thumbrella] stream lost — falling back to individual requests");
    for (const [url, els] of urlMap) {
      for (const el of els) {
        if (el.dataset.tbrLoaded) continue;
        try {
          await tbr.thumb(url);
        } catch {
          el.classList.add("tbr-failed");
          el.dataset.tbrLoaded = "failed";
        }
      }
    }
  }
}

// ── internal ─────────────────────────────────────────────────────────────

function applyResult(
  el: HTMLElement,
  result: { status: string; kind?: string | null; source?: string | null; thumbnail: { bytes: Uint8Array; length: number }; url: string },
): void {
  el.classList.add("tbr-loaded");
  el.classList.add(`tbr-${result.status}`);
  if (result.kind) el.classList.add(`tbr-kind-${result.kind}`);
  if (result.source) el.classList.add(`tbr-source-${result.source}`);

  el.dataset.tbrStatus = result.status;
  el.dataset.tbrKind = result.kind ?? "";
  el.dataset.tbrSource = result.source ?? "";
  el.dataset.tbrBytes = String(result.thumbnail.length);
  el.dataset.tbrLoaded = "true";

  if (el instanceof HTMLImageElement) {
    const blob = new Blob([result.thumbnail.bytes], { type: "image/jpeg" });
    const oldUrl = el.src.startsWith("blob:") ? el.src : null;
    el.src = URL.createObjectURL(blob);
    if (oldUrl) URL.revokeObjectURL(oldUrl);
  }

  el.dispatchEvent(new CustomEvent<LoadedDetail>("tbr:loaded", {
    bubbles: true,
    detail: {
      url: el.dataset.tbrUrl ?? "",
      status: result.status,
      kind: result.kind ?? null,
      source: result.source ?? null,
      bytes: result.thumbnail.length,
    },
  }));
}
