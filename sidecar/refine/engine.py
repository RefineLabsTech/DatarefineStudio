"""Schema-aware industrial cleaner. In-place. Never guesses below 80%."""

from __future__ import annotations

from typing import Any, Iterable

from sidecar.refine.audit import AuditLog
from sidecar.refine.cleaners.amount import AmountCleaner
from sidecar.refine.cleaners.country import CountryCleaner
from sidecar.refine.cleaners.date import DateCleaner
from sidecar.refine.cleaners.phone import PhoneCleaner
from sidecar.refine.confidence import MIN_APPLY
from sidecar.refine.profiler import DatasetProfiler

PHONE_TYPES = {"Phone"}
DATE_TYPES = {"Date", "DateTime"}
AMOUNT_TYPES = {"Amount"}
CURRENCY_TYPES = {"Currency"}
COUNTRY_TYPES = {"Country"}

Kind = str  # phone | date | amount | currency | country


class RefineEngine:
    def __init__(self, default_region: str = "US", date_order: str = "DMY") -> None:
        self.default_region = (default_region or "US").upper()
        self.date_order = (date_order or "DMY").upper()
        self.phone = PhoneCleaner(self.default_region)
        self.date = DateCleaner(self.date_order)
        self.amount = AmountCleaner()
        self.country = CountryCleaner()
        self.profiler = DatasetProfiler()

    def detect_locale(self, df: Any, schema: dict[str, dict] | None = None) -> tuple[str, str]:
        phones, amounts, countries, dates = [], [], [], []
        cols = list(getattr(df, "columns", []))
        schema = schema or {}
        for c in cols:
            typ = _type_of(schema, c)
            try:
                sample = df[c].drop_nulls().head(80).to_list()
            except Exception:
                continue
            if typ in PHONE_TYPES or "phone" in c.lower():
                phones.extend(sample)
            if typ in AMOUNT_TYPES | CURRENCY_TYPES:
                amounts.extend(sample)
            if typ in COUNTRY_TYPES or "country" in c.lower():
                countries.extend(sample)
            if typ in DATE_TYPES or "date" in c.lower() or c.lower() in {"signup", "dob"}:
                dates.extend(sample)
        region = self.profiler.detect_region(phones, amounts, countries)
        order = self.profiler.detect_date_order(dates)
        return region, order

    def clean_frame(
        self,
        df: Any,
        schema: dict[str, dict] | None = None,
        *,
        kinds: Iterable[Kind] | None = None,
        columns: list[str] | None = None,
        min_confidence: int = MIN_APPLY,
    ) -> tuple[Any, dict[str, Any]]:
        import polars as pl

        schema = schema or {}
        want = {k.lower() for k in (kinds or ("phone", "date", "amount", "currency", "country"))}
        cols = [c for c in (columns or list(df.columns)) if c in df.columns]
        if not cols:
            return df, {"applied": 0, "rejected": 0, "by_type": {}}

        region, order = self.detect_locale(df, schema)
        self.phone = PhoneCleaner(region)
        self.date = DateCleaner(order)
        audit = AuditLog()

        for c in cols:
            typ = _type_of(schema, c)
            kind = _kind_for(typ, c, want, explicit=bool(columns))
            if not kind or kind not in want:
                continue
            series = df[c]
            values = series.to_list()
            out: list[Any] = []
            changed = False
            for i, v in enumerate(values):
                try:
                    result = self._clean_one(kind, v)
                except Exception:
                    out.append(v)
                    continue
                ok = result.accept(min_confidence)
                if ok and result.cleaned is not None and str(result.cleaned) != ("" if v is None else str(v)):
                    out.append(result.cleaned)
                    changed = True
                    audit.add(result, column=c, row=i, applied=True)
                else:
                    out.append(v)
                    if v not in (None, "") and not ok:
                        audit.add(result, column=c, row=i, applied=False)
            if changed:
                df = df.with_columns(pl.Series(c, out))

        summary = audit.summary()
        summary["region"] = region
        summary["date_order"] = order
        return df, summary

    def _clean_one(self, kind: str, value: Any):
        if kind == "phone":
            return self.phone.clean(value)
        if kind == "date":
            return self.date.clean(value)
        if kind == "amount":
            return self.amount.clean(value)
        if kind == "currency":
            return self.amount.currency_code(value)
        if kind == "country":
            return self.country.clean(value)
        from sidecar.refine.models import CleanResult

        return CleanResult(original=str(value or ""), cleaned=None, data_type=kind, valid=False, confidence=0)


def _type_of(schema: dict[str, dict], col: str) -> str:
    rec = schema.get(col) or {}
    return str(rec.get("active") or rec.get("inferred") or "")


def _kind_for(typ: str, col: str, want: set[str], *, explicit: bool) -> Kind | None:
    if typ in PHONE_TYPES:
        return "phone"
    if typ in DATE_TYPES:
        return "date"
    if typ in AMOUNT_TYPES:
        return "amount"
    if typ in CURRENCY_TYPES:
        return "currency"
    if typ in COUNTRY_TYPES:
        return "country"
    if explicit:
        # Assigned to a specific column — honour the requested kinds.
        if "phone" in want:
            return "phone"
        if "date" in want:
            return "date"
        if "amount" in want:
            return "amount"
        if "currency" in want:
            return "currency"
        if "country" in want:
            return "country"
    return None
