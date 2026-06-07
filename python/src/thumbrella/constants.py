"""Status and type constants — string-based for cross-language portability."""


DEFAULT_BASE = "http://api.thumbrella.dev/"

MAX_BACKOFF = 60.0

HTTP_TIMEOUT = 12

HTTP_BACKOFF_TICK = 0.3


class Status:
    """Result statuses."""

    SUCCESS = "success"
    FAILED = "failed"
    OVERLOADED = "overloaded"
    INTERMEDIATE = "intermediate"
    PLACEHOLDER = "placeholder"  # Server returned a placeholder icon
    UNAVAILABLE = "unavailable"  # Only ever provided by the client


class FileKind:
    """Result media kinds."""

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
    """Result source — how the thumbnail was produced."""

    RENDER = "render"
    SHORTCUT = "shortcut"
    CACHE = "cache"
    NOT_MODIFIED = "not_modified"
    FALLBACK = "fallback"
    CLIENT = "client"
