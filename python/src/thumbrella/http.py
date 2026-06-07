"""Helpers and abstractions for dealing with http, internal code"""

import json
import os
import time
import urllib.parse
from typing import Any, Tuple, Sequence, AsyncIterator, TYPE_CHECKING

import requests

from .constants import DEFAULT_BASE, MAX_BACKOFF, HTTP_BACKOFF_TICK, HTTP_TIMEOUT
from .errors import ConnectionError, TimeoutError

if TYPE_CHECKING:
    import aiohttp

# Global backoff — shared across all Client instances.
_host_backoff: dict[str, tuple[float, int]] = {}


def check_backoff(host: str) -> None:
    """Check if host is on backoff timeout for ConnectionError"""
    global _host_backoff
    until, _ = _host_backoff.get(host, (0, 0))
    if time.monotonic() < until:
        time.sleep(HTTP_BACKOFF_TICK)
        raise ConnectionError("Server too busy, retry soon")


def record_backoff(host: str, throttled: bool) -> None:
    global _host_backoff
    if throttled:
        _, failures = _host_backoff.get(host, (0, 0))
        failures += 1
        delay = min(2 ** failures, MAX_BACKOFF)
        # Better to use a retry-after header if available?
        _host_backoff[host] = (time.monotonic() + delay, failures)
    else:
        _host_backoff.pop(host, None)


def parse_connect(
    connect: str | None,
    session: requests.Session,
) -> Tuple[str, str]:
    """Parse a connect string, apply headers to *session*, return base URL.

    Formats
    -------
    ``TOKEN``
        Bearer token for the cloud platform.  Sets ``Authorization: Bearer``.
        Uses the default cloud API base URL.
    ``http://host:port``
        Bare server URL, no auth.
    ``http://host:port,TOKEN``
        Comma-separated suffix.  Bare strings (no ``=``) set
        ``Authorization: Bearer TOKEN``.
    ``http://host:port,Token1,Header=Val,Token2``
        Assignments become http headers
    ``None``
        Reads ``TBR_CONNECT`` env var, then falls back to the default.
    """
    if connect is None:
        connect = os.environ.get("TBR_CONNECT", DEFAULT_BASE)

    # Bare token — no scheme, no host:port.
    if "://" not in connect:
        session.headers["Authorization"] = f"Bearer {connect}"
        return DEFAULT_BASE, "api.thumbrella.dev:0"

    segments = connect.split(",")
    server = segments[0].strip()
    segments = segments[1:]

    uri = urllib.parse.urlparse(server)
    base = f"{uri.scheme}://{uri.netloc}"
    host = f"{uri.hostname}:{uri.port}" if uri.port else uri.hostname or ""

    for segment in segments:
        segment = segment.strip()
        if not segment:
            continue
        if "=" in segment:
            key, _, value = segment.partition("=")
            session.headers[key.strip()] = value.strip()
        else:
            # Bare token — always goes to Authorization: Bearer.
            session.headers["Authorization"] = f"Bearer {segment}"

    return base, host


def requests_json(
    session: requests.Session,
    host: str,
    base_url: str,
    method: str,
    path: str,
    **kwargs: Any,
) -> Any:
    """Send an HTTP request to the server with backoff for 429/503.

    Args:
        method: HTTP method (``"GET"``, ``"POST"``, etc.).
        path: Server path (e.g. ``"/batch"``).
        headers: Extra headers merged with session defaults.
        **kwargs: Passed to ``requests.Request`` (``params``, ``json``,
            ``data``, etc.).

    Returns:
        A :class:`requests.Response`.

    Raises:
        ConnectionError: could not reach the server.
        TimeoutError: request timed out.
    """
    check_backoff(host)

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

    record_backoff(host, response.status_code in (429, 503))
    return response.json()


async def aio_ndjson(
    session: "aiohttp.ClientSession",
    host: str,
    base_url: str,
    path: str,
    **kwargs: Any,
) -> AsyncIterator[dict[str, Any]]:
    """POST *json_body* to *url* and yield each NDJSON line as a parsed dict.

    If *session* is given it is reused (connection pooling, DNS cache);
    otherwise a new one is created per call.
    """
    check_backoff(host)

    url = base_url + path
    headers = {"Accept": "application/x-ndjson"}
    headers.update(kwargs.pop("headers", ()))
    json_body = kwargs.pop("json", None)

    async with session.post(
        url, json=json_body, headers=headers, **kwargs
    ) as response:
        record_backoff(host, response.status in (429, 503))

        if not response.ok:
            return
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

