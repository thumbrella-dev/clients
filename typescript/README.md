# @thumbrella/client

TypeScript client for [Thumbrella](https://thumbrella.dev) — a thumbnail API that
handles images, video, documents, vector graphics, 3D models, and more.

[![npm version](https://img.shields.io/npm/v/@thumbrella/client)](https://www.npmjs.com/package/@thumbrella/client)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](../../LICENSE)

Thumbrella servers can be self-hosted or used as a cloud service. This package
wraps the HTTP API with typed results, streaming batches, pluggable
caching, and a connect-string system that works the same way across local dev,
CI, and production.

Zero runtime dependencies outside Node.js built-ins. Runs on Node 18+ and
modern JS runtimes with native `fetch`.

## Install

```bash
npm install @thumbrella/client
```

## Quick Start

```ts
import { Client } from "@thumbrella/client";

// Client() reads $TBR_CONNECT from the environment.
// verify() checks the server is reachable and auth is valid.
const tbr = await new Client().verify();

// Single URL — returns a Result with the thumbnail JPEG.
const result = await tbr.thumb("https://example.com/photo.jpg");
if (result.isSuccess()) {
  console.log(result.media!.thumbnail.length, "bytes");
}

// Batch many URLs at once.
const results = await tbr.batch([
  "https://example.com/a.jpg",
  "https://example.com/b.png",
]);

// Stream results as the server finishes each thumbnail.
for await (const r of tbr.stream([
  "https://example.com/a.jpg",
  "https://example.com/b.png",
])) {
  console.log(r.url, r.status);
}
```

## How It Works

Create a `Client` with server configuration and optional caches. Call `verify()`
to confirm connectivity. Then use `thumb()`, `batch()`, or `stream()` to
generate thumbnails.

Every URL gets a `Result` — even failures produce a result with a placeholder
image and an error message. Use `result.verify()` to throw on failure, or check
`result.isSuccess()` for inline handling.

### Connect Strings

The client reads `$TBR_CONNECT` by default. Pass a connect string to override:

```ts
// Local dev server (no auth)
new Client({ connect: "http://localhost:3114" });

// Cloud service with auth token
new Client({ connect: "https://api.thumbrella.dev,tbr_e_oQftPlhB6ulGkdu5lILXKZBM" });

// Custom server with handshake value
new Client({ connect: "https://my-server.example.com,my-handshake" });

// Custom HTTP headers
new Client({ connect: "https://api.example.com,Authorization=Bearer tok,x-custom=val" });
```

### Result

```ts
result.url          // string — the requested URL
result.status       // "SUCCESS" | "FAILED" | "OVERLOADED" | "INTERMEDIATE" | ...
result.source       // "RENDER" | "CACHE" | "FALLBACK" | "PLACEHOLDER" | ...
result.media        // Media | null — null when thumbnail could not be generated
result.duration     // number — server processing time (ms)
result.message      // string — error or informational message

result.isSuccess()  // true for SUCCESS or INTERMEDIATE
result.isFresh()    // true when the server freshly rendered (not from cache)
result.verify()     // returns this on success, throws ThumbError on failure
```

### Media

```ts
media.url           // string — the original media URL
media.mime          // "image/jpeg" | ...
media.kind          // "image" | "video" | "document" | "vector" | "geometry" | ...
media.fileSize      // number — original file size in bytes
media.thumbnail     // EncodedJpeg — the thumbnail JPEG bytes
```

### EncodedJpeg

```ts
jpeg.bytes          // Uint8Array — decoded JPEG bytes (lazy, cached)
jpeg.length          // number — byte count
jpeg.key            // string — content hash, useful for deduplication
```

### Errors

```ts
import { ThumbError, VerifyError, ConnectionError, TimeoutError } from "@thumbrella/client";
```

All errors extend `ThumbError`. `verify()` on a Client throws `VerifyError` for
bad config or unreachable servers. Network issues throw `ConnectionError` or
`TimeoutError` (12s default). Per-result failures don't throw — call
`result.verify()` to convert them to exceptions.

## Caching

Each `Client` defaults to an in-memory LRU cache (256 entries). Pass custom
caches to persist thumbnails across restarts or share them between clients:

```ts
import { Client, MemoryCache, putAllCaches } from "@thumbrella/client";
import type { Cache } from "@thumbrella/client";

// No caching
new Client({ caches: [] });

// Custom cache backend
class MyCache implements Cache {
  get(url: string): Media | null { /* check persistent store */ }
  set(media: Media): void { /* write to persistent store */ }
  reset(): void { /* clear */ }
}

// Multiple layers — checked in order, first hit wins
new Client({ caches: [new MyCache(), new MemoryCache({ maxEntries: 512 })] });
```

## Examples

```bash
# Download one thumbnail to disk
npx tsx examples/basic.ts https://demo.thumbrella.dev/media/math-guide.odt doc.jpeg

# Stream batch progress
npx tsx examples/stream.ts https://example.com/a.jpg https://example.com/b.png

# Thumbnail a local file (upload mode — zero extra deps)
TBR_CONNECT=tbr_s_YOUR_TOKEN npx tsx examples/file-share.ts ./document.pdf out.jpg

# Thumbnail a local file via tunnel (no middleman, supports range requests)
npm install localtunnel
TBR_CONNECT=tbr_s_YOUR_TOKEN npx tsx examples/file-share.ts --tunnel ./video.mp4 thumb.jpg
```

### Shipped CLI: `npx thumbrella-file`

```bash
npm install @thumbrella/client

# Upload mode
TBR_CONNECT=tbr_s_YOUR_TOKEN npx thumbrella-file ./photo.jpg thumb.jpg

# Tunnel mode (one extra dep)
npm install localtunnel
TBR_CONNECT=tbr_s_YOUR_TOKEN npx thumbrella-file --tunnel ./video.mp4 thumb.jpg
```

Source at [`src/bin/file.ts`](./src/bin/file.ts).

## Where To Go Next

- [Full client documentation](https://thumbrella.dev/docs/client)
- [Thumbrella main site](https://thumbrella.dev)
- [TypeScript API reference](https://thumbrella.dev/docs/client/typescript)
- [GitHub repository](https://github.com/thumbrella-dev/thumbrella-clients)

## License

Apache-2.0. See [LICENSE](LICENSE).

