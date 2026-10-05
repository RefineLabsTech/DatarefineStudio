"""Streaming-friendly exports."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import polars as pl


def export_frame(df: pl.DataFrame, fmt: str, dest: str, options: dict[str, Any] | None = None) -> str:
    options = options or {}
    path = Path(dest)
    path.parent.mkdir(parents=True, exist_ok=True)
    fmt = (fmt or path.suffix.lstrip(".") or "csv").lower().lstrip(".")
    include_header = bool(options.get("headers", True))
    if fmt == "csv":
        df.write_csv(path, include_header=include_header, separator=options.get("delimiter") or ",")
    elif fmt == "tsv":
        df.write_csv(path, include_header=include_header, separator="\t")
    elif fmt in {"xlsx", "xls"}:
        try:
            df.write_excel(path)
        except Exception:
            df.to_pandas().to_excel(str(path), index=False, engine="openpyxl")
    elif fmt == "json":
        df.write_json(path)
    elif fmt in {"ndjson", "jsonl"}:
        df.write_ndjson(path)
    elif fmt == "parquet":
        df.write_parquet(path)
    elif fmt in {"feather", "ipc", "arrow"}:
        df.write_ipc(path)
    elif fmt == "html":
        path.write_text(df.to_pandas().to_html(index=False), encoding="utf-8")
    else:
        raise ValueError(f"Unsupported export format: {fmt}")
    return str(path)
