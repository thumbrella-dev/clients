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
    """Result for every url.

    The result describes the operation for every thumbnail url. It handled both
    successed and failures. There are two levels of fields on the result.
    
    The top level ``url`` attribute contains the origin url the request was made
    for.

    The ``status`` attribute is used to help determine how this result should be
    handled. All statuses will still include an image, even for failures.
    Comparing the status to the defined values like
    `thumbrella.Status.SUCCESSFUL` is the best way to handle the status. The
    `verify()` method can also be used to return either a successful result,
    or raise an exception representing the problem.
    
    The top level fields all represent the process of generating the result.
    These describe if the operation was successful, how caching was involved,
    and the operations used by either the client or server. Most top level
    fields are optionally None, and may not be filled in, especially if the
    result was a failure.

    The ``media`` attribute represents all data collected about the media in a
    ``Media` value. This describes  file size, the mime type, and more. 
    
    This data is consistent and repeatable. When requesting data that has been
    cached by either the client or the server, the result will be the same media
    value that has been returned previously. The media objects have "object
    identity", which simplifies application caching and change tracking.

    The media also contains a ``thumbnail`` attribute which represents the jpeg
    encoded binary data for the thumbnail image. This binary data can be shared
    across multiple ``Media`` objects for efficient instances.
    
    Only the ``Client` methods generate ``Result`` values. They are intended to
    be immutable and constant. This is the same for the ``Media`` attribute.

    The fields and their meaning are described in more detail at
    https://thumbrella.dev/docs/result. The ``raw`` attribute represents the
    raw json data returned by the server, although the thumbnail binary data
    is removed for efficiency.

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
        """Build result from client side failure or unresponsive server."""
        data = {"url": url, "status": Status.FAILED, "source": Source.CLIENT, "message": message}
        return Result(data, thumbnail=_failed_thumbnail())

    def __repr__(self) -> str:
        return f"<thumbrella.Result {self.status} {self.url!r}>"

    def verify(self) -> Result:
        """Check if the result succeeded.

        This will return the successful result (itself) or raise a
        descriptive `ThumbError` exception.

        Failed results will still contain a placeholder thumbnail image.

        This can be checked more lightwight by comparing
        ``result.status == thumbrella.Status.SUCCEEDED``.
        """
        from .errors import ThumbError

        if self.status in (Status.SUCCESS, Status.INTERMEDIATE):
            return self
        raise ThumbError(
            f"thumbnail failed for {self.url}: {self.status}"
            + (f" - {self.message}" if self.message else "")
        )


class Media:
    """Data from the ``Result`` that describes the source media.

    Any two results from the same url that were cached (by either the client
    or the server) will share the same stable identity ``Media`` value for
    each result.

    The attributes are mostly mandatory. If the result has a ``media``
    attribute, then these fields will exist.

    The ``properties`` represent optional and additional informatio 
    Thumbrella provides to describe the media. Each ``kind`` has a different
    schema for what could be included in the properties. For example, images
    will come with ``width_pixels``, ``height_pixels`` and ``color_bpp``.
    But these properties are still optional and may not always be included.
    
    Stable media identity — reusable, cacheable, hashable by content.

    The ``thumbnail`` attribute will always be valid. This is a
    `EncodedJpeg` object that provides several conveniences for accessing
    the binary encoded image data. This thumbnail data can be shared across
    multiple instances of `Media` objects when it represents placeholder
    iamges.

    Media objects are only created from the `Client` object as part of
    a `Result`.

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

        The origin server that hosts the media can describe a time that the
        contents are guaranteed not to be changed. This freshness checking can
        be run to check if the client's current time does not need to 
        resubmit to be updated. 

        The `Client` will efficiently return the same `Media` when it is
        fresh, without requesting new data from the server.
        """
        return is_cache_fresh(self.cache)


class EncodedJpeg:
    """Binary JPEG thumbnail data.

    This is the value for the ``Media.thumbnail`` attribute. It can be shared
    across multiple medias to make placeholder images more efficient.

    This represents the encoded jpeg data stream. It does not represent pixel or
    image data itself. It must be used with an image library that understands
    how to read jpeg encoded data, like Pillow.
    
    There are several attributes to simplify loading the results into various
    Python media and image libraries. This is done efficiently in ways that
    avoid full copies of the jpeg data.

    Each Thumbrella thumbnail is approximately 5k of jpeg data. When the server
    encodes the image into json it uses a base64 encoding. This is handled
    lazily and automatically by this wrapper.

    Usage:
        img = Image.open(result.media.thumbnail.io)  # PIL (Pillow) surf =
        pygame.image.load(result.media.thumbnail)  # Pygame
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


    def __hash__(self) -> int:
        return id(self)

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
        """Byte length of the encoded jpeg binary data."""
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
