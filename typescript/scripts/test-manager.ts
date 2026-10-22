/**
 * test-manager.ts - batching behaviour of the internal request manager.
 *
 * The manager is not part of the public browser API, but it is the piece that
 * coalesces `<tbr-thumb>` requests, so its fan-out and lifecycle rules are
 * tested directly.
 */

import assert from "node:assert/strict";
import type { Client } from "../src/api.js";
import { BATCH_LIMIT, ThumbnailManager } from "../src/manager.js";
import { Result, Status } from "../src/types.js";

interface Target {
  results: Result[];
  finished: Promise<void>;
  update(result: Result): void;
}

function target(): Target {
  const results: Result[] = [];
  let resolve!: () => void;
  const finished = new Promise<void>((r) => { resolve = r; });
  return {
    results,
    finished,
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

async function main(): Promise<void> {
  await testCoalescingAndDeduplication();
  await testIntermediateReplay();
  await testReleaseStopsUpdates();
  await testReleaseDropsQueuedRequest();
  await testBatchLimit();
  await testClientReplacement();
  await testStreamFailure();
  console.log("Request manager coalescing, replay and lifecycle passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
