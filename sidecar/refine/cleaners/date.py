"""Worldwide date cleaning → ISO 8601 (YYYY-MM-DD)."""

from __future__ import annotations

import re
from typing import Any

from sidecar.refine.models import CleanResult

try:
    import dateparser

    HAS_DP = True
except ImportError:
    dateparser = None  # type: ignore
    HAS_DP = False

try:
    from dateutil import parser as du_parser

    HAS_DU = True
except ImportError:
    du_parser = None  # type: ignore
    HAS_DU = False

ISO_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?")
DMY_RE = re.compile(r"^(\d{1,2})[./\-](\d{1,2})[./\-](\d{2,4})$")
YMD_RE = re.compile(r"^(\d{4})[./](\d{1,2})[./](\d{1,2})$")
MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9, "oct": 10,
    "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}
MON = r"jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec"
DMON_RE = re.compile(rf"^(\d{{1,2}})\s+({MON})[a-z]*\.?,?\s+(\d{{2,4}})$", re.I)
MOND_RE = re.compile(rf"^({MON})[a-z]*\.?\s+(\d{{1,2}}),?\s+(\d{{2,4}})$", re.I)


def _year(y: int) -> int:
    if y < 100:
        return 2000 + y if y < 70 else 1900 + y
    return y


def _iso(y: int, m: int, d: int) -> str | None:
    if not (1 <= m <= 12 and 1 <= d <= 31 and 1900 <= y <= 2100):
        return None
    return f"{y:04d}-{m:02d}-{d:02d}"


class DateCleaner:
    def __init__(self, date_order: str = "DMY") -> None:
        self.date_order = (date_order or "DMY").upper()

    def clean(self, value: Any) -> CleanResult:
        if value is None:
            return CleanResult(original="", cleaned=None, data_type="date", valid=False, confidence=0)
        raw = str(value).strip()
        if not raw:
            return CleanResult(original=raw, cleaned=None, data_type="date", valid=False, confidence=0)

        hit = self._fast(raw)
        if hit:
            return CleanResult(
                original=raw, cleaned=hit, data_type="date", valid=True, confidence=99, rule="ISO8601_STANDARD"
            )

        dt = None
        if HAS_DP:
            settings = {
                "DATE_ORDER": self.date_order,
                "PREFER_DAY_OF_MONTH": "first",
                "RETURN_AS_TIMEZONE_AWARE": False,
                "STRICT_PARSING": True,
            }
            try:
                dt = dateparser.parse(raw, settings=settings)
            except Exception:
                dt = None
            if dt is None:
                settings["STRICT_PARSING"] = False
                try:
                    dt = dateparser.parse(raw, settings=settings)
                except Exception:
                    dt = None
        if dt is None and HAS_DU:
            try:
                dt = du_parser.parse(raw, dayfirst=self.date_order.startswith("D"), yearfirst=self.date_order.startswith("Y"))
            except Exception:
                dt = None

        if dt is None:
            return CleanResult(
                original=raw, cleaned=None, data_type="date", valid=False, confidence=0, message="Unrecognized date"
            )

        if dt.hour or dt.minute or dt.second:
            cleaned = dt.strftime("%Y-%m-%dT%H:%M:%S")
        else:
            cleaned = dt.strftime("%Y-%m-%d")
        return CleanResult(
            original=raw, cleaned=cleaned, data_type="date", valid=True, confidence=99, rule="ISO8601_STANDARD"
        )

    def _fast(self, raw: str) -> str | None:
        m = ISO_RE.match(raw)
        if m:
            y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
            iso = _iso(y, mo, d)
            if iso and m.group(4):
                return f"{iso}T{m.group(4)}:{m.group(5)}:{m.group(6) or '00'}"
            return iso
        m = YMD_RE.match(raw)
        if m:
            return _iso(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        m = DMY_RE.match(raw)
        if m:
            a, b, y = int(m.group(1)), int(m.group(2)), _year(int(m.group(3)))
            if self.date_order.startswith("M"):
                mo, d = a, b
            else:
                d, mo = a, b
            if mo > 12 and d <= 12:
                mo, d = d, mo
            return _iso(y, mo, d)
        m = DMON_RE.match(raw)
        if m:
            return _iso(_year(int(m.group(3))), MONTHS[m.group(2)[:3].lower()], int(m.group(1)))
        m = MOND_RE.match(raw)
        if m:
            return _iso(_year(int(m.group(3))), MONTHS[m.group(1)[:3].lower()], int(m.group(2)))
        jp = re.match(r"^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日", raw)
        if jp:
            return _iso(int(jp.group(1)), int(jp.group(2)), int(jp.group(3)))
        return None
