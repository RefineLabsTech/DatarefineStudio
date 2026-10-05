"""Worldwide amount cleaning → decimal + ISO 4217 currency when present."""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Any

from sidecar.refine.models import CleanResult

try:
    from babel.numbers import parse_decimal

    HAS_BABEL = True
except ImportError:
    parse_decimal = None  # type: ignore
    HAS_BABEL = False

SYMBOLS = [
    ("R$", "BRL"),
    ("CA$", "CAD"),
    ("A$", "AUD"),
    ("US$", "USD"),
    ("HK$", "HKD"),
    ("NZ$", "NZD"),
    ("S$", "SGD"),
    ("C$", "CAD"),
    ("Rs.", "INR"),
    ("Rs", "INR"),
    ("TK.", "BDT"),
    ("Tk", "BDT"),
    ("$", "USD"),
    ("€", "EUR"),
    ("£", "GBP"),
    ("¥", "JPY"),
    ("₹", "INR"),
    ("৳", "BDT"),
    ("₩", "KRW"),
    ("₽", "RUB"),
    ("₺", "TRY"),
    ("₦", "NGN"),
    ("₱", "PHP"),
    ("฿", "THB"),
    ("₫", "VND"),
]

CODE_RE = re.compile(r"\b([A-Z]{3})\b")
LOCALES = ("en_US", "en_GB", "de_DE", "fr_FR", "hi_IN", "en_IN", "nl_NL", "es_ES", "pt_BR")


class AmountCleaner:
    def clean(self, value: Any) -> CleanResult:
        if value is None:
            return CleanResult(original="", cleaned=None, data_type="amount", valid=False, confidence=0)
        original = str(value).strip()
        if not original:
            return CleanResult(original=original, cleaned=None, data_type="amount", valid=False, confidence=0)

        raw = original
        currency = None
        for sym, code in SYMBOLS:
            if sym in raw:
                currency = code
                raw = raw.replace(sym, "")
                break
        m = CODE_RE.search(raw)
        if m:
            currency = currency or m.group(1)
            raw = CODE_RE.sub("", raw)
        raw = raw.strip()

        negative = False
        if raw.startswith("(") and raw.endswith(")"):
            negative = True
            raw = raw[1:-1].strip()
        if raw.startswith("-"):
            negative = True
            raw = raw[1:].strip()
        if raw.endswith("-"):
            negative = True
            raw = raw[:-1].strip()

        parsed = self._parse(raw)
        if parsed is None:
            return CleanResult(
                original=original,
                cleaned=None,
                data_type="amount",
                valid=False,
                confidence=0,
                message="Cannot parse amount",
            )
        if negative:
            parsed = -parsed
        cleaned = f"{parsed:.2f}"
        return CleanResult(
            original=original,
            cleaned=cleaned,
            data_type="amount",
            valid=True,
            confidence=99,
            currency=currency,
            rule="ISO4217_DECIMAL",
        )

    def currency_code(self, value: Any) -> CleanResult:
        """Normalize a currency-code column to ISO 4217."""
        if value is None:
            return CleanResult(original="", cleaned=None, data_type="currency", valid=False, confidence=0)
        raw = str(value).strip()
        if not raw:
            return CleanResult(original=raw, cleaned=None, data_type="currency", valid=False, confidence=0)
        for sym, code in SYMBOLS:
            if raw == sym or raw.upper() == code:
                return CleanResult(
                    original=raw, cleaned=code, data_type="currency", valid=True, confidence=100, currency=code, rule="ISO4217"
                )
        m = CODE_RE.search(raw.upper())
        if m:
            return CleanResult(
                original=raw, cleaned=m.group(1), data_type="currency", valid=True, confidence=95, currency=m.group(1), rule="ISO4217"
            )
        amt = self.clean(raw)
        if amt.currency:
            return CleanResult(
                original=raw,
                cleaned=amt.currency,
                data_type="currency",
                valid=True,
                confidence=90,
                currency=amt.currency,
                rule="ISO4217",
            )
        return CleanResult(original=raw, cleaned=None, data_type="currency", valid=False, confidence=0, message="Unknown currency")

    def _parse(self, raw: str) -> Decimal | None:
        s = raw.strip()
        if not s:
            return None
        if HAS_BABEL:
            for loc in LOCALES:
                try:
                    return Decimal(str(parse_decimal(s, locale=loc)))
                except Exception:
                    continue
        t = s.replace(" ", "").replace("\u00a0", "")
        last_c, last_d = t.rfind(","), t.rfind(".")
        if last_c > last_d and last_d >= 0:
            t = t.replace(".", "").replace(",", ".")
        elif last_d > last_c:
            t = t.replace(",", "")
        elif "," in t:
            parts = t.split(",")
            if len(parts) > 2 and all(p.lstrip("-").isdigit() for p in parts):
                t = "".join(parts)
            elif len(parts) == 2 and len(parts[1]) == 3 and parts[0].lstrip("-").isdigit():
                t = parts[0] + parts[1]
            else:
                t = t.replace(",", ".")
        t = re.sub(r"[^\d.\-]", "", t)
        if t.count(".") > 1:
            parts = t.split(".")
            t = "".join(parts[:-1]) + "." + parts[-1]
        try:
            return Decimal(t)
        except (InvalidOperation, ValueError):
            return None
