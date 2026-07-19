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

# Connect to server and generate a thumbnail.
tbr = thumbrella.Client()
result = tbr.thumb("https://demo.thumbrella.dev/media/base-glove.usdz")
print(result.status, len(result.media.thumbnail), "bytes")

# Pillow can decode from a zero-copy buffer.
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
