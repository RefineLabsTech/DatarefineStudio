"""File and database ingestion into Polars."""

from __future__ import annotations

from pathlib import Path

import polars as pl

READ_LIMIT_MAP = {
    5000: 5_000,
    10000: 10_000,
    50000: 50_000,
    100000: 100_000,
    500000: 500_000,
    1000000: 1_000_000,
    0: None,
    -1: None,
}


def load_file(path: str | Path, n_rows: int | None = None) -> pl.DataFrame:
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(path)
    ext = path.suffix.lower()
    n = n_rows if n_rows and n_rows > 0 else None
    if ext in {".csv", ".tsv"}:
        sep = "\t" if ext == ".tsv" else ","
        return pl.read_csv(
            path,
            separator=sep,
            infer_schema_length=5000,
            try_parse_dates=True,
            ignore_errors=True,
            truncate_ragged_lines=True,
            n_rows=n,
        )
    if ext in {".parquet"}:
        df = pl.read_parquet(path)
        return df.head(n) if n else df
    if ext in {".json"}:
        try:
            df = pl.read_json(path)
        except Exception:
            df = pl.read_ndjson(path)
        return df.head(n) if n else df
    if ext in {".feather", ".arrow", ".ipc"}:
        df = pl.read_ipc(path)
        return df.head(n) if n else df
    if ext in {".xlsx", ".xls"}:
        df = pl.read_excel(path, engine="openpyxl")
        return df.head(n) if n else df
    raise ValueError(f"Unsupported file type: {ext}")


def load_sql(query: str, uri: str, n_rows: int | None = None) -> pl.DataFrame:
    import duckdb

    con = duckdb.connect()
    try:
        # DuckDB can attach many sources via httpfs / postgres scanner when configured.
        rel = con.execute(query)
        df = rel.pl()
    finally:
        con.close()
    if n_rows and n_rows > 0:
        return df.head(n_rows)
    return df


def connect_and_query(kind: str, config: dict, query: str, n_rows: int | None = None) -> pl.DataFrame:
    from sidecar.engine.dbio import build_uri, maybe_tunnel

    kind = (kind or "").lower()
    q = (query or "").strip() or "SELECT 1 AS connected"
    with maybe_tunnel(kind, config) as cfg:
        if kind == "sqlite":
            import duckdb

            path = cfg.get("path") or cfg.get("database")
            con = duckdb.connect()
            try:
                con.execute(f"ATTACH '{path}' AS src (TYPE SQLITE)")
                df = con.execute(q).pl()
            finally:
                con.close()
        elif kind == "duckdb":
            import duckdb

            path = cfg.get("path") or ":memory:"
            c2 = duckdb.connect(str(path))
            try:
                df = c2.execute(q).pl()
            finally:
                c2.close()
        else:
            from sqlalchemy import create_engine, text

            engine = create_engine(build_uri(kind, cfg))
            with engine.connect() as conn:
                result = conn.execute(text(q))
                rows = result.fetchall()
                cols = list(result.keys())
            df = pl.DataFrame({c: [r[i] for r in rows] for i, c in enumerate(cols)})
    if n_rows and n_rows > 0:
        return df.head(n_rows)
    return df
