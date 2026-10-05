"""Country names and codes → ISO 3166-1 alpha-2."""

from __future__ import annotations

from typing import Any

from sidecar.refine.models import CleanResult

try:
    import pycountry

    HAS_PC = True
except ImportError:
    pycountry = None  # type: ignore
    HAS_PC = False

# Always-on aliases (pycountry lookup misses many colloquial names).
ALIASES = {
    "usa": "US",
    "us": "US",
    "u.s.": "US",
    "u.s.a.": "US",
    "united states": "US",
    "united states of america": "US",
    "america": "US",
    "uk": "GB",
    "u.k.": "GB",
    "united kingdom": "GB",
    "great britain": "GB",
    "britain": "GB",
    "england": "GB",
    "scotland": "GB",
    "wales": "GB",
    "holland": "NL",
    "netherlands": "NL",
    "korea": "KR",
    "south korea": "KR",
    "republic of korea": "KR",
    "north korea": "KP",
    "russia": "RU",
    "russian federation": "RU",
    "uae": "AE",
    "u.a.e.": "AE",
    "united arab emirates": "AE",
    "czech": "CZ",
    "czechia": "CZ",
    "czech republic": "CZ",
    "ivory coast": "CI",
    "cote divoire": "CI",
    "côte d'ivoire": "CI",
    "vietnam": "VN",
    "viet nam": "VN",
    "palestine": "PS",
    "taiwan": "TW",
    "hong kong": "HK",
    "macau": "MO",
    "macao": "MO",
    "bolivia": "BO",
    "venezuela": "VE",
    "tanzania": "TZ",
    "iran": "IR",
    "syria": "SY",
    "laos": "LA",
    "brunei": "BN",
    "bd": "BD",
    "bangladesh": "BD",
    "india": "IN",
    "in": "IN",
    "pakistan": "PK",
    "china": "CN",
    "cn": "CN",
    "japan": "JP",
    "jp": "JP",
    "germany": "DE",
    "de": "DE",
    "france": "FR",
    "fr": "FR",
    "spain": "ES",
    "es": "ES",
    "italy": "IT",
    "it": "IT",
    "canada": "CA",
    "ca": "CA",
    "australia": "AU",
    "au": "AU",
    "brazil": "BR",
    "br": "BR",
    "mexico": "MX",
    "nigeria": "NG",
    "kenya": "KE",
    "south africa": "ZA",
    "turkey": "TR",
    "turkiye": "TR",
    "türkiye": "TR",
}


def _norm(s: str) -> str:
    return " ".join(s.strip().lower().replace(".", "").split())


class CountryCleaner:
    def __init__(self) -> None:
        self._map = dict(ALIASES)
        if HAS_PC:
            try:
                for c in pycountry.countries:
                    self._map[c.alpha_2.lower()] = c.alpha_2
                    self._map[c.alpha_3.lower()] = c.alpha_2
                    self._map[_norm(c.name)] = c.alpha_2
                    official = getattr(c, "official_name", None)
                    if official:
                        self._map[_norm(str(official))] = c.alpha_2
                    common = getattr(c, "common_name", None)
                    if common:
                        self._map[_norm(str(common))] = c.alpha_2
            except Exception:
                pass
        try:
            from sidecar.schemas.dictionaries import COUNTRY_CODES

            for code in COUNTRY_CODES:
                self._map[str(code).lower()] = str(code).upper()
        except Exception:
            pass

    def clean(self, value: Any) -> CleanResult:
        if value is None:
            return CleanResult(original="", cleaned=None, data_type="country", valid=False, confidence=0)
        raw = str(value).strip()
        if not raw:
            return CleanResult(original=raw, cleaned=None, data_type="country", valid=False, confidence=0)
        key = _norm(raw)
        code = self._map.get(key)
        if not code and HAS_PC:
            try:
                hit = pycountry.countries.lookup(raw)
                code = hit.alpha_2
            except Exception:
                code = None
        if code:
            conf = 100 if len(raw) <= 3 else 96
            return CleanResult(
                original=raw,
                cleaned=code,
                data_type="country",
                valid=True,
                confidence=conf,
                country=code,
                rule="ISO3166_ALPHA2",
            )
        return CleanResult(
            original=raw, cleaned=None, data_type="country", valid=False, confidence=0, message="Unknown country"
        )
