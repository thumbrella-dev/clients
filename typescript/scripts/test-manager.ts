/**
 * test-manager.ts - batching behaviour of the internal request manager.
 *
 * The manager is not part of the public browser API, but it is the piece that
 * coalesces `<tbr-thumb>` requests, so its fan-out and lifecycle rules are
 * tested directly.
 */

import assert from "node:assert/strict";
import { Client } from "../src/api.js";
import { MemoryCache } from "../src/cache.js";
import { BATCH_LIMIT, ThumbnailManager } from "../src/manager.js";
import { Media, Result, Source, Status } from "../src/types.js";

interface Target {
  results: Result[];
  remoteStates: boolean[];
  finished: Promise<void>;
  update(result: Result): void;
  setRemotePending(pending: boolean): void;
}

function target(): Target {
  const results: Result[] = [];
  const remoteStates: boolean[] = [];
  let resolve!: () => void;
  const finished = new Promise<void>((r) => { resolve = r; });
  return {
    results,
    remoteStates,
    finished,
    setRemotePending(pending) {
      remoteStates.push(pending);
    },
    update(result) {
      results.push(result);
      if (result.status !== Status.INTERMEDIATE) resolve();
    },
  };
}

type Build = (url: string) => Record<string, unknown>[];

function fakeClient(batches: string[][], build: Build): Client {
  return {
    async *stream(urls: string[]) {
      batches.push([...urls]);
      for (const url of urls) {
        for (const item of build(url)) {
          yield new Result({ url, ...item });
        }
      }
    },
  } as unknown as Client;
}

function success(url: string): Record<string, unknown>[] {
  return [{ status: Status.SUCCESS, media: { url } }];
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for manager");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function testCoalescingAndDeduplication(): Promise<void> {
  const batches: string[][] = [];
  const manager = new ThumbnailManager();
  manager.setClient(fakeClient(batches, success));

  const a1 = target();
  const a2 = target();
  const b = target();
  manager.request("https://media.test/a", a1);
  manager.request("https://media.test/a", a2);
  manager.request("https://media.test/b", b);

  await Promise.all([a1.finished, a2.finished, b.finished]);

  assert.deepEqual(
    batches,
    [["https://media.test/a", "https://media.test/b"]],
    "same-tick requests share one batch and duplicate URLs are sent once",
  );
  for (const t of [a1, a2, b]) {
    assert.deepEqual(t.results.map((r) => r.status), [Status.SUCCESS]);
  }
}

async function testIntermediateReplay(): Promise<void> {
  const url = "https://media.test/slow";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const manager = new ThumbnailManager();
  manager.setClient({
    async *stream() {
      yield new Result({
        url,
        status: Status.INTERMEDIATE,
        media: { url, thumbnail: "QUJD", placeholder: "image" },
      });
      await gate;
      yield new Result({
        url,
        status: Status.SUCCESS,
        media: { url, thumbnail: "REVGRw==" },
      });
    },
  } as unknown as Client);

  const first = target();
  manager.request(url, first);
  await waitFor(() => first.results.length === 1);

  const second = target();
  manager.request(url, second);
  assert.equal(
    second.results.length,
    1,
    "a late subscriber receives the latest intermediate frame",
  );
  assert.deepEqual(
    second.results[0]?.media?.thumbnail.bytes,
    new Uint8Array([65, 66, 67]),
  );

  release();
  await Promise.all([first.finished, second.finished]);
  assert.equal(first.results.at(-1)?.status, Status.SUCCESS);
  assert.equal(second.results.at(-1)?.status, Status.SUCCESS);
}

async function testReleaseStopsUpdates(): Promise<void> {
  const url = "https://media.test/released";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const manager = new ThumbnailManager();
  manager.setClient({
    async *stream() {
      yield new Result({ url, status: Status.INTERMEDIATE, media: { url } });
      await gate;
      yield new Result({ url, status: Status.SUCCESS, media: { url } });
    },
  } as unknown as Client);

  const abandoned = target();
  const kept = target();
  manager.request(url, abandoned);
  manager.request(url, kept);
  await waitFor(() => abandoned.results.length === 1 && kept.results.length === 1);

  manager.release(abandoned);
  release();
  await kept.finished;

  assert.equal(abandoned.results.length, 1, "a released target gets no terminal frame");
  assert.equal(kept.results.at(-1)?.status, Status.SUCCESS);
}

