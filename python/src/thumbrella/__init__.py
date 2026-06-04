"""Thumbrella - fast thumbnails online media.

Usage:
    import thumbrella

    tbr = thumbrella.Client(connect="http://localhost:8001")
    # or with a handshake secret:
    # tbr = thumbrella.Client(connect="http://localhost:8001#my-handshake")

    tbr.verify()

    result = tbr.thumb("https://example.com/photo.jpg")
    result.data  # JPEG bytes
    img = result.to_pil()        # PIL Image (optional)
    arr = result.to_numpy()      # numpy array (optional)

    print(result.kind, result.mime, result.file_size)
    if result.is_fresh():
        print("still fresh from last fetch")
"""

from .client import Client
from .result import Result
from .cache import Cache, MemoryCache
from .constants import Status, FileKind, Strategy
from .errors import ThumbError

__all__ = [
    "Client",
    "Result",
    "Cache",
    "MemoryCache",
    "Status",
    "FileKind",
    "Strategy",
    "ThumbError",
]
