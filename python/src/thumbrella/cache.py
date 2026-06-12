"""Caches attached to clients, internal code"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Sequence

if TYPE_CHECKING:
    from .result import Media


class Cache(ABC):
    """Abstract base class for result caches.
    
    Caches are passed to the `Client` when constructed. Each client works
    with a stack of cache objects, and will use a small `MemoryCache`
    by default.

    The caches offer limited management (`clear`) methods and simple
    statistics tracking (`hits` and `misses`)

    A cache can be used with multiple clients at the same time.
    """

    def __eq__(self, other: object) -> bool:
        return self is other

    def __ne__(self, other: object) -> bool:
        return self is not other

    def __hash__(self) -> int:
        return object.__hash__(self)

    @abstractmethod
    def get(self, url: str) -> "Media | None":
        """Get the possible cached media for an url."""

    @abstractmethod
    def put(self, media: "Media") -> None:
        """Store cached media for an url."""

    @abstractmethod
    def remove(self, url: str) -> None:
        """Remove possible cached media for an url."""

    @abstractmethod
    def reset(self) -> None:
        """Clear all cached urls and reset statistics."""

    @abstractmethod
    def __len__(self) -> int:
        """Number of cached entries."""

    @property
    @abstractmethod
    def hits(self) -> int:
        """Number of cache hits since creation or last reset."""

    @property
    @abstractmethod
    def misses(self) -> int:
        """Number of cache misses since creation or last reset."""


class MemoryCache(Cache):
    """A small temporary cache for the current process.

    The default cache stores a small amount of thumbnails in memory. Nothing
    is stored after the cache is removed.

    Each Thumbrella `Client` works with a stack of cache objects, assigned
    at construction time. By default the client creates and uses this
    `MemoryCache` with the default arguments. 

    This cache uses an LRU strategy to keep the number of thumbnails
    within the specified `max_items` limit. 
    
    Most thumbnails will use approximately 5K worth of data each.

    Usage:
        cache = thumbrella.MemoryCache(max_items=100)
        tbr = thumbrella.Client(caches=[cache])
        tbr.batch(urls)

        assert len(cache) == len(urls)
        assert (cache.hits + cache.misses) == len(urls)
    """

    def __init__(self, max_items: int = 256) -> None:
        self._max_items = max_items
        self._store: dict[str, "Media"] = {}
        self._order: list[str] = []  # LRU order: front = most recent
        self._hits = 0
        self._misses = 0

    def __repr__(self) -> str:
        return (
            f"<thumbrella.MemoryCache "
            f"items={len(self._store)}/{self._max_items} "
            f"hits={self._hits}/{self._hits + self._misses}>"
        )

    def get(self, url: str) -> "Media | None":
        try:
            media = self._store[url]
        except KeyError:
            self._misses += 1
            return None

        self._hits += 1

        # Move to front (most-recently-used).
        self._order.remove(url)
        self._order.insert(0, url)
        return media

    def put(self, media: "Media") -> None:
        url = media.url
        if not url:
            return
        if url in self._store:
            self._order.remove(url)
        elif len(self._store) >= self._max_items:
            stale = self._order.pop()
            del self._store[stale]

        self._store[url] = media
        self._order.insert(0, url)

    def remove(self, url: str) -> None:
        try:
            del self._store[url]
            self._order.remove(url)
        except (KeyError, ValueError):
            pass

    def reset(self) -> None:
        self._store.clear()
        self._order.clear()
        self._hits = 0
        self._misses = 0

    def __len__(self) -> int:
        return len(self._store)

    @property
    def hits(self) -> int:
        return self._hits

    @property
    def misses(self) -> int:
        return self._misses

    def __iter__(self):
        """Iterate over cached results (MRU order)."""
        return (self._store[u] for u in self._order)


# internal
def is_cache_fresh(cache_value: str) -> bool:
    """Check if the contents of a cache screen identify it as still fresh.

    A fresh cache means the server does not need to be queried to check
    if the thumbnail should be updated.
    """
    if not cache_value:
        return False
    partitions = cache_value.partition(":")
    if not all(partitions):
        return False
    try:
        expires = int(partitions[0], 16)
    except ValueError:
        return False
    return expires > 0 and expires > time.time()


# internal
def put_all_caches(caches: Sequence[Cache], media: Media | None) -> None:
    """Store media in all registered caches."""
    if media is not None:
        for cache in caches:
            cache.put(media)
