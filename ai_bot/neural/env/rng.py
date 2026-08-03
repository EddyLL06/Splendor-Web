"""Deterministic PRNG mirroring src/shared/ai/seeded-rng.ts (mulberry32 +
FNV-1a seed hash). Needed so Python traces reproduce TS games exactly."""

from __future__ import annotations

from typing import Iterable, List, TypeVar

MASK32 = 0xFFFFFFFF
FNV_OFFSET = 2166136261
FNV_PRIME = 16777619

T = TypeVar("T")


def _imul(a: int, b: int) -> int:
    """JavaScript Math.imul semantics (low 32 bits of the product)."""
    return ((a & MASK32) * (b & MASK32)) & MASK32


def hash_seed(seed: str | int) -> int:
    """FNV-1a over UTF-16 code units, matching JS charCodeAt."""
    if isinstance(seed, int):
        return seed & MASK32
    h = FNV_OFFSET
    for ch in seed:
        code = ord(ch)
        if code > 0xFFFF:
            code -= 0x10000
            for unit in (0xD800 + (code >> 10), 0xDC00 + (code & 0x3FF)):
                h ^= unit
                h = _imul(h, FNV_PRIME)
            continue
        h ^= code
        h = _imul(h, FNV_PRIME)
    return h & MASK32


class SeededRNG:
    def __init__(self, seed: str | int) -> None:
        state = hash_seed(seed)
        if state == 0:
            state = 0x9E3779B9
        self._state = state & MASK32

    def next(self) -> float:
        self._state = (self._state + 0x6D2B79F5) & MASK32
        t = self._state
        t = _imul(t ^ (t >> 15), t | 1)
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & MASK32
        return ((t ^ (t >> 14)) & MASK32) / 4294967296.0

    def int(self, max_exclusive: int) -> int:
        if max_exclusive <= 0:
            raise ValueError("int(maxExclusive) requires a positive integer.")
        return int(self.next() * max_exclusive)

    def choice(self, items: List[T]) -> T:
        if not items:
            raise ValueError("choice() requires at least one item.")
        return items[int(self.next() * len(items))]

    def shuffle(self, items: Iterable[T]) -> List[T]:
        result = list(items)
        for index in range(len(result) - 1, 0, -1):
            swap_index = int(self.next() * (index + 1))
            result[index], result[swap_index] = result[swap_index], result[index]
        return result
