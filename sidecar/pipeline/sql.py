"""Stage 2 — DuckDB SQL against the active frame."""

from __future__ import annotations

import time
from typing import Any

import duckdb
import polars as pl


def run_sql(df: pl.DataFrame, sql: str) -> tuple[pl.DataFrame, dict[str, Any]]:
    raw = sql or ""
    sql = "\n".join(ln for ln in raw.splitlines() if not ln.strip().startswith("--")).strip()
    if not sql:
        raise ValueError("SQL is empty.")
    con = duckdb.connect()
    t0 = time.perf_counter()
    try:
        try:
            con.register("data", df)
            con.register("df", df)
        except Exception:
            arrow = df.to_arrow()
            con.register("data", arrow)
            con.register("df", arrow)
        rel = con.execute(sql)
        try:
            out = rel.pl()
        except Exception:
            # Non-select statements
            out = con.execute("SELECT * FROM data").pl()
        runtime = (time.perf_counter() - t0) * 1000
        plan = ""
        try:
            plan = str(con.execute("EXPLAIN " + sql).fetchall())
        except Exception:
            pass
        return out, {
            "runtime_ms": round(runtime, 2),
            "rows": out.height,
            "columns": out.width,
            "plan": plan[:4000],
            "engine": "duckdb",
        }
    finally:
        con.close()
