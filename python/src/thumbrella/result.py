"""Result object — identity-stable, hashable, with image converters."""

from __future__ import annotations

import base64
import time
from typing import Any

from ._placeholders import FAILED as _FAILED_PLACEHOLDER
from .constants import Status


class Result:
    """A thumbnail result for one URL.

    Result objects are identity-stable: requesting the same URL from the same
    ``Client`` returns the same Python object (fields updated in-place).  This
    means you can hold a reference across multiple fetches and always see the
    latest data.

    Two Results compare equal and hash the same when they share the same URL.
    """

    def __init__(
        self,
        url: str,
    ) -> None:
        self.url = url
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
        self.data: bytes = b""
        self.raw: dict[str, Any] = {}
        self._decoded: dict[str, Any] = {}

    # -- identity -----------------------------------------------------------

    def __hash__(self) -> int:
        return hash(self.url)

    def __eq__(self, other: object) -> bool:
        if isinstance(other, Result):
            return self.url == other.url
        return NotImplemented

    def __repr__(self) -> str:
        return f"Result(url={self.url!r}, status={self.status!r})"

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

    def raise_for_status(self) -> None:
        """Raise an error if the result status is not successful or not-modified."""
        from .errors import ThumbError

        if self.status in (Status.SUCCESS, Status.NOT_MODIFIED):
            return
        raise ThumbError(
            f"thumbnail failed for {self.url}: {self.status}"
            + (f" — {self.message}" if self.message else "")
        )

    # -- image converters ---------------------------------------------------

    def to_pil(self):
        """Decode the JPEG thumbnail as a PIL Image.

        Requires ``Pillow``.  The decoded image is cached — subsequent calls
        return the same instance (even after in-place field updates, if the
        thumbnail bytes match).
        """
        if "pil" in self._decoded and self._decoded.get("_pil_data") == self.data:
            return self._decoded["pil"]

        from PIL import Image
        import io

        if not self.data:
            img = self._placeholder_image()
        else:
            img = Image.open(io.BytesIO(self.data))
            img.load()

        self._decoded["pil"] = img
        self._decoded["_pil_data"] = self.data
        return img

    # -- buffer protocol ----------------------------------------------------

    def __bytes__(self) -> bytes:
        return self.data

    def __len__(self) -> int:
        return len(self.data)

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

        thumb = raw.get("thumbnail", "")
        if isinstance(thumb, str) and thumb:
            self.data = base64.b64decode(thumb)
        elif isinstance(thumb, bytes):
            self.data = thumb
        else:
            self.data = b""

        # Invalidate cached decoders when data changes.
        if self._decoded.get("_pil_data") != self.data:
            self._decoded.clear()

    def _set_client_error(self, message: str) -> None:
        """Mark the result as a client-side error (server unreachable)."""
        self.status = Status.CLIENT_ERROR
        self.message = message
        self.data = self._placeholder_image_data()

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
        self.data = other.data
        self.raw = dict(other.raw)
        self._decoded.clear()

    def _placeholder_image(self):
        """Return the failed-placeholder as a PIL Image."""
        from PIL import Image
        import io
        return Image.open(io.BytesIO(_FAILED_PLACEHOLDER))

    def _placeholder_image_data(self) -> bytes:
        """Return the failed-placeholder JPEG bytes."""
        return _FAILED_PLACEHOLDER
