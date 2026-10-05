"""Column profiling + semantic type inference."""

from __future__ import annotations

from typing import Any

import polars as pl

from sidecar.profiler.detect import detect_column, infer_semantic

__all__ = ["infer_semantic", "profile_column", "profile_frame", "detect_column"]


def _sample_strings(s: pl.Series, n: int = 8) -> list[str]:
    vals = s.drop_nulls().cast(pl.Utf8, strict=False).head(n).to_list()
    return [str(v).strip() for v in vals if v is not None and str(v).strip() != ""]


def profile_column(s: pl.Series) -> dict[str, Any]:
    n = s.len()
    nulls = int(s.null_count())
    uniq = int(s.n_unique())
    detected = detect_column(s.name or "", s)
    semantic = str(detected.get("inferred") or "Text")
    out: dict[str, Any] = {
        "name": s.name,
        "dtype": str(s.dtype),
        "inferred": semantic,
        "confidence": detected.get("confidence"),
        "null_count": nulls,
        "null_pct": round(100.0 * nulls / n, 3) if n else 0,
        "unique_count": uniq,
        "duplicate_pct": round(100.0 * (1 - uniq / n), 3) if n else 0,
        "min": None,
        "max": None,
        "mean": None,
        "median": None,
        "std": None,
        "length": None,
        "regex": None,
        "example": None,
        "fingerprint": detected.get("fingerprint"),
    }
    try:
        samples = _sample_strings(s, 8)
        out["example"] = samples[0] if samples else None
    except Exception:
        pass
    numeric = s.dtype in (
        pl.Int8, pl.Int16, pl.Int32, pl.Int64, pl.UInt32, pl.UInt64, pl.Float32, pl.Float64,
    )
    if numeric:
        try:
            out["min"] = _num(s.min())
            out["max"] = _num(s.max())
            out["mean"] = _num(s.mean())
            out["median"] = _num(s.median())
            out["std"] = _num(s.std())
        except Exception:
            pass
    else:
        try:
            lens = s.cast(pl.Utf8, strict=False).str.len_chars()
            out["length"] = int(lens.mean() or 0)
        except Exception:
            pass
    return out


def profile_frame(df: pl.DataFrame) -> list[dict[str, Any]]:
    return [profile_column(df[c]) for c in df.columns]


def _num(v: Any) -> Any:
    if v is None:
        return None
    try:
        if isinstance(v, float):
            return round(v, 6)
        return v
    except Exception:
        return str(v)
