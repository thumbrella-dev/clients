"""Result caches — reduce server round-trips for repeated URLs.

All caches implement the :class:`Cache` abstract base class.  The
:class:`MemoryCache` is enabled by default on every :class:`Client`.
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .result import Result


class Cache(ABC):
    """Abstract base class for result caches."""

    @abstractmethod
    def get(self, url: str) -> Result | None:
        """Return a cached :class:`Result` for *url*, or ``None``."""

    @abstractmethod
    def put(self, result: Result) -> None:
        """Store *result* in the cache."""

    @abstractmethod
    def remove(self, url: str) -> None:
        """Remove any cached entry for *url*."""

    @abstractmethod
    def clear(self) -> None:
        """Remove all entries."""

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
    """In-memory LRU-ish cache with a size limit.

    When the cache exceeds *max_items*, the least-recently-used entry is
    evicted.
    """

    def __init__(self, max_items: int = 256) -> None:
        self._max_items = max_items
        self._store: dict[str, Result] = {}
        self._order: list[str] = []  # LRU order: front = most recent
        self._hits = 0
        self._misses = 0

    def get(self, url: str) -> Result | None:
        try:
            result = self._store[url]
        except KeyError:
            self._misses += 1
            return None

        self._hits += 1

        # Move to front (most-recently-used).
        self._order.remove(url)
        self._order.insert(0, url)
        return result

    def put(self, result: Result) -> None:
        url = result.url
        if url in self._store:
            self._order.remove(url)
        elif len(self._store) >= self._max_items:
            stale = self._order.pop()
            del self._store[stale]

        self._store[url] = result
        self._order.insert(0, url)

    def remove(self, url: str) -> None:
        try:
            del self._store[url]
            self._order.remove(url)
        except (KeyError, ValueError):
            pass

    def clear(self) -> None:
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
