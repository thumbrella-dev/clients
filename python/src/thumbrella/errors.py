"""Thumbrella client exceptions."""


class ThumbError(Exception):
    """Base exception for all Thumbrella client errors."""


class ConnectionError(ThumbError):
    """Could not reach the server."""


class ServerError(ThumbError):
    """Server returned an error response."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class VerifyError(ThumbError):
    """``Client.verify()`` failed — server is misconfigured or unreachable."""


class TimeoutError(ThumbError):
    """Request timed out."""
