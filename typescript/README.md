# @thumbrella/client

TypeScript/JavaScript client for [Thumbrella](https://thumbrella.dev), a fast
thumbnail server for images, video, documents, and more.

[![npm version](https://img.shields.io/npm/v/@thumbrella/client)](https://www.npmjs.com/package/@thumbrella/client)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](https://github.com/thumbrella-dev/clients/blob/main/LICENSE)

The [client git repository](https://github.com/thumbrella-dev/clients) also has
packages for other languages and environments. See
[Python](https://pypi.org/project/thumbrella-client/),
[Rust](https://crates.io/crates/thumbrella-client), and the
[full client documentation](https://thumbrella.dev/docs/client/).

For browser galleries and file browsers, start with the `<tbr-thumb>` web
component. Use the `Client` API when your application needs to control
requests, caching, batching, or streaming directly.

## Features

- Zero runtime dependencies, only needs `fetch`
- Runs in Node 18+, Deno, Bun, and modern browsers
- `<tbr-thumb>` web component for browser environments
- Single call efficiently processes multiple thumbnails in parallel
- Stream async results as the server renders thumbnails
- Client caching integrates with server and HTTP
- Placeholders for failures, even if disconnected or misconfigured
- Load easily into `sharp` and other image libraries
- Typed results with simple media metadata
- Thumbrella server supports 100+ formats

## Quickstart - Browser

Install the package if your application uses a bundler:

```bash
npm install @thumbrella/client
```

```html
<script type="module">
  import { tbrSetup } from "@thumbrella/client/browser";
  tbrSetup("http://localhost:3114");
</script>

<tbr-thumb
  src="https://demo.thumbrella.dev/media/space-colony.jpg"
  alt="Space colony">
</tbr-thumb>
```

For a static web page, import directly from the CDN and avoid the
npm operations with
`import { tbrSetup } from "https://js.thumbrella.dev/2.0/tbr.js";`

The `tbrSetup` call registers `<tbr-thumb>`, creates the page-wide client and
cache stack, and enables shared batching. Every element uses that single global
client; call `tbrSetup` again to change the connect string or cache stack.

The thumbnail will fade between various states. When first created the
it will look for the best available representation as an immediate starting
point. There will be a spinner overlayed while an actual remote request is
running.

## Quickstart - Node and server

```ts
import { Client } from "@thumbrella/client";

// Defaults to $TBR_CONNECT if no `Client` argument is provided
const tbr = await new Client("http://localhost:3114");

// Fetch a single thumbnail
const result = await tbr.thumb("https://demo.thumbrella.dev/media/pocket-game.webp");
console.log(result.status, result.media?.thumbnail.length ?? 0, "bytes");

// Stream results for a batch of thumbnails
const mediaUrls = [
  "https://demo.thumbrella.dev/media/padres-stereo.exr",
  "https://demo.thumbrella.dev/media/golden-gate.exr",
];
for await (const result of tbr.stream(mediaUrls)) {
  console.log(result.url, result.status);
}
```

## Result and media

### Result

```ts
result.url           // string - the requested URL
result.status        // "success" | "failed" | "overloaded" | "intermediate" | ...
result.source        // string | null - "render" | "cache" | "fallback" | "placeholder" | ...
result.media         // Media | null - source metadata and thumbnail, when available
result.duration      // number - server processing time (ms)
result.downloadSize  // number - bytes downloaded while processing
result.httpStatus    // number | null - source HTTP status, when available
result.message       // string | null - error or informational message
result.pin           // string | null - absolute URL to fetch the pinned JPEG
result.raw           // Record<string, unknown> - raw server result

result.isSuccess()   // true when status is "success"
result.isFresh()     // true when the media cache token has not expired
result.verify()      // returns this on success, throws ThumbError on failure
```

The client resolves `pin` against the HTTP request URL. It remains `null` when
pinning is unavailable or an older server omits the field.

See the [result documentation](https://thumbrella.dev/docs/client/#result)
for more details.

### Media

```ts
media.url          // string - informational, canonicalized url
media.mime         // string - "image/jpeg" | "application/pdf" | ...
media.kind         // string - "image" | "video" | "document" | "geometry" | ...
media.extension    // string - canonical extension without a dot
media.fileSize     // number - original file size in bytes (0 if unknown)
media.properties   // Record<string, number> - optional format-specific metadata
media.thumbnail    // EncodedJpeg - the thumbnail JPEG payload
media.cache        // string - opaque cache token used for revalidation
media.placeholder  // string - placeholder identifier, or empty for a real thumbnail
```

See the [media documentation](https://thumbrella.dev/docs/client/#media)
for more details.

### EncodedJpeg

```ts
jpeg.bytes         // Uint8Array - base64-decoded JPEG bytes (lazy, cached)
jpeg.length        // number - byte count
jpeg.key           // number - content hash, useful for deduplication
```

## Persistent Cache

`new Client({ caches })` accepts a `MemoryCache` or any `CacheBackend`
(`createMemoryCache`, `createBrowserCache`). In the browser, all
`<tbr-thumb>` elements share one global cache stack owned by `tbrSetup`:

```ts
import { createBrowserCache, tbrSetup } from "@thumbrella/client/browser";

tbrSetup({ persist: 10 });                    // add 10 MB of IndexedDB
tbrSetup({ caches: [createBrowserCache()] }); // replace the stack
```

Byte backends store serialized `Media` records, so thumbnails and their
metadata survive reloads. Calling `tbrSetup` again with a different connect
string creates a new global client but keeps the same cache objects.

On a `not_modified` result, cached thumbnail bytes and metadata are retained,
but a server-provided `media.cache` renews the stored freshness token. An
omitted token leaves the old value unchanged; an explicitly empty token
removes the entry from caches that support removal.

## Module Structure

| Import                               | Contents                                     |
|--------------------------------------|----------------------------------------------|
| `@thumbrella/client`                 | `Client`, `Result`, `Media`, `EncodedJpeg`, types |
| `@thumbrella/client/browser`         | browser helpers, `<tbr-thumb>` element, `tbrSetup()` |

Node users only import from the root. Browser users import from `browser`,
which includes `tbrSetup`, the `<tbr-thumb>` element, and the client
functionality used by the component.

### Where to Run It

The client uses only `fetch` and standard APIs, so it works anywhere modern JS
runs. The same `import` works in:

- **Node 18+** - server-side scripts, workers, CI pipelines
- **Browsers** - directly in a `<script type="module">` or bundled with your SPA
- **Edge runtimes** - Cloudflare Workers, Deno Deploy, Bun

## Servers

This client works with self-hosted Thumbrella servers and the online Thumbrella
Cloud service. Both are configured using the `$TBR_CONNECT` environment variable.
Alternatively, pass a connect string to the `Client` constructor:

```ts
new Client("http://localhost:3114");             // local server
new Client("tbr_e_3QnzBcWx7KpRmYT2000example");  // cloud token
new Client("https://demo.thumbrella.dev");       // free demo server
```

Thumbrella provides a [demo gallery](https://demo.thumbrella.dev) and server
that can be used for free with no account or signup. Use it for experimenting;
configure your own server or Cloud token for production applications.

## License

Apache-2.0. See [LICENSE](https://github.com/thumbrella-dev/clients/blob/main/LICENSE).
