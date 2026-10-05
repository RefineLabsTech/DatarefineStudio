"""Stage 1 — Universal deterministic cleaning rules."""

from __future__ import annotations

import re
import unicodedata
from typing import Any

import polars as pl

HIDDEN_RE = re.compile(r"[\u200b-\u200f\u202a-\u202e\ufeff\u00a0]")
EMPTY_TOKENS = {"", "na", "n/a", "null", "none", "-", "--", "nan", "#n/a", "#null"}


def classify_rule(rule: dict[str, Any]) -> str:
    """named | python | javascript — named stays on the fast Polars path."""
    params = rule.get("parameters") if isinstance(rule.get("parameters"), dict) else {}
    lang = str(params.get("language") or rule.get("language") or "").lower()
    kind = str(rule.get("kind") or "").lower()
    body = str(rule.get("body") or "")
    if lang in {"python", "py"} or kind == "python":
        return "python"
    if lang in {"javascript", "js"} or kind in {"javascript", "js"}:
        return "javascript"
    if kind == "regex":
        return "named"
    stripped = body.strip()
    if not stripped:
        return "named"
    if re.fullmatch(r"[A-Za-z0-9_\-]+", stripped):
        return "named"
    if "return row" in stripped or "typeof " in stripped or "Object.keys" in stripped:
        return "javascript"
    if "df" in stripped or "pl." in stripped or "import " in stripped:
        return "python"
    return "named"


def apply_rule_list(
    df: pl.DataFrame, rules: list[dict[str, Any]], schema: dict[str, dict] | None = None
) -> tuple[pl.DataFrame, int]:
    """Universal stage: named builtins, then pasted Python / JavaScript in order."""
    from sidecar.pipeline.javascript import run_javascript
    from sidecar.pipeline.python_exec import run_python

    changed = 0
    named: list[dict[str, Any]] = []

    def flush_named() -> None:
        nonlocal df, named, changed
        if not named:
            return
        df, n = apply_rules(df, named, schema=schema)
        changed += n
        named = []

    for rule in rules or []:
        engine = classify_rule(rule)
        body = str(rule.get("body") or "")
        if engine == "python":
            flush_named()
            if body.strip():
                cols = rule.get("columns")
                cols = cols if isinstance(cols, list) else None
                df, _meta = run_python(df, body, columns=cols)
        elif engine == "javascript":
            flush_named()
            if body.strip():
                df, _meta = run_javascript(df, body)
        else:
            named.append(rule)
    flush_named()
    return df, changed


def apply_rules(
    df: pl.DataFrame, rules: list[dict[str, Any]], schema: dict[str, dict] | None = None
) -> tuple[pl.DataFrame, int]:
    """Apply named universal rules. Returns (df, approximate cells touched)."""
    before = df
    for rule in rules:
        kind = (rule.get("kind") or "").lower()
        name = (rule.get("name") or rule.get("id") or rule.get("body") or "").lower()
        explicit = bool(rule.get("columns"))
        cols = rule.get("columns") or df.columns
        cols = [c for c in cols if c in df.columns]
        if name in {"auto_clean", "universal_auto", "auto"}:
            cols = [c for c in cols if _is_text(df.schema[c])]
        if not cols:
            continue
        if kind == "regex" or name in {"regex_replace", "regex"}:
            pattern = rule.get("pattern") or (rule.get("parameters") or {}).get("pattern") or rule.get("body") or ""
            repl = rule.get("replacement") or (rule.get("parameters") or {}).get("replacement") or ""
            if pattern:
                df = df.with_columns(
                    [pl.col(c).cast(pl.Utf8, strict=False).str.replace_all(pattern, str(repl), literal=False) for c in cols]
                )
            continue
        if name in {"auto_clean", "universal_auto", "auto"}:
            df = df.with_columns(
                [pl.col(c).cast(pl.Utf8, strict=False).map_elements(_auto_cell, return_dtype=pl.Utf8) for c in cols]
            )
        elif name in {"trim", "strip"}:
            df = df.with_columns([pl.col(c).cast(pl.Utf8, strict=False).str.strip_chars() for c in cols])
        elif name in {"hidden_unicode", "hidden unicode"}:
            df = df.with_columns(
                [pl.col(c).cast(pl.Utf8, strict=False).map_elements(_strip_hidden, return_dtype=pl.Utf8) for c in cols]
            )
        elif name in {"normalize_unicode", "nfc", "unicode_nfc"}:
            df = df.with_columns(
                [pl.col(c).cast(pl.Utf8, strict=False).map_elements(_nfc, return_dtype=pl.Utf8) for c in cols]
            )
        elif name in {"normalize_case", "lower"}:
            df = df.with_columns([pl.col(c).cast(pl.Utf8, strict=False).str.to_lowercase() for c in cols])
        elif name in {"upper"}:
            df = df.with_columns([pl.col(c).cast(pl.Utf8, strict=False).str.to_uppercase() for c in cols])
        elif name in {"remove_spaces", "collapse_spaces"}:
            df = df.with_columns(
                [pl.col(c).cast(pl.Utf8, strict=False).str.replace_all(r"[ \t]+", " ", literal=False) for c in cols]
            )
        elif name in {"line_endings", "normalize_line_endings"}:
            df = df.with_columns(
                [
                    pl.col(c)
                    .cast(pl.Utf8, strict=False)
                    .str.replace_all("\r\n", "\n", literal=True)
                    .str.replace_all("\r", "\n", literal=True)
                    for c in cols
                ]
            )
        elif name in {"blank_lines", "duplicate_blank_lines"}:
            df = df.with_columns(
                [pl.col(c).cast(pl.Utf8, strict=False).str.replace_all(r"\n{3,}", "\n\n", literal=False) for c in cols]
            )
        elif name in {"empty_to_null", "null_empty"}:
            df = df.with_columns(
                [pl.col(c).cast(pl.Utf8, strict=False).map_elements(_empty_null, return_dtype=pl.Utf8) for c in cols]
            )
        elif name in {"email_cleanup", "email"}:
            df = df.with_columns(
                [pl.col(c).cast(pl.Utf8, strict=False).str.strip_chars().str.to_lowercase() for c in cols]
            )
        elif name in {"phone_normalize", "phone", "phone_e164"}:
            df = _industrial(df, schema, ("phone",), cols if explicit else None)
        elif name in {"date_normalize", "date", "date_iso"}:
            df = _industrial(df, schema, ("date",), cols if explicit else None)
        elif name in {"currency_normalize", "currency", "amount", "amount_iso"}:
            df = _industrial(df, schema, ("amount", "currency"), cols if explicit else None)
        elif name in {"country_mapping", "country", "country_iso"}:
            df = _industrial(df, schema, ("country",), cols if explicit else None)
        elif name in {"standardize", "industrial", "industrial_standardize"}:
            df = _industrial(
                df, schema, ("phone", "date", "amount", "currency", "country"), cols if explicit else None
            )
    changed = _approx_changed(before, df)
    return df, changed


