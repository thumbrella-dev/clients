"""Thumbrella HTTP client."""

from __future__ import annotations

import importlib.metadata
from typing import Any, AsyncIterator, Sequence

import requests

from .cache import Cache, MemoryCache, put_all_caches
from .constants import DEFAULT_BASE, HTTP_TIMEOUT, Source, Status
from .result import Result, Media, EncodedJpeg
from .errors import ConnectionError, TimeoutError, VerifyError, ThumbError
from .http import parse_connect, requests_json, aio_ndjson


class Client:
    """Thumbrella API client.

    A centralized configuration for a Thumbrella server and client side caches.
    The connection is described by a "connect string". By default this uses the
    ``$TBR_CONNECT`` envirionment variable.

    Most thumbnails will be handled in batches with the ``batch()`` or
    ``stream()`` methods. These will return (or iterate) a set of ``Result``
    objects. Which can individually succeed, fail, or reuse cached contents. All
    result objects will have a placeholder or failure image, even if one could
    not be rendered.

    The ``stream()`` is asyncronous and requires an additional optional
    dependency on `aiohttp`.     

    Creating the client makes no immediate connection to the server. When a
    connection is misconfigured calls will still provide ``Result`` objects with
    incomplete results.  Use the ``verify()`` to ensure the configuration is
    good, which will raise exceptions if there any server side or client side
    issues.

    A collection of caches can be passed to the client. These are integrated
    with each of the lookup methods to improve performance. By default the
    client will use a single ``MemoryCache`` with the default settings. A client
    can also be created with no caching by explictly passing an empty sequence
    for the ``caches`` argument.

    This exposes a ``session`` attribute. This a ``requests.Session` object that
    can be used to customize the http calls being made. Add custom proxies,
    cookies, tls certificates, and more. The Thumbrella connection string is
    usually responsible for defining additional http headers. But more extensive
    customization can be done on an created client.
    
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
        """Check configuration and server connectivity.

        Check that the server is operational and the configuration string
        is valid. If the connection string defines tokens or custom http
        headers those will also be validated.

        On success this returns itself, to allow method chaining for 
        simplistic use cases.

        Usage:
            url = "http://demo.thumbrella.dev/cat.jpeg"
            tbr = thumbrella.Client()
            tbr.verify().thumb(url)

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
        """Get a single url result and fail if unsuccessful.

        This is a shortcut to regular `batch()` for simple use cases. If
        there is any problem generating a thumbnail this will result in an
        exception, instead of a placeholder `Result`.
        
        Individual results can get the same effect by using `Result.verify`.

        This call waits for the result to complete before returning. It is
        syncronous and blocking.

        See the https://thumbrella.dev/docs/api/batch.html server documentation
        on the batch call for more details on how the server processes these
        results.

        Usage:
            url = "http://demo.thumbrella.dev/cat.jpeg"
            tbr = thumbrella.Client()
            tbr.thumb(url)

            tbr.batch([url])[0].verify()  # equivalent batch call

        Raises:
            ThumbError: if the server returned an error for this URL.
        """
        return self.batch((url, ))[0].verify()

    def batch(self, urls: Sequence[str]) -> list[Result]:
        """Generate multiple thumbnail results.

        Generate a list of ``Result`` objects for the given urls. The returned
        results are provided in the same order as the input urls.

        This call waits for all results to complete before returning. It is
        syncronous and blocking. For incremental results, see the `stream()`
        method.

        This call won't raise exceptions. On errors, results will be marked
        with a failure status, but will still contain placeholder thumbnails.
        
        See the https://thumbrella.dev/docs/api/batch.html server documentation
        on the batch call for more details on how the server processes these
        results.

        Usage:
            urls = ["http://demo.thumbrella.dev/cat.jpeg", "http://demo.thumbrella.dev/dog.png"]
            tbr = thumbrella.Client()
            results = tbr.batch(urls)
            print([f"{r.status} {r.url}" for r in results])
        """
        done, stale = _preflight_urls(urls, self.caches)

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
        """Stream multiple thumbnail results as they complete.

        This efficiently provides thumbnail results as they become available.
        Media that requires longer rendering can receive intermediate updates
        and placeholders as they are processed.

        This async method requires the optional ``aiohttp`` module to be
        importable. If the module cannot be found this raises an exception.

        Every url will receive one result in the iterator, on success or failure.
        Some media also receives intermediate results as the thumbnail is
        processed. That can be determined with `Result.status` being
        `thumbrella.Status.INTERMEDIATE`.

        Python asyncronous code should often use a context to help control
        lifetime of resources and processing with the ``async wait`` or
        ``async for`` operators.
        
        The ``session`` attribute used to customize the http operations is
        not used natively by aiiohttp. The major information is transalted
        to ``aiohttp`` but not all features are expected to work.

        See the https://thumbrella.dev/docs/api/batch.html server documentation
        on the batch call for more details on how the server processes these
        results.

        Usage:
            urls = ["http://demo.thumbrella.dev/cat.jpeg", "http://demo.thumbrella.dev/dog.png"]
            tbr = thumbrella.Client()
            async for result in tbr.stream(urls):
                print([f"{r.status} {r.url}" for r in results])
        """
        done, stale = _preflight_urls(urls, self.caches)
        for url in urls:
            if url in done:
                yield done[url]
        if not stale:
            return

        pending: set[str] = {item["url"] for item in stale}

        try:
            import aiohttp
        except ImportError:
            raise ThumbError("The `stream` method requires aiohttp which cannot be imported")

        if self._asession is None:
            timeout = aiohttp.ClientTimeout(total=HTTP_TIMEOUT)
            self._asession = aiohttp.ClientSession(timeout=timeout)

        msg = ""
        try:
            async for item in aio_ndjson(
                self._asession, self.host_name, self.base_url, "/batch",
                json={"items": stale}, headers={"Accept": "application/x-ndjson"},
            ):
                kind = item.get("type", "")
                result_data = item.get("result")
                if not result_data or kind not in ("item.intermediate", "item.result"):
                    continue
                item_url = result_data.get("url", "")
                if kind == "item.result":
                    pending.discard(item_url)
                result = _result_from_server(
                    result_data, caches=self.caches, server_key=self.base_url
                )
                yield result
        except Exception as exc:
            msg = str(exc) or type(exc).__name__

        for item_url in pending:
            yield Result.client_fail(item_url, msg or "stream connection lost")

    def reset_caches(self) -> None:
        """Reset all attached caches.
        
        The cache reset is intended to clear the cache contents and reset
        statistics and tracking information.
        """
        for cache in self.caches:
            cache.reset()

    async def close(self) -> None:
        """Close asyncronous sessions.

        The asyncronous workers of the `stream()` call are cleaned up with
        this async method if needed.

        It is safe to call this method multiple times.
        """
        if self._asession is not None:
            await self._asession.close()
            self._asession = None

    async def __aenter__(self) -> Client:
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.close()


def _client_user_agent() -> str:
    """Build a User-Agent string from the installed package version."""
    try:
        ver = importlib.metadata.version("thumbrella-client")
    except Exception:
        ver = "dev"
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


def _preflight_urls(
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


