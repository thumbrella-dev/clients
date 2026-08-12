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

/**
 * A {@link Client} wrapper that coalesces individual
 * {@link streamUrl} calls into batched HTTP requests.
 *
 * URLs submitted within the same microtask/macrotask boundary are
 * queued together and dispatched as a single `/batch` call.  Each
 * call site receives an independent `AsyncGenerator` that yields only
 * results for its own URL.
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
  #pending = new Map<
    string,
    ReturnType<typeof createAsyncQueue<Result>>
  >();
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(client: Client) {
    this.#client = client;
  }

  /** The underlying (unbatched) {@link Client}. */
  get client(): Client {
    return this.#client;
  }

  /**
   * Stream results for a single URL.
   *
   * The URL is queued internally.  When the flush timer fires all
   * queued URLs are submitted together via {@link Client.stream}.
   * Results are routed back to the per-URL async generator returned
   * here.
   */
  streamUrl(url: string): AsyncIterableIterator<Result> {
    const existing = this.#pending.get(url);
    if (existing) return existing.iter;

    const q = createAsyncQueue<Result>();
    this.#pending.set(url, q);
    this.#scheduleFlush();
    return q.iter;
  }

  #scheduleFlush(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => this.#flush(), 0);
  }

  async #flush(): Promise<void> {
    this.#timer = null;

    const entries = [...this.#pending.entries()];
    if (entries.length === 0) return;
    this.#pending.clear();

    const urlMap = new Map(entries);

    try {
      for await (const result of this.#client.stream(
        entries.map(([u]) => u),
      )) {
        const q = urlMap.get(result.url);
        if (!q) continue;
        q.push(result);
        if (result.status !== Status.INTERMEDIATE) {
          q.done();
        }
      }
    } catch {
      for (const [url, q] of entries) {
        q.push(Result.clientFail(url, "batch request failed"));
        q.done();
      }
    }

    // Safety net — ensure every queue is closed
    for (const [, q] of entries) {
      q.done();
    }
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
