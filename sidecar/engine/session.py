"""In-memory workspace sessions with viewport, schema, provenance, metrics."""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import polars as pl

from sidecar.engine.ingest import READ_LIMIT_MAP, connect_and_query, load_file
from sidecar.exporters.export import export_frame
from sidecar.exporters.report import write_cleaning_report
from sidecar.lineage.graph import record as record_lineage
from sidecar.pipeline.javascript import run_javascript
from sidecar.pipeline.python_exec import run_python
from sidecar.pipeline.rules import apply_rule_list
from sidecar.pipeline.sql import run_sql
from sidecar.profiler.profile import profile_frame
from sidecar.schemas.types import empty_column_schema
from sidecar.versioning.versions import snapshot
from sidecar.wal.wal import Wal

from sidecar.paths import DATA_ROOT


@dataclass
class Session:
    id: str
    source: str
    df: pl.DataFrame
    schema: dict[str, dict]
    created_at: str
    n_rows_loaded: int
    provenance: dict[str, dict] = field(default_factory=dict)
    highlights: list[dict] = field(default_factory=list)
    logs: list[dict] = field(default_factory=list)
    last_runtime_ms: float = 0
    dirty: int = 0
    baseline: dict[str, Any] = field(default_factory=dict)
    clean_total: int = 0
    clean_by_stage: dict[str, int] = field(default_factory=dict)
    clean_by_column: dict[str, int] = field(default_factory=dict)
    clean_runs: list[dict] = field(default_factory=list)
    undo: list[Any] = field(default_factory=list)
    redo: list[Any] = field(default_factory=list)
    db_kind: str = ""
    db_config: dict[str, Any] = field(default_factory=dict)
    ai_plan: dict[str, Any] = field(default_factory=dict)
    exported: bool = False
    sql: str = ""
    javascript: str = ""
    python: str = ""
    column_rules: dict[str, str] = field(default_factory=dict)
    label: str = ""
    undo_meta: list[dict] = field(default_factory=list)
    redo_meta: list[dict] = field(default_factory=list)

    def columns(self) -> list[str]:
        return list(self.df.columns)

    def height(self) -> int:
        return self.df.height


