"""In-memory audit of cleaner decisions. Never holds the full frame."""

from __future__ import annotations

from typing import Any

from sidecar.refine.models import CleanResult


class AuditLog:
    def __init__(self, cap: int = 2500) -> None:
        self.cap = cap
        self.rows: list[dict[str, Any]] = []
        self.applied = 0
        self.rejected = 0
        self.by_type: dict[str, int] = {}

    def add(self, result: CleanResult, *, column: str, row: int | None = None, applied: bool = False) -> None:
        if applied:
            self.applied += 1
            self.by_type[result.data_type] = self.by_type.get(result.data_type, 0) + 1
        else:
            self.rejected += 1
        if len(self.rows) >= self.cap:
            return
        rec = result.to_dict()
        rec["column"] = column
        if row is not None:
            rec["row"] = row
        rec["applied"] = applied
        self.rows.append(rec)

    def summary(self) -> dict[str, Any]:
        return {
            "applied": self.applied,
            "rejected": self.rejected,
            "by_type": dict(self.by_type),
            "samples": self.rows[:80],
        }
