"""Thumbrella HTTP client."""

from __future__ import annotations

import json
import time
from importlib.metadata import version as _package_version
from typing import Any, AsyncIterator, Sequence
from urllib.parse import urlparse

import requests

from .cache import Cache, MemoryCache, put_all_caches
from .constants import DEFAULT_BASE, Source, Status
from .errors import ConnectionError, TimeoutError, VerifyError
from .result import EncodedJpeg, Media, Result
from .http import parse_connect, requests_json, aio_ndjson


class Client:
    """Thumbrella API client.

    All ``thumb()`` calls for the same URL return the same ``Result``
    instance (fields updated in-place on re-fetch). Results are weakly
    referenced -- they live as long as your code holds a reference.

    By default, a small in-memory :class:`MemoryCache` is enabled. Pass
    ``caches=[]`` to disable caching entirely.

    The ``session`` attribute is a :class:`requests.Session` that you can
    customize for proxies, TLS certificates, custom timeouts, cookies, or
    any other transport-level tuning. Not needed for normal use.

    Args:
        connect: Optional connection string that overrides ``$TBR_CONNECT``.
        caches: One or more :class:`Cache` backends. ``None`` (the
            default) creates a :class:`MemoryCache` with 256 entries.
            Pass an empty sequence to disable caching.

    """

    def __init__(
        self,
        connect: str | None = None,
        *,
        caches: Sequence[Cache] | None = None,
    ) -> None:
        self.session: requests.Session = requests.Session()
        self._asession: Any = None  # lazy aiohttp.ClientSession
        self.base_url, self.host_name = parse_connect(connect, self.session)
        self.session.headers["User-Agent"] = _client_user_agent()

        if caches is None:
            self.caches: tuple[Cache, ...] = (MemoryCache(), )
        else:
            self.caches = tuple(caches)

    def __repr__(self) -> str:
        return f"<thumbrella.Client {self.base_url!r}>"

    def __eq__(self, other: object) -> bool:
        return self is other

    def __ne__(self, other: object) -> bool:
        return not self == other

    def __hash__(self) -> int:
        return object.__hash__(self)

    def verify(self) -> Client:
        """Check connectivity. Returns ``self`` for chaining.

        Uses ``/health`` for self-hosted servers and ``/token`` for the
        cloud platform (which validates the bearer token).

        Raises:
            VerifyError: if the server is unreachable or misconfigured.
        """
        if self.base_url == DEFAULT_BASE:
            path = "/token"
            key = "token_type"
        else:
            path = "/health"
            key = "status"

        try:
            data = requests_json(
                self.session, self.host_name, self.base_url, "GET", path
            )
        except (ConnectionError, TimeoutError) as exc:
            raise VerifyError(
                f"could not reach server at {self.base_url}"
            ) from exc
        except requests.RequestException as exc:
            raise VerifyError(
                f"server at {self.base_url}: {exc}"
            ) from exc

        if not data.get(key):
            raise VerifyError(f"unexpected response: {data}")
        return self

    def thumb(self, url: str) -> Result:
        """Fetch a thumbnail for a single URL. Raises on failure.

        Delegates to :meth:`batch` and auto-verifies the result. The
        same ``Result`` instance is returned for repeated calls with the
        same URL (fields updated in-place).

        Raises:
            ThumbError: if the server returned an error for this URL.
        """
        return self.batch((url, ))[0].verify()

    def batch(self, urls: Sequence[str]) -> list[Result]:
        """Fetch thumbnails for multiple URLs in one request.

        Returns a list of ``Result`` objects in the same order as *urls*.
        Fresh cache entries and invalid URLs are resolved locally; the
        remainder go to the server in a single ``POST /batch``.
        """
        done, stale = preflight_urls(urls, self.caches)

        if stale:
            try:
                body = requests_json(
                    self.session, self.host_name, self.base_url, "POST", "/batch",
                    json={"items": stale},
                )
            except (ConnectionError, TimeoutError) as exc:
                return _fail_all(done, stale, urls, str(exc))

            items = body.get("items")
            if not isinstance(items, list):
                return _fail_all(done, stale, urls, "unexpected server response")

            for item in items:
                result = _result_from_server(item, caches=self.caches, server_key=self.base_url)
                done[result.url] = result

        return _ordered_results(done, urls)

    async def stream(self, urls: Sequence[str]) -> AsyncIterator[Result]:
        """Stream thumbnail results as they complete.

        Requires ``aiohttp`` (``pip install thumbrella-client[async]``).

        Fresh cache hits are yielded immediately.  The remainder are sent
        to the server as a streaming batch; each result is yielded as it
        arrives via NDJSON.
        """
        # Handle fresh urls immediately
        done, stale = preflight_urls(urls, self.caches)
        for url in urls:
            if url in done:
                yield done[url]
        if not stale:
            return

        pending: set[str] = {item["url"] for item in stale}
        #headers = {self.session.headers, "Accept": "application/x-ndjson"}
        #url = f"{self.base_url}/batch"

        import aiohttp
        if self._asession is None:
            self._asession = aiohttp.ClientSession()

        try:
            async for item in aio_ndjson(
                self._asession, self.host_name, self.base_url, "/batch",
                json={"items": stale}, headers={"Accept": "application/x-ndjson"},
            ):
                item_url = item.get("url", "")
                if item.get("status") != Status.INTERMEDIATE:
                    pending.discard(item_url)
                result = _result_from_server(
                    item, caches=self.caches, server_key=self.base_url
                )
                yield result
        except Exception:
            pass

        for item_url in pending:
            yield Result.client_fail(item_url, "stream connection lost")


    def clear_caches(self) -> None:
        """Remove all entries from all registered caches."""
        for cache in self.caches:
            cache.clear()

    async def close(self) -> None:
        """Close persistent sessions.  Safe to call multiple times."""
        if self._asession is not None:
            await self._asession.close()
            self._asession = None