async function testReplacementRejoinsActiveStream(): Promise<void> {
  const url = "https://media.test/replaced";
  let next!: () => void;
  let finish!: () => void;
  const nextGate = new Promise<void>((resolve) => { next = resolve; });
  const finalGate = new Promise<void>((resolve) => { finish = resolve; });
  let calls = 0;
  let secondDelivered = false;
  const manager = new ThumbnailManager();
  manager.setClient({
    async *stream() {
      calls++;
      yield new Result({
        url, status: Status.INTERMEDIATE,
        media: { thumbnail: "QUJD", placeholder: "image" },
      });
      await nextGate;
      yield new Result({
        url, status: Status.INTERMEDIATE,
        media: { thumbnail: "REVGRw==", placeholder: "image" },
      });
      secondDelivered = true;
      await finalGate;
      yield new Result({ url, status: Status.SUCCESS });
    },
  } as unknown as Client);

  const first = target();
  assert.equal(manager.join(url, first), false, "joining must not create a request");
  manager.request(url, first);
  await waitFor(() => first.results.length === 1);
  manager.release(first);

  const replacement = target();
  assert.equal(manager.join(url, replacement), true);
  assert.deepEqual(
    replacement.results[0]?.media?.thumbnail.bytes, new Uint8Array([65, 66, 67]),
    "removing the last element must not discard the active stream's frame",
  );
  manager.release(replacement);
  next();
  await waitFor(() => secondDelivered);

  const late = target();
  assert.equal(manager.join(url, late), true);
  assert.deepEqual(
    late.results[0]?.media?.thumbnail.bytes, new Uint8Array([68, 69, 70, 71]),
    "frames received with no mounted elements must still be remembered",
  );
  finish();
  await late.finished;
  assert.equal(calls, 1, "replacement elements must not duplicate a remote request");
  assert.equal(first.results.length, 1, "detached elements must stay unsubscribed");
  assert.equal(replacement.results.length, 1);
  assert.equal(manager.join(url, target()), false, "completed streams must not be retained");
}

async function testReleaseDropsQueuedRequest(): Promise<void> {
  const batches: string[][] = [];
  const manager = new ThumbnailManager();
  manager.setClient(fakeClient(batches, success));

  const t = target();
  manager.request("https://media.test/cancel", t);
  manager.release(t);

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(batches, [], "a request with no subscribers is never sent");
}

async function testUnobservedStreamCompletes(): Promise<void> {
  const url = "https://media.test/unobserved";
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  let completed = false;
  const manager = new ThumbnailManager();
  manager.setClient({
    async *stream() {
      yield new Result({ url, status: Status.INTERMEDIATE, media: { url } });
      await gate;
      yield new Result({ url, status: Status.SUCCESS, media: { url } });
      completed = true;
    },
  } as unknown as Client);

  const abandoned = target();
  manager.request(url, abandoned);
  await waitFor(() => abandoned.results.length === 1);
  manager.release(abandoned);
  finish();
  await waitFor(() => completed);
  assert.equal(abandoned.results.length, 1, "unmounted elements must not receive completion");
  assert.equal(manager.join(url, target()), false, "an unobserved completed request must be cleared");
}

async function testRemoteStateTracksActualFetch(): Promise<void> {
  const freshUrl = "https://media.test/local";
  const remoteUrl = "https://media.test/remote";
  const cache = new MemoryCache();
  cache.put(freshUrl, new Media({
    thumbnail: "QUJD",
    cache: `${(Math.floor(Date.now() / 1_000) + 60).toString(16)}:AAAA`,
  }));
  cache.put(remoteUrl, new Media({ thumbnail: "QUJD", cache: "1:AAAA" }));
  const originalFetch = globalThis.fetch;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  let fetches = 0;
  const manager = new ThumbnailManager();
  const fresh = target();
  const remote = target();
  try {
    globalThis.fetch = async (_input, init) => {
      fetches++;
      assert.deepEqual(
        JSON.parse(String(init?.body)).items.map((item: { url: string }) => item.url),
        [remoteUrl],
      );
      assert.equal(remote.remoteStates.at(-1), true, "pending state starts at fetch");
      assert.equal(fresh.remoteStates.includes(true), false, "fresh hits never go remote");
      await gate;
      return new Response(JSON.stringify({
        url: remoteUrl, status: Status.SUCCESS,
        media: { thumbnail: "QUJD" },
      }) + "\n");
    };
    manager.setClient(new Client({ connect: "http://server.test", caches: [cache] }));
    manager.request(freshUrl, fresh);
    manager.request(remoteUrl, remote);
    assert.equal(remote.remoteStates.includes(true), false, "queued work is not remote");
    await waitFor(() => fetches === 1);
    await fresh.finished;
    assert.equal(fresh.remoteStates.includes(true), false);

    const late = target();
    assert.equal(manager.join(remoteUrl, late), true);
    assert.equal(late.remoteStates.at(-1), true, "late subscribers share actual remote state");
    manager.release(remote);
    assert.equal(remote.remoteStates.at(-1), false, "released elements stop spinning");
    assert.equal(late.remoteStates.at(-1), true);
    finish();
    await late.finished;
    assert.equal(late.remoteStates.at(-1), false, "terminal result clears remote state");
    assert.equal(fetches, 1);

    globalThis.fetch = async () => { throw new Error("offline"); };
    const failed = target();
    manager.request("https://media.test/offline", failed);
    await failed.finished;
    assert.equal(failed.remoteStates.includes(true), true, "failed fetch was still a remote attempt");
    assert.equal(failed.remoteStates.at(-1), false, "failed fetch must clear pending state");
    assert.equal(failed.results.at(-1)?.status, Status.UNAVAILABLE);
  } finally {
    finish();
    globalThis.fetch = originalFetch;
  }
}

