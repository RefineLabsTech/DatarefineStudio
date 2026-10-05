"""Apply threshold for deterministic cleaners. Never guess below 80%."""

from __future__ import annotations

MIN_APPLY = 80


def accept(confidence: int | float, floor: int = MIN_APPLY) -> bool:
    try:
        n = float(confidence)
    except (TypeError, ValueError):
        return False
    if 0 <= n <= 1:
        n *= 100.0
    return n >= floor
