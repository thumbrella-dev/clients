"""Status and type constants — string-based for cross-language portability."""


class Status:
    """Job status values returned by the server."""

    SUCCESS = "success"
    NOT_MODIFIED = "not_modified"
    UNAVAILABLE = "unavailable"
    FAILED = "failed"

    # Client-side synthetic status (server unreachable)
    CLIENT_ERROR = "client_error"


class FileKind:
    """Media kind — matches the server's ``FileKind`` enum."""

    IMAGE = "image"
    VIDEO = "video"
    AUDIO = "audio"
    VECTOR = "vector"
    DOCUMENT = "document"
    GEOMETRY = "geometry"
    ARCHIVE = "archive"
    TEXT = "text"
    BINARY = "binary"
    UNKNOWN = "unknown"


class Strategy:
    """Processing strategy used — matches the server's ``Strategy`` enum."""

    RENDER = "render"
    SHORTCUT = "shortcut"
    FALLBACK = "fallback"
    HANDOFF = "handoff"
