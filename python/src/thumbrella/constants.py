"""Status and type constants — string-based for cross-language portability."""


class Status:
    """Job status values returned by the server."""

    SUCCESS = "success"
    FAILED = "failed"
    OVERLOADED = "overloaded"
    INTERMEDIATE = "intermediate"

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


class Source:
    """How the thumbnail was produced.  ``None`` on failure."""

    RENDER = "render"
    SHORTCUT = "shortcut"
    CACHE = "cache"
    CLIENT = "client"


class Strategy:
    """Processing strategy used — matches the server's ``Strategy`` enum."""

    RENDER = "render"
    PROGRESSIVE = "progressive"
    EMBEDDED = "embedded"
    FALLBACK = "fallback"
