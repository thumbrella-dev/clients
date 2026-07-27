# @thumbrella/client

TypeScript client for [Thumbrella](https://thumbrella.dev) — a thumbnail API that
handles images, video, documents, vector graphics, 3D models, and more.

[![npm version](https://img.shields.io/npm/v/@thumbrella/client)](https://www.npmjs.com/package/@thumbrella/client)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](../../LICENSE)

Zero runtime dependencies.  Runs on Node 18+ and modern JS runtimes with
native `fetch`.  Includes a `<tbr-thumb>` custom element for zero-config
browser thumbnails.

## Install

```bash
npm install @thumbrella/client
```

## Quick Start — Node

```ts
import { Client } from "@thumbrella/client";

// No args → reads $TBR_CONNECT from the environment.
const tbr = await new Client().verify();

const result = await tbr.thumb("https://example.com/photo.jpg");
if (result.isSuccess()) {
  console.log(result.media!.thumbnail.length, "bytes");
}

// Batch many URLs at once.
const results = await tbr.batch([
  "https://example.com/a.jpg",
  "https://example.com/b.png",
]);

// Stream results as each thumbnail completes.
for await (const r of tbr.stream(["https://example.com/a.jpg", "https://example.com/b.png"])) {
  console.log(r.url, r.status);
}
```

## Quick Start — Browser

```html
<script type="module">
  import { tbrSetup } from "@thumbrella/client/element";
  tbrSetup("https://demo.thumbrella.dev");
</script>

<tbr-thumb src="https://demo.thumbrella.dev/media/space-colony.jpg"
           style="width:200px"></tbr-thumb>
<tbr-thumb src="https://demo.thumbrella.dev/media/stanford-bunny.stl"
           style="width:200px"></tbr-thumb>
```

One `tbrSetup` call and `<tbr-thumb>` elements handle everything: shimmer
skeleton, spinner, streaming placeholders, failure images, and byte-level
caching.  Zero configuration beyond the connect string.

## Module Structure

| Import                               | Contents                                     |
|--------------------------------------|----------------------------------------------|
| `@thumbrella/client`                 | `Client`, `Result`, `Media`, `EncodedJpeg`, types |
| `@thumbrella/client/element`         | `<tbr-thumb>` custom element, `tbrSetup()`    |
| `@thumbrella/client/browser`         | `getClient()`, `createThumbImg()`, `createBrowserCache()`, helpers |

Node users only import from the root.  Browser users import from `./element`
or `./browser`.

## How It Works

Create a `Client` with a connect string.  Call `verify()` to confirm
connectivity.  Then use `thumb()`, `batch()`, or `stream()` to generate
thumbnails.

Every URL produces a `Result` — even failures include a placeholder JPEG.
Call `result.verify()` to throw on failure, or check `result.isSuccess()`.

### Connect Strings

```ts
// No args — reads $TBR_CONNECT
new Client();

// Just a URL
new Client("http://localhost:3114");

// Auth token
new Client("tbr_e_oQftPlhB6ulGkdu5lILXKZBM");

// Full config
new Client({
  connect: "https://api.thumbrella.dev,tbr_e_xxx",
  caches: [],
});
```

### Client constructor

The constructor accepts a connect string, a config object, or nothing (reads
`$TBR_CONNECT` / `window.TBR_CONNECT`).

### Result

```ts
result.url          // string — the requested URL
result.status       // "success" | "failed" | "overloaded" | "intermediate" | "unavailable"
result.source       // "render" | "shortcut" | "cache" | "fallback" | "client" | null
result.media        // Media | null
result.duration     // number — server processing time (s)
result.message      // string | null — error or informational message
result.httpStatus   // number | null — upstream HTTP status

result.isSuccess()  // true for "success"
result.verify()     // returns this on success, throws ThumbError on failure
```

### Media

```ts
media.url           // string — the original media URL
media.mime          // "image/jpeg" | ...
media.kind          // "image" | "video" | "audio" | "document" | "geometry" | ...
media.fileSize      // number — original file size in bytes
media.extension     // string — canonical extension, no dot
media.cache         // string — cache token for conditional revalidation
media.placeholder   // string — non-empty when this is a shared placeholder image
media.properties    // Record<string, number> — format-specific metadata
media.thumbnail     // EncodedJpeg — always valid (falls back to "unavailable" JPEG)

media.isFresh()     // true when the cache token hasn't expired
```

### EncodedJpeg

```ts
jpeg.bytes          // Uint8Array — decoded JPEG bytes (lazy, cached)
jpeg.length         // number — byte count
jpeg.key            // number — content hash, usable as a Map key
```

### Errors

```ts
import { ThumbError, VerifyError, ConnectionError, TimeoutError } from "@thumbrella/client";
```

All errors extend `ThumbError`.  `verify()` on a Client throws `VerifyError`.
Network issues throw `ConnectionError` or `TimeoutError` (12 s default).
Per-result failures don't throw — call `result.verify()` instead.

## Caching

Each `Client` defaults to an in-memory LRU cache (256 entries).  The cache
stores `Media` objects with TTL freshness.  Pass custom caches:

```ts
import { Client, MemoryCache } from "@thumbrella/client";
import type { Cache } from "@thumbrella/client";

// No caching
new Client({ caches: [] });

// Custom cache backend
new Client({ caches: [new MemoryCache({ maxItems: 512 })] });
```

`stream()` and `batch()` automatically check caches before calling the
server and send cache tokens for conditional revalidation.

## `<tbr-thumb>` Element

| Attribute | Description |
|-----------|-------------|
| `src`     | Media URL to thumbnail |
| `connect` | Per-element connect string override |
| `alt`     | Accessible label (shown during loading) |
| `lazy`    | `"true"` to load only when scrolled into view |

CSS custom properties: `--tbr-shimmer`, `--tbr-spinner-color`, `--tbr-bg`.

Fires `tbr:loaded` (CustomEvent, bubbles, composed) with `detail: { result }`.

## Examples

```bash
# Open element.html in a browser — shows <tbr-thumb> in action.
open examples/element.html

# Download one thumbnail to disk.
npx tsx examples/basic.ts https://demo.thumbrella.dev/media/math-guide.odt doc.jpeg

# Stream batch progress.
npx tsx examples/stream.ts https://example.com/a.jpg https://example.com/b.png
```

## License

Apache-2.0. See [LICENSE](LICENSE).
