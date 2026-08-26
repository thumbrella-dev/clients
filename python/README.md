# thumbrella-client

Python client for [Thumbrella](https://thumbrella.dev), a fast thumbnail server
for images, video, documents, and more.

[![PyPI version](https://img.shields.io/pypi/v/thumbrella-client)](https://pypi.org/project/thumbrella-client/)
[![Python](https://img.shields.io/pypi/pyversions/thumbrella-client)](https://pypi.org/project/thumbrella-client/)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](https://github.com/thumbrella-dev/clients/blob/main/LICENSE)

The [client git repository](https://github.com/thumbrella-dev/clients) also 
has packages for other languages and environments. See 
[Typescript](https://www.npmjs.com/package/@thumbrella/client), 
[Rust](https://crates.io/crates/thumbrella-client), and more coming soon.

## Features

- Client defaults to synchronous requests with [requests](https://pypi.org/project/requests/)
- Async support via `thumbrella-client[async]` using [aiohttp](https://pypi.org/project/aiohttp/)
- Single call efficiently processes multiple thumbnails in parallel
- Persistent client caching integrates with server and HTTP
- Placeholders for failures, even if disconnected or misconfigured
- Typed results with simple media metadata
- Load easily into `PIL`, `Qt`, `Pygame`, and others
- Thumbrella server supports 100+ formats

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
result = tbr.thumb("https://www.pygame.org/docs/_images/pygame_lofi.png")
if result.is_success():
    print(len(result.media.thumbnail), "bytes")

# Batch many URLs at once.
results = tbr.batch([
    "https://www.python.org/static/img/python-logo-large.png",
    "https://web.mit.edu/18.417/doc/pydocs/ref.pdf",
])
for r in results:
    print(r.url, r.status, r.media.kind)

# Stream results as the server completes each thumbnail (requires aiohttp).
import asyncio

async def stream_example():
    tbr = thumbrella.Client()
    async for r in tbr.stream([
        "https://www.python.org/static/img/python-logo-large.png",
        "https://web.mit.edu/18.417/doc/pydocs/ref.pdf",
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
thumbrella.Client("tbr_e_3QnzBcWx7KpRmYT2000example")
```

The connect string can also define custom headers. Thumbrella servers can
define an additional handshake token to prevent unwanted users. The documentation
describes these in more detail at, https://thumbrella.dev/docs/client/#connect

The `Client` object defines a `requests.Session` attribute which can be
further customized for proxies, TLS certificates, cookies, or other HTTP-level 
configuration.

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

All the result properties are documented at, 
https://thumbrella.dev/docs/client/#result

### Media

```python
media.url          # str — the original media URL
media.mime         # "image/jpeg" | "application/pdf" | ...
media.kind         # "image" | "video" | "document" | "vector" | "geometry" | ...
media.file_size    # int — original file size in bytes
media.thumbnail    # EncodedJpeg — the thumbnail JPEG bytes
```

All the result properties are documented at, 
https://thumbrella.dev/docs/client/#media

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

This client works with any self-hosted Thumbrella server and also the online
Thumbrella Cloud service. Both are configured using the `$TBR_CONNECT`
environment variable. Alternatively, a connect string can be passed to the
`Client` constructor.

Thumbrella provides a [demo gallery](https://demo.thumbrella.dev) and server
that can be used for free with no account and no signup.

## License

Apache-2.0. See [LICENSE](https://github.com/thumbrella-dev/clients/blob/main/LICENSE).
