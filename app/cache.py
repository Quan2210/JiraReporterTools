import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any


class TTLCache:
    """In-memory cache; concurrent misses on the same key share one load."""

    def __init__(self, ttl_seconds: float = 600.0):
        self._ttl = ttl_seconds
        self._data: dict[str, tuple[float, Any]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def get(self, key: str, loader: Callable[[], Awaitable[Any]]) -> Any:
        hit = self._data.get(key)
        if hit and hit[0] > time.monotonic():
            return hit[1]
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            hit = self._data.get(key)
            if hit and hit[0] > time.monotonic():
                return hit[1]
            value = await loader()
            self._data[key] = (time.monotonic() + self._ttl, value)
            return value

    def clear(self) -> None:
        self._data.clear()
