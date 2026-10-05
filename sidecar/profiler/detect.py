"""Hybrid deterministic schema detection: profile + patterns + headers + dictionaries.

Score = 0.45·V + 0.30·H + 0.15·P + 0.10·S
Never guess below 0.80. Values outrank headers.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from typing import Any

import polars as pl

from sidecar.schemas.dictionaries import (
    BOOLEAN_VALUES,
    CITY_VALUES,
    COUNTRY_CODES,
    COUNTRY_VALUES,
    CURRENCY_CODES,
    CURRENCY_WORDS,
    GENDER_VALUES,
    HEADER_ALIASES,
    STATUS_VALUES,
    norm_header,
)

SAMPLE_CAP = 1000
MIN_CONF = 0.80

EMAIL_RE = re.compile(r"^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$", re.I)
URL_RE = re.compile(r"^(https?://|www\.)\S+$", re.I)
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I
)
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)?$")
YMD_COMPACT_RE = re.compile(r"^(?:19|20)\d{2}[./\-]?\d{2}[./\-]?\d{2}$")
DMY_RE = re.compile(r"^\d{1,2}[./\-]\d{1,2}[./\-]\d{2,4}$")
MONTH_DATE_RE = re.compile(
    r"^(?:\d{1,2}\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{2,4}$"
    r"|^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{2,4}$"
    r"|^\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+\d{2,4}$",
    re.I,
)
YEAR_RE = re.compile(r"^(?:19|20)\d{2}$")
PERCENT_RE = re.compile(r"^-?\d+(?:\.\d+)?\s*%$")
CURRENCY_RE = re.compile(
    r"^(?:[$€£¥₹৳₩]|rs\.?|usd|eur|gbp|bdt|inr|cad|aud)\s*-?\d{1,3}(?:,\d{3})*(?:\.\d{1,4})?$"
    r"|^-?\d{1,3}(?:,\d{3})*(?:\.\d{1,4})?\s*(?:[$€£¥₹৳]|usd|eur|gbp|bdt|inr)$",
    re.I,
)
INT_RE = re.compile(r"^-?\d{1,18}$")
FLOAT_RE = re.compile(r"^-?\d+\.\d+$")
JSON_RE = re.compile(r"^[\{\[].*[\}\]]$")


def _sample_strings(s: pl.Series, n: int = SAMPLE_CAP) -> list[str]:
    try:
        vals = s.drop_nulls().cast(pl.Utf8, strict=False).head(n).to_list()
    except Exception:
        return []
    out = []
    for v in vals:
        if v is None:
            continue
        t = str(v).strip()
        if t:
            out.append(t)
    return out


def _ratio(samples: list[str], pred) -> float:
    if not samples:
        return 0.0
    return sum(1 for x in samples if pred(x)) / len(samples)


def _entropy(text: str) -> float:
    if not text:
        return 0.0
    n = len(text)
    c = Counter(text)
    return -sum((v / n) * math.log2(v / n) for v in c.values())


def _is_date(x: str) -> bool:
    s = x.strip()
    if ISO_DATE_RE.match(s):
        return True
    if MONTH_DATE_RE.match(s):
        return True
    if DMY_RE.match(s):
        parts = re.split(r"[./\-]", s)
        try:
            nums = [int(p) for p in parts if p]
        except ValueError:
            return False
        if len(nums) != 3:
            return False
        a, b, c = nums
        year = c if c > 31 else (a if a > 31 else 0)
        if year and year < 100:
            year += 2000 if year < 70 else 1900
        if year and not (1900 <= year <= 2100):
            return False
        month_candidates = [n for n in (a, b) if 1 <= n <= 12]
        return bool(month_candidates)
    if YMD_COMPACT_RE.match(re.sub(r"[./\-]", "", s)) and not re.search(r"[A-Za-z]", s):
        raw = re.sub(r"\D", "", s)
        if len(raw) == 8:
            y, m, d = int(raw[:4]), int(raw[4:6]), int(raw[6:8])
            return 1900 <= y <= 2100 and 1 <= m <= 12 and 1 <= d <= 31
    return False


def _is_datetime(x: str) -> bool:
    s = x.strip()
    if ISO_DATE_RE.match(s) and ("T" in s or " " in s and ":" in s):
        return True
    return bool(re.match(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}", s))


def _is_phone(x: str) -> bool:
    if _is_date(x) or _is_datetime(x):
        return False
    if EMAIL_RE.match(x) or URL_RE.match(x):
        return False
    letters = re.sub(r"[^A-Za-z]", "", x)
    if letters and letters.lower() not in {"ext", "x", "tel"}:
        return False
    digits = re.sub(r"\D", "", x)
    if len(digits) < 7 or len(digits) > 15:
        return False
    # Compact yyyymmdd (8 digits starting 19/20) is a date, not a phone.
    if len(digits) == 8 and digits[:2] in {"19", "20"}:
        try:
            m, d = int(digits[4:6]), int(digits[6:8])
            if 1 <= m <= 12 and 1 <= d <= 31:
                return False
        except ValueError:
            pass
    return True


def _is_country(x: str) -> bool:
    k = x.strip().lower()
    if k in COUNTRY_VALUES:
        return True
    if re.fullmatch(r"[A-Za-z]{2}", k) and k in COUNTRY_CODES:
        return True
    return False


def _is_city(x: str) -> bool:
    return x.strip().lower() in CITY_VALUES


def _is_currency_val(x: str) -> bool:
    s = x.strip()
    if CURRENCY_RE.match(s):
        return True
    low = s.lower()
    if low in CURRENCY_CODES:
        return True
    if low in CURRENCY_WORDS:
        return True
    return False


def _is_amount(x: str) -> bool:
    s = x.strip()
    if CURRENCY_RE.match(s):
        return True
    if re.match(r"^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$", s):
        return True
    if re.match(r"^-?\d+\.\d{2}$", s):
        return True
    return False


def fingerprint(samples: list[str], null_ratio: float, unique_ratio: float) -> dict[str, float]:
    if not samples:
        return {
            "null_ratio": null_ratio,
            "unique_ratio": unique_ratio,
            "avg_length": 0,
            "min_length": 0,
            "max_length": 0,
            "numeric_ratio": 0,
            "alphabet_ratio": 0,
            "at_ratio": 0,
            "digit_ratio": 0,
            "entropy": 0,
        }
    lens = [len(x) for x in samples]
    n = len(samples)
    def avg(pred) -> float:
        return sum(1 for x in samples if pred(x)) / n

    joined = "".join(samples[:200])
    return {
        "null_ratio": null_ratio,
        "unique_ratio": unique_ratio,
        "avg_length": sum(lens) / n,
        "min_length": float(min(lens)),
        "max_length": float(max(lens)),
        "numeric_ratio": avg(lambda x: bool(re.fullmatch(r"[-+]?\d+(?:\.\d+)?", x.replace(",", "")))),
        "alphabet_ratio": avg(lambda x: bool(re.search(r"[A-Za-z]", x))),
        "at_ratio": avg(lambda x: "@" in x),
        "digit_ratio": avg(lambda x: any(ch.isdigit() for ch in x)),
        "entropy": sum(_entropy(x) for x in samples[:80]) / min(80, n),
    }


def _header_hit(col: str, kind: str) -> float:
    n = norm_header(col)
    mapped = HEADER_ALIASES.get(n)
    if mapped == kind:
        return 1.0
    # soft contains
    if kind == "Date" and any(k in n for k in ("date", "signup", "dob", "birth", "created", "joined")):
        return 0.85
    if kind == "Phone" and any(k in n for k in ("phone", "mobile", "tel", "cell", "whatsapp", "fax")):
        return 0.9
    if kind == "Email" and "mail" in n:
        return 0.9
    if kind == "Country" and any(k in n for k in ("country", "nation")):
        return 0.9
    if kind == "City" and any(k in n for k in ("city", "town", "district")):
        return 0.85
    if kind == "Name" and (n.endswith("name") or n == "name"):
        return 0.85
    if kind == "Amount" and any(k in n for k in ("amount", "price", "total", "cost", "salary", "fee")):
        return 0.85
    if kind == "Currency" and "currenc" in n:
        return 0.9
    if kind == "URL" and any(k in n for k in ("url", "website", "web", "link")):
        return 0.85
    if kind == "Category" and any(k in n for k in ("status", "state", "type", "category", "dept")):
        return 0.8
    return 0.0


def _stat_score(kind: str, fp: dict[str, float]) -> float:
    avg_len = fp["avg_length"]
    uniq = fp["unique_ratio"]
    if kind == "Email":
        return min(1.0, fp["at_ratio"] * 1.1)
    if kind == "Phone":
        return 0.7 if 7 <= avg_len <= 18 else 0.3
    if kind == "Date":
        return 0.7 if 6 <= avg_len <= 18 else 0.35
    if kind == "UUID":
        return 0.9 if 30 <= avg_len <= 40 and uniq > 0.9 else 0.2
    if kind == "ID":
        return 0.7 if uniq > 0.9 else 0.25
    if kind == "Category":
        return 0.8 if uniq < 0.15 else (0.5 if uniq < 0.35 else 0.15)
    if kind == "Country":
        return 0.6 if avg_len <= 24 else 0.2
    if kind == "Name":
        return 0.6 if fp["alphabet_ratio"] > 0.8 else 0.2
    if kind in {"Integer", "Decimal", "Amount", "Currency"}:
        return min(1.0, fp["numeric_ratio"] + 0.2)
    if kind == "Boolean":
        return 0.8 if uniq <= 0.1 else 0.3
    return 0.4


def detect_column(name: str, s: pl.Series) -> dict[str, Any]:
    """Return inferred type + fingerprint + scores. Never guesses below MIN_CONF."""
    n = s.len() or 1
    nulls = int(s.null_count())
    try:
        uniq = int(s.n_unique())
    except Exception:
        uniq = 0
    samples = _sample_strings(s, SAMPLE_CAP)
    null_ratio = nulls / n
    unique_ratio = uniq / n if n else 0
    fp = fingerprint(samples, null_ratio, unique_ratio)

    dtype = s.dtype
    if dtype == pl.Boolean:
        return {"inferred": "Boolean", "confidence": 1.0, "fingerprint": fp}
    if dtype in (pl.Date,):
        return {"inferred": "Date", "confidence": 1.0, "fingerprint": fp}
    if str(dtype).startswith("Datetime"):
        return {"inferred": "DateTime", "confidence": 1.0, "fingerprint": fp}
    if dtype in (pl.Time,):
        return {"inferred": "Time", "confidence": 1.0, "fingerprint": fp}

    if not samples:
        h = HEADER_ALIASES.get(norm_header(name))
        if h:
            return {"inferred": h, "confidence": 0.82, "fingerprint": fp, "via": "header"}
        return {"inferred": "Text", "confidence": 0.0, "fingerprint": fp}

    value_preds: list[tuple[str, float]] = [
        ("Email", _ratio(samples, lambda x: bool(EMAIL_RE.match(x)))),
        ("URL", _ratio(samples, lambda x: bool(URL_RE.match(x)))),
        ("UUID", _ratio(samples, lambda x: bool(UUID_RE.match(x)))),
        ("DateTime", _ratio(samples, _is_datetime)),
        ("Date", _ratio(samples, _is_date)),
        ("Phone", _ratio(samples, _is_phone)),
        ("Country", _ratio(samples, _is_country)),
        ("City", _ratio(samples, _is_city)),
        ("Currency", _ratio(samples, _is_currency_val)),
        ("Amount", _ratio(samples, _is_amount)),
        ("Percent", _ratio(samples, lambda x: bool(PERCENT_RE.match(x)))),
        ("Gender", _ratio(samples, lambda x: x.strip().lower() in GENDER_VALUES)),
        ("Boolean", _ratio(samples, lambda x: x.strip().lower() in BOOLEAN_VALUES)),
        ("Year", _ratio(samples, lambda x: bool(YEAR_RE.match(x)))),
        ("JSON", _ratio(samples, lambda x: bool(JSON_RE.match(x)))),
        ("Integer", _ratio(samples, lambda x: bool(INT_RE.match(x.replace(",", ""))))),
        ("Decimal", _ratio(samples, lambda x: bool(FLOAT_RE.match(x.replace(",", ""))))),
    ]

    scores: dict[str, float] = {}
    detail: dict[str, dict[str, float]] = {}
    for kind, v in value_preds:
        h = _header_hit(name, kind)
        p = v  # pattern match rate is the same signal as V for regex types
        stat = _stat_score(kind, fp)
        combined = 0.45 * v + 0.30 * h + 0.15 * p + 0.10 * stat
        score = combined
        if v >= MIN_CONF:
            score = max(score, v)
        scores[kind] = score
        detail[kind] = {"V": round(v, 4), "H": round(h, 4), "P": round(p, 4), "S": round(stat, 4), "score": round(score, 4)}

    # Category: low unique ratio, not already a closed vocab
    cat_h = _header_hit(name, "Category")
    if unique_ratio <= 0.15 and uniq <= 40 and len(samples) >= 8:
        cat_v = 0.75 if unique_ratio <= 0.08 else 0.55
        scores["Category"] = 0.45 * cat_v + 0.30 * cat_h + 0.15 * cat_v + 0.10 * _stat_score("Category", fp)
        if cat_h >= 0.8:
            scores["Category"] = max(scores["Category"], 0.82)
    status_r = _ratio(samples, lambda x: x.strip().lower() in STATUS_VALUES)
    if status_r >= 0.6:
        scores["Category"] = max(scores.get("Category", 0), status_r)

    # Name: alphabetic tokens, header, not country/city/email
    name_h = _header_hit(name, "Name")
    name_v = _ratio(samples, lambda x: bool(re.fullmatch(r"[A-Za-z][A-Za-z .'\-]{1,60}", x)))
    if name_h or name_v >= 0.7:
        scores["Name"] = 0.45 * name_v + 0.30 * name_h + 0.15 * name_v + 0.10 * _stat_score("Name", fp)

    # ID: high uniqueness, short-ish codes, header
    id_h = _header_hit(name, "ID")
    if unique_ratio >= 0.9 and 3 <= fp["avg_length"] <= 24 and fp["at_ratio"] < 0.05:
        id_v = 0.7
        scores["ID"] = 0.45 * id_v + 0.30 * id_h + 0.15 * id_v + 0.10 * _stat_score("ID", fp)
        if id_h >= 0.8:
            scores["ID"] = max(scores["ID"], 0.84)

    if dtype in (pl.Int8, pl.Int16, pl.Int32, pl.Int64, pl.UInt8, pl.UInt16, pl.UInt32, pl.UInt64):
        scores["Integer"] = max(scores.get("Integer", 0), 0.9)
    if dtype in (pl.Float32, pl.Float64) or "Decimal" in str(dtype):
        scores["Decimal"] = max(scores.get("Decimal", 0), 0.88)

    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    best_kind, best = ranked[0] if ranked else ("Text", 0.0)
    if best < MIN_CONF:
        h_only = HEADER_ALIASES.get(norm_header(name))
        if h_only and scores.get(h_only, 0) >= 0.5:
            # header-only is not enough unless values don't contradict
            return {
                "inferred": "Text",
                "confidence": round(best, 4),
                "fingerprint": fp,
                "scores": {k: round(v, 4) for k, v in ranked[:8]},
                "detail": detail,
            }
        return {
            "inferred": "Text",
            "confidence": round(best, 4),
            "fingerprint": fp,
            "scores": {k: round(v, 4) for k, v in ranked[:8]},
            "detail": detail,
        }

    # Prefer Date over Phone when both high (dates used to match phone regex).
    if best_kind == "Phone" and scores.get("Date", 0) >= MIN_CONF:
        best_kind, best = "Date", scores["Date"]
    if best_kind == "Integer" and scores.get("Year", 0) >= MIN_CONF and fp["avg_length"] <= 4.5:
        best_kind, best = "Year", scores["Year"]
    if best_kind == "Amount" and scores.get("Currency", 0) >= best:
        best_kind, best = "Currency", scores["Currency"]
    if best_kind == "Decimal" and scores.get("Amount", 0) >= MIN_CONF:
        best_kind, best = "Amount", scores["Amount"]

    return {
        "inferred": best_kind,
        "confidence": round(best, 4),
        "fingerprint": fp,
        "scores": {k: round(v, 4) for k, v in ranked[:8]},
        "detail": detail,
    }


def infer_semantic(s: pl.Series) -> str:
    try:
        return str(detect_column(s.name or "", s).get("inferred") or "Text")
    except Exception:
        return "Text"