class SessionManager:
    def __init__(self, store) -> None:
        self.store = store
        self.sessions: dict[str, Session] = {}
        self.active_sid: str | None = None
        self.wal = Wal(store)
        self._stats: dict[str, dict] = {}
        self._stats_busy: set[str] = set()
        self._copy_pending: set[str] = set()
        threading.Thread(target=self._bgcopy_loop, name="drs-bgcopy", daemon=True).start()
        # The Windows app hard-kills the sidecar (TerminateProcess), so the
        # FastAPI shutdown hook often never runs. This daemon keeps the
        # crash-safe copy at most `interval` seconds stale.
        threading.Thread(target=self._autoflush_loop, name="drs-autoflush", daemon=True).start()

    def _autoflush_loop(self, interval: float = 4.0) -> None:
        while True:
            time.sleep(interval)
            for sess in list(self.sessions.values()):
                if not sess.dirty:
                    continue
                try:
                    # Only the sheet the user is ON owns the single `current`
                    # slot; every sheet keeps its own crash copy regardless.
                    if sess.id == self.active_sid:
                        self.wal.flush(sess)
                    else:
                        self.save_session_state(sess.id)
                except Exception:
                    pass

    def _bgcopy_loop(self, interval: float = 1.0) -> None:
        """Writes per-sheet crash copies off the request path (tab switches)."""
        while True:
            time.sleep(interval)
            pending, self._copy_pending = self._copy_pending, set()
            for sid in pending:
                try:
                    self.save_session_state(sid)
                except Exception:
                    pass

    def _stats_key(self, sess: "Session") -> tuple:
        return (
            int(sess.dirty),
            int(sess.df.height),
            int(sess.df.width),
            tuple(sorted((c, str(s.get("active") or "")) for c, s in sess.schema.items())),
        )

    def _spawn_stats(self, sid: str) -> None:
        if sid in self._stats_busy:
            return
        self._stats_busy.add(sid)

        def work() -> None:
            try:
                sess = self.sessions.get(sid)
                if sess is None:
                    return
                ent = self._stats.setdefault(sid, {})
                ent["metrics"] = self._compute_metrics(sess)
                ent["profile"] = self._compute_profile(sess)
                ent["key"] = self._stats_key(sess)
            except Exception:
                pass
            finally:
                self._stats_busy.discard(sid)

        threading.Thread(target=work, name=f"drs-stats-{sid[:8]}", daemon=True).start()

    def open_file(self, path: str, row_limit: int = 10000, force: bool = False) -> Session:
        resumed = self._resume_for_source(path, force=force)
        if resumed is not None:
            return resumed
        n = READ_LIMIT_MAP.get(row_limit, row_limit if row_limit > 0 else None)
        if row_limit in (0, -1) or str(row_limit).lower() == "all":
            n = None
        try:
            df = load_file(path, n_rows=n)
        except Exception:
            from sidecar.plugins.runtime import try_ingest

            df = try_ingest(self.store, path, n)
            if df is None:
                raise
        df = _stabilize(df)
        df, notes = self._plugin_hooks("after_ingest", df, {"path": str(path)})
        sid = uuid.uuid4().hex[:12]
        schema = {c: empty_column_schema(c) for c in df.columns}
        profiles = profile_frame(df)
        for p in profiles:
            schema[p["name"]]["inferred"] = p["inferred"]
            schema[p["name"]]["active"] = p["inferred"]
            schema[p["name"]]["example"] = p.get("example") or ""
        sess = Session(
            id=sid,
            source=str(path),
            df=df,
            schema=schema,
            created_at=datetime.now().isoformat(timespec="seconds"),
            n_rows_loaded=df.height,
        )
        self.sessions[sid] = sess
        for note in notes:
            self._log(sess, "plugin", note)
        sess.baseline = self.metrics(sid)
        self.store.add_recent(str(path))
        self._log(sess, "ingest", f"Opened {path} ({df.height} × {df.width})")
        record_lineage(self.store, sid, stage="ingest", title=Path(path).name, rows_changed=df.height)
        snapshot(self.store, sess, DATA_ROOT / "sessions", name="initial")
        self._persist(sess, frame=True)
        return sess

    def _resume_for_source(self, path: str, force: bool = False) -> "Session | None":
        """Reopening a file resumes its autosaved sheet when the source is unchanged.

        Without this, open_file() re-ingests raw source and overwrites
        sessions/current, silently discarding the user's edits and cleaning.
        """
        if force:
            return None
        try:
            from sidecar.engine.persist import load_current, peek

            info = peek()
            if info.get("exported"):
                return None  # exported sheet = saved & done; open fresh
            sid = str(info.get("session_id") or "")
            src = str(info.get("source") or "")
            if not sid or not src:
                return None
            if str(Path(src).resolve()) != str(Path(path).resolve()):
                return None
            saved_at = str(info.get("saved_at") or "")
            if saved_at:
                saved_ts = datetime.fromisoformat(saved_at).timestamp()
                if Path(path).stat().st_mtime > saved_ts + 1:
                    return None  # source changed since autosave -> respect new data
            sess = load_current()
            if not sess:
                return None
            self.sessions[sess.id] = sess
            self._log(sess, "persist", f"Resumed saved sheet for {Path(path).name}")
            return sess
        except Exception:
            return None

    def open_database(self, kind: str, config: dict, query: str, row_limit: int = 10000) -> Session:
        n = None if row_limit in (0, -1) else row_limit
        df = connect_and_query(kind, config, query, n_rows=n)
        df = _stabilize(df)
        df, notes = self._plugin_hooks("after_ingest", df, {"kind": kind, "query": query})
        sid = uuid.uuid4().hex[:12]
        schema = {c: empty_column_schema(c) for c in df.columns}
        for p in profile_frame(df):
            schema[p["name"]]["inferred"] = p["inferred"]
            schema[p["name"]]["active"] = p["inferred"]
        sess = Session(
            id=sid,
            source=f"{kind}://query",
            df=df,
            schema=schema,
            created_at=datetime.now().isoformat(timespec="seconds"),
            n_rows_loaded=df.height,
        )
        self.sessions[sid] = sess
        for note in notes:
            self._log(sess, "plugin", note)
        sess.baseline = self.metrics(sid)
        sess.db_kind = kind
        sess.db_config = dict(config or {})
        record_lineage(self.store, sid, stage="ingest", title=f"{kind} query", rows_changed=df.height)
        self._persist(sess, frame=True)
        return sess

    def get(self, sid: str) -> Session:
        sess = self.sessions.get(sid)
        if sess:
            return sess
        # Self-heal: the session may live only on disk (sidecar restarted
        # between /session/resume and the next call). Restore instead of 500.
        try:
            from sidecar.engine.persist import load_current, peek

            info = peek()
            if str(info.get("session_id") or "") == str(sid):
                restored = load_current()
                if restored is not None and restored.id == str(sid):
                    self.sessions[restored.id] = restored
                    self._log(restored, "persist", "Re-restored session after sidecar restart")
                    return restored
        except Exception:
            pass
        raise KeyError(f"Unknown session {sid}")

    def resume(self) -> Session | None:
        """Live sidecar session, or last unsaved parquet after a crash / power cut."""
        from sidecar.engine.persist import load_current, peek, should_restore

        info = peek()
        sid = str(info.get("session_id") or "")
        if sid and sid in self.sessions:
            return self.sessions[sid]
        if self.sessions:
            return next(reversed(list(self.sessions.values())))
        if not should_restore(None):
            return None
        sess = load_current()
        if not sess:
            return None
        self.sessions[sess.id] = sess
        self._log(sess, "persist", "Restored sheet from previous session")
        return sess

    def restore_disk(self, sid: str) -> "Session":
        """Rehydrate a crashed sheet from its own crash copy (or last snapshot)."""
        live = self.sessions.get(sid)
        if live is not None:
            return live
        import json as _json

        meta: dict = {}
        mp = DATA_ROOT / "sessions" / sid / "meta.json"
        if mp.is_file():
            try:
                meta = _json.loads(mp.read_text(encoding="utf-8")) or {}
            except Exception:
                meta = {}
        if meta.get("exported") or meta.get("closed"):
            raise KeyError(f"Session {sid} is not restorable")
        schema_raw: Any = meta.get("schema")
        path = DATA_ROOT / "sessions" / sid / "frame.parquet"
        if not path.is_file():
            rows = self.store.versions(sid)
            if not rows:
                raise KeyError(f"No snapshots for session {sid}")
            hit = rows[0]
            path = Path(str(hit.get("snapshot_path") or ""))
            if not path.is_file():
                raise KeyError(f"Snapshot file missing for session {sid}")
            if schema_raw is None:
                try:
                    schema_raw = _json.loads(str(hit.get("schema_json") or "[]"))
                except Exception:
                    schema_raw = []
        if path.suffix.lower() == ".parquet":
            df = pl.read_parquet(path)
        else:
            df = pl.read_csv(path)
        df = _stabilize(df)
        schema: dict[str, dict] = {}
        try:
            for item in schema_raw or []:
                if isinstance(item, dict) and item.get("name"):
                    schema[str(item["name"])] = item
        except Exception:
            pass
        for c in df.columns:
            if not isinstance(schema.get(c), dict):
                schema[c] = empty_column_schema(c)
        sess = Session(
            id=sid,
            source=str(meta.get("source") or ""),
            df=df,
            schema=schema,
            created_at=str(meta.get("created_at") or datetime.now().isoformat(timespec="seconds")),
            n_rows_loaded=df.height,
            dirty=0,
            exported=bool(meta.get("exported")),
            label=str(meta.get("label") or ""),
        )
        self.sessions[sess.id] = sess
        self._log(sess, "persist", "Restored sheet from disk snapshot")
        return sess

    def update_workspace(self, sid: str, patch: dict[str, Any]) -> dict:
        sess = self.get(sid)
        if "sql" in patch and patch["sql"] is not None:
            sess.sql = str(patch["sql"])
        if "javascript" in patch and patch["javascript"] is not None:
            sess.javascript = str(patch["javascript"])
        if "python" in patch and patch["python"] is not None:
            sess.python = str(patch["python"])
        rules = patch.get("column_rules")
        if isinstance(rules, dict):
            sess.column_rules = {str(k): str(v) for k, v in rules.items() if k}
        self._persist(sess, frame=False)
        # Tab switch-out: freeze this sheet's own crash copy in the background
        # so it survives even if it isn't active — without blocking the switch.
        self._copy_pending.add(sid)
        return {"saved": True}

    def save_session_state(self, sid: str) -> bool:
        """Freeze this sheet's own crash copy now (tab switch-out etc.)."""
        sess = self.sessions.get(sid)
        if sess is None:
            return False
        from sidecar.engine.persist import save_session_copy

        ok = save_session_copy(sess)
        if ok:
            sess.dirty = 0
        else:
            self._log(sess, "persist", "Session snapshot failed")
        return ok

    def _persist(self, sess: Session, frame: bool = True) -> None:
        try:
            from sidecar.engine.persist import save_current

            save_current(sess, frame=frame)
            if frame:
                sess.dirty = 0
            self.wal._last_flush = time.time()
        except Exception as exc:
            self._log(sess, "persist", f"Autosave failed: {exc}")

    def viewport(self, sid: str, offset: int = 0, limit: int = 80) -> dict:
        sess = self.get(sid)
        self.active_sid = sid
        offset = max(0, offset)
        limit = min(max(1, limit), 500)
        sl = sess.df.slice(offset, limit)
        rows = []
        for rec in sl.iter_rows():
            rows.append([_cell(v) for v in rec])
        return {
            "session_id": sid,
            "offset": offset,
            "limit": limit,
            "total": sess.height(),
            "columns": sess.columns(),
            "schema": [sess.schema.get(c, empty_column_schema(c)) for c in sess.columns()],
            "rows": rows,
        }

    def profile(self, sid: str) -> list[dict]:
        sess = self.get(sid)
        rows = profile_frame(sess.df)
        for r in rows:
            sch = sess.schema.get(r["name"], {})
            r["active"] = sch.get("active") or r["inferred"]
            r["manual"] = bool(sch.get("manual"))
        return rows

    def _compute_metrics(self, sess: "Session") -> dict:
        df = sess.df
        total_cells = max(1, df.height * df.width)
        missing = int(sum(df[c].null_count() for c in df.columns))
        dup_rows = int((~df.is_unique()).sum()) if df.height else 0
        invalid = missing
        # cheap validators using active schema
        for c, sch in sess.schema.items():
            if c not in df.columns:
                continue
            active = sch.get("active")
            s = df[c].cast(pl.Utf8, strict=False)
            if active == "Email":
                nonempty = int(s.len() - s.null_count())
                invalid += max(0, nonempty - int(s.str.contains(r"@").fill_null(False).sum()))
            if active == "Phone":
                invalid += int((s.str.replace_all(r"\D", "", literal=False).str.len_chars() < 7).fill_null(False).sum())
        health = max(0.0, min(100.0, 100.0 * (1 - invalid / total_cells)))
        return {
            "rows": df.height,
            "columns": df.width,
            "missing": missing,
            "duplicates": dup_rows,
            "invalid": int(invalid),
            "health": round(health, 2),
            "runtime_ms": sess.last_runtime_ms,
            "source": sess.source,
            "loaded": sess.n_rows_loaded,
            "cells_cleaned": int(sess.clean_total),
        }

    def _compute_profile(self, sess: "Session") -> list[dict]:
        rows = profile_frame(sess.df)
        for r in rows:
            sch = sess.schema.get(r["name"], {})
            r["active"] = sch.get("active") or r["inferred"]
            r["manual"] = bool(sch.get("manual"))
        return rows

    def profile(self, sid: str) -> list[dict]:
        sess = self.get(sid)
        key = self._stats_key(sess)
        ent = self._stats.get(sid)
        if ent and ent.get("key") == key and ent.get("profile") is not None:
            return ent["profile"]
        if ent and ent.get("profile") is not None:
            self._spawn_stats(sid)
            return ent["profile"]
        rows = self._compute_profile(sess)
        e = self._stats.setdefault(sid, {})
        e["profile"] = rows
        e["key"] = key
        return rows

    def metrics(self, sid: str) -> dict:
        sess = self.get(sid)
        key = self._stats_key(sess)
        ent = self._stats.get(sid)
        if ent and ent.get("key") == key and ent.get("metrics") is not None:
            return ent["metrics"]
        if ent and ent.get("metrics") is not None:
            # Keep the UI fluid: serve last stats now, recompute in background.
            self._spawn_stats(sid)
            return ent["metrics"]
        m = self._compute_metrics(sess)
        e = self._stats.setdefault(sid, {})
        e["metrics"] = m
        e["key"] = key
        return m

    def edit_cell(self, sid: str, row: int, column: str, value: Any) -> None:
        sess = self.get(sid)
        if column not in sess.df.columns:
            raise KeyError(column)
        if row < 0 or row >= sess.height():
            raise IndexError(row)
        self._checkpoint(sess, sess.df)
        series = sess.df[column]
        old = series[row]
        try:
            # O(1)-ish in-place-style update: no Python round-trip over the column,
            # so million-row sheets edit as fast as ten-row ones.
            sess.df = sess.df.with_columns(series.scatter([row], [value]))
            new_val = sess.df[column][row]
        except Exception:
            values = series.to_list()
            values[row] = value
            try:
                sess.df = sess.df.with_columns(pl.Series(column, values).cast(series.dtype, strict=False))
                new_val = sess.df[column][row]
            except Exception:
                sess.df = sess.df.with_columns(
                    pl.Series(column, [None if v is None else str(v) for v in values])
                )
                new_val = value
        key = f"{row}:{column}"
        sess.provenance[key] = {
            "old": _cell(old),
            "new": _cell(new_val),
            "stage": "manual",
            "ts": datetime.now().isoformat(timespec="seconds"),
            "rule": "inline-edit",
        }
        sess.dirty += 1
        sess.exported = False
        self._record_clean(sess, "manual", 1, {column: 1}, [{"row": row, "column": column, "stage": "manual"}])
        self.wal.maybe_flush(sess)

    def update_schema(self, sid: str, column: str, patch: dict) -> dict:
        sess = self.get(sid)
        cur = sess.schema.setdefault(column, empty_column_schema(column))
        cur.update({k: v for k, v in patch.items() if v is not None})
        if patch.get("active") or patch.get("manual"):
            cur["manual"] = True
            cur["locked"] = True
        sess.schema[column] = cur
        sess.exported = False
        self._persist(sess, frame=False)
        return cur

    def drop_columns(self, sid: str, columns: list[str]) -> dict:
        sess = self.get(sid)
        seen: set[str] = set()
        cols: list[str] = []
        missing: list[str] = []
        for raw in columns or []:
            name = str(raw)
            if not name or name in seen:
                continue
            seen.add(name)
            if name in sess.df.columns:
                cols.append(name)
            else:
                missing.append(name)
        if not cols:
            raise KeyError("No matching columns to delete")
        if sess.df.width - len(cols) < 1:
            raise ValueError("Keep at least one column")
        self._checkpoint(sess, sess.df)
        drop_set = set(cols)
        keep = [c for c in sess.df.columns if c not in drop_set]
        sess.df = sess.df.select(keep)
        sess.highlights = [h for h in sess.highlights if h.get("column") not in drop_set]
        sess.provenance = {k: v for k, v in sess.provenance.items() if k.split(":", 1)[-1] not in drop_set}
        # Keep schema entries so Undo restores types. Viewport only lists live columns.
        label = ", ".join(cols)
        self._after(sess, "schema", f"Deleted column{'s' if len(cols) != 1 else ''} {label}", 0)
        return {
            "dropped": cols,
            "missing": missing,
            "columns": sess.columns(),
            "rows": sess.height(),
        }

    def add_column(self, sid: str, name: str, active: str = "Text", after: str | None = None) -> dict:
        sess = self.get(sid)
        raw = str(name or "").strip()
        raw = "".join(ch if ch.isprintable() and ch not in "\n\r\t" else "_" for ch in raw)
        if not raw or raw == "_r":
            raw = "column"
        taken = set(sess.df.columns)
        col = raw
        if col in taken:
            n = 2
            while f"{raw}_{n}" in taken:
                n += 1
            col = f"{raw}_{n}"
        typ = str(active or "Text").strip() or "Text"
        self._checkpoint(sess, sess.df)
        sess.df = sess.df.with_columns(pl.lit(None).alias(col))
        order = list(sess.df.columns)
        after_name = str(after or "")
        if after_name in order and after_name != col:
            order.remove(col)
            order.insert(order.index(after_name) + 1, col)
            sess.df = sess.df.select(order)
        sch = empty_column_schema(col, inferred=typ)
        sch["active"] = typ
        sch["manual"] = True
        sch["locked"] = True
        sess.schema[col] = sch
        self._after(sess, "schema", f"Added column {col}", 0)
        return {
            "added": col,
            "type": typ,
            "columns": sess.columns(),
            "rows": sess.height(),
        }

    def apply_template(self, sid: str, mapping: list[dict]) -> dict:
        """Lock matching columns to the template. Name match, then unique type alias."""
        from sidecar.schemas.dictionaries import HEADER_ALIASES, norm_header

        sess = self.get(sid)
        by_norm: dict[str, dict] = {}
        for m in mapping or []:
            if not isinstance(m, dict):
                continue
            key = norm_header(str(m.get("column") or m.get("name") or ""))
            if key:
                by_norm[key] = m
        applied = []
        for c in sess.columns():
            n = norm_header(c)
            m = by_norm.get(n)
            if not m:
                kind = HEADER_ALIASES.get(n)
                if kind:
                    hits = [
                        x
                        for x in by_norm.values()
                        if str(x.get("type") or x.get("active") or "") == kind
                        or HEADER_ALIASES.get(norm_header(str(x.get("column") or x.get("name") or ""))) == kind
                    ]
                    if len(hits) == 1:
                        m = hits[0]
            if not m:
                continue
            cur = sess.schema.setdefault(c, empty_column_schema(c))
            typ = m.get("type") or m.get("active") or cur.get("active")
            cur["active"] = typ
            cur["manual"] = True
            cur["locked"] = True
            for k in ("required", "nullable", "unique", "regex", "validation", "description", "example"):
                if m.get(k) not in (None, ""):
                    cur[k] = m[k]
            sess.schema[c] = cur
            applied.append({"column": c, "type": typ})
        sess.exported = False
        self._persist(sess, frame=False)
        return {"applied": applied, "count": len(applied)}

    def run_rules(self, sid: str, rules: list[dict]) -> dict:
        sess = self.get(sid)
        t0 = time.perf_counter()
        before = sess.df
        self._checkpoint(sess, before)
        rest, plugin_rules = _split_plugin_rules(rules)
        df, changed = apply_rule_list(sess.df, rest, schema=sess.schema)
        if plugin_rules:
            df = self._run_plugin_rules(sid, df, plugin_rules)
        highlights, total, by_col = _cell_diff(before, df, "rules")
        n = total if total else changed
        sess.df = df
        self._apply_sess_hooks(sess, "after_rules")
        self._record_clean(sess, "rules", n, by_col, highlights)
        sess.last_runtime_ms = (time.perf_counter() - t0) * 1000
        self._after(sess, "rules", "Universal rules", n)
        return {"changed": n, "runtime_ms": round(sess.last_runtime_ms, 2), "highlights": highlights}

    def run_sql(self, sid: str, sql: str) -> dict:
        sess = self.get(sid)
        before = sess.df
        self._checkpoint(sess, before)
        df, meta = run_sql(sess.df, sql)
        df = _stabilize(df)
        highlights, total, by_col = _cell_diff(before, df, "sql")
        sess.df = df
        self._apply_sess_hooks(sess, "after_sql")
        self._record_clean(sess, "sql", total, by_col, highlights)
        sess.last_runtime_ms = meta["runtime_ms"]
        self._sync_schema(sess)
        self._after(sess, "sql", "DuckDB SQL", total)
        meta["highlights"] = highlights
        meta["changed"] = total
        return meta

    def run_js(self, sid: str, code: str) -> dict:
        sess = self.get(sid)
        before = sess.df
        self._checkpoint(sess, before)
        df, meta = run_javascript(sess.df, code)
        df = _stabilize(df)
        highlights, total, by_col = _cell_diff(before, df, "javascript")
        sess.df = df
        self._apply_sess_hooks(sess, "after_javascript")
        self._record_clean(sess, "javascript", total, by_col, highlights)
        sess.last_runtime_ms = meta["runtime_ms"]
        self._after(sess, "javascript", "JavaScript V8", total)
        meta["highlights"] = highlights
        meta["changed"] = total
        return meta

    def run_python(self, sid: str, code: str) -> dict:
        sess = self.get(sid)
        before = sess.df
        self._checkpoint(sess, before)
        df, meta = run_python(sess.df, code)
        df = _stabilize(df)
        for line in meta.get("prints") or []:
            self._log(sess, "python", str(line))
        highlights, total, by_col = _cell_diff(before, df, "python")
        sess.df = df
        self._apply_sess_hooks(sess, "after_python")
        self._record_clean(sess, "python", total, by_col, highlights)
        sess.last_runtime_ms = meta["runtime_ms"]
        self._sync_schema(sess)
        self._after(sess, "python", "Python Polars", total)
        meta["highlights"] = highlights
        meta["changed"] = total
        return meta

    def run_pipeline(self, sid: str, payload: dict) -> dict:
        """Mandatory 4-stage order: Universal rules → DuckDB SQL → JavaScript V8 → Python Polars."""
        t0 = time.perf_counter()
        results = {}
        sess = self.get(sid)
        self._apply_sess_hooks(sess, "before_pipeline")
        if payload.get("rules"):
            results["rules"] = self.run_rules(sid, payload["rules"])
        sql = payload.get("sql") or ""
        sql_eff = "\n".join(ln for ln in sql.splitlines() if not ln.strip().startswith("--")).strip()
        if sql_eff:
            results["sql"] = self.run_sql(sid, sql)
        js = (payload.get("javascript") or "").strip()
        if js and not all(ln.strip().startswith("//") or not ln.strip() for ln in js.splitlines()):
            results["js"] = self.run_js(sid, js)
        py = (payload.get("python") or "").strip()
        if py and not all(ln.strip().startswith("#") or not ln.strip() for ln in py.splitlines()):
            results["python"] = self.run_python(sid, py)
        self._apply_sess_hooks(self.get(sid), "after_pipeline")
        results["runtime_ms"] = round((time.perf_counter() - t0) * 1000, 2)
        results["highlights"] = self.get(sid).highlights[-2500:]
        results["changed"] = self.get(sid).clean_total
        snapshot(self.store, self.get(sid), DATA_ROOT / "sessions", name="pipeline")
        return results

    def cleaning_report(self, sid: str) -> dict:
        sess = self.get(sid)
        now = self.metrics(sid)
        total_cells = max(0, int(now["rows"]) * int(now["columns"]))
        cleaned = int(sess.clean_total)
        pct = round(100.0 * cleaned / total_cells, 2) if total_cells else 0.0
        by_stage = [{"stage": k, "cells": v} for k, v in sorted(sess.clean_by_stage.items(), key=lambda x: -x[1])]
        by_column = [
            {"column": k, "cells": v, "pct": round(100.0 * v / max(1, int(now["rows"])), 2)}
            for k, v in sorted(sess.clean_by_column.items(), key=lambda x: -x[1])
        ]
        return {
            "title": "DataRefine Studio — Data quality report",
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "baseline": sess.baseline,
            "current": now,
            "cells_cleaned": cleaned,
            "pct_cleaned": pct,
            "total_cells": total_cells,
            "by_stage": by_stage,
            "by_column": by_column[:30],
        }

    def export(self, sid: str, fmt: str, dest: str, options: dict | None = None) -> str:
        fmt_l = (fmt or "").lower().lstrip(".")
        if fmt_l in {"pdf", "report", "report-pdf", "pdf-report"}:
            return write_cleaning_report(self.cleaning_report(sid), dest)
        sess = self.get(sid)
        from sidecar.plugins.runtime import find_exporter, run_exporter

        df, notes = self._plugin_hooks("before_export", sess.df, {"fmt": fmt, "dest": dest, "session_id": sid})
        for note in notes:
            self._log(sess, "plugin", note)
        hit = find_exporter(self.store, fmt_l)
        if hit:
            path = run_exporter(self.store, hit, df, dest, options or {})
        else:
            path = export_frame(df, fmt, dest, options or {})
        _, notes2 = self._plugin_hooks("after_export", df, {"fmt": fmt, "dest": path, "session_id": sid})
        for note in notes2:
            self._log(sess, "plugin", note)
        sess.exported = True
        self._persist(sess, frame=True)
        try:
            from sidecar.engine.persist import save_session_copy

            save_session_copy(sess)  # crash copy must know export = done
        except Exception:
            pass
        return path

    def push_to_db(
        self,
        sid: str,
        kind: str,
        config: dict,
        table: str,
        mode: str = "replace",
        schema: str = "",
    ) -> dict:
        from sidecar.engine.dbio import push_frame

        sess = self.get(sid)
        kind = kind or sess.db_kind
        config = config or sess.db_config
        n = push_frame(sess.df, kind, config, table, mode, schema)
        self._log(sess, "push", f"Pushed {n} rows → {schema + '.' if schema else ''}{table} ({mode})")
        sess.db_kind = kind
        sess.db_config = dict(config or {})
        return {"rows": n, "table": table, "mode": mode, "kind": kind}

    def undo(self, sid: str) -> dict:
        sess = self.get(sid)
        if not sess.undo:
            raise KeyError("Nothing to undo")
        sess.redo.append(sess.df)
        sess.redo = sess.redo[-12:]
        sess.redo_meta.append(sess.undo_meta.pop() if sess.undo_meta else {})
        sess.df = sess.undo.pop()
        self._sync_schema(sess)
        self._log(sess, "undo", "Undo")
        sess.exported = False
        self._persist(sess, frame=True)
        return {"rows": sess.height(), "columns": sess.columns(), "can_undo": bool(sess.undo), "can_redo": bool(sess.redo)}

    def redo(self, sid: str) -> dict:
        sess = self.get(sid)
        if not sess.redo:
            raise KeyError("Nothing to redo")
        sess.undo.append(sess.df)
        sess.undo = sess.undo[-12:]
        sess.undo_meta.append(sess.redo_meta.pop() if sess.redo_meta else {})
        sess.df = sess.redo.pop()
        self._sync_schema(sess)
        self._log(sess, "redo", "Redo")
        sess.exported = False
        self._persist(sess, frame=True)
        return {"rows": sess.height(), "columns": sess.columns(), "can_undo": bool(sess.undo), "can_redo": bool(sess.redo)}

    def restore_version(self, sid: str, version_id: int) -> dict:
        sess = self.get(sid)
        rows = self.store.versions(sid)
        hit = next((x for x in rows if int(x["id"]) == int(version_id)), None)
        if not hit:
            raise KeyError(f"Unknown version {version_id}")
        path = Path(hit["snapshot_path"])
        if not path.exists():
            raise FileNotFoundError(str(path))
        self._checkpoint(sess, sess.df)
        if path.suffix.lower() == ".parquet":
            sess.df = pl.read_parquet(path)
        else:
            sess.df = pl.read_csv(path)
        sess.df = _stabilize(sess.df)
        self._sync_schema(sess)
        self._log(sess, "versions", f"Restored {hit.get('name') or path.name}")
        sess.exported = False
        self._persist(sess, frame=True)
        return {"rows": sess.height(), "columns": sess.columns(), "name": hit.get("name")}

    def search_replace(
        self,
        sid: str,
        find: str,
        replace: str = "",
        column: str | None = None,
        regex: bool = False,
        do_replace: bool = False,
    ) -> dict:
        sess = self.get(sid)
        cols = [column] if column and column in sess.df.columns else list(sess.df.columns)
        hits = 0
        exprs = []
        for c in sess.df.columns:
            if c not in cols:
                exprs.append(pl.col(c))
                continue
            s = pl.col(c).cast(pl.Utf8, strict=False)
            if regex:
                mask = s.str.contains(find, literal=False)
                nxt = s.str.replace_all(find, replace, literal=False) if do_replace else s
            else:
                mask = s.str.contains(find, literal=True)
                nxt = s.str.replace_all(find, replace, literal=True) if do_replace else s
            hits += int(sess.df.select(mask.fill_null(False).sum()).item())
            exprs.append(nxt.alias(c) if do_replace else pl.col(c))
        if do_replace:
            self._checkpoint(sess, sess.df)
            after = sess.df.with_columns(exprs)
            highlights, total, by_col = _cell_diff(sess.df, after, "search")
            sess.df = after
            self._record_clean(sess, "search", total or hits, by_col, highlights)
            self._after(sess, "search", f"Replace '{find}'", total or hits)
            return {"matches": hits, "replaced": do_replace, "highlights": highlights, "changed": total or hits}
        return {"matches": hits, "replaced": do_replace}

    def preview_ai(self, sid: str, body: dict | None = None) -> dict:
        """Detect → Plan → Preview. JSON only. Does not write cells."""
        from sidecar.ai.pipeline import detect_and_preview, refine_plan_with_llm

        sess = self.get(sid)
        body = body or {}
        cols = [c for c in (body.get("columns") or []) if c in sess.columns()]
        rows = body.get("rows") if isinstance(body.get("rows"), list) else None
        extra = str(body.get("extra") or "")
        settings = body.get("settings") if isinstance(body.get("settings"), dict) else {}
        raw_thr = body.get("threshold")
        if raw_thr is None:
            raw_thr = settings.get("accept_confidence")
        try:
            accept_min = float(raw_thr if raw_thr is not None else 0.95)
        except (TypeError, ValueError):
            accept_min = 0.95
        if accept_min > 1:
            accept_min = accept_min / 100.0
        result = detect_and_preview(
            sess.df, sess.schema, columns=cols or None, rows=rows, extra=extra, accept_min=accept_min
        )
        if body.get("use_llm"):
            try:
                stored = self.store.get_setting("ai", {}) or {}
                settings = {**stored, **(body.get("settings") or {})}
                from sidecar.ai.providers import complete

                plan_blob = [
                    {"title": o.get("title"), "cells": o.get("cells"), "columns": o.get("columns"), "confidence": o.get("confidence")}
                    for o in result.get("plan") or []
                ]
                profiles = result.get("profiles") or []
                prompt = (
                    "You refine a data-quality execution plan. Do not invent columns or cell values.\n"
                    f"Profiles: {profiles[:40]}\nPlan: {plan_blob}\nExtra: {extra or '(none)'}\n"
                    "Return ONLY a JSON array of "
                    '[{ "column": "", "reason": "", "confidence": 0.0, "rule": "operation title" }].'
                )
                text = complete(settings, prompt)
                result["plan"] = refine_plan_with_llm(result.get("plan") or [], text)
                result["llm"] = True
                result["raw"] = (text or "")[:4000]
            except Exception as exc:
                result["llm"] = False
                result["llm_error"] = str(exc)
        result["wrote"] = False
        sess.ai_plan = {k: result[k] for k in ("plan", "buckets", "scope", "profiles") if k in result}
        self._log(sess, "ai", f"Preview plan · {len(result.get('plan') or [])} operations · not applied")
        return result

    def apply_ai_ops(self, sid: str, operations: list[dict], threshold: float = 0.0) -> dict:
        """One undoable transaction. Never returns the full frame."""
        sess = self.get(sid)
        before = sess.df
        self._checkpoint(sess, before)
        applied = 0
        tagged: list[dict] = []
        for op in operations:
            col = str(op.get("column") or "")
            if col not in sess.df.columns:
                continue
            try:
                conf = float(op.get("confidence") if op.get("confidence") is not None else 1)
            except (TypeError, ValueError):
                conf = 1.0
            if conf > 1:
                conf = conf / 100.0
            if conf < threshold:
                continue
            suggested = op.get("suggested")
            row = op.get("row")
            kind = str(op.get("kind") or "")
            stage = "rules" if kind == "rule" else "ai"
            if row is not None:
                try:
                    r = int(row)
                    series = sess.df[col]
                    values = series.to_list()
                    if 0 <= r < len(values):
                        values[r] = suggested
                        sess.df = sess.df.with_columns(pl.Series(col, values))
                        applied += 1
                        tagged.append({"row": r, "column": col, "stage": stage})
                except Exception:
                    continue
                continue
            original = op.get("original")
            if original is None or suggested is None:
                continue
            s = sess.df[col].cast(pl.Utf8, strict=False)
            nxt = pl.when(s == str(original)).then(pl.lit(str(suggested))).otherwise(s).alias(col)
            prev_n = int((s == str(original)).fill_null(False).sum())
            sess.df = sess.df.with_columns(nxt)
            applied += prev_n
        highlights, total, by_col = _cell_diff(before, sess.df, "ai")
        if tagged:
            highlights = tagged[:2500]
        self._record_clean(sess, "ai", total or applied, by_col, highlights)
        self._after(sess, "ai", "AI apply transaction", total or applied)
        try:
            snapshot(self.store, sess, DATA_ROOT / "sessions", name="ai-apply")
        except Exception:
            pass
        return {"applied": applied, "highlights": highlights, "changed": total or applied, "transaction": True}

    def run_plugin_command(self, sid: str | None, plugin_id: str, command_id: str, extra: dict | None = None) -> dict:
        from sidecar.plugins.loader import get_plugin
        from sidecar.plugins.runtime import call_python_ref_safe, plugin_failure

        try:
            rec = get_plugin(self.store, plugin_id)
            cmds = (rec.get("contributes") or {}).get("commands") or []
            cmd = next((c for c in cmds if isinstance(c, dict) and c.get("id") == command_id), None)
            if not cmd:
                raise KeyError(f"Unknown command {command_id}")
            if not cmd.get("python"):
                return {"ok": True, "changed": 0, "ui": True, "view": cmd.get("view"), "theme": cmd.get("theme")}
            ref = cmd.get("python") or ""
            fn = cmd.get("function") or "run"
            if ":" not in str(ref):
                ref = f"{ref}:{fn}"
            sess = self.get(sid) if sid else None
            df = sess.df if sess is not None else pl.DataFrame()
            ident = {}
            try:
                from sidecar.auth.github import plugin_identity

                ident = plugin_identity(self.store)
            except Exception:
                ident = {}
            ctx = {
                **(extra or {}),
                "session_id": sid or "",
                "command_id": command_id,
                "workspace": str(DATA_ROOT),
                **ident,
            }
            execution = call_python_ref_safe(self.store, plugin_id, str(ref), df, ctx, command_id)
            if execution.get("ok") is False:
                return execution
            out = execution.get("result")
            if isinstance(out, pl.DataFrame):
                if sess is None:
                    raise ValueError("Open a dataset first to run this command.")
                before = sess.df
                self._checkpoint(sess, before)
                nxt = _stabilize(out)
                highlights, total, by_col = _cell_diff(before, nxt, "plugin")
                sess.df = nxt
                self._sync_schema(sess)
                self._record_clean(sess, "plugin", total, by_col, highlights)
                self._after(sess, "plugin", rec.get("displayName") or plugin_id, total)
                return {"ok": True, "changed": total, "highlights": highlights, "runtime_ms": 0, "output": ""}
            text = _plugin_text(out)
            if sess is not None:
                self._log(sess, "plugin", (text.splitlines() or [command_id])[0][:240])
            return {"ok": True, "changed": 0, "highlights": [], "runtime_ms": 0, "output": text, "message": text[-4000:]}
        except Exception as exc:
            return plugin_failure(plugin_id, command_id, exc)

    def undo_to(self, sid: str, index: int) -> dict:
        """Jump back to checkpoint `index` (0 = oldest kept checkpoint)."""
        sess = self.get(sid)
        index = max(0, min(int(index), len(sess.undo)))
        steps = 0
        while len(sess.undo) > index:
            sess.redo.append(sess.df)
            sess.redo = sess.redo[-12:]
            sess.redo_meta.append(sess.undo_meta.pop() if sess.undo_meta else {})
            sess.df = sess.undo.pop()
            steps += 1
        if not steps:
            raise KeyError("Nothing to undo")
        self._sync_schema(sess)
        self._log(sess, "undo", f"Jumped back {steps} step(s)")
        sess.exported = False
        self._persist(sess, frame=True)
        return {"rows": sess.height(), "columns": sess.columns(), "can_undo": bool(sess.undo), "can_redo": bool(sess.redo)}

    def history(self, sid: str) -> dict:
        sess = self.get(sid)
        return {
            "checkpoints": [
                {"i": i, "rows": int(m.get("rows") or 0), "cols": int(m.get("cols") or 0), "ts": str(m.get("ts") or "")}
                for i, m in enumerate(sess.undo_meta)
            ],
            "current": {"rows": sess.height(), "cols": sess.width if hasattr(sess, "width") else sess.df.width},
        }

    def list_sessions(self) -> list[dict]:
        out = []
        for s in self.sessions.values():
            out.append(
                {
                    "id": s.id,
                    "label": s.label or Path(s.source).name or s.id,
                    "source": s.source,
                    "rows": s.height(),
                    "cols": s.df.width,
                    "created_at": s.created_at,
                    "exported": bool(s.exported),
                    "dirty": int(s.dirty),
                }
            )
        return out

    def rename(self, sid: str, label: str) -> dict:
        sess = self.get(sid)
        sess.label = str(label or "")[:80]
        self._persist(sess, frame=False)
        return {"label": sess.label}

    def delete_session(self, sid: str) -> dict:
        sess = self.sessions.pop(sid, None)
        if sess is None:
            raise KeyError(f"Unknown session {sid}")
        try:
            import json as _json

            mp = DATA_ROOT / "sessions" / sid / "meta.json"
            if mp.is_file():
                m = _json.loads(mp.read_text(encoding="utf-8")) or {}
                m["closed"] = True
                mp.write_text(_json.dumps(m), encoding="utf-8")
        except Exception:
            pass
        try:
            from sidecar.engine.persist import clear_current, peek

            if str((peek() or {}).get("session_id") or "") == sid:
                clear_current()
        except Exception:
            pass
        return {"deleted": sid}

    def workspace_get(self, sid: str) -> dict:
        sess = self.get(sid)
        return {
            "sql": sess.sql,
            "javascript": sess.javascript,
            "python": sess.python,
            "column_rules": sess.column_rules,
            "highlights": list(sess.highlights)[-2500:],
            "source": sess.source,
            "label": sess.label or Path(sess.source).name or sess.id,
            "exported": bool(sess.exported),
        }

    def _plugin_hooks(self, hook: str, df: pl.DataFrame, ctx: dict) -> tuple[pl.DataFrame, list[str]]:
        try:
            from sidecar.plugins.runtime import apply_hooks

            return apply_hooks(self.store, hook, df, ctx)
        except Exception as exc:
            return df, [f"{hook} failed: {exc}"]

    def _apply_sess_hooks(self, sess: Session, hook: str) -> None:
        df, notes = self._plugin_hooks(hook, sess.df, {"session_id": sess.id})
        sess.df = df
        for note in notes:
            self._log(sess, "plugin", note)

    def _run_plugin_rules(self, sid: str, df: pl.DataFrame, rules: list[dict]) -> pl.DataFrame:
        from sidecar.plugins.runtime import run_python_ref

        out = df
        for rule in rules:
            pid = str(rule.get("plugin") or (rule.get("parameters") or {}).get("plugin") or "")
            ref = str(rule.get("python") or (rule.get("parameters") or {}).get("python") or rule.get("body") or "")
            if not pid or not ref:
                continue
            try:
                out = run_python_ref(
                    self.store,
                    pid,
                    ref,
                    out,
                    {"session_id": sid, "columns": rule.get("columns"), "rule": rule.get("name")},
                )
            except Exception as exc:
                self._log(self.get(sid), "plugin", f"{pid} rule failed: {exc}")
        return out

    def _checkpoint(self, sess: Session, before: pl.DataFrame) -> None:
        sess.undo.append(before)
        sess.undo_meta.append(
            {
                "ts": datetime.now().isoformat(timespec="seconds"),
                "rows": before.height,
                "cols": before.width,
            }
        )
        sess.undo = sess.undo[-12:]
        sess.undo_meta = sess.undo_meta[-12:]
        sess.redo = []
        sess.redo_meta = []

    def _record_clean(
        self,
        sess: Session,
        stage: str,
        total: int,
        by_col: dict[str, int],
        highlights: list[dict],
    ) -> None:
        n = int(total or 0)
        if n > 0:
            sess.clean_total += n
            sess.clean_by_stage[stage] = sess.clean_by_stage.get(stage, 0) + n
            for col, count in (by_col or {}).items():
                sess.clean_by_column[col] = sess.clean_by_column.get(col, 0) + int(count)
            sess.clean_runs.append(
                {
                    "ts": datetime.now().isoformat(timespec="seconds"),
                    "stage": stage,
                    "cells": n,
                }
            )
            sess.clean_runs = sess.clean_runs[-80:]
        if highlights:
            sess.highlights = (sess.highlights + highlights)[-8000:]

    def _sync_schema(self, sess: Session) -> None:
        for c in sess.columns():
            if c not in sess.schema:
                sess.schema[c] = empty_column_schema(c)
        sess.schema = {c: sess.schema[c] for c in sess.columns() if c in sess.schema}

    def _after(self, sess: Session, stage: str, title: str, changed: int) -> None:
        self._log(sess, stage, title)
        record_lineage(
            self.store,
            sess.id,
            stage=stage,
            title=title,
            runtime_ms=sess.last_runtime_ms,
            rows_changed=changed,
            extra={"columns": sess.columns()},
        )
        self.wal.maybe_flush(sess)

    def _log(self, sess: Session, channel: str, message: str) -> None:
        sess.logs.append(
            {
                "ts": datetime.now().isoformat(timespec="seconds"),
                "channel": channel,
                "message": message,
            }
        )
        sess.logs = sess.logs[-500:]


