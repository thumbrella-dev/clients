# thumbrella-client

Python client for [Thumbrella](https://thumbrella.dev) — a thumbnail API that
handles images, video, documents, vector graphics, 3D models, and more.

[![PyPI version](https://img.shields.io/pypi/v/thumbrella-client)](https://pypi.org/project/thumbrella-client/)
[![Python](https://img.shields.io/pypi/pyversions/thumbrella-client)](https://pypi.org/project/thumbrella-client/)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](../../LICENSE)

Requires Python 3.10+.  Sync usage depends on `requests`.  Async streaming
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

# Stream results as each thumbnail completes (requires aiohttp).
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

Create a `Client` with a connect string.  Call `verify()` to confirm
connectivity.  Then use `thumb()`, `batch()`, or `stream()` to generate
thumbnails.

Every URL produces a `Result` — even failures include a placeholder JPEG.
Call `result.verify()` to raise on failure, or check `result.is_success()`.

### Connect Strings

```python
# No args — reads $TBR_CONNECT
thumbrella.Client()

# Local dev server
thumbrella.Client("http://localhost:3114")

# Cloud service with auth token
thumbrella.Client("tbr_e_oQftPlhB6ulGkdu5lILXKZBM")

# Custom server with handshake
thumbrella.Client("https://my-server.example.com,my-handshake")

# Custom HTTP headers
thumbrella.Client("https://api.example.com,Authorization=Bearer tok,x-custom=val")
```

The `session` attribute is a `requests.Session` — customize it for proxies,
TLS, cookies, or other HTTP configuration.

### Result

```python
result.url          # str — the requested URL
result.status        # "success" | "failed" | "overloaded" | "intermediate" | "unavailable"
result.source        # "render" | "shortcut" | "cache" | "fallback" | "client" | None
result.media         # Media | None
result.duration      # float — server processing time (s)
result.message       # str | None — error or informational message

result.is_success()  # True for "success" or "intermediate"
result.verify()      # returns self on success, raises ThumbError on failure
```

### Media

```python
media.url            # str — the original media URL
media.mime           # "image/jpeg" | ...
media.kind           # "image" | "video" | "audio" | "document" | "geometry" | ...
media.file_size      # int — original file size in bytes
media.extension      # str — canonical extension, no dot
media.cache          # str — cache token for conditional revalidation
media.placeholder    # str — non-empty when this is a shared placeholder image
media.properties     # dict[str, int|float] — format-specific metadata
media.thumbnail      # EncodedJpeg — always valid (falls back to "unavailable" JPEG)

media.is_fresh()     # True when the cache token hasn't expired
```

### EncodedJpeg

```python
jpeg.bytes           # bytes — decoded JPEG bytes (lazy, cached)
jpeg.io              # _BytesIO — file-like object, compatible with PIL and numpy
len(jpeg)            # int — byte count
jpeg.key             # int — content hash, usable as a dict key
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

All errors extend `ThumbError`.  `verify()` on a Client raises `VerifyError`.
Network issues raise `ConnectionError` or `TimeoutError`.  Per-result
failures don't raise — call `result.verify()` instead.

## Caching

Each `Client` defaults to an in-memory LRU cache (256 entries).  The cache
stores `Media` objects with TTL freshness.  Pass custom caches:

```python
import thumbrella

# No caching
thumbrella.Client(caches=[])

# Custom cache backend
class MyCache(thumbrella.Cache):
    def get(self, url: str) -> thumbrella.Media | None: ...
    def put(self, media: thumbrella.Media) -> None: ...
    def reset(self) -> None: ...

# Multiple layers — checked in order, first hit wins
thumbrella.Client(caches=[MyCache(), thumbrella.MemoryCache()])
```

`stream()` and `batch()` automatically check caches before calling the
server and send cache tokens for conditional revalidation.

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

## License

Apache-2.0. See [LICENSE](LICENSE).
