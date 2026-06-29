# thumbrella-client

Python client for [Thumbrella](https://thumbrella.dev) — a thumbnail API that
handles images, video, documents, vector graphics, 3D models, and more.

[![PyPI version](https://img.shields.io/pypi/v/thumbrella-client)](https://pypi.org/project/thumbrella-client/)
[![Python](https://img.shields.io/pypi/pyversions/thumbrella-client)](https://pypi.org/project/thumbrella-client/)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](../../LICENSE)

Thumbrella servers can be self-hosted or used as Thumbrella Cloud. This package
wraps the HTTP API with typed results, async streaming, pluggable caching, and
a connect-string system that works the same way across local dev, CI, and
production.

Requires Python 3.10+. Sync-only usage depends on `requests`. Async streaming
needs the optional `async` extra (`aiohttp`).

## Install

```bash
pip install thumbrella-client
```

For async streaming:

```bash
pip install "thumbrella-client[async]"
```

## Quick Start

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

# Stream results as the server finishes each thumbnail (requires aiohttp).
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
thumbrella.Client("https://cloud.thumbrella.dev,tbr_e_oQftPlhB6ulGkdu5lILXKZBM")

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
result.status      # "SUCCESS" | "FAILED" | "OVERLOADED" | "INTERMEDIATE" | ...
result.source      # "RENDER" | "CACHE" | "FALLBACK" | "PLACEHOLDER" | ...
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
print(img.mode, img.size)
```

### Errors

```python
from thumbrella import ThumbError, ConnectionError, TimeoutError, VerifyError
```

All errors extend `ThumbError`. `verify()` on a Client raises `VerifyError` for
bad config or unreachable servers. Network issues raise `ConnectionError` or
`TimeoutError`. Per-result failures don't raise — call `result.verify()` to
convert them to exceptions.

## Caching

Each `Client` defaults to an in-memory LRU cache (256 entries). Pass custom
caches to persist thumbnails across restarts or share them between clients:

```python
import thumbrella

# Default memory cache
thumbrella.Client()

# No caching
thumbrella.Client(caches=[])

# Custom cache backend
class MyCache(thumbrella.Cache):
    def get(self, url: str) -> thumbrella.Media | None:
        ...  # check persistent store
    def set(self, media: thumbrella.Media) -> None:
        ...  # write to persistent store
    def reset(self) -> None:
        ...  # clear

# Multiple layers — checked in order, first hit wins
thumbrella.Client(caches=[MyCache(), thumbrella.MemoryCache()])
```

## Examples

```bash
# Download one thumbnail to disk (with PIL inspection)
python examples/basic.py https://demo.thumbrella.dev/media/raw-canon.cr2 cam.jpeg

# Stream batch progress
python examples/stream.py https://example.com/a.jpg https://example.com/b.png

# Build a collage grid from streamed thumbnails
python examples/collage.py urls.txt

# Batch download with persistent caching
python examples/gallery.py https://example.com/a.jpg https://example.com/b.png
```

See [`examples/`](./examples) for full source.

## Where To Go Next

- [Full client documentation](https://thumbrella.dev/docs/client/)
- [Thumbrella main site](https://thumbrella.dev)
- [Thumbrella main site](https://thumbrella.dev)
- [GitHub repository](https://github.com/thumbrella-dev/clients)

## License

Apache-2.0. See [LICENSE](./LICENSE).

