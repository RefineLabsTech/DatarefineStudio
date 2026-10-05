"""Detect dataset locale from phones, amounts, and country columns — never hardcode BD."""

from __future__ import annotations

from collections import Counter
from typing import Any, Iterable

PREFIX = {
    "+1": "US",
    "+44": "GB",
    "+880": "BD",
    "+91": "IN",
    "+86": "CN",
    "+81": "JP",
    "+49": "DE",
    "+33": "FR",
    "+61": "AU",
    "+55": "BR",
    "+234": "NG",
    "+82": "KR",
    "+90": "TR",
    "+92": "PK",
    "+62": "ID",
    "+63": "PH",
    "+66": "TH",
    "+84": "VN",
    "+27": "ZA",
    "+971": "AE",
    "+966": "SA",
    "+20": "EG",
    "+39": "IT",
    "+34": "ES",
    "+31": "NL",
    "+46": "SE",
    "+47": "NO",
    "+48": "PL",
    "+52": "MX",
    "+54": "AR",
    "+56": "CL",
    "+57": "CO",
    "+58": "VE",
    "+7": "RU",
    "+380": "UA",
    "+94": "LK",
    "+977": "NP",
    "+880": "BD",
}

CURRENCY_HINT = {
    "€": "DE",
    "£": "GB",
    "৳": "BD",
    "₹": "IN",
    "¥": "JP",
    "₩": "KR",
    "R$": "BR",
    "₽": "RU",
    "₺": "TR",
    "₦": "NG",
    "A$": "AU",
    "C$": "CA",
}

DATE_MDY_HINT = 0
DATE_DMY_HINT = 0


class DatasetProfiler:
    def detect_region(
        self,
        phone_values: Iterable[Any] | None = None,
        currency_values: Iterable[Any] | None = None,
        country_values: Iterable[Any] | None = None,
    ) -> str:
        score: Counter[str] = Counter()
        for p in phone_values or []:
            if not p:
                continue
            s = str(p).strip().replace(" ", "")
            if not s.startswith("+"):
                continue
            best = None
            for prefix, region in PREFIX.items():
                if s.startswith(prefix) and (best is None or len(prefix) > len(best)):
                    best = prefix
            if best:
                score[PREFIX[best]] += 5

        for a in currency_values or []:
            if not a:
                continue
            s = str(a)
            for token, region in CURRENCY_HINT.items():
                if token in s:
                    score[region] += 2

        if country_values:
            try:
                from sidecar.refine.cleaners.country import CountryCleaner

                cc = CountryCleaner()
                for v in country_values:
                    r = cc.clean(v)
                    if r.accept():
                        score[str(r.cleaned)] += 4
            except Exception:
                pass

        if not score:
            return "US"
        return score.most_common(1)[0][0]

    def detect_date_order(self, date_values: Iterable[Any] | None = None) -> str:
        """DMY if first number is often > 12, else MDY. Default DMY (worldwide)."""
        dmy = 0
        mdy = 0
        for v in date_values or []:
            if not v:
                continue
            s = str(v).strip()
            parts = None
            for sep in ("/", "-", "."):
                if sep in s:
                    bits = s.split(sep)
                    if len(bits) >= 2 and bits[0].isdigit() and bits[1].isdigit():
                        parts = (int(bits[0]), int(bits[1]))
                        break
            if not parts:
                continue
            a, b = parts
            if a > 12 and b <= 12:
                dmy += 1
            elif b > 12 and a <= 12:
                mdy += 1
        if mdy > dmy * 1.2:
            return "MDY"
        return "DMY"
