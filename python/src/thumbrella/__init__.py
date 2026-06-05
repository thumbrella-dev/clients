"""Thumbrella - fast thumbnails online media.

Usage:
    import thumbrella

    tbr = thumbrella.Client().verify()

    result = tbr.thumb("https://example.com/photo.jpg").verify()
    result.thumbnail.bytes  # JPEG bytes
    result.thumbnail.io     # zero-copy read-only stream

    print(result.kind, result.mime, result.file_size)
    if result.is_fresh():
        print("still fresh from last fetch")
"""

from .client import Client
from .result import Result
from .cache import Cache, MemoryCache
from .constants import Source, Status, FileKind, Strategy
from .errors import ThumbError

__all__ = [
    "Client",
    "Result",
    "Cache",
    "MemoryCache",
    "Source",
    "Status",
    "FileKind",
    "Strategy",
    "ThumbError",
]
