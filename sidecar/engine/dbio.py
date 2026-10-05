"""Database URI, test, and push — never send the full frame as JSON."""

from __future__ import annotations

from contextlib import contextmanager
from time import perf_counter
from typing import Any, Iterator
import re
from urllib.parse import quote_plus

import polars as pl

DIALECT = {
    "postgres": "postgresql+pg8000",
    "postgresql": "postgresql+pg8000",
    "mysql": "mysql+pymysql",
    "mariadb": "mysql+pymysql",
    "sqlserver": "mssql+pyodbc",
    "mssql": "mssql+pyodbc",
    "snowflake": "snowflake",
    "sqlite": "sqlite",
}


def build_uri(kind: str, config: dict[str, Any]) -> str:
    if config.get("uri"):
        return str(config["uri"])
    kind = (kind or "").lower()
    if kind in {"sqlite", "duckdb"}:
        path = config.get("path") or config.get("database") or ":memory:"
        if kind == "sqlite":
            return f"sqlite:///{path}"
        return str(path)
    dialect = DIALECT.get(kind, "postgresql+pg8000")
    user = quote_plus(str(config.get("user") or ""))
    password = quote_plus(str(config.get("password") or ""))
    host = str(config.get("host") or "localhost")
    port = str(config.get("port") or "")
    db = str(config.get("database") or "")
    auth = f"{user}:{password}@" if user or password else ""
    hostport = f"{host}:{port}" if port else host
    uri = f"{dialect}://{auth}{hostport}/{db}"
    if config.get("ssl"):
        sep = "&" if "?" in uri else "?"
        uri += f"{sep}sslmode=require"
    return uri


@contextmanager
def maybe_tunnel(kind: str, config: dict[str, Any]) -> Iterator[dict[str, Any]]:
    ssh = config.get("ssh") if isinstance(config.get("ssh"), dict) else {}
    if not ssh or not ssh.get("enabled"):
        yield config
        return
    try:
        from sshtunnel import SSHTunnelForwarder
    except ImportError as exc:
        raise RuntimeError("SSH tunnel needs: py -3 -m pip install sshtunnel") from exc
    remote_host = str(config.get("host") or "localhost")
    remote_port = int(config.get("port") or _default_port(kind))
    kw: dict[str, Any] = {
        "ssh_username": ssh.get("user") or "",
        "remote_bind_address": (remote_host, remote_port),
    }
    if ssh.get("key"):
        kw["ssh_pkey"] = ssh.get("key")
    if ssh.get("password"):
        kw["ssh_password"] = ssh.get("password")
    server = SSHTunnelForwarder((str(ssh.get("host") or ""), int(ssh.get("port") or 22)), **kw)
    server.start()
    try:
        yield {**config, "host": "127.0.0.1", "port": server.local_bind_port, "uri": ""}
    finally:
        server.stop()


def test_connection(kind: str, config: dict[str, Any]) -> dict[str, Any]:
    t0 = perf_counter()
    kind = (kind or "").lower()
    with maybe_tunnel(kind, config) as cfg:
        if kind == "duckdb":
            import duckdb

            path = cfg.get("path") or cfg.get("database") or ":memory:"
            con = duckdb.connect(str(path))
            try:
                con.execute("SELECT 1")
            finally:
                con.close()
        elif kind == "sqlite":
            from sqlalchemy import create_engine, text

            engine = create_engine(build_uri(kind, cfg))
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
        else:
            from sqlalchemy import create_engine, text

            engine = create_engine(build_uri(kind, cfg))
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
    return {"ok": True, "ms": round((perf_counter() - t0) * 1000, 1)}


def push_frame(
    df: pl.DataFrame,
    kind: str,
    config: dict[str, Any],
    table: str,
    mode: str = "replace",
    schema: str = "",
) -> int:
    if not table or not str(table).strip():
        raise ValueError("Table name required")
    table = str(table).strip()
    mode = (mode or "replace").lower()
    if mode not in {"replace", "append", "fail"}:
        mode = "replace"
    kind = (kind or "").lower()
    sch = str(schema).strip() if schema else ""
    name = f"{sch}.{table}" if sch else table
    if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$", name):
        raise ValueError("Table name may only contain letters, numbers, underscore, and one optional schema.")
    with maybe_tunnel(kind, config) as cfg:
        if kind == "duckdb":
            import duckdb

            path = cfg.get("path") or cfg.get("database") or ":memory:"
            con = duckdb.connect(str(path))
            try:
                con.register("_push", df)
                if mode == "replace":
                    con.execute(f"CREATE OR REPLACE TABLE {name} AS SELECT * FROM _push")
                elif mode == "fail":
                    con.execute(f"CREATE TABLE {name} AS SELECT * FROM _push")
                else:
                    con.execute(f"INSERT INTO {name} SELECT * FROM _push")
            finally:
                con.close()
            return df.height
        if kind == "sqlite":
            uri = build_uri(kind, cfg)
        else:
            uri = build_uri(kind, cfg)
        df.write_database(name, connection=uri, if_table_exists=mode, engine="sqlalchemy")
    return df.height


def _default_port(kind: str) -> int:
    return {"postgres": 5432, "postgresql": 5432, "mysql": 3306, "mariadb": 3306, "sqlserver": 1433, "mssql": 1433}.get(
        (kind or "").lower(), 5432
    )