def _cell_diff(
    before: pl.DataFrame, after: pl.DataFrame, stage: str, limit: int = 2500
) -> tuple[list[dict], int, dict[str, int]]:
    """Sample of changed cells + full counts. Never returns the frame."""
    out: list[dict] = []
    by_col: dict[str, int] = {}
    total = 0
    if after.height == 0:
        return out, 0, by_col
    if list(before.columns) != list(after.columns) or before.height != after.height:
        total = abs(after.height - before.height) or after.height
        cols = [c for c in after.columns if c not in before.columns] or list(after.columns)[:24]
        n = min(after.height, 80)
        for r in range(n):
            for c in cols:
                out.append({"row": r, "column": c, "stage": stage})
                if len(out) >= limit:
                    return out, total, by_col
        return out, total, by_col
    for c in after.columns:
        try:
            n = int(
                (
                    (before[c].cast(pl.Utf8, strict=False).fill_null("") != after[c].cast(pl.Utf8, strict=False).fill_null(""))
                    | (before[c].is_null() != after[c].is_null())
                )
                .fill_null(False)
                .sum()
            )
        except Exception:
            n = 0
        if n:
            by_col[c] = n
            total += n
        if n and len(out) < limit:
            try:
                flags = (
                    (
                        (before[c].cast(pl.Utf8, strict=False).fill_null("") != after[c].cast(pl.Utf8, strict=False).fill_null(""))
                        | (before[c].is_null() != after[c].is_null())
                    )
                    .fill_null(False)
                    .to_list()
                )
            except Exception:
                continue
            for r, flag in enumerate(flags):
                if not flag:
                    continue
                out.append({"row": int(r), "column": c, "stage": stage})
                if len(out) >= limit:
                    break
    return out, total, by_col


