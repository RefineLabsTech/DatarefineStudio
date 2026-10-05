"""Crash-safe current sheet. Parquet for cells; JSON meta only — never the full frame as JSON."""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from sidecar.engine.session import Session

from sidecar.paths import DATA_ROOT, ensure_data_layout

ensure_data_layout()
CURRENT = DATA_ROOT / "sessions" / "current"
FRAME = CURRENT / "frame.parquet"
FRAME_CSV = CURRENT / "frame.csv"
META = CURRENT / "meta.json"
SESSIONS = DATA_ROOT / "sessions"

_lock = threading.Lock()


def peek() -> dict[str, Any]:
    meta = _read_meta()
    if not meta:
        return {"restored": False, "exported": False}
    return {
        "session_id": meta.get("id") or "",
        "source": meta.get("source") or "",
        "exported": bool(meta.get("exported")),
        "clean_total": int(meta.get("clean_total") or 0),
        "rows": int(meta.get("height") or 0),
        "columns": list(meta.get("columns") or []),
        "saved_at": meta.get("saved_at") or "",
    }


def should_restore(meta: dict[str, Any] | None = None) -> bool:
    meta = meta if meta is not None else _read_meta()
    if not meta:
        return False
    if not _frame_path():
        return False
    # Export = the user's "saved & done": start fresh on the next launch.
    # Unsaved work (or new edits after an export) still restores.
    return not bool(meta.get("exported"))


def save_current(sess: "Session", *, frame: bool = True) -> None:
    with _lock:
        CURRENT.mkdir(parents=True, exist_ok=True)
        if frame:
            _write_frame(sess)
        _write_meta(sess)


def save_session_copy(sess: "Session") -> bool:
    """Per-sheet crash copy: sessions/{sid}/frame.parquet + meta.json.

    Every open sheet gets its own file pair, so a hard kill loses no sheet —
    not just the one that happened to own the single `current` slot."""
    import json as _json

    dest = SESSIONS / sess.id
    try:
        dest.mkdir(parents=True, exist_ok=True)
        sess.df.write_parquet(dest / "frame.parquet")
        (dest / "meta.json").write_text(
            _json.dumps(
                {
                    "id": sess.id,
                    "source": sess.source,
                    "label": sess.label,
                    "created_at": sess.created_at,
                    "exported": bool(sess.exported),
                    "closed": False,
                    "saved_at": datetime.now().isoformat(timespec="seconds"),
                    "schema": list(sess.schema.values()),
                }
            ),
            encoding="utf-8",
        )
        return True
    except Exception:
        return False


def load_current() -> "Session | None":
    from sidecar.engine.session import Session, _stabilize
    from sidecar.schemas.types import empty_column_schema

    with _lock:
        meta = _read_meta()
        path = _frame_path()
        if not path:
            return None
        try:
            import polars as pl

            if path.suffix.lower() == ".parquet":
                df = pl.read_parquet(path)
            else:
                df = pl.read_csv(path)
            df = _stabilize(df)
        except Exception:
            return None

    meta = meta or {}
    sid = str(meta.get("id") or "restored")[:32] or "restored"
    schema_in = meta.get("schema") if isinstance(meta.get("schema"), dict) else {}
    schema: dict[str, dict] = {}
    for c in df.columns:
        cur = schema_in.get(c) if isinstance(schema_in.get(c), dict) else None
        schema[c] = dict(cur) if cur else empty_column_schema(c)

    rules = meta.get("column_rules") if isinstance(meta.get("column_rules"), dict) else {}
    column_rules = {str(k): str(v) for k, v in rules.items() if k}

    sess = Session(
        id=sid,
        source=str(meta.get("source") or ""),
        df=df,
        schema=schema,
        created_at=str(meta.get("created_at") or datetime.now().isoformat(timespec="seconds")),
        n_rows_loaded=int(meta.get("n_rows_loaded") or df.height),
        highlights=list(meta.get("highlights") or [])[-2500:],
        logs=list(meta.get("logs") or [])[-200:],
        last_runtime_ms=float(meta.get("last_runtime_ms") or 0),
        dirty=0,
        baseline=dict(meta.get("baseline") or {}),
        clean_total=int(meta.get("clean_total") or 0),
        clean_by_stage={str(k): int(v) for k, v in dict(meta.get("clean_by_stage") or {}).items()},
        clean_by_column={str(k): int(v) for k, v in dict(meta.get("clean_by_column") or {}).items()},
        clean_runs=list(meta.get("clean_runs") or [])[-80:],
        exported=bool(meta.get("exported")),
        sql=str(meta.get("sql") or ""),
        javascript=str(meta.get("javascript") or ""),
        python=str(meta.get("python") or ""),
        column_rules=column_rules,
        label=str(meta.get("label") or ""),
    )
    return sess


def resume_payload(sess: "Session") -> dict[str, Any]:
    return {
        "restored": True,
        "session_id": sess.id,
        "rows": sess.height(),
        "columns": sess.columns(),
        "source": sess.source,
        "sql": sess.sql,
        "javascript": sess.javascript,
        "python": sess.python,
        "column_rules": sess.column_rules,
        "clean_total": int(sess.clean_total),
        "highlights": list(sess.highlights)[-2500:],
        "exported": bool(sess.exported),
    }


def clear_current() -> None:
    """Drop the crash-safe copy (used when its session is deleted)."""
    with _lock:
        for f in (FRAME, FRAME_CSV, META):
            try:
                if f.is_file():
                    f.unlink()
            except OSError:
                pass


def _frame_path() -> Path | None:
    if FRAME.is_file() and FRAME.stat().st_size > 0:
        return FRAME
    if FRAME_CSV.is_file() and FRAME_CSV.stat().st_size > 0:
        return FRAME_CSV
    return None


def _read_meta() -> dict[str, Any] | None:
    if not META.is_file():
        return None
    try:
        data = json.loads(META.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _write_frame(sess: "Session") -> None:
    tmp = CURRENT / "frame.parquet.tmp"
    try:
        sess.df.write_parquet(tmp)
        os.replace(tmp, FRAME)
        if FRAME_CSV.is_file():
            try:
                FRAME_CSV.unlink()
            except OSError:
                pass
        return
    except Exception:
        try:
            if tmp.is_file():
                tmp.unlink()
        except OSError:
            pass
    csv_tmp = CURRENT / "frame.csv.tmp"
    sess.df.write_csv(csv_tmp)
    os.replace(csv_tmp, FRAME_CSV)


def _write_meta(sess: "Session") -> None:
    payload = {
        "id": sess.id,
        "source": sess.source,
        "created_at": sess.created_at,
        "n_rows_loaded": sess.n_rows_loaded,
        "height": sess.height(),
        "columns": sess.columns(),
        "schema": sess.schema,
        "highlights": list(sess.highlights)[-2500:],
        "logs": list(sess.logs)[-200:],
        "last_runtime_ms": sess.last_runtime_ms,
        "baseline": sess.baseline,
        "clean_total": int(sess.clean_total),
        "clean_by_stage": sess.clean_by_stage,
        "clean_by_column": sess.clean_by_column,
        "clean_runs": list(sess.clean_runs)[-80:],
        "exported": bool(sess.exported),
        "sql": sess.sql,
        "javascript": sess.javascript,
        "python": sess.python,
        "column_rules": sess.column_rules,
        "label": sess.label,
        "saved_at": datetime.now().isoformat(timespec="seconds"),
    }
    raw = json.dumps(payload, ensure_ascii=False, default=str)
    tmp = CURRENT / "meta.json.tmp"
    tmp.write_text(raw, encoding="utf-8")
    os.replace(tmp, META)
