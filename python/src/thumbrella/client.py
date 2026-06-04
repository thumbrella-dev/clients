"""Thumbrella HTTP client."""

import os
import time
import weakref
from typing import Any, AsyncIterator, Sequence
from urllib.parse import urlparse

import requests

from .cache import Cache, MemoryCache
from .constants import Status
from .errors import ConnectionError, ServerError, TimeoutError, VerifyError
from .result import Result


# Default base URL when none is configured.
_DEFAULT_BASE = "http://127.0.0.1:8001"

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
                - ``"http://host:port"`` — bare server URL
                - ``"http://host:port#handshake"`` — server URL with handshake secret
                - ``None`` — read ``TBR_CONNECT`` env var, then fall back to
                  defaults (``TBR_SERVER``, or ``http://127.0.0.1:8001``).
            timeout: Request timeout in seconds.
            caches: One or more :class:`Cache` backends.  ``None`` (the default)
                creates a :class:`MemoryCache` with 256 entries.  Pass an empty
                sequence to disable caching.
        """
        self._base_url, self._handshake = _parse_connect(connect)
        self._timeout = timeout
        self._session = requests.Session()
        self._session.headers["User-Agent"] = "thumbrella-client/0.1"
        if self._handshake:
            self._session.headers["x-tbr-handshake"] = self._handshake

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

    # ── public API ────────────────────────────────────────────────────────

    def verify(self) -> dict[str, Any]:
        """Check connectivity and return server information.

        Raises:
            VerifyError: if the server is unreachable or misconfigured.
        """
        try:
            resp = self._session.get(
                f"{self._base_url}/health",
                timeout=self._timeout,
            )
            resp.raise_for_status()
            data = resp.json()
        except requests.RequestException as exc:
            raise VerifyError(
                f"could not reach server at {self._base_url}: {exc}"
            ) from exc

        if data.get("status") != "ok":
            raise VerifyError(f"unexpected health response: {data}")
        return data

    def thumb(self, url: str) -> Result:
        """Fetch a thumbnail for a single URL.

        Returns a ``Result``.  The same ``Result`` instance is returned for
        repeated calls with the same URL (fields updated in-place).

        Checks registered caches before making a network request.  Stale
        results are revalidated; fresh results skip the network entirely.

        By default, does NOT raise on failure — check ``result.status`` or
        call ``result.raise_for_status()``.  The result always contains
        thumbnail bytes (a placeholder on error).

        Raises:
            ConnectionError: if the server is unreachable after retries.
            TimeoutError: if the request times out.
        """
        result = self._get_or_create_result(url)

        # Check caches.
        for cache in self._caches:
            cached = cache.get(url)
            if cached is not None and cached is not result:
                result._update_from_result(cached)
            if result.is_fresh():
                return result

        # Cache miss or stale — fetch from server.
        params = {"url": url}
        if result.cache:
            params["cache"] = result.cache

        try:
            resp = self._request_with_backoff(
                "GET",
                f"{self._base_url}/thumb.jpeg",
                params=params,
            )
        except (ConnectionError, TimeoutError):
            result._set_client_error("server unreachable")
            return result

        if resp.status_code == 304:
            result.status = Status.NOT_MODIFIED
            result._decoded.clear()
            self._cache_put(result)
            return result

        if not resp.ok:
            result._set_client_error(f"server returned {resp.status_code}")
            return result

        result._update_from_json(resp.json())
        self._cache_put(result)
        return result

    def batch(self, urls: list[str]) -> list[Result]:
        """Fetch thumbnails for multiple URLs in one request.

        Returns a list of ``Result`` objects in the same order.

        Checks caches first — fresh URLs are not sent to the server.
        """
        results = [self._get_or_create_result(u) for u in urls]

        # Check caches and gather cache tokens for fresh entries.
        items = []
        for r in results:
            for cache in self._caches:
                cached = cache.get(r.url)
                if cached is not None and cached is not r:
                    r._update_from_result(cached)
            if r.is_fresh():
                continue
            item: dict[str, str] = {"url": r.url}
            if r.cache:
                item["cache"] = r.cache
            items.append(item)

        if not items:
            return results  # all fresh from cache

        try:
            resp = self._request_with_backoff(
                "POST",
                f"{self._base_url}/batch",
                json={"items": items},
            )
        except (ConnectionError, TimeoutError):
            for r in results:
                if not r.data:
                    r._set_client_error("server unreachable")
            return results

        if not resp.ok:
            for r in results:
                r._set_client_error(f"server returned {resp.status_code}")
            return results

        body = resp.json()
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

        timeout = aiohttp.ClientTimeout(total=self._timeout)
        headers = {"Accept": "application/x-ndjson"}
        if self._handshake:
            headers["x-tbr-handshake"] = self._handshake

        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(
                    f"{self._base_url}/batch",
                    json={"items": items},
                    headers=headers,
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
                                url_map[url]._update_from_json(item)
                                yield url_map[url]
                        elif event.get("type") == "item.error":
                            url = event.get("url", "")
                            if url in url_map:
                                url_map[url]._set_client_error(
                                    event.get("error", "stream error")
                                )
                                yield url_map[url]
        except Exception:
            for r in results:
                if not r.data:
                    r._set_client_error("stream connection lost")
                    yield r

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
            result = Result(url)
            self._results[url] = result
            return result

    def _request_with_backoff(
        self,
        method: str,
        url: str,
        **kwargs: Any,
    ) -> requests.Response:
        """Make an HTTP request with per-host backoff for 429/503."""
        host = urlparse(url).hostname or ""
        backoff_until, failures = self._backoff.get(host, (0, 0))

        if time.monotonic() < backoff_until:
            wait = backoff_until - time.monotonic()
            time.sleep(wait)

        try:
            resp = self._session.request(
                method, url, timeout=self._timeout, **kwargs
            )
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


# ── connect string parsing ────────────────────────────────────────────────


def _parse_connect(
    connect: str | None,
) -> tuple[str, str | None]:
    """Parse a connection string into (base_url, handshake).

    Formats:
        ``"http://host:port"``
        ``"http://host:port#handshake"``
        ``None`` — reads ``TBR_CONNECT`` env var, falls back to ``TBR_SERVER``
          or the default.
    """
    if connect is None:
        connect = os.environ.get("TBR_CONNECT") or os.environ.get(
            "TBR_SERVER"
        ) or _DEFAULT_BASE

    parsed = urlparse(connect)
    base = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme else connect
    handshake = parsed.fragment or None

    return base, handshake
