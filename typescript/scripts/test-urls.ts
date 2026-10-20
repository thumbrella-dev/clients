/**
 * test-urls.ts - regression checks for URL identity and batch fan-out.
 *
 *   npm run test
 *
 * The server echoes the URL it was given in Result.url, so a client can match
 * an answer to a request by string equality.  Two signed variants of one
 * object stay two distinct results.  Media.url is informational and is never
 * used as a cache key or identity.
 */

import assert from "node:assert/strict";
import {
  Client,
  BatchedClient,
  MemoryCache,
  Media,
  Result,
  Source,
  Status,
  mediaFromCaches,
  putAllCaches,
  removeFromCaches,
} from "../src/index.js";

type Item = { url: string };

function mockStream(build: (item: Item, i: number) => Record<string, unknown>[]) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    assert.match(String(input), /\/batch$/);
    const { items } = JSON.parse(String(init?.body)) as { items: Item[] };
    const lines = items.flatMap((item, i) =>
      build(item, i).map((r) => JSON.stringify(r)),
    );
    return new Response(lines.join("\n"), {
      headers: { "Content-Type": "application/x-ndjson" },
    });
  };
}

const originalFetch = globalThis.fetch;

async function testCanonicalCacheKeys(): Promise<void> {
  const a = "https://CDN.Example.com/path/File.JPG?X-Amz-Signature=aaa#frag";
  const b = "https://cdn.example.com/path/File.JPG?X-Amz-Signature=bbb";
  let calls = 0;
  const seen: { url: string; cache?: string }[] = [];

  globalThis.fetch = async (_input, init) => {
    calls++;
    const { items } = JSON.parse(String(init?.body)) as {
      items: { url: string; cache?: string }[];
    };
    seen.push(...items);
    const lines = items.map((item) => JSON.stringify({
      url: item.url,
      status: Status.SUCCESS,
      media: { url: "https://cdn.example.com/path/File.JPG", cache: "1:tok" },
    }));
    return new Response(lines.join("\n"));
  };

  const cache = new MemoryCache();
  const client = new Client({ connect: "https://server.test/api", caches: [cache] });
  await client.batch([a]);
  const [second] = await client.batch([b]);

  assert.equal(calls, 2, "the second variant revalidates instead of refetching blindly");
  assert.equal(seen[0]?.url, a, "the full signed URL is sent on the wire");
  assert.equal(seen[1]?.cache, "1:tok", "the canonical cache entry supplies the token");
  assert.equal(second.url, b, "the result keeps the requested URL");
  assert.ok(mediaFromCaches([cache], a), "the first variant is cached");
  assert.ok(
    mediaFromCaches([cache], b),
    "the second variant resolves to the same cache entry",
  );
  assert.equal(cache.size, 1, "signed variants share one entry");
}

function testRemoveFromCaches(): void {
  const a = "https://CDN.Example.com/path/File.JPG?X-Amz-Signature=aaa";
  const b = "https://cdn.example.com/path/File.JPG?X-Amz-Signature=bbb";
  const cache = new MemoryCache();

  putAllCaches([cache], a, new Media({ url: a, cache: "1:tok" }));
  assert.equal(cache.size, 1);

  removeFromCaches([cache], b);
  assert.equal(
    cache.size,
    0,
    "removing a signed variant removes the canonical entry",
  );
}

async function testExactEcho(): Promise<void> {
  const requested = "https://media.test/clip.mp4?X-Amz-Signature=abc123&X-Amz-Expires=900";
  globalThis.fetch = mockStream((item) => [
    { url: item.url, status: Status.INTERMEDIATE, media: { url: item.url } },
    { url: item.url, status: Status.SUCCESS, media: { url: item.url } },
  ]);

  const client = new Client({ connect: "https://server.test/api", caches: [] });
  const [batch] = await client.batch([requested]);
  assert.equal(batch.url, requested, "batch() reports the requested URL");
  assert.equal(batch.status, Status.SUCCESS);
  assert.ok(batch.media, "the result carries media");

  const streamed: Result[] = [];
  for await (const r of client.stream([requested])) streamed.push(r);
  assert.deepEqual(
    streamed.map((r) => [r.status, r.url]),
    [[Status.INTERMEDIATE, requested], [Status.SUCCESS, requested]],
    "stream() reports the requested URL on every line",
  );
}

async function testDistinctVariants(): Promise<void> {
  const a = "https://media.test/clip.mp4?X-Amz-Signature=aaa";
  const b = "https://media.test/clip.mp4?X-Amz-Signature=bbb";
  globalThis.fetch = mockStream((item) => [
    { url: item.url, status: Status.SUCCESS, media: { url: item.url } },
  ]);

  const client = new Client({ connect: "https://server.test/api", caches: [] });
  const results = await client.batch([a, b]);
  assert.deepEqual(results.map((r) => r.url), [a, b], "each answer keeps its own URL");
  assert.deepEqual(results.map((r) => r.status), [Status.SUCCESS, Status.SUCCESS]);
}

async function testRevalidation(): Promise<void> {
  const requested = "https://media.test/report.pdf?X-Amz-Signature=sig";
  let calls = 0;
  const seen: Record<string, unknown>[] = [];
  globalThis.fetch = async (_input, init) => {
    calls++;
    const { items } = JSON.parse(String(init?.body)) as { items: Record<string, unknown>[] };
    seen.push(...items);
    const lines = items.map((item) => JSON.stringify({
      url: item.url,
      status: Status.SUCCESS,
      // epoch 1 = origin supplied no Cache-Control (R2, plain static hosts)
      media: { url: item.url, cache: "1:tok" },
    }));
    return new Response(lines.join("\n"));
  };

  const client = new Client({ connect: "https://server.test/api" });
  await client.batch([requested]);
  const [revalidated] = await client.batch([requested]);
  assert.equal(calls, 2, "an origin with no lifetime is revalidated every time");
  assert.equal(seen.at(-1)?.cache, "1:tok", "the cache token is offered for revalidation");
  assert.equal(revalidated.status, Status.SUCCESS);
  assert.equal(revalidated.url, requested, "revalidation reports the requested URL");
}

