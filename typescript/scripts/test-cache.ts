import assert from "node:assert/strict";
import { test } from "node:test";
import "fake-indexeddb/auto";
import { Client, MemoryCache, Media, Source, canonicalUrl, createMemoryCache } from "../src/index.js";
import { configure, createBrowserCache, enablePersistentCache, getClient, getBatchedClient, tbrSetup } from "../src/browser.js";

const freshToken = `${(Math.floor(Date.now() / 1000) + 3600).toString(16)}:test`;
const staleToken = "1:test";

function media(cache = freshToken): Record<string, unknown> {
  return {
    url: "https://media.test/model.glb",
    thumbnail: "AQID",
    cache,
    kind: "geometry",
    mime: "model/gltf-binary",
    extension: "glb",
    file_size: 1234,
    properties: { vertices: 42 },
  };
}

test("canonical keys strip credentials but preserve content query parameters", () => {
  const cases = [
    ["HTTPS://MEDIA.test/model.glb?size=large&TOKEN=one#part", "https://media.test/model.glb?size=large"],
    ["https://media.test/a?X-Amz-Signature=a&X-Amz-Date=b&v=2", "https://media.test/a?v=2"],
    ["https://media.test/a?X-Goog-Credential=a&X-Goog-Expires=10&v=2", "https://media.test/a?v=2"],
    ["https://media.test/a?AWSAccessKeyId=a&Signature=b&Expires=1", "https://media.test/a"],
    ["https://media.test/a?sv=1&sp=r&sig=a&se=tomorrow&width=2", "https://media.test/a?width=2"],
    ["https://media.test/a?sv=1&width=2", "https://media.test/a?sv=1&width=2"],
    ["https://media.test/a?token=a&token=b&width=2&width=3", "https://media.test/a?width=2&width=3"],
    ["https://media.test/a?%74oken=a&v=2", "https://media.test/a?v=2"],
    ["https://media.test/a?b=2&a=1", "https://media.test/a?b=2&a=1"],
    ["https://media.test/a?q=a%20b&token=one", "https://media.test/a?q=a+b"],
    ["https://media.test/a?q=a%20b", "https://media.test/a?q=a+b"],
    ["file:///tmp/a?token=keep#part", "file:///tmp/a?token=keep#part"],
    ["/tmp/a?token=keep", "/tmp/a?token=keep"],
    ["https://[invalid", "https://[invalid"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(canonicalUrl(input), expected, input);
    assert.equal(canonicalUrl(canonicalUrl(input)), expected, input);
  }
});

test("MemoryCache lookup and removal use canonical keys", () => {
  const cache = new MemoryCache();
  const item = new Media({ ...media(), url: "https://media.test/a?token=one&v=2" });
  cache.put(item);
  assert.equal(cache.get("https://media.test/a?token=two&v=2"), item);
  assert.equal(cache.get("https://media.test/a?v=3"), undefined);
  cache.remove("https://media.test/a?token=three&v=2");
  assert.equal(cache.size, 0);
});

test("client media and byte caches preserve request URLs, metadata and revalidation", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const cache of [new MemoryCache(), createMemoryCache(), createBrowserCache()]) {
      cache.reset();
      const requests: { url: string; cache?: string }[][] = [];
      let token = freshToken;
      let notModified = false;
      globalThis.fetch = async (_input, init) => {
        const { items } = JSON.parse(String(init?.body)) as { items: { url: string; cache?: string }[] };
        requests.push(items);
        return new Response(items.map(({ url }) => JSON.stringify({
          url, status: "success",
          source: notModified ? "not_modified" : "render",
          ...(notModified ? {} : { media: media(token) }),
        })).join("\n"));
      };
      const client = new Client({ connect: "https://server.test", caches: [cache] });
      const first = "https://media.test/model.glb?v=2&token=one#part";
      const second = "https://media.test/model.glb?v=2&token=two";
      const result = await client.thumb(first);
      assert.equal(result.url, first);
      assert.equal(requests[0][0].url, first);
      const hit = await client.thumb(second);
      assert.equal(hit.url, second);
      assert.equal(hit.source, Source.CACHE);
      if (cache instanceof MemoryCache) assert.equal(hit.media, result.media);
      assert.equal(hit.media?.cache, freshToken);
      assert.deepEqual(hit.media?.properties, { vertices: 42 });
      assert.equal(hit.media?.fileSize, 1234);
      assert.deepEqual(hit.media?.thumbnail.bytes, new Uint8Array([1, 2, 3]));
      assert.equal(requests.length, 1);
      const restored = await new Client({ connect: "https://server.test", caches: [cache] }).thumb(second);
      assert.equal(restored.source, Source.CACHE);
      await client.thumb("https://media.test/model.glb?v=3&token=three");
      assert.equal(requests.length, 2);

      client.resetCaches();
      token = staleToken;
      await client.thumb(first);
      notModified = true;
      const revalidated = await client.thumb(second);
      assert.equal(requests.at(-1)?.[0].url, second);
      assert.equal(requests.at(-1)?.[0].cache, staleToken);
      assert.equal(revalidated.source, Source.NOT_MODIFIED);
      assert.deepEqual(revalidated.media?.thumbnail.bytes, new Uint8Array([1, 2, 3]));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("empty cache stacks disable caching and unavailable storage does not block requests", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  let requests = 0;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  globalThis.fetch = async (_input, init) => {
    requests++;
    const { items } = JSON.parse(String(init?.body)) as { items: { url: string }[] };
    return new Response(items.map(({ url }) => JSON.stringify({
      url, status: "success", media: media(),
    })).join("\n"));
  };
  try {
    const client = new Client({ connect: "https://server.test", caches: [] });
    const url = "https://media.test/no-cache.glb";
    await client.thumb(url);
    await client.thumb(url);
    assert.equal(requests, 2);
    const failing = new Client({
      connect: "https://server.test",
      caches: [{
        get: async () => { throw new DOMException("blocked", "SecurityError"); },
        set: async () => { throw new DOMException("full", "QuotaExceededError"); },
        reset: () => {},
      }],
    });
    assert.equal((await failing.thumb(url)).status, "success");
    assert.ok(warnings.some(([message]) => message === "Thumbrella cache read failed"));
    assert.ok(warnings.some(([message]) => message === "Thumbrella cache write failed"));
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("browser setup wires configured caches into existing and new shared clients", async () => {
  const oldFetch = globalThis.fetch;
  const globals = ["window", "document", "customElements"];
  const descriptors = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  let definitions = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      currentScript: { dataset: { tbrConnect: "https://setup.test", tbrPersist: "1" } },
      getElementById: () => null,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
  });
  Object.defineProperty(globalThis, "customElements", {
    configurable: true, value: { define: () => { definitions++; } },
  });
  try {
    getBatchedClient("https://setup.test");
    tbrSetup({ persist: -1 });
    assert.fail("invalid persistence should throw");
  } catch (error) {
    assert.ok(error instanceof RangeError);
  }
  try {
    tbrSetup();
    assert.equal(definitions, 1);
    tbrSetup();
    assert.equal(definitions, 1);
    const client = getClient();
    assert.equal(client, getBatchedClient("https://setup.test").client);
    assert.equal(client.cachesList.length, 2);
    assert.equal(getClient("https://other.test").baseUrl, "https://other.test");
    assert.notEqual(client, getClient("https://other.test"));
    const persistent = enablePersistentCache();
    assert.equal(client.cachesList.length, 2);

    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++;
      const { items } = JSON.parse(String(init?.body)) as { items: { url: string }[] };
      return new Response(items.map(({ url }) => JSON.stringify({
        url, status: "success", media: media(),
      })).join("\n"));
    };
    const url = "https://media.test/setup.glb?v=2&token=one";
    for await (const result of getBatchedClient().streamUrl(url)) {
      assert.equal(result.status, "success");
    }
    assert.ok(await persistent.get(canonicalUrl(url)));
    configure({ caches: [createBrowserCache()] });
    assert.equal(getClient(), client);
    const hit = await client.thumb(url.replace("one", "two"));
    assert.equal(hit.source, Source.CACHE);
    assert.equal(calls, 1);
    const replacement = createMemoryCache();
    configure({ caches: [replacement] });
    assert.deepEqual(client.cachesList, [replacement]);
    enablePersistentCache();
    assert.equal(client.cachesList.length, 2);
  } finally {
    globalThis.fetch = oldFetch;
    globals.forEach((key, i) => {
      if (descriptors[i]) Object.defineProperty(globalThis, key, descriptors[i]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});

test("IndexedDB enforces its byte budget without evicting unrelated entries on overwrite", async () => {
  const cache = createBrowserCache(12 / (1024 * 1024));
  cache.reset();
  // Await a read to ensure the queued reset transaction has committed.
  await cache.get("a");
  await cache.set("a", new Uint8Array(6));
  await cache.set("b", new Uint8Array(6));
  await cache.set("a", new Uint8Array(6));
  assert.equal((await cache.get("b"))?.length, 6);
  await cache.set("c", new Uint8Array(6));
  assert.equal(await cache.get("a"), undefined);
  assert.equal((await cache.get("b"))?.length, 6);
  assert.equal((await cache.get("c"))?.length, 6);
  await cache.set("b", new Uint8Array(8));
  assert.equal((await cache.get("b"))?.length, 8);
  assert.equal(await cache.get("c"), undefined);
  await assert.rejects(async () => cache.set("oversized", new Uint8Array(13)), RangeError);
});
