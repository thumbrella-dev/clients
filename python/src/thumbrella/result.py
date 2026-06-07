"""Result and Media objects"""

from __future__ import annotations

import base64
import io
import os
import pkgutil
from typing import Any

from .constants import Source, Status, FileKind
from .cache import is_cache_fresh


class Result:
    """A single thumbnail request outcome — process fields + stable media.

    Each ``Result`` is unique per request invocation.  The ``media``
    attribute is the stable, reusable payload — two results for the same
    file share the same ``Media`` instance.

    Top-level fields describe *this invocation* (status, timing, source).
    The ``media`` sub-object holds the thumbnail, metadata, and cache token.

    On failure, ``media`` is ``None`` and ``message`` explains why.
    """
    __slots__ = (
        "url", "status", "message", "source", "duration", "download_size", 
        "placeholder", "media", "raw", "__weakref__",    
    )

    def __init__(
        self,
        data: dict[str, Any], 
        *,
        media: Media | None = None,
        thumbnail: EncodedJpeg | None = None,
    ) -> None:
        assert not (media and thumbnail), "cannot override media and override thumbnail on result"
        self.url: str = data.get("url", "")
        self.status: str = data.get("status", Status.UNAVAILABLE)
        self.message: str | None = data.get("message")
        self.source: str | None = data.get("source", Source.CLIENT)
        self.duration: float = float(data.get("duration", 0.0))
        self.download_size: int = int(data.get("download_size", 0))
        self.placeholder: str | None = data.get("placeholder")
        self.media: Media | None = media
        self.raw: dict[str, Any] = data
        if not media:
            media_data = data.get("media")
            if media_data is not None:
                media_data = dict(media_data)
                media_data.setdefault("url", self.url)
            else:
                media_data = {"url": self.url}
            self.media = Media(media_data, thumbnail=thumbnail)

    @classmethod
    def client_fail(
        cls,
        url: str,
        message: str,
    ) -> Result:
        """Build result from client side failure, or unresponsive server."""
        data = {"url": url, "status": Status.FAILED, "source": Source.CLIENT, "message": message}
        return Result(data, thumbnail=_failed_thumbnail())

    def __repr__(self) -> str:
        return f"<thumbrella.Result {self.status} {self.url!r}>"

    def verify(self) -> Result:
        """Check this result is usable.  Returns ``self`` for chaining.

        Raises :class:`ThumbError` on failure.  Symmetric with
        :meth:`Client.verify`.
        """
        from .errors import ThumbError

        if self.status in (Status.SUCCESS, Status.INTERMEDIATE):
            return self
        raise ThumbError(
            f"thumbnail failed for {self.url}: {self.status}"
            + (f" - {self.message}" if self.message else "")
        )


class Media:
    """Stable media identity — reusable, cacheable, hashable by content.

    Two ``Media`` instances with identical content compare equal and hash
    the same.  Use as dict keys for client-side image caches.

    The ``thumbnail`` is an :class:`EncodedJpeg` blob.  Placeholder
    thumbnails are shared across results via a per-server pool.
    """

    __slots__ = ("url", "thumbnail", "mime", "file_size", "kind",
                 "extension", "properties", "cache", "__weakref__")

    def __init__(
        self,
        data: dict[str, Any], 
        *,
        thumbnail: EncodedJpeg | None = None,
    ) -> None:
        self.url: str = data.get("url", "")
        self.cache: str = data.get("cache", "")
        self.file_size: int = data.get("file_size", 0)
        self.kind: str = data.get("kind", FileKind.UNKNOWN)
        self.extension: str = data.get("extension", "")
        self.mime: str = data.get("mime", "application/octet-stream")
        self.properties: dict[str, int | float] = data.get("properties", {})
        if thumbnail:
            self.thumbnail: EncodedJpeg = thumbnail
        else:
            thumb_data = data.get('thumbnail')
            if thumb_data:
                self.thumbnail: EncodedJpeg = EncodedJpeg(b64=thumb_data)
            else:
                self.thumbnail = _failed_thumbnail()

    def __eq__(self, other: object) -> bool:
        if isinstance(other, Media):
            return self is other
        return NotImplemented

    def __ne__(self, other: object) -> bool:
        if isinstance(other, Media):
            return self is not other
        return NotImplemented

    def __hash__(self) -> int:
        return id(self)

    def __repr__(self) -> str:
        n = len(self.thumbnail) if (self.thumbnail is not None) else 0
        return f"<thumbrella.Media {self.kind or '?'} {self.url!r} thumb={n}B>"

    def is_fresh(self) -> bool:
        """Check if the cached result is still fresh.

        Delegates to ``media.cache``.  Returns ``False`` when no cache
        data is available (always stale).
        """
        return is_cache_fresh(self.cache)


