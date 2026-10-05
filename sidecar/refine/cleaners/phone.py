"""Worldwide phone cleaning → E.164. Google numbering plan when phonenumbers is installed."""

from __future__ import annotations

import re
from typing import Any

from sidecar.refine.models import CleanResult

try:
    import phonenumbers
    from phonenumbers import NumberParseException, PhoneNumberFormat

    HAS_PN = True
except ImportError:
    phonenumbers = None  # type: ignore
    NumberParseException = Exception  # type: ignore
    PhoneNumberFormat = None  # type: ignore
    HAS_PN = False

OCR_MAP = str.maketrans({"O": "0", "o": "0", "I": "1", "l": "1", "S": "5", "B": "8"})
DIGIT_RE = re.compile(r"[^\d+]")


class PhoneCleaner:
    def __init__(self, default_region: str = "US") -> None:
        self.default_region = (default_region or "US").upper()

    def clean(self, value: Any) -> CleanResult:
        if value is None:
            return CleanResult(original="", cleaned=None, data_type="phone", valid=False, confidence=0)
        raw = str(value).strip()
        if not raw:
            return CleanResult(original=raw, cleaned=None, data_type="phone", valid=False, confidence=0)

        normalized = DIGIT_RE.sub("", raw.translate(OCR_MAP))
        if normalized.count("+") > 1:
            normalized = "+" + normalized.replace("+", "")
        if normalized.startswith("00"):
            normalized = "+" + normalized[2:]

        if HAS_PN:
            try:
                number = phonenumbers.parse(normalized, self.default_region)
                if not phonenumbers.is_possible_number(number):
                    return CleanResult(
                        original=raw,
                        cleaned=normalized or None,
                        data_type="phone",
                        valid=False,
                        confidence=20,
                        message="Not a possible number",
                    )
                valid = phonenumbers.is_valid_number(number)
                e164 = phonenumbers.format_number(number, PhoneNumberFormat.E164)
                region = phonenumbers.region_code_for_number(number) or self.default_region
                if valid:
                    return CleanResult(
                        original=raw,
                        cleaned=e164,
                        data_type="phone",
                        valid=True,
                        confidence=100,
                        country=region,
                        rule="E164_STANDARDIZATION",
                    )
                return CleanResult(
                    original=raw,
                    cleaned=e164,
                    data_type="phone",
                    valid=False,
                    confidence=45,
                    country=region,
                    message="Parsed but not a valid number for its region",
                )
            except NumberParseException as exc:
                return CleanResult(
                    original=raw,
                    cleaned=None,
                    data_type="phone",
                    valid=False,
                    confidence=0,
                    message=str(exc),
                )
            except Exception as exc:
                return CleanResult(
                    original=raw, cleaned=None, data_type="phone", valid=False, confidence=0, message=str(exc)
                )

        digits = re.sub(r"\D+", "", normalized)
        if len(digits) < 7 or len(digits) > 15:
            return CleanResult(
                original=raw,
                cleaned=None,
                data_type="phone",
                valid=False,
                confidence=0,
                message="Install phonenumbers for E.164 validation",
            )
        cleaned = "+" + digits if not normalized.startswith("+") and len(digits) > 10 else (
            normalized if normalized.startswith("+") else digits
        )
        return CleanResult(
            original=raw,
            cleaned=cleaned,
            data_type="phone",
            valid=True,
            confidence=55,
            rule="DIGITS_FALLBACK",
            message="phonenumbers not installed — digits only",
        )
