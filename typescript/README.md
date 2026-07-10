# @thumbrella/client

TypeScript/JavaScript client for [Thumbrella](https://thumbrella.dev), a fast
thumbnail server for images, video, documents, and more.

[![npm version](https://img.shields.io/npm/v/@thumbrella/client)](https://www.npmjs.com/package/@thumbrella/client)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](https://github.com/thumbrella-dev/clients/blob/main/LICENSE)

> Thumbrella is still in prerelease. The server functionality is operational,
> but several production components have yet to appear. Recommended for early
> evaluation only.

The [client git repository](https://github.com/thumbrella-dev/clients) also has
packages for other languages and environments. See
[Python](https://pypi.org/project/thumbrella-client/),
[Rust](https://crates.io/crates/thumbrella-client),
[React](https://www.npmjs.com/package/@thumbrella/react),
[Astro](https://www.npmjs.com/package/@thumbrella/astro), and more coming soon.

If you're building a React or Astro site, check out
**[@thumbrella/react](https://www.npmjs.com/package/@thumbrella/react)**
and **[@thumbrella/astro](https://www.npmjs.com/package/@thumbrella/astro)** —
component wrappers that drop straight into your templates.

## Features

- Zero runtime dependencies — only needs `fetch`
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

const tbr = await new Client().verify();
const result = await tbr.thumb("https://example.com/photo.jpg");

console.log(result.status, result.media!.thumbnail.length, "bytes");

// Batch many URLs
const results = await tbr.batch([
  "https://example.com/a.jpg",
  "https://example.com/b.png",
]);

// Stream results as they complete
for await (const r of tbr.stream([
  "https://example.com/a.jpg",
  "https://example.com/b.png",
])) {
  console.log(r.url, r.status);
}
```

Using the bundled CLI:

```bash
# Upload a file to a public host, then thumbnail the URL
npx thumbrella-file ./photo.jpg thumb.jpg

# Tunnel mode — serve from your machine, no middleman
npm install localtunnel
npx thumbrella-file --tunnel ./video.mp4 thumb.jpg
```

### Where to Run It

The client uses only `fetch` and standard APIs, so it works anywhere modern JS
runs. The same `import` works in:

- **Node 18+** — server-side scripts, workers, CI pipelines
- **Browsers** — directly in a `<script type="module">` or bundled with your SPA
- **Edge runtimes** — Cloudflare Workers, Deno Deploy, Bun

## Servers

This client works with self-hosted Thumbrella servers and the online Thumbrella
Cloud service. Both are configured using the `$TBR_CONNECT` environment variable.
Alternatively, pass a connect string to the `Client` constructor:

```ts
new Client({ connect: "http://localhost:3114" });                   // local dev
new Client({ connect: "https://cloud.thumbrella.dev,tbr_s_..." });  // cloud token
```

Thumbrella provides a [demo gallery](https://demo.thumbrella.dev) and server
that can be used for free — no account, no signup, immediate access.

## License

Apache-2.0. See [LICENSE](https://github.com/thumbrella-dev/clients/blob/main/LICENSE).

