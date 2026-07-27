# Thumbrella Clients

Official client libraries for the [Thumbrella](https://thumbrella.dev) thumbnail
API.  Apache-2.0 licensed.  Lightweight, typed, and easy to integrate.

Thumbrella generates thumbnails for images, video, documents, vector graphics,
3D models, and more.  These clients wrap the HTTP API with language-idiomatic
interfaces: typed results, streaming batches, and pluggable caching.

## Packages

| Language   | Package                         | Status     |
|------------|---------------------------------|------------|
| TypeScript | [@thumbrella/client](./typescript) | Prerelease |
| Python     | [thumbrella-client](./python)   | Prerelease |
| Rust       | [thumbrella](./rust)            | Prerelease |

Each subdirectory is independently versioned, tested, and published.

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

## Library API Overview

Create a `Client` with a connect string (defaults to `$TBR_CONNECT`).  Call
`verify()` to confirm connectivity.  Then use `thumb()`, `batch()`, or
`stream()` to generate thumbnails.

Every URL produces a `Result` — even failures include a placeholder image.
Call `result.verify()` to raise on failure, or check `result.isSuccess()`.

### Connect Strings

```
# Local dev server (no auth)
http://localhost:3114

# Cloud service with auth token
tbr_e_oQftPlhB6ulGkdu5lILXKZBM

# Custom server with handshake
https://my-server.example.com,my-handshake

# Custom HTTP headers
https://api.example.com,Authorization=Bearer tok,x-custom=val
```

## Examples

Each package has runnable examples:

```bash
# TypeScript
cd typescript && npx tsx examples/basic.ts https://demo.thumbrella.dev/media/math-guide.odt doc.jpeg

# Python
cd python && python examples/basic.py https://demo.thumbrella.dev/media/raw-canon.cr2 cam.jpeg
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
