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
) -> Tuple[str, str]:
    """Parse a connect string into a session object."""
    if connect is None:
        connect = os.environ.get("TBR_CONNECT", DEFAULT_BASE)

    # Bare value — no scheme.  Dispatch to auth or handshake by prefix.
    if "://" not in connect:
        if _is_auth_token(connect):
            session.headers["Authorization"] = f"Bearer {connect}"
        else:
            session.headers["x-tbr-handshake"] = connect
        return DEFAULT_BASE, "cloud.thumbrella.dev:0"

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
        elif _is_auth_token(segment):
            session.headers["Authorization"] = f"Bearer {segment}"
        else:
            session.headers["x-tbr-handshake"] = segment

    return base, host


def requests_json(
    session: requests.Session,
    host: str,
    base_url: str,
    method: str,
    path: str,
    **kwargs: Any,
) -> Any:
    """Manage blocking, syncronous http post through requests"""
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
    """Manage asyncronous streaming http post through aiiohttp"""
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


# Global backoff — shared across all Client instances.
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