def _industrial(
    df: pl.DataFrame,
    schema: dict[str, dict] | None,
    kinds: tuple[str, ...],
    columns: list[str] | None,
) -> pl.DataFrame:
    try:
        from sidecar.refine.engine import RefineEngine

        eng = RefineEngine()
        out, _summary = eng.clean_frame(df, schema, kinds=kinds, columns=columns)
        return out
    except Exception:
        return df


def _is_text(dt: Any) -> bool:
    s = str(dt)
    return "Utf8" in s or "String" in s or "Categorical" in s or s in {"Null", "Object", "Unknown"}


def _auto_cell(v: Any) -> Any:
    if v is None:
        return None
    s = str(v)
    s = HIDDEN_RE.sub("", s)
    s = unicodedata.normalize("NFC", s)
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    s = re.sub(r"\n{3,}", "\n\n", s)
    s = re.sub(r"[ \t]+", " ", s)
    s = s.strip()
    if s.lower() in EMPTY_TOKENS:
        return None
    return s


def _strip_hidden(v: Any) -> Any:
    if v is None:
        return None
    s = HIDDEN_RE.sub("", str(v))
    return unicodedata.normalize("NFC", s)


def _nfc(v: Any) -> Any:
    if v is None:
        return None
    return unicodedata.normalize("NFC", str(v))


def _empty_null(v: Any) -> Any:
    if v is None:
        return None
    s = str(v).strip()
    if s.lower() in EMPTY_TOKENS:
        return None
    return s


def _phone(v: Any) -> Any:
    if v is None:
        return None
    digits = re.sub(r"\D+", "", str(v))
    return digits or None


def _currency(v: Any) -> Any:
    if v is None:
        return None
    s = re.sub(r"[^\d.\-]", "", str(v))
    return s or None


COUNTRY_MAP = {
    "usa": "US",
    "united states": "US",
    "uk": "GB",
    "england": "GB",
    "bangladesh": "BD",
    "bd": "BD",
    "india": "IN",
    "canada": "CA",
    "germany": "DE",
    "france": "FR",
}


def _country(v: Any) -> Any:
    if v is None:
        return None
    key = str(v).strip().lower()
    return COUNTRY_MAP.get(key, str(v).strip())


def _approx_changed(a: pl.DataFrame, b: pl.DataFrame) -> int:
    if a.shape != b.shape or a.columns != b.columns:
        return a.height * max(1, len(a.columns))
    n = 0
    for c in a.columns:
        try:
            n += int((a[c].cast(pl.Utf8, strict=False) != b[c].cast(pl.Utf8, strict=False)).sum())
        except Exception:
            pass
    return n
