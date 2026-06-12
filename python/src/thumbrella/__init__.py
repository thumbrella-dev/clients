"""Thumbrella - fast thumbnails for online media.

Thumbrella is an online thumbnailing service. It is easy to self host or run
self hosted servers or use existing online cloud services. Learn more at
https://thumbrella.dev

This Python client makes it simple and efficient to access the thumbnailer.
There are several main classes that manage the process. 

- `Client` is the main configuration and interface to accessing a server. It
  provides methods like `batch` and `stream` to generate a collection of `Result
  objects.
- Each `Result` contains a small collection of attributes about the thumbnail,
  the most important is the `media` attribute, which contains details about the
  origin file and the binary encoded jpeg data.
- There are also a set of `Cache` objects which make it easy to persist caching
  to systems like SQLite.

Usage:
    import thumbrella

    tbr = thumbrella.Client() result =
    tbr.thumb("https://example.com/photo.jpg") result.thumbnail.bytes  # JPEG
    encoded binary data
  
The Thumbrella server and a collection of client libraries and tools are all
released under the Apache 2 license. Visit https://thumbrella.dev/docs/ for more
information.

The server generates thumbnails for a variety of media; images, video, vector,
documents, 3d geometry, and more. This client makes is straightfoward to use
advanced server features; advanced caching, partial file reads, streaming
asyncronous batch result, fallbacks, rate control, and more.

The `Client.stream()` method provide asyncronous and efficient results. These
require the optional dependency ``aiohttp``. This can be installed
independently, or included with thumbrella as a feature, installing
```thumbrella-client[async]```

"""

from .client import Client
from .result import EncodedJpeg, Media, Result
from .cache import Cache, MemoryCache
from .constants import Source, Status, FileKind, Source
from .errors import ThumbError

__all__ = [
    "Client",
    "Media",
    "EncodedJpeg",
    "Result",
    "Cache",
    "MemoryCache",
    "Source",
    "Status",
    "FileKind",
    "ThumbError",
]