def _split_plugin_rules(rules: list[dict]) -> tuple[list[dict], list[dict]]:
    rest, plugin = [], []
    for rule in rules or []:
        kind = str(rule.get("kind") or "").lower()
        params = rule.get("parameters") if isinstance(rule.get("parameters"), dict) else {}
        pid = rule.get("plugin") or params.get("plugin")
        pyref = rule.get("python") or params.get("python")
        if kind in {"plugin", "python-plugin"} or (pid and pyref):
            plugin.append({**rule, "plugin": pid, "python": pyref})
        else:
            rest.append(rule)
    return rest, plugin


def _stabilize(df: pl.DataFrame) -> pl.DataFrame:
    rename = {}
    seen = set()
    for i, c in enumerate(df.columns):
        name = str(c or f"column_{i+1}").strip() or f"column_{i+1}"
        base = name
        n = 2
        while name in seen:
            name = f"{base}_{n}"
            n += 1
        seen.add(name)
        if name != c:
            rename[c] = name
    if rename:
        df = df.rename(rename)
    return df


def _plugin_text(out: Any) -> str:
    if out is None:
        return ""
    if isinstance(out, (bytes, bytearray)):
        return bytes(out).decode("utf-8", errors="replace")
    if isinstance(out, dict):
        return str(out.get("output") or out.get("message") or out)
    return str(out)


def _cell(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, float) and v != v:  # NaN
        return None
    if hasattr(v, "isoformat"):
        try:
            return v.isoformat()
        except Exception:
            return str(v)
    if isinstance(v, (bytes, bytearray)):
        return v.decode("utf-8", errors="replace")
    if isinstance(v, (int, float, str, bool)):
        return v
    return str(v)
