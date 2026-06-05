"""Result object — identity-stable, with shared thumbnail data."""

from __future__ import annotations

import base64
import io as _io
import time
import weakref
from typing import Any

from ._placeholders import FAILED as _FAILED_PLACEHOLDER
from .constants import Status


class _BytesReader:
    """Zero-copy read-only binary IO wrapping a bytes object."""

    def __init__(self, data: bytes) -> None:
        self._data = data
        self._pos = 0

    def read(self, n: int = -1) -> bytes:
        if n < 0:
            chunk = self._data[self._pos :]
            self._pos = len(self._data)
        else:
            chunk = self._data[self._pos : self._pos + n]
            self._pos += len(chunk)
        return chunk

    def readinto(self, buf: bytearray | memoryview) -> int:
        n = min(len(buf), len(self._data) - self._pos)
        buf[:n] = self._data[self._pos : self._pos + n]
        self._pos += n
        return n

    def seek(self, offset: int, whence: int = 0) -> int:
        if whence == 0:
            self._pos = max(0, min(offset, len(self._data)))
        elif whence == 1:
            self._pos = max(0, min(self._pos + offset, len(self._data)))
        elif whence == 2:
            self._pos = max(0, min(len(self._data) + offset, len(self._data)))
        else:
            raise ValueError(f"invalid whence: {whence}")
        return self._pos

    def tell(self) -> int:
        return self._pos

    def readable(self) -> bool:
        return True

    def writable(self) -> bool:
        return False

    def seekable(self) -> bool:
        return True

    def write(self, _data: bytes) -> int:
        raise _io.UnsupportedOperation("write")

    def truncate(self, _size: int | None = None) -> int:
        raise _io.UnsupportedOperation("truncate")

    def close(self) -> None:
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args: object) -> None:
        pass


