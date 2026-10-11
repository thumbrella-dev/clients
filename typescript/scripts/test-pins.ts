import assert from "node:assert/strict";
import { Client, Result } from "../src/index.js";

const originalFetch = globalThis.fetch;
const pins = [
  "pin/i123456789012.jpeg",
  "/pin/i123456789012.jpeg",
  "https://other.test/pin.jpeg",
  null,
  undefined,
  "http://[invalid",
];
const urls = pins.map((_, i) => `https://media.test/${i}.jpeg`);
const expected = [
  "https://server.test/api/pin/i123456789012.jpeg",
  "https://server.test/pin/i123456789012.jpeg",
  "https://other.test/pin.jpeg",
  null,
  null,
  null,
];
try {
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://server.test/api/batch");
    const { items } = JSON.parse(String(init?.body)) as { items: { url: string }[] };
    const results = items.map((item, i) => ({
      url: item.url, status: "success", ...(pins[i] === undefined ? {} : { pin: pins[i] }),
    }));
    return new Response(results.map((r) => JSON.stringify(r)).join("\n"));
  };
  const client = new Client({ connect: "https://server.test/api", caches: [] });
  const batch = await client.batch(urls);
  assert.deepEqual(batch.map((r) => r.pin), expected);
  const stream: Result[] = [];
  for await (const result of client.stream(urls)) stream.push(result);
  assert.deepEqual(stream.map((r) => r.pin), expected);
  assert.equal(batch[0].raw.pin, pins[0]);
  assert.equal(batch[5].status, "unavailable");
  assert.match(batch[5].message ?? "", /invalid pin URL/);
  assert.equal(Result.clientFail(urls[0], "offline").pin, null);
  console.log("Pin batch/stream resolution and v1 compatibility passed");
} finally {
  globalThis.fetch = originalFetch;
}
