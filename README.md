# Thumbrella Clients

Official client libraries for the [Thumbrella](https://thumbrella.dev) thumbnail
API. Apache-2.0 licensed. Lightweight, typed, and easy to integrate.

Thumbrella is the open source server for online thumbnails.
Serve fast, cached thumbnails from over 100 formats: photographs, videos,
documents, even 3D models. Feed it your media libraries and get reliable
thumbnail back.

One command runs it locally or in Docker. Our Thumbrella Cloud is efficient enough
to offer a genuinely useful free tier.

Start with client the packages for languages you already use. Docs and examples
get you streaming thumbnails immediately.

The full documentation for clients is on the main Thumbrella website,
[thumbrella.dev/docs/client/](https://thumbrella.dev/docs/client/).

## Packages

There is a growing list of langauges supported by Thumbrella clients. See each
language readme file for more specific details.

| Language   | Package                                          | Status      |
|------------|--------------------------------------------------|-------------|
| TypeScript | [@thumbrella/client](./typescript)               | Prerelease  |
| Python     | [thumbrella-client](./python)                    | Prerelease  |
| Rust       | [thumbrella](./rust)                             | Prerelease  |

Thumbrella also provides several higher level component libraries for use in
web browsers. These are highly recomended when creating interactive applications
for the web.

| Environment| Package                                          | Status      |
|------------|--------------------------------------------------|-------------|
| React      | [@thumbrella/react](./react)                     | Planned     |
| Astro      | [@thumbrella/astro](./astro)                     | Prerelease  |

There are several other examples and subdirectories included that are not
packages or libraries.

| Directory  | Contents                                                       |
|------------|----------------------------------------------------------------|
| http/      | Examples of direct calls to servers (see humao.rest-client)    |

Each subdirectory is independently versioned, tested, and published to its
language's package registry. Framework components (React, Astro, etc.) depend on
the core TypeScript package.

## Library API Overview

Each language library exposes a similar set of core operations. Naming follows
each language's conventions but the semantics are identical. Each language will
use different `async` behaviors depending on the language and http dependencies.

First create a `Client()` object. This contains server configuration and 
client caching layers. 

The client methods will always return results, even placeholders if the
Thumbrella server is incaccesible.

The main methods are `batch(urls)` and `stream(urls)`. These both take a list
of media urls and will return a set of results for each. The batch call will
provide a full list of results at once, one for each url. The stream provides
a set of results and intermediate placeholders for thumbnails as soon as they
become available.

Every url will be provided a result object. These give metadata about the
media at the provided url. It also describes details about the thumbnail
process. Even invalid urls will recieve placeholder results.

The `verify()` method on the client and each result will convert failed
connections or results into an immediate exception with a descriptive
reason.

The client also has a simplified `thumb(url)` method to lookup a single url
and get a single result, or fail with an exception.

Each language provides a list of `Cache` object subclasses. These can cache
results in memory and also persist them for client reuse. Each `Client`
object accepts a list of cache objects at construction, and will default
to a minimal in-memory cache by default.

## Library Components Overview

The web component packages usually have a `<Thumbnail>` type of component,
and some will use a global `<Thumbrella>` component somewhere on the page
to manage the common configurations.

### Connect Strings

Every client needs a connection string to connect to a server. There are several
forms this string can take. Usually it is just the url of the server but it can
be extended with things like authentication tokens and even custom http headers.

By default the client fetches the connection string from the `$TBR_CONNECT`
environment variable. It can also be passed as an argument to the `Client`
constructor.

```
# Local dev server (no auth)
http://localhost:3114

# Thumbrella Cloud uses an authentication token
tbr_e_oQftPlhB6ulGkdu5lILXKZBM      (example)
```

## Quick Start

**TypeScript / Node.js**
```bash
npm install @thumbrella/client
```
```ts
import { Client } from "@thumbrella/client";
const tbr = await new Client().verify();
const result = await tbr.thumb("https://example.com/photo.jpg");
console.log(result.media?.thumbnail.length, "bytes");
```

**Python**
```bash
pip install thumbrella-client
```
```python
import thumbrella
tbr = thumbrella.Client().verify()
result = tbr.thumb("https://example.com/photo.jpg")
print(len(result.media.thumbnail), "bytes")
```

**Rust**
```bash
cargo add thumbrella
```
```rust
let tbr = thumbrella::Client::new(None);
tbr.verify().await?;
let result = tbr.thumb("https://example.com/photo.jpg").await?;
println!("{} bytes", result.media.unwrap().thumbnail.len());
```

## Examples

Each package includes runnable examples:

- **basic** — download a single thumbnail to disk
- **stream** — monitor streaming batch progress
- **collage** (Python) — build an image grid from streamed thumbnails
- **gallery** (Python) — batch download with persistent caching

Run them from the package directory:

```bash
# TypeScript
cd typescript && npx tsx examples/basic.ts https://demo.thumbrella.dev/media/math-guide.odt doc.jpeg

# Python
cd python && python examples/basic.py https://demo.thumbrella.dev/media/raw-canon.cr2 cam.jpeg

# Rust
cd rust && cargo run --example basic https://demo.thumbrella.dev/media/stanford-bunny.stl model.jpg
```

## License

Apache-2.0. See [LICENSE](./LICENSE).

