"""Thumbrella - fast thumbnails for online media.

Usage:
    import thumbrella

    tbr = thumbrella.Client()
    result = tbr.thumb("https://example.com/photo.jpg")
    result.thumbnail.bytes  # JPEG bytes

    print(result.kind, result.mime, result.file_size)
    if result.is_fresh():
        print("still fresh from last fetch")

    # Customize the session for proxies, TLS, etc.
    tbr.session.proxies = {"http": "http://proxy:8080"}
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