async function testFanOut(): Promise<void> {
  const url = "https://media.test/one.jpg?X-Amz-Signature=xyz";
  globalThis.fetch = mockStream(() => [
    { url, status: Status.INTERMEDIATE, media: { url } },
    { url, status: Status.SUCCESS, media: { url } },
  ]);

  const client = new Client({ connect: "https://server.test/api", caches: [] });
  const batched = new BatchedClient(client);

  const collect = async (): Promise<string[]> => {
    const seen: string[] = [];
    for await (const r of batched.streamUrl(url)) seen.push(r.status);
    return seen;
  };

  const [first, second] = await Promise.all([collect(), collect()]);
  assert.deepEqual(first, [Status.INTERMEDIATE, Status.SUCCESS]);
  assert.deepEqual(second, first, "both subscribers receive the whole stream");
}

async function testClientKeying(): Promise<void> {
  const { getClient } = await import("../src/batched.js");
  const a = getClient("http://a.test");
  const b = getClient("http://b.test");
  assert.notEqual(a, b, "each connect string gets its own client");
  assert.equal(getClient("http://a.test"), a, "the same connect string is shared");
  assert.equal(a.baseUrl, "http://a.test");
  assert.equal(b.baseUrl, "http://b.test");
  assert.equal(
    a.cachesList[0],
    b.cachesList[0],
    "switching connect strings keeps the same cache",
  );
}

async function testFailuresAreNotCachedFresh(): Promise<void> {
  const requested = "https://media.test/broken.bin?X-Amz-Signature=sig";
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    const { items } = JSON.parse(String(init?.body)) as { items: Record<string, unknown>[] };
    const lines = items.map((item) => JSON.stringify({
      url: item.url,
      status: Status.FAILED,
      media: { url: item.url, cache: "1:tok" },
    }));
    return new Response(lines.join("\n"));
  };

  const client = new Client({ connect: "https://server.test/api" });
  await client.batch([requested]);
  await client.batch([requested]);
  assert.equal(calls, 2, "a failed result is retried on the next request");
}

async function testIntermediateDoesNotWinCache(): Promise<void> {
  const requested = "https://media.test/pic.svg?X-Amz-Signature=abc";
  const canonical = "https://media.test/pic.svg";
  let calls = 0;

  globalThis.fetch = async (_input, init) => {
    calls++;
    const { items } = JSON.parse(String(init?.body)) as {
      items: { url: string; cache?: string }[];
    };
    // First request streams an intermediate placeholder and then the real
    // render.  The server reports the final media under the canonical URL, but
    // the result URL stays the signed one the client asked for.
    const lines = calls === 1
      ? [
          {
            url: requested,
            status: Status.INTERMEDIATE,
            media: {
              url: requested,
              placeholder: "vector",
              cache: "1:tok",
              thumbnail: "QUJD",
            },
          },
          {
            url: requested,
            status: Status.SUCCESS,
            source: Source.RENDER,
            media: {
              url: canonical,
              placeholder: "",
              cache: "1:tok",
              thumbnail: "REVGRw==",
            },
          },
        ]
      : [
          {
            url: items[0]!.url,
            status: Status.SUCCESS,
            source: Source.NOT_MODIFIED,
          },
        ];
    return new Response(lines.map((l) => JSON.stringify(l)).join("\n"));
  };

  const cache = new MemoryCache();
  const client = new Client({ connect: "https://server.test/api", caches: [cache] });

  // Consume the stream one result at a time so the cache can be inspected after
  // the intermediate frame and before the final one.
  const iter = client.stream([requested]);
  const step = await iter.next();
  assert.equal(step.value?.status, Status.INTERMEDIATE);
  assert.equal(
    mediaFromCaches([cache], requested),
    undefined,
    "an intermediate placeholder must not seed the cache",
  );

  const last = await iter.next();
  assert.equal(last.value?.status, Status.SUCCESS);
  assert.equal(last.value?.url, requested, "the result keeps the requested URL");
  assert.equal(last.value?.media?.url, canonical, "media.url stays informational");
  assert.equal(last.value?.media?.placeholder, "", "the final result is not a placeholder");
  await iter.return?.(undefined);

  const cached = mediaFromCaches([cache], requested);
  assert.ok(cached, "the final result is cached under the requested URL");
  assert.equal(cached.placeholder, "", "the final result replaces the intermediate");
  assert.equal(cached.thumbnail.length, 4, "the final thumbnail is the one kept");

  const [revalidated] = await client.batch([requested]);
  assert.equal(revalidated.status, Status.SUCCESS);
  assert.equal(revalidated.media?.placeholder, "", "not_modified reuses the final media");
  assert.equal(
    revalidated.media?.thumbnail.length,
    4,
    "revalidation must not resurrect the intermediate placeholder",
  );
}

async function main(): Promise<void> {
  try {
    testRemoveFromCaches();
    await testExactEcho();
    await testDistinctVariants();
    await testRevalidation();
    await testCanonicalCacheKeys();
    await testFanOut();
    await testClientKeying();
    await testFailuresAreNotCachedFresh();
    await testIntermediateDoesNotWinCache();
    console.log("URL identity, revalidation and batch fan-out passed");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
