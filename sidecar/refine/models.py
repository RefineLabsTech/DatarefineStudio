"""Cleaner result model — one cell, one decision."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Optional


@dataclass
class CleanResult:
    original: str
    cleaned: Optional[str]
    data_type: str
    valid: bool
    confidence: int
    country: Optional[str] = None
    currency: Optional[str] = None
    rule: Optional[str] = None
    message: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def accept(self, min_confidence: int = 80) -> bool:
        return bool(self.valid and self.cleaned is not None and int(self.confidence) >= min_confidence)
