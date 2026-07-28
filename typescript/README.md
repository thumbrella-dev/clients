# @thumbrella/client

TypeScript/JavaScript client for [Thumbrella](https://thumbrella.dev), a fast
thumbnail server for images, video, documents, and more.

[![npm version](https://img.shields.io/npm/v/@thumbrella/client)](https://www.npmjs.com/package/@thumbrella/client)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](https://github.com/thumbrella-dev/clients/blob/main/LICENSE)

The [client git repository](https://github.com/thumbrella-dev/clients) also has
packages for other languages and environments. See
[Python](https://pypi.org/project/thumbrella-client/),
[Rust](https://crates.io/crates/thumbrella-client),

## Features

- Zero runtime dependencies, only needs `fetch`
- Runs in Node 18+, Deno, Bun, and modern browsers
- Stream results as the server renders thumbnails
- In-memory LRU cache takes full advantage of HTTP cache headers
- The client and server always provide placeholder images, even when disconnected
- Optional `verify()` methods promote failed results into exceptions
- Typed results with media classification and metadata
- Bundled CLI for thumbnailing local files
- Thumbrella server supports hundreds of formats

## Quickstart

```bash
npm install @thumbrella/client
```

```ts
import { Client } from "@thumbrella/client";

const tbr = await new Client();
const result = await tbr.thumb("https://demo.thumbrella.dev/media/pocket-game.webp");

console.log(result.status, result.media!.thumbnail.length, "bytes");

const media_urls = [
  "https://demo.thumbrella.dev/media/padres-stereo.exr",
  "https://demo.thumbrella.dev/media/golden-gate.exr",
];

// Batch many URLs
const results = await tbr.batch(media_urls);

// Stream results as they complete
for await (const r of tbr.stream(media_urls)) {
  console.log(r.url, r.status);
}
```

## Quick Start — Browser

```html
<script type="module">
  import { tbrSetup } from "@thumbrella/client/element";
  tbrSetup("https://demo.thumbrella.dev");
</script>

<tbr-thumb src="https://demo.thumbrella.dev/media/space-colony.jpg"></tbr-thumb>
<tbr-thumb src="https://demo.thumbrella.dev/media/stanford-bunny.stl"></tbr-thumb>
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
new Client("http://localhost:3114");             // local dev
new Client("tbr_e_3QnzBcWx7KpRmYT2000example");  // cloud token
```

Thumbrella provides a [demo gallery](https://demo.thumbrella.dev) and server
that can be used for free; no account, no signup, immediate access.

## License

Apache-2.0. See [LICENSE](https://github.com/thumbrella-dev/clients/blob/main/LICENSE).

