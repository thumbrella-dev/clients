"""Helpers and abstractions for dealing with http, internal code"""

import json
import os
import time
import urllib.parse
from dataclasses import dataclass
from typing import Any, Literal, Sequence, AsyncIterator, TYPE_CHECKING

import requests

from .constants import DEFAULT_BASE, MAX_BACKOFF, HTTP_BACKOFF_TICK, HTTP_TIMEOUT
from .errors import ConnectionError, TimeoutError

_DEFAULT_HOST = urllib.parse.urlparse(DEFAULT_BASE).hostname or "cloud.thumbrella.dev"

if TYPE_CHECKING:
    import aiohttp


@dataclass(frozen=True)
class ConnectConfig:
    """Parsed connect string.

    Attributes:
        base_url: Server base URL, without a trailing slash.
        connect: Full effective connection string.
        host: Host and port, used for logging and backoff tracking.
        source: Where the connect string came from. One of ``"argument"``,
            ``"env"``, or ``"default"``. This is used to explain misconfig-
            urations in terms that match how the user set it up.
    """

    base_url: str
    connect: str
    host: str
    source: Literal["argument", "env", "default"]

def _is_auth_token(value: str) -> bool:
    """True when a value looks like a Thumbrella auth token (`tbr_[a-z]_` prefix)."""
    return (
        len(value) >= 6
        and value.startswith("tbr_")
        and value[4].islower()
        and value[5] == "_"
    )


def parse_connect(
    connect: str | None,
    session: requests.Session,
) -> ConnectConfig:
    """Parse a connect string into a session object.

    When ``connect`` is ``None`` this falls back to the
    ``$TBR_CONNECT`` environment variable, then to the Thumbrella Cloud
    default. The returned :class:`ConnectConfig` records which of these was
    used so callers can produce errors that match the user's setup.
    """
    source: Literal["argument", "env", "default"]
    if connect is not None:
        source = "argument"
    else:
        # Fall back to `$TBR_CONNECT`, then the Thumbrella Cloud default.
        env = os.environ.get("TBR_CONNECT")
        if env:
            connect = env
            source = "env"
        else:
            connect = DEFAULT_BASE
            source = "default"

    if not connect.strip():
        return ConnectConfig("", connect, "", source)

    # Bare value, no scheme.  Only auth tokens are valid without a URL.
    if "://" not in connect:
        if _is_auth_token(connect):
            session.headers["Authorization"] = f"Bearer {connect}"
            return ConnectConfig(DEFAULT_BASE, connect, f"{_DEFAULT_HOST}:0", source)
        raise ValueError(
            "bare connect string without a URL must be an auth token "
            "(tbr_?_...)"
        )

    segments = connect.split(",")
    server = segments[0].strip()
    segments = segments[1:]

    uri = urllib.parse.urlparse(server)
    base = f"{uri.scheme}://{uri.netloc}".rstrip("/")
    host = f"{uri.hostname}:{uri.port}" if uri.port else uri.hostname or ""

    for segment in segments:
        segment = segment.strip()
        if not segment:
            continue
        if "=" in segment:
            key, _, value = segment.partition("=")
            session.headers[key.strip()] = value.strip()
        elif _is_auth_token(segment):
            session.headers["Authorization"] = f"Bearer {segment}"
        else:
            session.headers["x-tbr-handshake"] = segment

    return ConnectConfig(base, connect, host, source)


def requests_json(
    session: requests.Session,
    host: str,
    base_url: str,
    method: str,
    path: str,
    **kwargs: Any,
) -> Any:
    """Manage blocking, synchronous http post through requests"""
    _check_backoff(host)

    url = base_url + path
    headers = {"Accept": "application/json"}
    headers.update(kwargs.pop("headers", ()))
    timeout = kwargs.pop("timeout", HTTP_TIMEOUT)

    try:
        response = session.request(
            method, url, headers=headers, timeout=timeout, **kwargs
        )
    except requests.Timeout as exc:
        raise TimeoutError(f"request to {host} timed out") from exc
    except requests.ConnectionError as exc:
        raise ConnectionError(f"could not connect to {host}: {exc}") from exc

    _record_backoff(host, response.status_code in (429, 503))
    return response.json()


async def aio_ndjson(
    session: "aiohttp.ClientSession",
    host: str,
    base_url: str,
    path: str,
    **kwargs: Any,
) -> AsyncIterator[dict[str, Any]]:
    """Manage asynchronous streaming http post through aiohttp"""
    _check_backoff(host)

    url = base_url + path
    headers = {"Accept": "application/x-ndjson"}
    headers.update(kwargs.pop("headers", ()))
    json_body = kwargs.pop("json", None)

    async with session.post(
        url, json=json_body, headers=headers, **kwargs
    ) as response:
        _record_backoff(host, response.status in (429, 503))

        if not response.ok:
            raise ConnectionError(
                f"server returned {response.status} {response.reason}"
            )
        buf = b""
        async for chunk in response.content:
            buf += chunk
            while b"\n" in buf:
                raw_line, buf = buf.split(b"\n", 1)
                line = raw_line.decode("utf-8").strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    pass
        # Flush any trailing data without a final newline.
        if buf:
            line = buf.decode("utf-8").strip()
            if line:
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    pass


# Global backoff, shared across all Client instances.
_host_backoff: dict[str, tuple[float, int]] = {}


def _check_backoff(host: str) -> None:
    """Check if host is on backoff timeout for ConnectionError"""
    global _host_backoff
    until, _ = _host_backoff.get(host, (0, 0))
    if time.monotonic() < until:
        time.sleep(HTTP_BACKOFF_TICK)
        raise ConnectionError("Server too busy, retry soon")


def _record_backoff(host: str, throttled: bool) -> None:
    global _host_backoff
    if throttled:
        _, failures = _host_backoff.get(host, (0, 0))
        failures += 1
        delay = min(2 ** failures, MAX_BACKOFF)
        # Better to use a retry-after header if available?
        _host_backoff[host] = (time.monotonic() + delay, failures)
    else:
        _host_backoff.pop(host, None)
