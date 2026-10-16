/**
 * batched.ts — shared `Client` singletons and batched request coalescing.
 *
 * Browser-oriented helpers that are still safe to import in Node (no DOM
 * globals at module scope).  Kept separate from browser.ts so the root entry
 * (index.ts) can re-export these without loading the DOM-heavy browser module.
 */

import { Client } from "./api.js";
import { Result, Status } from "./types.js";

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

/** Default number of thumbnails a {@link BatchedClient} keeps in flight. */
export const BATCH_LIMIT = 12;

/**
 * A {@link Client} wrapper that coalesces individual
 * {@link streamUrl} calls into batched HTTP requests.
 *
 * URLs submitted within the same microtask/macrotask boundary are
 * queued together and dispatched as `/batch` calls.  Each call site
 * receives an independent `AsyncGenerator` that yields only results
 * for its own URL.
 *
 * At most `limit` thumbnails are in flight at once, but they need not
 * share a request: each final result frees a slot, and a new batch is
 * sent once enough slots are free.  "Enough" starts at `limit` right
 * after a send and drops by one per second, so a few slow outliers
 * delay the next batch by at most `limit` seconds and an idle client
 * always sends immediately.
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
  readonly limit: number;
  /** Every unfinished URL, queued or in flight. */
  #active = new Map<string, ReturnType<typeof createAsyncQueue<Result>>>();
  #queue: string[] = [];
  #inflight = 0;
  #lastSend = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(client: Client, opts: { limit?: number } = {}) {
    this.#client = client;
    this.limit = opts.limit ?? BATCH_LIMIT;
  }

  /** The underlying (unbatched) {@link Client}. */
  get client(): Client {
    return this.#client;
  }

  /**
   * Stream results for a single URL.
   *
   * The URL is queued internally and sent with the next batch.
   * Results are routed back to the per-URL async generator returned
   * here.
   */
  streamUrl(url: string): AsyncIterableIterator<Result> {
    const existing = this.#active.get(url);
    if (existing) return existing.iter;

    const q = createAsyncQueue<Result>();
    this.#active.set(url, q);
    this.#queue.push(url);
    this.#schedule(0);
    return q.iter;
  }

  #schedule(ms: number): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#pump(), ms);
  }

  /** Send a batch if enough slots are free, otherwise wake when they would be. */
  #pump(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#queue.length === 0) return;
    const free = this.limit - this.#inflight;
    if (free <= 0) return; // a finishing item will pump again
    if (this.#inflight > 0) {
      const softMin = this.limit - (Date.now() - this.#lastSend) / 1000;
      if (free < softMin) {
        this.#schedule((softMin - free) * 1000);
        return;
      }
    }
    const batch = this.#queue.splice(0, free);
    this.#inflight += batch.length;
    this.#lastSend = Date.now();
    void this.#run(batch);
  }

  async #run(batch: string[]): Promise<void> {
    const open = new Set(batch);
    const finish = (url: string, result?: Result): void => {
      const q = this.#active.get(url);
      if (result) q?.push(result);
      q?.done();
      this.#active.delete(url);
      if (open.delete(url)) {
        this.#inflight--;
        this.#pump();
      }
    };

    try {
      for await (const result of this.#client.stream(batch)) {
        if (!open.has(result.url)) continue;
        if (result.status === Status.INTERMEDIATE) {
          this.#active.get(result.url)?.push(result);
        } else {
          finish(result.url, result);
        }
      }
    } catch {
      for (const url of [...open]) {
        finish(url, Result.clientFail(url, "batch request failed"));
      }
    }

    // Safety net — ensure every item is released
    for (const url of [...open]) finish(url);
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
