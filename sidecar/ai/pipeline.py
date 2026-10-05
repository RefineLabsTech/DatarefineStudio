"""Industrial AI quality pipeline: Detect → Plan → Preview (JSON only).

Never writes the frame. Only apply_ai_ops commits a transaction.
Never returns the full dataframe.
"""

from __future__ import annotations

import re
import uuid
from typing import Any

import polars as pl

from sidecar.profiler.profile import infer_semantic, profile_column

EMAIL_RE = re.compile(r"^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$", re.I)
NAME_RE = re.compile(r"name|company|customer|person|entity|client|vendor", re.I)
COUNTRY_RE = re.compile(r"country|nation|region", re.I)
PHONE_RE = re.compile(r"phone|mobile|tel\b|cell", re.I)
EMAIL_COL_RE = re.compile(r"e-?mail", re.I)

DIFF_CAP = 1200
SAMPLE_CAP = 48


def bucket(conf: float, auto_min: float = 0.95) -> str:
    try:
        auto_min = float(auto_min)
    except (TypeError, ValueError):
        auto_min = 0.95
    if auto_min > 1:
        auto_min = auto_min / 100.0
    auto_min = max(0.5, min(1.0, auto_min))
    if conf >= auto_min:
        return "auto"
    if conf >= auto_min - 0.15:
        return "review"
    return "ignore"


def _utf(s: pl.Expr) -> pl.Expr:
    return s.cast(pl.Utf8, strict=False)


def _rows_filter(df: pl.DataFrame, rows: list[int] | None) -> pl.DataFrame:
    if not rows:
        return df.with_row_index("__i")
    want = sorted({int(r) for r in rows if isinstance(r, (int, float)) and int(r) >= 0})[:20000]
    if not want:
        return df.with_row_index("__i")
    return df.with_row_index("__i").filter(pl.col("__i").is_in(want))


def _sample_diffs(scoped: pl.DataFrame, mask: pl.Expr, col: str, suggested: pl.Expr, limit: int) -> list[dict[str, Any]]:
    try:
        hit = scoped.filter(mask).select(
            pl.col("__i"),
            pl.col(col).alias("original"),
            suggested.alias("suggested"),
        ).head(limit)
    except Exception:
        return []
    out = []
    for rec in hit.iter_rows(named=True):
        orig = rec.get("original")
        sug = rec.get("suggested")
        if orig == sug:
            continue
        out.append(
            {
                "row": int(rec["__i"]),
                "column": col,
                "original": None if orig is None else str(orig),
                "suggested": None if sug is None else str(sug),
            }
        )
    return out