async function testBatchLimit(): Promise<void> {
  const batches: string[][] = [];
  const manager = new ThumbnailManager();
  manager.setClient(fakeClient(batches, success));

  const urls = Array.from(
    { length: BATCH_LIMIT + 5 },
    (_, i) => `https://media.test/${i}`,
  );
  const targets = urls.map(() => target());
  urls.forEach((url, i) => manager.request(url, targets[i]!));

  await Promise.all(targets.map((t) => t.finished));
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [BATCH_LIMIT, 5],
    "the manager caps each batch and drains the rest afterwards",
  );
}

async function testClientReplacement(): Promise<void> {
  const firstBatches: string[][] = [];
  const secondBatches: string[][] = [];
  const manager = new ThumbnailManager();
  manager.setClient(fakeClient(firstBatches, success));

  const first = target();
  manager.request("https://media.test/one", first);
  await first.finished;

  manager.setClient(fakeClient(secondBatches, success));
  const second = target();
  manager.request("https://media.test/two", second);
  await second.finished;

  assert.deepEqual(firstBatches, [["https://media.test/one"]]);
  assert.deepEqual(secondBatches, [["https://media.test/two"]]);
}

async function testStreamFailure(): Promise<void> {
  const manager = new ThumbnailManager();
  manager.setClient({
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("connection refused");
    },
  } as unknown as Client);

  const t = target();
  manager.request("https://media.test/down", t);
  await t.finished;

  const result = t.results.at(-1);
  assert.equal(result?.status, Status.UNAVAILABLE);
  assert.match(result?.message ?? "", /connection refused/);
}

async function testStaleCachePrimesIntermediate(): Promise<void> {
  const url = "https://media.test/stale";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const cache = new MemoryCache();
  cache.put(
    url,
    new Media({ url, thumbnail: "U1RBTEU=", cache: "1:AAAA" }),
  );

  const manager = new ThumbnailManager();
  manager.setClient({
    cachesList: [cache],
    async *stream() {
      yield new Result({
        url,
        status: Status.INTERMEDIATE,
        media: { url, thumbnail: "UExBQ0U=", placeholder: "image" },
      });
      await gate;
      yield new Result({ url, status: Status.SUCCESS, media: { url, thumbnail: "RklOQUw=" } });
    },
  } as unknown as Client);

  const t = target();
  manager.request(url, t);
  await waitFor(() => t.results.length >= 2);

  assert.equal(t.results[0]!.status, Status.INTERMEDIATE);
  assert.equal(t.results[0]!.source, Source.CACHE);
  assert.deepEqual(
    t.results[0]!.media?.thumbnail.bytes,
    new Uint8Array([83, 84, 65, 76, 69]),
    "the stale cached image is pushed before the server speaks",
  );

  // A late subscriber replays the stale image, not the server placeholder.
  const late = target();
  manager.request(url, late);
  assert.equal(late.results.length, 1);
  assert.deepEqual(late.results[0]?.media?.thumbnail.bytes, new Uint8Array([83, 84, 65, 76, 69]));

  manager.release(t);
  manager.release(late);
  const replacement = target();
  assert.equal(manager.join(url, replacement), true);
  assert.deepEqual(
    replacement.results[0]?.media?.thumbnail.bytes,
    new Uint8Array([83, 84, 65, 76, 69]),
    "a full view rebuild must preserve the real cached image over server placeholders",
  );

  release();
  await replacement.finished;
  assert.equal(replacement.results.at(-1)?.status, Status.SUCCESS);
}

async function testFreshCacheDoesNotPrime(): Promise<void> {
  const url = "https://media.test/fresh";
  const epoch = Math.floor(Date.now() / 1_000) + 60;
  const cache = new MemoryCache();
  cache.put(
    url,
    new Media({ url, thumbnail: "RlJFU0g=", cache: `${epoch.toString(16)}:AAAA` }),
  );

  const manager = new ThumbnailManager();
  manager.setClient({
    cachesList: [cache],
    async *stream() {
      yield new Result({ url, status: Status.SUCCESS, media: { url, thumbnail: "RklOQUw=" } });
    },
  } as unknown as Client);

  const t = target();
  manager.request(url, t);
  await t.finished;

  assert.deepEqual(
    t.results.map((r) => r.status),
    [Status.SUCCESS],
    "a fresh cache entry gets no synthetic intermediate",
  );
}

async function main(): Promise<void> {
  await testCoalescingAndDeduplication();
  await testIntermediateReplay();
  await testReplacementRejoinsActiveStream();
  await testStaleCachePrimesIntermediate();
  await testFreshCacheDoesNotPrime();
  await testReleaseStopsUpdates();
  await testReleaseDropsQueuedRequest();
  await testUnobservedStreamCompletes();
  await testRemoteStateTracksActualFetch();
  await testBatchLimit();
  await testClientReplacement();
  await testStreamFailure();
  console.log("Request manager coalescing, replay and lifecycle passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
