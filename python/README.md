# thumbrella-client

Python client for [Thumbrella](https://thumbrella.dev), a fast thumbnail server
for images, video, documents, and more.

[![PyPI version](https://img.shields.io/pypi/v/thumbrella-client)](https://pypi.org/project/thumbrella-client/)
[![Python](https://img.shields.io/pypi/pyversions/thumbrella-client)](https://pypi.org/project/thumbrella-client/)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](https://github.com/thumbrella-dev/clients/blob/main/LICENSE)

> Thumbrella is still in prerelease. The server functionality is operational,
> but several production components have yet to appear. Recommended for early
> evaluation only.

The [client git repository](https://github.com/thumbrella-dev/clients) also 
has packages for other languages and environments. See 
[Typescript](https://www.npmjs.com/package/@thumbrella/client), 
[Rust](https://crates.io/crates/thumbrella-client), 
[React](https://www.npmjs.com/package/@thumbrella/react), 
[Astro](https://www.npmjs.com/package/@thumbrella/astro), and more coming soon.

## Features

- Client defaults to synchronous requests with [requests](https://pypi.org/project/requests/)
- Async support via `thumbrella-client[async]` using [aiohttp](https://pypi.org/project/aiohttp/)
- The `batch()` call processes multiple URLs in parallel
- In-memory LRU cache takes full advantage of HTTP cache headers
- Binary thumbnail data loads easily into PIL, Qt, Pygame, or any other image library
- The client and server always provide placeholder images, even when disconnected or misconfigured
- Optional `verify()` methods promote failed results into exceptions
- Media classification and lightweight metadata provided with every result
- Thumbrella server supports hundreds of formats

## Quickstart

Install with your package manager of choice using `thumbrella-client` or `thumbrella-client[async]`.

```bash
uv add thumbrella-client
pip install thumbrella-client
```

```python
import thumbrella

# Client() reads $TBR_CONNECT from the environment.
# verify() checks the server is reachable and auth is valid.
tbr = thumbrella.Client().verify()

# Single URL — returns a Result with the thumbnail JPEG.
result = tbr.thumb("https://example.com/photo.jpg")
if result.is_success():
    print(len(result.media.thumbnail), "bytes")

# Batch many URLs at once.
results = tbr.batch([
    "https://example.com/a.jpg",
    "https://example.com/b.png",
])
for r in results:
    print(r.url, r.status, r.media.kind)

# Stream results as the server completes each thumbnail (requires aiohttp).
import asyncio

async def stream_example():
    tbr = thumbrella.Client()
    async for r in tbr.stream([
        "https://example.com/a.jpg",
        "https://example.com/b.png",
    ]):
        print(r.url, r.status)

asyncio.run(stream_example())
```

## How It Works

Create a `Client` with server configuration and optional caches. Call `verify()`
to confirm connectivity. Then use `thumb()`, `batch()`, or `stream()` to
generate thumbnails.

Every URL gets a `Result` — even failures produce a result with a placeholder
image and an error message. Use `result.verify()` to raise an exception on
failure, or check `result.is_success()` for inline handling.

### Connect Strings

The client reads `$TBR_CONNECT` by default. Pass a connect string to override:

```python
# Local dev server (no auth)
thumbrella.Client("http://localhost:3114")

# Cloud service with auth token
thumbrella.Client("https://api.thumbrella.dev,tbr_e_oQftPlhB6ulGkdu5lILXKZBM")

# Custom server with handshake value
thumbrella.Client("https://my-server.example.com,my-handshake")

# Custom HTTP headers
thumbrella.Client("https://api.example.com,Authorization=Bearer tok,x-custom=val")
```

The `session` attribute on a Client is a `requests.Session` — customize it for
proxies, TLS certificates, cookies, or other HTTP-level configuration.

### Result

```python
result.url         # str — the requested URL
result.status      # "success" | "failed" | "overloaded" | "intermediate" | ...
result.source      # "render" | "cache" | "fallback" | "placeholder" | ...
result.media       # Media | None — None when thumbnail could not be generated
result.duration    # float — server processing time (ms)
result.message     # str — error or informational message

result.is_success()  # True for SUCCESS or INTERMEDIATE
result.is_fresh()    # True when the server freshly rendered (not from cache)
result.verify()      # returns self on success, raises ThumbError on failure
```

### Media

```python
media.url          # str — the original media URL
media.mime         # "image/jpeg" | ...
media.kind         # "image" | "video" | "document" | "vector" | "geometry" | ...
media.file_size    # int — original file size in bytes
media.thumbnail    # EncodedJpeg — the thumbnail JPEG bytes
```

### EncodedJpeg

```python
jpeg.bytes         # bytes — decoded JPEG bytes (lazy, cached)
jpeg.io            # _BytesIO — file-like object, compatible with PIL and numpy
len(jpeg)          # int — byte count
jpeg.key           # str — content hash, useful for deduplication
```

PIL integration:

```python
from PIL import Image
img = Image.open(result.media.thumbnail.io)
```

The source comes with several starting point examples. See the [client
documentation](https://thumbrella.dev/docs/client/) for more details and
examples.

- [`examples/basic.py`](https://github.com/thumbrella-dev/clients/blob/main/python/examples/basic.py) 
  Download a thumbnail from a single url.
- [`examples/stream.py`](https://github.com/thumbrella-dev/clients/blob/main/python/examples/stream.py) 
  Stream multiple thumbnails as they render.
- [`examples/collage.py`](https://github.com/thumbrella-dev/clients/blob/main/python/examples/collage.py) 
  Assemble thumbnails from multiple sources into a single grid image.

## Servers

This client works with self-hosted Thumbrella servers and the online
Thumbrella Cloud service. Both are configured using the `$TBR_CONNECT`
environment variable. Alternatively, a connect string can be passed to the
`Client` constructor.

Thumbrella provides a [demo gallery](https://demo.thumbrella.dev) and server
that can be used for free with no account and no signup.

## License

Apache-2.0. See [LICENSE](https://github.com/thumbrella-dev/clients/blob/main/LICENSE).
