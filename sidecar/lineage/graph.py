"""Operation graph (DAG) persistence."""

from __future__ import annotations

from typing import Any


def record(store, session_id: str, **fields: Any) -> int:
    return store.add_lineage(session_id, **fields)
