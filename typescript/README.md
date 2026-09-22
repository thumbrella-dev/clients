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
`import { tbrSetup } from "https://js.thumbrella.dev/1.4/tbr.js";`

The `tbrSetup` call registers `<tbr-thumb>` and configures its loading states,
placeholders, caching, and lazy loading.

## Quickstart - Node and server

```ts
import { Client } from "@thumbrella/client";

// Defaults to $TBR_CONNECT of no `Client` argument provided
const tbr = await new Client("http://localhost:3114")

// Fetch a single thumbnail
const result = await tbr.thumb("https://demo.thumbrella.dev/media/pocket-game.webp");
console.log(result.status, result.media?.thumbnail.length ?? 0, "bytes");

// Stream results of thumbnail batch
const mediaUrls = [
  "https://demo.thumbrella.dev/media/padres-stereo.exr",
  "https://demo.thumbrella.dev/media/golden-gate.exr",
];
for await (const result of tbr.stream(mediaUrls)) {
  console.log(result.url, result.status);
}
```

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