class EncodedJpeg:
    """Lazy-decoded JPEG thumbnail data, hashable by content.

    Used as the value of ``Media.thumbnail``.  Two blobs with identical
    bytes compare equal and hash the same, so ``media.thumbnail`` can be
    used directly as a dict key for client-side image caches::

        img_cache = {}
        img = img_cache.get(result.media.thumbnail)
        if img is None:
            img = img_cache[result.media.thumbnail] = load_jpeg(result.media.thumbnail.io)
    """

    __slots__ = ("_b64", "_data", "_hash", "__weakref__")

    def __init__(
        self,
        *,
        b64: str | None = None,
        data: bytes | None = None,
    ) -> None:
        self._b64 = b64
        self._data = data
        self._hash: int | None = None

    @property
    def bytes(self) -> bytes:
        """The raw JPEG payload (base64-decoded lazily on first access)."""
        if self._data is None:
            if self._b64:
                self._data = base64.b64decode(self._b64)
            else:
                self._data = b""
            self._b64 = None
        return self._data

    @property
    def io(self) -> "_BytesReader":
        """Fresh zero-copy read-only binary stream of the JPEG data."""
        return _BytesReader(self.bytes)

    @property
    def key(self) -> int:
        """Stable hash of the JPEG content — identical to ``hash(blob)``.

        Use as a dict key when you prefer attribute access over operator
        syntax, or when passing the key to an API that expects an int.
        """
        return hash(self)

    def __hash__(self) -> int:
        if self._hash is None:
            self._hash = hash(self.bytes)
        return self._hash

    def __eq__(self, other: object) -> bool:
        if isinstance(other, EncodedJpeg):
            return self.bytes == other.bytes
        return NotImplemented

    def __ne__(self, other: object) -> bool:
        eq = self.__eq__(other)
        if eq is NotImplemented:
            return NotImplemented
        return not eq

    def __bytes__(self) -> bytes:
        return self.bytes

    def __len__(self) -> int:
        """Byte length of the decoded JPEG, computed without decoding."""
        if self._data is not None:
            return len(self._data)
        if self._b64:
            # (n * 3) // 4 gives the decoded length for any valid base64
            # string, minus padding chars that carry no data.
            return (len(self._b64) * 3) // 4 - self._b64[-4:].count("=")
        return 0

    def __repr__(self) -> str:
        return f"<thumbrella.EncodedJpeg bytes={len(self)}>"


class _BytesReader:
    """Zero-copy read-only binary IO wrapping a bytes object."""

    def __init__(self, data: bytes) -> None:
        self.closed = False
        self._data = data
        self._view = memoryview(data)
        self._pos = 0

    def read(self, n: int = -1) -> memoryview | bytes:
        if n < 0:
            chunk = self._view[self._pos :]
            self._pos = len(self._view)
        else:
            end = self._pos + n
            chunk = self._view[self._pos : end]
            self._pos += len(chunk)

        # memoryview is somewhat limited in that it doesn't support methods
        # like "startswith`, which are definitely used by image libraries like
        # Pillow to do data sniffing. But none of that is needed for actual
        # decoding passes. In an effort to be "low copy" of data we cheat by
        # handing out two incompatible data types. Enjoy the (negligable)
        # effeciency. Choke on the tears of non-deterministic errors.
        if len(chunk) < 128:
            return chunk.tobytes()
        return chunk

    def readinto(self, buf: bytearray | memoryview) -> int:
        n = min(len(buf), len(self._view) - self._pos)
        memoryview(buf)[:n] = self._view[self._pos : self._pos + n]
        self._pos += n
        return n

    def seek(self, offset: int, whence: int = 0) -> int:
        if whence == os.SEEK_SET:
            self._pos = max(0, min(offset, len(self._view)))
        elif whence == os.SEEK_CUR:
            self._pos = max(0, min(self._pos + offset, len(self._view)))
        elif whence == os.SEEK_END:
            self._pos = max(0, min(len(self._view) + offset, len(self._view)))
        else:
            raise ValueError(f"invalid whence: {whence}")
        return self._pos

    def tell(self) -> int:
        return self._pos

    def getvalue(self):
        return self._data

    def readable(self) -> bool:
        return True

    def writable(self) -> bool:
        return False

    def isatty(self) -> bool:
        return False

    def seekable(self) -> bool:
        return True

    def write(self, _data: bytes) -> int:
        raise io.UnsupportedOperation("write")

    def truncate(self, _size: int | None = None) -> int:
        raise io.UnsupportedOperation("truncate")

    def fileno(self) -> int:
        raise io.UnsupportedOperation("fileno")

    def close(self) -> None:
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args) -> bool:
        return False


# Client side placeholder handles when server unreachable
_FAILED_PLACEHOLDER = None

def _failed_thumbnail():
    """Shared client failure thumbnail"""
    global _FAILED_PLACEHOLDER
    if not _FAILED_PLACEHOLDER:
        data = pkgutil.get_data("thumbrella", "failed.jpeg")
        _FAILED_PLACEHOLDER = EncodedJpeg(data=data)
    return _FAILED_PLACEHOLDER