class _JpegBlob:
    """Lazy-decoded JPEG thumbnail data, hashable by content.

    Used as the value of ``Result.thumbnail``.  Two blobs with identical
    bytes compare equal and hash the same, so ``result.thumbnail`` can be
    used directly as a dict key for client-side image caches::

        img_cache = {}
        img = img_cache.get(result.thumbnail)
        if img is None:
            img = img_cache[result.thumbnail] = load_jpeg(result.thumbnail.io)
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

    # -- constructors ---------------------------------------------------

    @classmethod
    def from_wire(cls, thumb: Any) -> _JpegBlob:
        if isinstance(thumb, str) and thumb:
            return cls(b64=thumb)
        if isinstance(thumb, bytes):
            return cls(data=thumb)
        return cls(data=b"")

    # -- content access -------------------------------------------------

    @property
    def bytes(self) -> bytes:
        """The raw JPEG payload (base64-decoded lazily on first access)."""
        if self._data is None:
            if self._b64:
                self._data = base64.b64decode(self._b64)
            else:
                self._data = b""
            self._b64 = None  # drop encoded form
        return self._data

    @property
    def io(self) -> _BytesReader:
        """Fresh zero-copy read-only binary stream of the JPEG data."""
        return _BytesReader(self.bytes)

    # -- identity (hashable / equatable by content) ---------------------

    def __hash__(self) -> int:
        if self._hash is None:
            self._hash = hash(self.bytes)
        return self._hash

    @property
    def key(self) -> int:
        """Stable hash of the JPEG content — identical to ``hash(blob)``.

        Use as a dict key when you prefer attribute access over operator
        syntax, or when passing the key to an API that expects an int.
        """
        return hash(self)

    def __eq__(self, other: object) -> bool:
        if isinstance(other, _JpegBlob):
            return self.bytes == other.bytes
        return NotImplemented

    def __ne__(self, other: object) -> bool:
        eq = self.__eq__(other)
        if eq is NotImplemented:
            return NotImplemented
        return not eq

    def __bytes__(self) -> bytes:
        return self.bytes

    def __repr__(self) -> str:
        n = len(self.bytes)
        return f"<thumbrella.Jpeg bytes={n}>" if n else "<thumbrella.Jpeg bytes=0>"


# Per-server placeholder sharing pool.
_PLACEHOLDER_POOL: weakref.WeakValueDictionary[str, _JpegBlob] = (
    weakref.WeakValueDictionary()
)


class Result:
    """A thumbnail result for one URL.

    Result objects are identity-stable: requesting the same URL from the same
    ``Client`` returns the same Python object (fields updated in-place).  This
    means you can hold a reference across multiple fetches and always see the
    latest data.

    Equality compares both source and rendered output fields.

    ``Result`` is mutable (values update in-place), so it is intentionally
    unhashable.
    """

    def __init__(
        self,
        url: str,
        *,
        _server_key: str = "",
    ) -> None:
        self.url = url
        self._server_key = _server_key
        self.status: str = Status.CLIENT_ERROR
        self.source_status: int | None = None
        self.duration: float = 0.0
        self.download_size: int = 0
        self.message: str | None = None
        self.strategy: str | None = None
        self.placeholder: str | None = None
        self.mime: str | None = None
        self.file_size: int | None = None
        self.kind: str | None = None
        self.extension: str | None = None
        self.properties: dict[str, Any] = {}
        self.cache: str | None = None
        self.source: str | None = None
        self.thumbnail: _JpegBlob = _JpegBlob(data=b"")
        self.raw: dict[str, Any] = {}

    # -- identity -----------------------------------------------------------

    __hash__ = None

    def __eq__(self, other: object) -> bool:
        if isinstance(other, Result):
            return (
                self.url == other.url
                and self.status == other.status
                and self.source_status == other.source_status
                and self.thumbnail == other.thumbnail
            )
        return NotImplemented

    def __ne__(self, other: object) -> bool:
        eq = self.__eq__(other)
        if eq is NotImplemented:
            return NotImplemented
        return not eq

    def __repr__(self) -> str:
        return f"<thumbrella.Result {self.status} {self.url!r}>" 

    # -- freshness ----------------------------------------------------------

    def is_fresh(self) -> bool:
        """Check if the cached result is still fresh.

        Parses the hex epoch prefix from the ``cache`` field.  Returns
        ``False`` when no cache data is available (always stale).
        """
        if not self.cache:
            return False
        try:
            epoch_hex, _, _ = self.cache.partition(":")
            expires = int(epoch_hex, 16)
        except (ValueError, TypeError):
            return False
        return expires > 0 and expires > time.time()

    def is_success(self) -> bool:
        """True when the thumbnail was produced successfully."""
        return self.status == Status.SUCCESS

    def raise_for_status(self) -> Result:
        """Raise an error if the result status is not successful or
        not-modified.  Returns ``self`` for chaining."""
        from .errors import ThumbError

        if self.status == Status.SUCCESS:
            return self
        raise ThumbError(
            f"thumbnail failed for {self.url}: {self.status}"
            + (f" — {self.message}" if self.message else "")
        )

    def verify(self) -> Result:
        """Check this result is usable.  Returns ``self`` for chaining.

        Raises :class:`ThumbError` on failure.  Symmetric with
        :meth:`Client.verify`.
        """
        return self.raise_for_status()

    # -- buffer protocol ----------------------------------------------------

    def __bytes__(self) -> bytes:
        return self.thumbnail.bytes

    def __len__(self) -> int:
        return len(self.thumbnail.bytes)

    # -- property accessors (forward-compat) --------------------------------

    def get(self, key: str, default: Any = None) -> Any:
        """Get a field from the raw JSON dict — useful for new server fields
        that the client library hasn't added as attributes yet."""
        return self.raw.get(key, default)

    # -- internal -----------------------------------------------------------

    def _update_from_json(self, raw: dict[str, Any]) -> None:
        """Update all fields in-place from a parsed JSON response dict."""
        self.raw = raw
        self.status = raw.get("status", Status.CLIENT_ERROR)
        self.source_status = raw.get("source_status")
        self.duration = float(raw.get("duration", 0))
        self.download_size = int(raw.get("download_size", 0))
        self.message = raw.get("message")
        self.strategy = raw.get("strategy")
        self.placeholder = raw.get("placeholder")
        self.mime = raw.get("mime")
        self.file_size = raw.get("file_size")
        self.kind = raw.get("kind")
        self.extension = raw.get("extension")
        self.properties = raw.get("properties") or {}
        self.cache = raw.get("cache")

        self.source = raw.get("source")

        # Pop thumbnail before storing raw — the blob owns it now.
        # Keeping b64 in raw wastes memory for the lifetime of the result.
        thumb = raw.pop("thumbnail", "")
        if self.placeholder is not None:
            self.thumbnail = self._get_or_create_placeholder_blob(thumb)
        else:
            self.thumbnail = _JpegBlob.from_wire(thumb)

    def _set_client_error(self, message: str) -> None:
        """Mark the result as a client-side error (server unreachable)."""
        self.status = Status.CLIENT_ERROR
        self.message = message
        self.thumbnail = _JpegBlob(data=_FAILED_PLACEHOLDER)

    def _update_from_result(self, other: Result) -> None:
        """Copy fields from another Result for the same URL.

        Used when a cache hit returns a different Result instance than the
        one the caller holds — the caller's instance is updated in-place.
        """
        if other is self:
            return
        self.status = other.status
        self.source_status = other.source_status
        self.duration = other.duration
        self.download_size = other.download_size
        self.message = other.message
        self.strategy = other.strategy
        self.placeholder = other.placeholder
        self.mime = other.mime
        self.file_size = other.file_size
        self.kind = other.kind
        self.extension = other.extension
        self.properties = dict(other.properties)
        self.cache = other.cache
        self.source = other.source
        self.thumbnail = other.thumbnail
        self.raw = dict(other.raw)

    def _get_or_create_placeholder_blob(self, thumb: Any) -> _JpegBlob:
        """Get a shared placeholder blob for this server+placeholder key."""
        placeholder_key = self.placeholder or "unknown"
        if isinstance(thumb, str):
            thumb_key = thumb
        elif isinstance(thumb, bytes):
            thumb_key = thumb.hex()
        else:
            thumb_key = ""

        key = f"{self._server_key}|{placeholder_key}|{thumb_key}"
        shared = _PLACEHOLDER_POOL.get(key)
        if shared is not None:
            return shared

        blob = _JpegBlob.from_wire(thumb)
        _PLACEHOLDER_POOL[key] = blob
        return blob
