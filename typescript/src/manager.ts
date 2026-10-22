/**
 * manager.ts — internal request dispatcher for `<tbr-thumb>`.
 *
 * This module is deliberately not part of the public browser API.  The
 * single instance lives in `browser.ts` and is created by `tbrSetup()`; the
 * package `exports` map does not expose this file, so applications cannot
 * reach the batching machinery directly.
 */

import type { Client } from "./api.js";
import { Result, Status } from "./types.js";

/** A mounted element that can receive thumbnail updates. */
export interface ThumbnailTarget {
  update(result: Result): void;
}

/** Maximum URLs the server accepts in one batch. */
export const BATCH_LIMIT = 12;

/**
 * Coalesces thumbnail requests from every mounted element into batched
 * `/batch` calls.
 *
 * Individual elements register a URL; the manager groups those registrations
 * into batches, streams results back to each interested element, and replays
 * the latest intermediate frame to elements that join a request already in
 * flight.
 */
export class ThumbnailManager {
  #client: Client | null = null;
  /** URL -> elements waiting for it. */
  #subscribers = new Map<string, Set<ThumbnailTarget>>();
  /** Element -> URLs it is waiting for (reverse index for release). */
  #targets = new Map<ThumbnailTarget, Set<string>>();
  /** Latest intermediate result per in-flight URL. */
  #intermediates = new Map<string, Result>();
  #queue: string[] = [];
  #inflight = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  setClient(client: Client): void {
    this.#client = client;
    if (this.#queue.length > 0) this.#schedule();
  }

  /** Register `target` for `url`.  Joining an active request is allowed. */
  request(url: string, target: ThumbnailTarget): void {
    let subscribers = this.#subscribers.get(url);
    if (!subscribers) {
      subscribers = new Set();
      this.#subscribers.set(url, subscribers);
      this.#queue.push(url);
      this.#schedule();
    }
    subscribers.add(target);

    let urls = this.#targets.get(target);
    if (!urls) {
      urls = new Set();
      this.#targets.set(target, urls);
    }
    urls.add(url);

    const intermediate = this.#intermediates.get(url);
    if (intermediate) target.update(intermediate);
  }

  /** Stop sending updates for every URL this target is waiting on. */
  release(target: ThumbnailTarget): void {
    const urls = this.#targets.get(target);
    if (!urls) return;
    this.#targets.delete(target);

    for (const url of urls) {
      const subscribers = this.#subscribers.get(url);
      if (!subscribers) continue;
      subscribers.delete(target);
      if (subscribers.size > 0) continue;

      this.#subscribers.delete(url);
      this.#intermediates.delete(url);
      const queued = this.#queue.indexOf(url);
      if (queued >= 0) this.#queue.splice(queued, 1);
    }
  }

  #schedule(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#dispatch();
    }, 0);
  }

  #dispatch(): void {
    const client = this.#client;
    if (!client) return;

    const free = BATCH_LIMIT - this.#inflight;
    if (free <= 0) return;

    const batch: string[] = [];
    while (batch.length < free && this.#queue.length > 0) {
      const url = this.#queue.shift()!;
      if (this.#subscribers.has(url)) batch.push(url);
    }
    if (batch.length === 0) return;

    this.#inflight += batch.length;
    void this.#run(client, batch);
  }

  async #run(client: Client, batch: string[]): Promise<void> {
    const open = new Set(batch);

    // Release one slot per terminal result, so a slow URL does not hold up
    // the next batch for every other element on the page.
    const settle = (url: string, result?: Result): void => {
      if (!open.delete(url)) return;
      if (result) {
        this.#deliver(url, result);
        this.#complete(url);
      }
      this.#inflight--;
      this.#schedule();
    };

    try {
      for await (const result of client.stream(batch)) {
        if (!open.has(result.url)) continue;
        if (result.status === Status.INTERMEDIATE) {
          this.#deliver(result.url, result);
        } else {
          settle(result.url, result);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "batch request failed";
      for (const url of [...open]) settle(url, Result.clientFail(url, message));
    }

    // The stream can end without a terminal frame for a URL (for example when
    // the connection drops between frames).  Never leave an element loading.
    for (const url of [...open]) {
      settle(url, Result.clientFail(url, "stream connection lost"));
    }
  }

  #deliver(url: string, result: Result): void {
    const subscribers = this.#subscribers.get(url);
    if (!subscribers) return;
    if (result.status === Status.INTERMEDIATE) {
      this.#intermediates.set(url, result);
    }
    for (const target of [...subscribers]) target.update(result);
  }

  #complete(url: string): void {
    this.#subscribers.delete(url);
    this.#intermediates.delete(url);
  }
}