def detect_and_preview(
    df: pl.DataFrame,
    schema: dict[str, dict],
    *,
    columns: list[str] | None = None,
    rows: list[int] | None = None,
    extra: str = "",
    accept_min: float = 0.95,
) -> dict[str, Any]:
    """Rules-first detect + preview diffs. No LLM. No writes."""
    cols = [c for c in (columns or list(df.columns)) if c in df.columns] or list(df.columns)
    scoped = _rows_filter(df, rows)
    profiles = []
    for c in cols:
        try:
            p = profile_column(scoped[c] if c in scoped.columns else df[c])
        except Exception:
            p = {"name": c, "inferred": "Text", "null_pct": 0, "unique_count": 0, "dtype": ""}
        sch = schema.get(c) or {}
        p["active"] = sch.get("active") or p.get("inferred")
        p["manual"] = bool(sch.get("manual"))
        profiles.append(
            {
                "name": p.get("name") or c,
                "inferred": p.get("inferred") or "Text",
                "active": p.get("active") or p.get("inferred") or "Text",
                "null_pct": p.get("null_pct") or 0,
                "unique_count": p.get("unique_count") or 0,
                "dtype": str(p.get("dtype") or ""),
                "example": p.get("example"),
            }
        )

    ops: list[dict[str, Any]] = []
    diffs: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []

    def add_op(title: str, kind: str, conf: float, cells: int, columns_hit: list[str], reason: str, samples: list[dict[str, Any]]):
        if cells <= 0 and not samples:
            return
        oid = uuid.uuid4().hex[:10]
        b = bucket(conf, accept_min)
        ops.append(
            {
                "id": oid,
                "title": title,
                "kind": kind,
                "cells": int(cells),
                "columns": columns_hit,
                "confidence": round(conf, 4),
                "bucket": b,
                "description": reason,
                "enabled": b != "ignore",
            }
        )
        findings.append({"id": oid, "title": title, "cells": int(cells), "columns": columns_hit, "confidence": conf})
        room = DIFF_CAP - len(diffs)
        for d in samples[: max(0, min(SAMPLE_CAP, room))]:
            diffs.append(
                {
                    **d,
                    "op_id": oid,
                    "confidence": round(conf, 4),
                    "bucket": b,
                    "reason": reason,
                    "status": "pending",
                }
            )

    for c in cols:
        s = _utf(pl.col(c))
        inferred = infer_semantic(df[c]) if c in df.columns else "Text"
        active = str((schema.get(c) or {}).get("active") or inferred)
        look = f"{c} {active} {inferred}"

        if inferred == "Email" or EMAIL_COL_RE.search(c) or active == "Email":
            stripped = s.str.strip_chars().str.to_lowercase()
            dirty = s.is_not_null() & (s.str.strip_chars() != "") & (s != stripped)
            try:
                n = int(scoped.select(dirty.fill_null(False).sum()).item())
            except Exception:
                n = 0
            samples = _sample_diffs(scoped, dirty.fill_null(False), c, stripped, SAMPLE_CAP)
            add_op("Normalize Emails", "rule", 0.99, n, [c], "Trim and lowercase email addresses.", samples)

            invalid = s.is_not_null() & (s.str.strip_chars() != "") & ~s.str.contains(r"@")
            try:
                n_inv = int(scoped.select(invalid.fill_null(False).sum()).item())
            except Exception:
                n_inv = 0
            samples_inv = _sample_diffs(scoped, invalid.fill_null(False), c, s, SAMPLE_CAP)
            for d in samples_inv:
                d["suggested"] = d.get("original")
            add_op("Review invalid emails", "ai", 0.62, n_inv, [c], "Non-empty values without '@' need a human.", samples_inv)

        if inferred == "Phone" or PHONE_RE.search(look) or active == "Phone":
            digits = s.str.replace_all(r"\D", "")
            dirty = s.is_not_null() & (s.str.strip_chars() != "") & (s != digits) & (digits.str.len_chars() >= 7)
            try:
                n = int(scoped.select(dirty.fill_null(False).sum()).item())
            except Exception:
                n = 0
            samples = _sample_diffs(scoped, dirty.fill_null(False), c, digits, SAMPLE_CAP)
            add_op("Standardize Phone Numbers", "rule", 0.96, n, [c], "Keep digits only for phone values.", samples)

        if inferred == "Country" or COUNTRY_RE.search(c) or active == "Country":
            empty = s.is_null() | (s.str.strip_chars() == "")
            try:
                n = int(scoped.select(empty.fill_null(False).sum()).item())
            except Exception:
                n = 0
            mode = None
            try:
                modes = scoped.filter(~empty.fill_null(False)).select(pl.col(c).mode())
                if modes.height:
                    mode = modes[0, 0]
            except Exception:
                mode = None
            if mode is not None and n:
                samples = _sample_diffs(scoped, empty.fill_null(False), c, pl.lit(str(mode)), SAMPLE_CAP)
                add_op("Fill Missing Country", "ai", 0.86, n, [c], f"Fill empty country with the mode “{mode}”.", samples)
            elif n:
                add_op("Fill Missing Country", "ai", 0.55, n, [c], "Empty country values — no dominant fill value.", [])

        if NAME_RE.search(c) or inferred == "Category" and "name" in c.lower():
            try:
                titled = s.str.to_titlecase()
            except Exception:
                titled = s
            dirty = s.is_not_null() & (s.str.strip_chars() != "") & (s != titled)
            try:
                n = int(scoped.select(dirty.fill_null(False).sum()).item())
            except Exception:
                n = 0
            samples = _sample_diffs(scoped, dirty.fill_null(False), c, titled, SAMPLE_CAP)
            add_op("Review Entity Names", "ai", 0.84, n, [c], "Title-case likely entity names.", samples)

        if active in {"Email", "Phone", "URL", "UUID"}:
            if active == "URL":
                bad = s.is_not_null() & (s.str.strip_chars() != "") & ~s.str.contains(r"^https?://")
                try:
                    n = int(scoped.select(bad.fill_null(False).sum()).item())
                except Exception:
                    n = 0
                samples = _sample_diffs(scoped, bad.fill_null(False), c, s, SAMPLE_CAP)
                add_op("Review invalid URLs", "ai", 0.58, n, [c], "Values that are not http(s) URLs.", samples)

    # Merge ops with the same title
    merged: dict[str, dict[str, Any]] = {}
    remap: dict[str, str] = {}
    for op in ops:
        key = op["title"]
        if key not in merged:
            merged[key] = {**op, "columns": list(op["columns"])}
            continue
        dest = merged[key]
        remap[op["id"]] = dest["id"]
        dest["cells"] = int(dest["cells"]) + int(op["cells"])
        for c in op["columns"]:
            if c not in dest["columns"]:
                dest["columns"].append(c)
        dest["confidence"] = min(float(dest["confidence"]), float(op["confidence"]))
        dest["bucket"] = bucket(float(dest["confidence"]), accept_min)
        dest["enabled"] = dest["bucket"] != "ignore"
    if remap:
        for d in diffs:
            d["op_id"] = remap.get(d["op_id"], d["op_id"])
            parent = next((o for o in merged.values() if o["id"] == d["op_id"]), None)
            if parent:
                d["bucket"] = parent["bucket"]
                d["confidence"] = parent["confidence"]
    ops = [o for o in merged.values() if o["cells"] > 0]
    ops.sort(key=lambda o: (-{"auto": 2, "review": 1, "ignore": 0}[o["bucket"]], -int(o["cells"])))

    auto = sum(1 for d in diffs if d["bucket"] == "auto")
    review = sum(1 for d in diffs if d["bucket"] == "review")
    ignore = sum(1 for d in diffs if d["bucket"] == "ignore")
    auto_cells = sum(int(o["cells"]) for o in ops if o["bucket"] == "auto")
    review_cells = sum(int(o["cells"]) for o in ops if o["bucket"] == "review")
    ignore_cells = sum(int(o["cells"]) for o in ops if o["bucket"] == "ignore")

    highlights = []
    for d in diffs:
        if d.get("row") is None or not d.get("column"):
            continue
        reason = str(d.get("reason") or "").lower()
        if "invalid" in reason or "without '@'" in reason or "not http" in reason:
            stage = "error"
        else:
            stage = "review"
        highlights.append({"row": int(d["row"]), "column": d["column"], "stage": stage})
        if len(highlights) >= 2500:
            break

    extra_note = (extra or "").strip()
    return {
        "phase": "preview",
        "profiles": profiles,
        "plan": ops,
        "diffs": diffs[:DIFF_CAP],
        "findings": findings,
        "buckets": {
            "auto": auto_cells,
            "review": review_cells,
            "ignore": ignore_cells,
            "auto_samples": auto,
            "review_samples": review,
            "ignore_samples": ignore,
        },
        "highlights": highlights,
        "scope": {"columns": cols, "row_count": scoped.height, "extra": extra_note},
        "llm": False,
        "wrote": False,
    }


def refine_plan_with_llm(plan: list[dict[str, Any]], text: str) -> list[dict[str, Any]]:
    """Apply optional LLM title/confidence tweaks. Never adds unknown ops."""
    if not text or not plan:
        return plan
    from sidecar.ai.providers import parse_proposals

    items = parse_proposals(text)
    if not items:
        # try object list with title
        return plan
    by_col = {}
    for it in items:
        title = str(it.get("rule") or it.get("reason") or "").strip()
        col = str(it.get("column") or "")
        if col:
            by_col[col] = it
    if not by_col:
        return plan
    out = []
    for op in plan:
        hit = None
        for c in op.get("columns") or []:
            if c in by_col:
                hit = by_col[c]
                break
        if hit and hit.get("reason"):
            op = {**op, "description": str(hit.get("reason") or op.get("description"))}
        out.append(op)
    return out
