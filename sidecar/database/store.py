"""SQLite store — rules, schema templates, versions, WAL, settings, lineage."""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any

SCHEMA_SQL = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_templates (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    mapping TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    description TEXT,
    category TEXT,
    tags TEXT,
    body TEXT NOT NULL,
    parameters TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    usage_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS versions (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    name TEXT,
    branch TEXT NOT NULL DEFAULT 'main',
    snapshot_path TEXT NOT NULL,
    schema_json TEXT,
    created_at TEXT NOT NULL,
    note TEXT
);

CREATE TABLE IF NOT EXISTS lineage_nodes (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    title TEXT NOT NULL,
    runtime_ms REAL,
    rows_changed INTEGER,
    input_schema TEXT,
    output_schema TEXT,
    created_at TEXT NOT NULL,
    extra TEXT
);

CREATE TABLE IF NOT EXISTS wal_entries (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recent_files (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    opened_at TEXT NOT NULL
);
"""


class Store:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self._init()

    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(str(self.path), check_same_thread=False)
            conn.row_factory = sqlite3.Row
            self._local.conn = conn
        return conn

    def _init(self) -> None:
        conn = self._conn()
        conn.executescript(SCHEMA_SQL)
        conn.commit()
        self._seed()

    def _seed(self) -> None:
        existing = {r["name"] for r in self.rules()}
        seeds = [
            ("Active rows SQL", "sql", "SELECT * FROM data WHERE 1=1;", "Keep all rows (edit the WHERE clause)", "sql", {}),
            ("Lowercase JS", "javascript", "for (const k of Object.keys(row)) {\n  if (typeof row[k] === 'string') row[k] = row[k].trim();\n}\nreturn row;", "Trim every string cell in the row", "javascript", {}),
            ("Cast strings Python", "python", "df = df.with_columns(pl.all().cast(pl.Utf8, strict=False))", "Cast every column to string", "python", {}),
            ("Strip trailing punctuation", "regex", r"[\\s.,;:]+$", "Remove trailing punctuation/spaces", "regex", {"pattern": r"[\\s.,;:]+$", "replacement": ""}),
        ]
        for name, kind, body, desc, cat, params in seeds:
            if name in existing:
                continue
            self.save_rule(name=name, kind=kind, body=body, description=desc, category=cat, parameters=params)

    def get_setting(self, key: str, default: Any = None) -> Any:
        row = self._conn().execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        if row is None:
            return default
        try:
            return json.loads(row["value"])
        except json.JSONDecodeError:
            return row["value"]

    def set_setting(self, key: str, value: Any) -> None:
        self._conn().execute(
            "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value)),
        )
        self._conn().commit()

    def all_settings(self) -> dict:
        rows = self._conn().execute("SELECT key, value FROM settings").fetchall()
        out = {}
        for r in rows:
            try:
                out[r["key"]] = json.loads(r["value"])
            except json.JSONDecodeError:
                out[r["key"]] = r["value"]
        return out

    def add_recent(self, path: str) -> None:
        from datetime import datetime

        self._conn().execute(
            """
            INSERT INTO recent_files(path, opened_at) VALUES(?,?)
            ON CONFLICT(path) DO UPDATE SET opened_at=excluded.opened_at
            """,
            (path, datetime.now().isoformat(timespec="seconds")),
        )
        self._conn().commit()

    def recents(self, limit: int = 20) -> list[dict]:
        rows = self._conn().execute(
            "SELECT path, opened_at FROM recent_files ORDER BY opened_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]

    def save_template(self, name: str, mapping: list, description: str = "") -> int:
        from datetime import datetime

        now = datetime.now().isoformat(timespec="seconds")
        cur = self._conn().execute(
            """
            INSERT INTO schema_templates(name, description, version, mapping, created_at, updated_at)
            VALUES (?,?,1,?,?,?)
            """,
            (name, description, json.dumps(mapping), now, now),
        )
        self._conn().commit()
        return int(cur.lastrowid)

    def templates(self) -> list[dict]:
        rows = self._conn().execute(
            "SELECT * FROM schema_templates ORDER BY updated_at DESC"
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["mapping"] = json.loads(d["mapping"])
            out.append(d)
        return out

    def save_rule(self, **fields) -> int:
        from datetime import datetime

        rid_raw = fields.get("id")
        try:
            rid = int(rid_raw) if rid_raw not in (None, "", 0, "0") else 0
        except (TypeError, ValueError):
            rid = 0
        params = json.dumps(fields.get("parameters") or {})
        tags = json.dumps(fields.get("tags") or [])
        if rid:
            row = self._conn().execute("SELECT id FROM rules WHERE id=?", (rid,)).fetchone()
            if row:
                self._conn().execute(
                    """
                    UPDATE rules
                    SET name=?, kind=?, description=?, category=?, tags=?, body=?, parameters=?
                    WHERE id=?
                    """,
                    (
                        fields.get("name"),
                        fields.get("kind"),
                        fields.get("description", ""),
                        fields.get("category", "general"),
                        tags,
                        fields.get("body", ""),
                        params,
                        rid,
                    ),
                )
                self._conn().commit()
                return rid
        cur = self._conn().execute(
            """
            INSERT INTO rules(name, kind, description, category, tags, body, parameters, version, created_at)
            VALUES (?,?,?,?,?,?,?,1,?)
            """,
            (
                fields.get("name"),
                fields.get("kind"),
                fields.get("description", ""),
                fields.get("category", "general"),
                tags,
                fields.get("body", ""),
                params,
                datetime.now().isoformat(timespec="seconds"),
            ),
        )
        self._conn().commit()
        return int(cur.lastrowid)

    def rules(self, kind: str | None = None) -> list[dict]:
        if kind:
            rows = self._conn().execute(
                "SELECT * FROM rules WHERE kind=? ORDER BY usage_count DESC, id DESC", (kind,)
            ).fetchall()
        else:
            rows = self._conn().execute("SELECT * FROM rules ORDER BY usage_count DESC, id DESC").fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["tags"] = json.loads(d["tags"] or "[]")
            d["parameters"] = json.loads(d["parameters"] or "{}")
            out.append(d)
        return out

    def bump_rule(self, rule_id: int) -> None:
        self._conn().execute("UPDATE rules SET usage_count = usage_count + 1 WHERE id=?", (rule_id,))
        self._conn().commit()

    def delete_rule(self, rule_id: int) -> None:
        self._conn().execute("DELETE FROM rules WHERE id=?", (int(rule_id),))
        self._conn().commit()

    def add_version(self, session_id: str, snapshot_path: str, schema_json: str, name: str = "", note: str = "") -> int:
        from datetime import datetime

        cur = self._conn().execute(
            """
            INSERT INTO versions(session_id, name, snapshot_path, schema_json, created_at, note)
            VALUES (?,?,?,?,?,?)
            """,
            (session_id, name, snapshot_path, schema_json, datetime.now().isoformat(timespec="seconds"), note),
        )
        self._conn().commit()
        return int(cur.lastrowid)

    def versions(self, session_id: str) -> list[dict]:
        rows = self._conn().execute(
            "SELECT * FROM versions WHERE session_id=? ORDER BY id DESC", (session_id,)
        ).fetchall()
        return [dict(r) for r in rows]

    def add_lineage(self, session_id: str, **fields) -> int:
        from datetime import datetime

        cur = self._conn().execute(
            """
            INSERT INTO lineage_nodes(session_id, stage, title, runtime_ms, rows_changed, input_schema, output_schema, created_at, extra)
            VALUES (?,?,?,?,?,?,?,?,?)
            """,
            (
                session_id,
                fields.get("stage"),
                fields.get("title"),
                fields.get("runtime_ms"),
                fields.get("rows_changed"),
                json.dumps(fields.get("input_schema") or []),
                json.dumps(fields.get("output_schema") or []),
                datetime.now().isoformat(timespec="seconds"),
                json.dumps(fields.get("extra") or {}),
            ),
        )
        self._conn().commit()
        return int(cur.lastrowid)

    def lineage(self, session_id: str) -> list[dict]:
        rows = self._conn().execute(
            "SELECT * FROM lineage_nodes WHERE session_id=? ORDER BY id", (session_id,)
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["input_schema"] = json.loads(d["input_schema"] or "[]")
            d["output_schema"] = json.loads(d["output_schema"] or "[]")
            d["extra"] = json.loads(d["extra"] or "{}")
            out.append(d)
        return out

    def wal_append(self, session_id: str, payload: dict) -> None:
        from datetime import datetime

        self._conn().execute(
            "INSERT INTO wal_entries(session_id, payload, created_at) VALUES (?,?,?)",
            (session_id, json.dumps(payload), datetime.now().isoformat(timespec="seconds")),
        )
        self._conn().commit()

    def wal_for(self, session_id: str) -> list[dict]:
        rows = self._conn().execute(
            "SELECT * FROM wal_entries WHERE session_id=? ORDER BY id", (session_id,)
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["payload"] = json.loads(d["payload"])
            out.append(d)
        return out

    def wal_clear(self, session_id: str) -> None:
        self._conn().execute("DELETE FROM wal_entries WHERE session_id=?", (session_id,))
        self._conn().commit()

    def purge_versions(self, session_id: str) -> None:
        with self._conn() as c:
            c.execute("DELETE FROM versions WHERE session_id = ?", (session_id,))

    def unfinished_sessions(self) -> list[str]:
        rows = self._conn().execute("SELECT DISTINCT session_id FROM wal_entries").fetchall()
        return [r["session_id"] for r in rows]