def _client_user_agent() -> str:
    """Build a User-Agent string from the installed package version."""
    try:
        ver = _package_version("thumbrella-client")
    except Exception:
        ver = "0.1.0"
    return f"thumbrella-python/{ver}"


# Per-server placeholder thumbnail cache — permanent, keyed by connect string.
_PLACEHOLDER_CACHE: dict[str, dict[str, EncodedJpeg]] = {}


def _result_from_server(
    item: dict[str, Any],
    *,
    caches: Sequence[Cache],
    server_key: str,
) -> Result:
    """Build a :class:`Result` from a server response item, with identity sharing.

    - ``not_modified`` responses reuse cached :class:`Media` (same instance).
    - Placeholder thumbnails share :class:`EncodedJpeg` blobs across results.
    - Normal results construct fresh objects.

    On success the result's media is stored in all *caches*.
    """
    url = item.get("url", "")
    source = item.get("source")
    placeholder = item.get("placeholder")

    if source == Source.NOT_MODIFIED:
        media = _media_from_caches(url, caches)
        result = Result(item, media=media) if media else Result(item)
    elif placeholder:
        thumb_b64 = item.get("media", {}).get("thumbnail", "")
        thumb = _placeholder_thumb(server_key, placeholder, thumb_b64)
        result = Result(item, thumbnail=thumb)
    else:
        result = Result(item)

    put_all_caches(caches, result.media)
    return result


def _media_from_caches(url: str, caches: Sequence[Cache]) -> Media | None:
    """Return cached Media for *url*, or ``None``."""
    for cache in caches:
        media = cache.get(url)
        if media is not None:
            return media
    return None


def _placeholder_thumb(server_key: str, placeholder: str, b64: str) -> EncodedJpeg:
    """Get or create a shared EncodedJpeg for a placeholder icon."""
    pool = _PLACEHOLDER_CACHE.setdefault(server_key, {})
    shared = pool.get(placeholder)
    if shared is not None:
        return shared
    blob = EncodedJpeg(b64=b64)
    pool[placeholder] = blob
    return blob


def _fail_all(
    done: dict[str, Result],
    items: Sequence[dict[str, str]],
    urls: Sequence[str],
    message: str,
) -> list[Result]:
    """Mark *items* as failed and return ordered Results for *urls*."""
    for item in items:
        url = item["url"]
        done[url] = Result.client_fail(url, message)
    return _ordered_results(done, urls)


def _ordered_results(
    done: dict[str, Result],
    urls: Sequence[str],
) -> list[Result]:
    """Return Results in *urls* order, filling gaps with client-fail Results."""
    results: list[Result] = []
    for url in urls:
        result = done.get(url)
        if result is None:
            result = Result.client_fail(url, "internal error: no result")
        results.append(result)
    return results


def preflight_urls(
    urls: Sequence[str],
    caches: Sequence[Cache],
) -> tuple[dict[str, Result], list[dict[str, str]]]:
    """Check caches and validate URLs.

    Returns ``(done, stale)`` where *done* maps url → Result for items
    resolved without a server call, and *stale* is a list of
    ``{"url": ..., "cache": ...}`` dicts to send to the server.
    """
    done: dict[str, Result] = {}
    stale: list[dict[str, str]] = []

    for url in urls:
        # Basic URL validation — must have a scheme.
        if not url or "://" not in url:
            done[url] = Result.client_fail(url, "invalid URL")
            continue

        # Check all caches for a fresh entry.
        fresh = False
        for cache in caches:
            media = cache.get(url)
            if media is not None and media.is_fresh():
                data = {"url": url, "status": Status.SUCCESS, "source": Source.CLIENT}
                done[url] = Result(data, media=media)
                fresh = True
                break

        if fresh:
            continue

        # Stale — build the server request.  Include the cache token
        # from any cached media so the server can do a conditional revalidation.
        item: dict[str, str] = {"url": url}
        for cache in caches:
            media = cache.get(url)
            if media is not None and media.cache:
                item["cache"] = media.cache
                break
        stale.append(item)

    return done, stale


