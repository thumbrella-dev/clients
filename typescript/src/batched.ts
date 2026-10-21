/**
 * batched.ts — shared `Client` singletons and batched request coalescing.
 *
 * Browser-oriented helpers that are still safe to import in Node (no DOM
 * globals at module scope).  Kept separate from browser.ts so the root entry
 * (index.ts) can re-export these without loading the DOM-heavy browser module.
 */

import { Client } from "./api.js";
import type { ClientCache } from "./cache.js";
import { MemoryCache } from "./cache.js";
import { Result, Status } from "./types.js";

// Shared clients, one per connect string

const _clients = new Map<string, Client>();
const _defaults: { connect?: string; caches?: ClientCache[] } = {};

/**
 * One result cache shared by every client created here.
 *
 * Caches are keyed by canonical URL, not by server, so switching connect
 * strings keeps every thumbnail already fetched.  A per-client cache would
 * throw the whole collection away on each `tbrSetup()` call.
 */
const _sharedCaches: ClientCache[] = [new MemoryCache()];

/** Update defaults used by shared clients, including existing ones. */
export function configureClients(opts: {
  connect?: string;
  caches?: ClientCache[];
}): void {
  if (opts.connect !== undefined) _defaults.connect = opts.connect;
  if (opts.caches !== undefined) {
    _defaults.caches = opts.caches;
    for (const client of _clients.values()) client.setCaches(opts.caches);
  }
}

/**
 * Get (or create) a shared Thumbrella {@link Client}.
 *
 * @param connect  Optional connect string (falls back to `window.TBR_CONNECT`).
 *
 * Clients are keyed by connect string: a page that switches servers at
 * runtime gets a client for the new one instead of silently reusing the
 * client created for the first.  All of them share the default cache stack
 * unless `configureClients` supplies one.
 */
export function getClient(connect?: string): Client {
  const target = connect ?? _defaults.connect ??
    (typeof window !== "undefined"
      ? (window as unknown as Record<string, string>).TBR_CONNECT
      : undefined);
  const key = target ?? "__default__";
  let client = _clients.get(key);
  if (!client) {
    client = new Client({ connect: target, caches: _defaults.caches ?? _sharedCaches });
    _clients.set(key, client);
  }
  return client;
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
  readonly closed: boolean;
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
      if (finished) return;
      if (waiter) {
        waiter({ value: item, done: false });
        waiter = null;
      } else {
        buffer.push(item);
      }
    },
    done() {
      if (finished) return;
      finished = true;
      if (waiter) {
        waiter({ value: undefined as unknown as T, done: true });
        waiter = null;
      }
    },
    get closed() {
      return finished;
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
  /** Every unfinished URL, queued or in flight, and its subscribers. */
  #active = new Map<string, Set<ReturnType<typeof createAsyncQueue<Result>>>>();
  /** Latest in-flight intermediate per URL, replayed to late subscribers. */
  #intermediates = new Map<string, Result>();
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
    const q = createAsyncQueue<Result>();
    let subs = this.#active.get(url);
    if (!subs) {
      subs = new Set();
      this.#active.set(url, subs);
      this.#queue.push(url);
      this.#schedule(0);
    }
    // A URL already in flight serves this subscriber too.  Handing back the
    // iterator of an existing queue would split one result between two
    // consumers — each `next()` settles a single waiter — leaving the second
    // element waiting for a result that had already been delivered.
    subs.add(q);
    // A subscriber that joins after the first progress frame still needs the
    // placeholder.  The result cache deliberately holds terminal answers only,
    // so replay the latest in-flight intermediate from here instead.
    const intermediate = this.#intermediates.get(url);
    if (intermediate) q.push(intermediate);
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
    const send = (url: string, result: Result): void => {
      for (const q of this.#active.get(url) ?? []) {
        if (!q.closed) q.push(result);
      }
    };
    const finish = (url: string, result?: Result): void => {
      const subs = this.#active.get(url);
      if (subs) {
        for (const q of subs) {
          if (result && !q.closed) q.push(result);
          if (!q.closed) q.done();
        }
      }
      this.#intermediates.delete(url);
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
          this.#intermediates.set(result.url, result);
          send(result.url, result);
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

// Singleton batched clients (keyed by resolved client)

const _batchedClients = new Map<Client, BatchedClient>();

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
  const client = getClient(connect);
  let bc = _batchedClients.get(client);
  if (!bc) {
    bc = new BatchedClient(client);
    _batchedClients.set(client, bc);
  }
  return bc;
}
