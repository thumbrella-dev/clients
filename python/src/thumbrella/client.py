"""Thumbrella HTTP client."""

from __future__ import annotations

import os
import time
import weakref
from typing import Any, AsyncIterator, Sequence
from urllib.parse import urlparse

import requests

from .cache import Cache, MemoryCache
from .errors import ConnectionError, TimeoutError, VerifyError
from .result import Result


# Default base URL when none is configured.
_DEFAULT_BASE = "http://api.thumbrella.dev/"

# Backoff ceiling for 429/503 responses (seconds).
_MAX_BACKOFF = 60.0


class Client:
    """Thumbrella API client.

    All ``thumb()`` calls for the same URL return the same ``Result`` instance
    (fields updated in-place on re-fetch).  Results are weakly referenced —
    they live as long as your code holds a reference.

    By default, an in-memory :class:`MemoryCache` is enabled.  Pass
    ``caches=[]`` to disable caching entirely.
    """

    def __init__(
        self,
        connect: str | None = None,
        *,
        timeout: float = 30.0,
        caches: Sequence[Cache] | None = None,
    ) -> None:
        """Create a client.

        Args:
            connect: Connection string in one of these forms:
                - ``"tbr_s_XXXX"`` — bearer token for cloud platform
                - ``"http://host:port"`` — bare server URL
                - ``"http://host:port#HANDSHAKECODE"`` — URL with handshake
                  (bare fragment without ``tbr_`` prefix)
                - ``"http://host:port#tbr_s_XXXX"`` — staging URL with
                  bearer token (bare fragment starting with ``tbr_``)
                - ``"http://host:port#Key=val&Key2=val2"`` — URL with custom
                  headers
                - ``None`` — read ``TBR_CONNECT`` env var, then ``TBR_SERVER``,
                  then the default.
            timeout: Request timeout in seconds.
            caches: One or more :class:`Cache` backends.  ``None`` (the default)
                creates a :class:`MemoryCache` with 256 entries.  Pass an empty
                sequence to disable caching.
        """
        self._base_url, connect_headers = _parse_connect(connect)
        self._server_key = self._base_url
        self._timeout = timeout
        self._session = requests.Session()
        self._session.headers["User-Agent"] = "thumbrella-client/0.1"
        for key, value in connect_headers.items():
            self._session.headers[key] = value

        # Caches — checked in order on every request.
        if caches is None:
            self._caches: list[Cache] = [MemoryCache()]
        else:
            self._caches = list(caches)

        # Weak dict: URL → Result.  Callers holding a reference keep the
        # Result alive; when all references drop, it's garbage-collected.
        self._results: weakref.WeakValueDictionary[str, Result] = (
            weakref.WeakValueDictionary()
        )

        # Per-host backoff state: (backoff_until, consecutive_failures).
        self._backoff: dict[str, tuple[float, int]] = {}

    def __repr__(self) -> str:
        return f"<thumbrella.Client {self._base_url!r}>" 

    def __eq__(self, other: object) -> bool:
        return self is other

    def __ne__(self, other: object) -> bool:
        return not self == other

    def __hash__(self) -> int:
        return object.__hash__(self)

    # ── public API ────────────────────────────────────────────────────────

    def verify(self) -> Client:
        """Check connectivity.  Returns ``self`` for chaining.

        Uses ``/health`` for self-hosted servers and ``/token`` for the
        cloud platform (which validates the bearer token).

        Raises:
            VerifyError: if the server is unreachable or misconfigured.
        """
        path = "/token" if self._base_url == _DEFAULT_BASE else "/health"
        try:
            resp = self.request("GET", path)
            resp.raise_for_status()
            data = resp.json()
        except (ConnectionError, TimeoutError) as exc:
            raise VerifyError(
                f"could not reach server at {self._base_url}"
            ) from exc
        except requests.RequestException as exc:
            raise VerifyError(
                f"server at {self._base_url}: {exc}"
            ) from exc

        if data.get("status") != "ok":
            raise VerifyError(f"unexpected response: {data}")
        return self

    def thumb(self, url: str) -> Result:
        """Fetch a thumbnail for a single URL.  Raises on failure.

        Delegates to :meth:`batch` and auto-verifies the result.  The
        same ``Result`` instance is returned for repeated calls with the
        same URL (fields updated in-place).

        Raises:
            ThumbError: if the server returned an error for this URL.
        """
        return self.batch([url])[0].verify()

    def batch(self, urls: list[str]) -> list[Result]:
        """Fetch thumbnails for multiple URLs in one request.

        Returns a list of ``Result`` objects in the same order.

        Checks caches first — fresh URLs are not sent to the server.
        """
        results = [self._get_or_create_result(u) for u in urls]

        # Check caches and gather cache tokens for fresh entries.
        items = []
        fetch_indices: list[int] = []
        for i, r in enumerate(results):
            for cache in self._caches:
                cached = cache.get(r.url)
                if cached is not None and cached is not r:
                    r._update_from_result(cached)
            if r.is_fresh():
                r.source = "client"
                continue
            fetch_indices.append(i)
            item: dict[str, str] = {"url": r.url}
            if r.cache:
                item["cache"] = r.cache
            items.append(item)

        if not items:
            return results  # all fresh from cache

        try:
            resp = self.request(
                "POST",
                "/batch",
                json={"items": items},
            )
        except (ConnectionError, TimeoutError):
            for i in fetch_indices:
                results[i]._set_client_error("server unreachable")
            return results

        if not resp.ok:
            for r in results:
                r._set_client_error(f"server returned {resp.status_code}")
            return results

        try:
            body = resp.json()
        except ValueError:
            for r in results:
                r._set_client_error(f"invalid JSON from server ({resp.status_code})")
            return results

        for r, item in zip(results, body.get("items", [])):
            r._update_from_json(item)
            self._cache_put(r)
        return results

    async def stream(self, urls: list[str]) -> AsyncIterator[Result]:
        """Stream thumbnail results as they complete.

        Requires ``aiohttp``.
        """
        import aiohttp

        results = [self._get_or_create_result(u) for u in urls]
        url_map = {r.url: r for r in results}

        items = [
            {"url": url}
            if not (r.cache and r.is_fresh())
            else {"url": url, "cache": r.cache}
            for url, r in zip(urls, results)
        ]

        req = self.build_request(
            "POST", "/batch",
            json={"items": items},
            headers={"Accept": "application/x-ndjson"},
        )

        timeout = aiohttp.ClientTimeout(total=self._timeout)
        stream_urls = {item["url"] for item in items}
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(
                    req.url,
                    json=req.json,
                    headers=req.headers,
                ) as resp:
                    resp.raise_for_status()
                    async for raw_line in resp.content:
                        line = raw_line.decode("utf-8").strip()
                        if not line:
                            continue

                        import json

                        try:
                            event = json.loads(line)
                        except json.JSONDecodeError:
                            continue

                        if event.get("type") == "item.result":
                            item = event.get("result", {})
                            url = item.get("url", "")
                            if url in url_map:
                                result = url_map[url]
                                # Don't cache intermediate results — the
                                # real result arrives later in the stream.
                                if item.get("status") != "intermediate":
                                    result._update_from_json(item)
                                    self._cache_put(result)
                                yield result
                        elif event.get("type") == "item.error":
                            url = event.get("url", "")
                            if url in url_map:
                                url_map[url]._set_client_error(
                                    event.get("error", "stream error")
                                )
                                yield url_map[url]
        except Exception:
            for url in stream_urls:
                if url in url_map:
                    url_map[url]._set_client_error("stream connection lost")
                    yield url_map[url]

    @property
    def base_url(self) -> str:
        """The server base URL this client is connected to."""
        return self._base_url

    @property
    def caches(self) -> tuple[Cache, ...]:
        """Registered cache backends (read-only)."""
        return tuple(self._caches)

    def clear_caches(self) -> None:
        """Remove all entries from all registered caches."""
        for cache in self._caches:
            cache.clear()

    # ── internal ──────────────────────────────────────────────────────────

    def _cache_put(self, result: Result) -> None:
        """Store *result* in all registered caches."""
        for cache in self._caches:
            cache.put(result)

    def _get_or_create_result(self, url: str) -> Result:
        """Get existing Result for *url* or create a new one."""
        try:
            return self._results[url]
        except KeyError:
            result = Result(url, _server_key=self._server_key)
            self._results[url] = result
            return result

    def build_request(
        self,
        method: str,
        path: str,
        *,
        headers: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> requests.Request:
        """Build a :class:`requests.Request` without executing it.

        The request carries the full URL, session handshake headers, and
        any per-call overrides.  You can inspect it, modify it, or pass it
        to :meth:`_execute` (sync) or extract its fields for use with
        ``aiohttp`` / ``httpx`` (async).

        Args:
            method: HTTP method (``\"GET\"``, ``\"POST\"``, etc.).
            path: Server path (e.g. ``\"/thumb.jpeg\"``, ``\"/batch\"``).
            headers: Extra headers merged with session defaults.
            **kwargs: Passed to ``requests.Request`` (``params``, ``json``,
                ``data``, etc.).
        """
        url = f"{self._base_url}{path}"
        req_headers = dict(self._session.headers)
        if headers:
            req_headers.update(headers)
        return requests.Request(method, url, headers=req_headers, **kwargs)

    def _execute(self, req: requests.Request) -> requests.Response:
        """Prepare and send *req* with per-host backoff for 429/503."""
        prepared = self._session.prepare_request(req)
        host = urlparse(prepared.url).hostname or ""
        backoff_until, failures = self._backoff.get(host, (0, 0))

        if time.monotonic() < backoff_until:
            wait = backoff_until - time.monotonic()
            time.sleep(wait)

        try:
            resp = self._session.send(prepared, timeout=self._timeout)
        except requests.Timeout as exc:
            raise TimeoutError(f"request to {host} timed out") from exc
        except requests.ConnectionError as exc:
            raise ConnectionError(f"could not connect to {host}: {exc}") from exc

        if resp.status_code in (429, 503):
            failures += 1
            delay = min(2 ** failures, _MAX_BACKOFF)
            self._backoff[host] = (time.monotonic() + delay, failures)
        elif resp.ok:
            self._backoff.pop(host, None)

        return resp

    def request(
        self,
        method: str,
        path: str,
        *,
        headers: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> requests.Response:
        """Low-level HTTP request — build + execute in one call.

        Prefer :meth:`thumb` or :meth:`batch` for normal use.  For async
        use, call :meth:`build_request` and extract fields for your async
        HTTP library.

        Args:
            method: HTTP method (``\"GET\"``, ``\"POST\"``, etc.).
            path: Server path (e.g. ``\"/thumb.jpeg\"``, ``\"/batch\"``).
            headers: Extra headers merged with session defaults.
            **kwargs: Passed to ``requests.Request`` (``params``, ``json``,
                ``data``, etc.).
        """
        return self._execute(
            self.build_request(method, path, headers=headers, **kwargs)
        )


# ── connect string parsing ────────────────────────────────────────────────

# Fragment segment without '=' is shorthand for this header.
_HANDSHAKE_HEADER = "x-tbr-handshake"


def _parse_connect(
    connect: str | None,
) -> tuple[str, dict[str, str]]:
    """Parse a connect string into (base_url, extra_headers).

    Formats
    -------
    ``tbr_X_XXXX``
        Bearer token for the cloud platform.  Sets ``Authorization: Bearer``.
        Uses the default cloud API base URL.
    ``http://host:port``
        Bare server URL, no auth.
    ``http://host:port#HANDSHAKECODE``
        Shorthand: bare fragment without ``tbr_`` prefix sets the
        ``x-tbr-handshake`` header.
    ``http://host:port#tbr_s_XXXX``
        Bare fragment starting with ``tbr_`` is a bearer token — use
        this for staging servers that need both a custom URL and auth.
    ``http://host:port#x-tbr-handshake=CODE``
        Explicit handshake header.
    ``http://host:port#Modal-Key=wk-xxx&Modal-Secret=ws-yyy``
        Arbitrary custom headers (platform-level auth, etc.).
    ``None``
        Reads ``TBR_CONNECT`` env var, then ``TBR_SERVER``, then the default.
    """
    if connect is None:
        connect = os.environ.get("TBR_CONNECT") or os.environ.get(
            "TBR_SERVER"
        ) or _DEFAULT_BASE

    # Bearer token (no scheme, no host:port pattern).
    if "://" not in connect:
        return _DEFAULT_BASE, {"Authorization": f"Bearer {connect}"}

    # URL with optional fragment headers.
    parsed = urlparse(connect)
    base = f"{parsed.scheme}://{parsed.netloc}"
    headers: dict[str, str] = {}

    if parsed.fragment:
        for seg in parsed.fragment.split("&"):
            seg = seg.strip()
            if not seg:
                continue
            if "=" in seg:
                key, _, value = seg.partition("=")
                headers[key.strip()] = value.strip()
            else:
                # Bare segment — shorthand.  tbr_ prefix = bearer token,
                # anything else = handshake header.
                if seg.startswith("tbr_"):
                    headers["Authorization"] = f"Bearer {seg}"
                else:
                    headers[_HANDSHAKE_HEADER] = seg

    return base, headers
