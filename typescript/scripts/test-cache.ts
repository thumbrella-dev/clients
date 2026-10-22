/**
 * test-cache.ts - persistent/byte cache backends and browser cache wiring.
 *
 *   npm run test
 */

import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  Client,
  Media,
  MemoryCache,
  Source,
  VerifyError,
  createMemoryCache,
  putAllCaches,
  removeFromCaches,
} from "../src/index.js";
import * as browser from "../src/browser.js";
import { createBrowserCache, tbrSetup } from "../src/browser.js";

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

async function testByteBackends(): Promise<void> {
  const originalFetch = globalThis.fetch;
  try {
    for (const cache of [new MemoryCache(), createMemoryCache(), createBrowserCache()]) {
      cache.reset();
      const requests: { url: string; cache?: string }[][] = [];
      let token = freshToken;
      let notModified = false;
      globalThis.fetch = async (_input, init) => {
        const { items } = JSON.parse(String(init?.body)) as {
          items: { url: string; cache?: string }[];
        };
        requests.push(items);
        return new Response(items.map(({ url }) => JSON.stringify({
          url,
          status: "success",
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

      const restored = await new Client({
        connect: "https://server.test",
        caches: [cache],
      }).thumb(second);
      assert.equal(restored.source, Source.CACHE);

      await client.thumb("https://media.test/other.glb");
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
}

async function testEmptyAndFailingCaches(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  let requests = 0;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  globalThis.fetch = async (_input, init) => {
    requests++;
    const { items } = JSON.parse(String(init?.body)) as { items: { url: string }[] };
    return new Response(items.map(({ url }) => JSON.stringify({
      url,
      status: "success",
      media: media(),
    })).join("\n"));
  };
  try {
    const url = "https://media.test/no-cache.glb";
    const uncached = new Client({ connect: "https://server.test", caches: [] });
    await uncached.thumb(url);
    await uncached.thumb(url);
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
}

async function testVerifyCoalescing(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let respond!: (response: Response) => void;
  globalThis.fetch = async () => {
    requests++;
    return new Promise((resolve) => { respond = resolve; });
  };
  try {
    const client = new Client("https://verify.test");
    const first = client.verify();
    const second = client.verify();
    assert.equal(requests, 1);

    respond(new Response(JSON.stringify({ status: "ok", thumbrella: 2, token: true })));
    assert.equal(await first, client);
    assert.equal(await second, client);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testConnectConfiguration(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalConnect = process.env.TBR_CONNECT;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(JSON.stringify({ status: "ok", thumbrella: 2, token: true }));
  };
  try {
    process.env.TBR_CONNECT = "https://environment.test";
    assert.equal(new Client().connect, "https://environment.test");
    const connect = "https://connect.test/,x-custom=value";
    const client = new Client(connect);
    assert.equal(client.connect, connect);
    assert.equal(client.baseUrl, "https://connect.test");
    assert.equal(await client.verify(), client);
    const token = "tbr_a_test";
    assert.equal(new Client(token).connect, token);
    assert.equal(new Client(token).baseUrl, "https://cloud.thumbrella.dev");
    for (const empty of ["", " \t\n"]) {
      for (const client of [new Client(empty), new Client({ connect: empty })]) {
        assert.equal(client.connect, empty);
        await assert.rejects(client.verify(), {
          name: VerifyError.name,
          message: "Connection string is empty",
        });
      }
    }
    assert.equal(requests, 1, "empty configuration never makes a request");
    delete process.env.TBR_CONNECT;
    assert.equal(new Client().connect, "https://cloud.thumbrella.dev");
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalConnect === undefined) delete process.env.TBR_CONNECT;
    else process.env.TBR_CONNECT = originalConnect;
  }
}

async function testStackRemoval(): Promise<void> {
  const cache = createMemoryCache();
  const url = "https://media.test/remove.glb?token=one";
  const key = "https://media.test/remove.glb";
  await putAllCaches([cache], url, new Media({ url, thumbnail: "AQID" }));
  assert.ok(await cache.get(key));
  await removeFromCaches([cache], url.replace("one", "two"));
  assert.equal(await cache.get(key), undefined);
}

async function testIndexedDbBudget(): Promise<void> {
  const cache = createBrowserCache(12 / (1024 * 1024));
  cache.reset();
  await cache.get("a");

  await cache.set("a", new Uint8Array(6));
  await cache.set("b", new Uint8Array(6));
  await cache.set("a", new Uint8Array(6));
  assert.equal((await cache.get("a"))?.length, 6);
  assert.equal((await cache.get("b"))?.length, 6);

  await cache.set("c", new Uint8Array(6));
  assert.equal(await cache.get("a"), undefined);
  assert.equal((await cache.get("b"))?.length, 6);
  assert.equal((await cache.get("c"))?.length, 6);

  await cache.set("b", new Uint8Array(8));
  assert.equal((await cache.get("b"))?.length, 8);
  assert.equal(await cache.get("c"), undefined);

  await assert.rejects(
    async () => cache.set("oversized", new Uint8Array(13)),
    RangeError,
  );

  await cache.set("removed", new Uint8Array(2));
  await cache.remove("removed");
  assert.equal(await cache.get("removed"), undefined);
}

async function testBrowserWiring(): Promise<void> {
  const globals = ["window", "document", "customElements"] as const;
  const descriptors = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  let definitions = 0;

  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      currentScript: { dataset: { tbrConnect: "https://persist.test", tbrPersist: "1" } },
      getElementById: () => null,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
  });
  Object.defineProperty(globalThis, "customElements", {
    configurable: true,
    value: { define: () => { definitions++; } },
  });

  try {
    // The old per-connect helpers are gone; tbrSetup is the only entry point.
    const exported = browser as unknown as Record<string, unknown>;
    for (const name of [
      "configure", "enablePersistentCache", "getClient",
      "getBatchedClient", "BatchedClient", "resolveConnect",
    ]) {
      assert.equal(exported[name], undefined, `${name} must not be exported`);
    }

    assert.throws(() => tbrSetup({ persist: -1 }), RangeError);

    // First call: script defaults, one memory cache, one persistent cache,
    // and one custom-element definition.
    const client = tbrSetup();
    assert.equal(client.connect, "https://persist.test");
    assert.equal(definitions, 1);
    assert.equal(client.cachesList.length, 2);
    assert.ok(client.cachesList[0] instanceof MemoryCache);
    const persistent = client.cachesList[1];

    // Repeated calls keep the same global client and do not redefine.
    assert.equal(tbrSetup(), client);
    assert.equal(tbrSetup({}), client);
    assert.equal(definitions, 1);

    // Replacing caches updates the current client in place.
    const replacement = createMemoryCache();
    assert.equal(tbrSetup({ caches: [replacement] }), client);
    assert.deepEqual(client.cachesList, [replacement]);

    // Changing the server creates a new client but reuses the cache objects.
    const other = tbrSetup("https://other.test");
    assert.notEqual(other, client);
    assert.equal(other.connect, "https://other.test");
    assert.equal(other.cachesList[0], replacement);
    assert.equal(tbrSetup(), other);

    // Persistence can be added later; it is appended to the current stack.
    const persisted = tbrSetup({ persist: 2 });
    assert.equal(persisted, other);
    assert.deepEqual(persisted.cachesList, [replacement, persistent]);

    // An explicit empty connect string is honoured.
    const empty = tbrSetup("");
    assert.equal(empty.connect, "");
    await assert.rejects(empty.verify(), VerifyError);
  } finally {
    globals.forEach((key, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}

async function main(): Promise<void> {
  await testByteBackends();
  await testEmptyAndFailingCaches();
  await testVerifyCoalescing();
  await testConnectConfiguration();
  await testStackRemoval();
  await testIndexedDbBudget();
  await testBrowserWiring();
  console.log("Byte caches, IndexedDB budget and browser wiring passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
