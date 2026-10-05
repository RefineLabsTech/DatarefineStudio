"""PDF cleaning report — Helvetica only, no extra packages."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

PAGE_W = 595.28
PAGE_H = 841.89
MARGIN = 48
NAVY = (0.10, 0.16, 0.28)
NAVY_MID = (0.16, 0.24, 0.40)
ACCENT = (0.27, 0.45, 0.82)
INK = (0.13, 0.16, 0.20)
DIM = (0.42, 0.46, 0.52)
LINE = (0.86, 0.88, 0.91)
PAPER = (0.97, 0.98, 0.99)
WHITE = (1.0, 1.0, 1.0)
OK = (0.12, 0.48, 0.34)
FOOT = 36

STAGE_LABELS = {
    "rules": "Universal rules",
    "sql": "DuckDB SQL",
    "javascript": "JavaScript V8",
    "js": "JavaScript V8",
    "python": "Python Polars",
    "manual": "Manual edits",
    "ai": "AI apply",
    "search": "Find & replace",
    "plugin": "Plugins",
}


def write_cleaning_report(report: dict[str, Any], dest: str) -> str:
    path = Path(dest)
    if path.suffix.lower() != ".pdf":
        path = path.with_suffix(".pdf")
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = _Pdf()
    _draw(doc, report)
    path.write_bytes(doc.dumps())
    return str(path)


def _draw(doc: "_Pdf", r: dict[str, Any]) -> None:
    cleaned = int(r.get("cells_cleaned") or 0)
    total_cells = int(r.get("total_cells") or 0)
    try:
        pct = float(r.get("pct_cleaned") or 0)
    except (TypeError, ValueError):
        pct = 0.0
    cur = r.get("current") or {}
    base = r.get("baseline") or {}
    rows = int(cur.get("rows") or 0)
    cols = int(cur.get("columns") or 0)

    doc.title_block("Data quality report", _when(r.get("generated_at")))

    health_now = _num(cur.get("health"))
    health_was = _num(base.get("health")) if base else None
    health_hint = f"was {_fmt(health_was)}" if health_was is not None else "current score"
    doc.kpis(
        [
            ("Cells cleaned", f"{cleaned:,}", f"{pct:.1f}% of {total_cells:,} cells" if total_cells else "this session"),
            ("Health", _fmt(health_now), health_hint),
            ("Dataset", f"{rows:,} x {cols}", "rows x columns"),
            ("Missing", f"{int(cur.get('missing') or 0):,}", _missing_hint(base, cur)),
        ]
    )

    doc.section("Quality snapshot")
    snap = [
        ["Rows", _n(base.get("rows")), f"{rows:,}", _delta(base.get("rows"), rows)],
        ["Columns", _n(base.get("columns")), f"{cols:,}", _delta(base.get("columns"), cols)],
        ["Health", _fmt(health_was) if health_was is not None else "—", _fmt(health_now), _health_delta(health_was, health_now)],
        ["Missing cells", _n(base.get("missing")), f"{int(cur.get('missing') or 0):,}", _delta(base.get("missing"), cur.get("missing"), invert=True)],
        ["Invalid cells", _n(base.get("invalid")), f"{int(cur.get('invalid') or 0):,}", _delta(base.get("invalid"), cur.get("invalid"), invert=True)],
        ["Duplicate rows", _n(base.get("duplicates")), f"{int(cur.get('duplicates') or 0):,}", _delta(base.get("duplicates"), cur.get("duplicates"), invert=True)],
    ]
    doc.table(["Metric", "Before", "After", "Change"], snap, widths=[160, 90, 90, 159])

    stages = r.get("by_stage") or []
    if stages:
        doc.section("Cleaning by stage")
        body = []
        for x in stages:
            n = int(x.get("cells") or 0)
            share = (100.0 * n / cleaned) if cleaned else 0.0
            body.append([_stage(x.get("stage")), f"{n:,}", f"{share:.1f}%"])
        doc.table(["Stage", "Cells cleaned", "Share"], body, widths=[260, 130, 109])

    cols_rep = r.get("by_column") or []
    if cols_rep:
        doc.section("Cleaning by column")
        body = []
        for x in cols_rep[:30]:
            n = int(x.get("cells") or 0)
            share = x.get("pct")
            try:
                share_s = f"{float(share):.1f}%"
            except (TypeError, ValueError):
                share_s = "—"
            body.append([str(x.get("column") or ""), f"{n:,}", share_s])
        doc.table(["Column", "Cells cleaned", "% of rows"], body, widths=[260, 130, 109])

    doc.gap(10)
    doc.note("Counts are cell updates per stage. A cell cleaned more than once is counted each time.")


def _stage(raw: Any) -> str:
    key = str(raw or "").strip().lower()
    return STAGE_LABELS.get(key, (str(raw or "Other").replace("_", " ").title()))


def _when(raw: Any) -> str:
    s = str(raw or "").strip()
    if not s:
        return datetime.now().strftime("%d %b %Y  %H:%M")
    try:
        return datetime.fromisoformat(s.replace("Z", "")).strftime("%d %b %Y  %H:%M")
    except Exception:
        return s


def _num(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _fmt(v: float | None) -> str:
    if v is None:
        return "—"
    return f"{v:.1f}"


def _n(v: Any) -> str:
    if v is None or v == "":
        return "—"
    try:
        return f"{int(v):,}"
    except (TypeError, ValueError):
        return str(v)


def _delta(before: Any, after: Any, invert: bool = False) -> str:
    try:
        b = float(before)
        a = float(after)
    except (TypeError, ValueError):
        return "—"
    d = a - b
    if abs(d) < 0.05:
        return "No change"
    sign = "+" if d > 0 else ""
    if invert:
        label = "improved" if d < 0 else "increased"
        return f"{sign}{d:,.0f}  {label}" if abs(d) >= 1 else f"{sign}{d:.1f}  {label}"
    if abs(d) >= 1:
        return f"{sign}{d:,.0f}"
    return f"{sign}{d:.1f}"


def _health_delta(before: float | None, after: float | None) -> str:
    if before is None or after is None:
        return "—"
    d = after - before
    if abs(d) < 0.05:
        return "No change"
    sign = "+" if d > 0 else ""
    word = "improved" if d > 0 else "declined"
    return f"{sign}{d:.1f}  {word}"


def _missing_hint(base: dict, cur: dict) -> str:
    try:
        b = int(base.get("missing") or 0)
        a = int(cur.get("missing") or 0)
        d = a - b
        if d == 0:
            return "unchanged vs import"
        if d < 0:
            return f"{abs(d):,} fewer than import"
        return f"{d:,} more than import"
    except (TypeError, ValueError):
        return "current count"


class _Pdf:
    def __init__(self) -> None:
        self.pages: list[list[str]] = []
        self.ops: list[str] = []
        self.y = PAGE_H - MARGIN
        self.page_no = 0
        self._started = False
        self.new_page()

    def new_page(self) -> None:
        if self._started:
            self.pages.append(self.ops)
        self._started = True
        self.page_no += 1
        self.ops = []
        self._fill(0, PAGE_H - 40, PAGE_W, 40, NAVY)
        self._text(MARGIN, PAGE_H - 25, "DataRefine Studio", 11, WHITE, "F2")
        self._text(PAGE_W - MARGIN - 118, PAGE_H - 25, "Data quality report", 9, (0.78, 0.84, 0.94), "F1")
        self._fill(0, 0, PAGE_W, 28, NAVY)
        self._text(MARGIN, 11, "Confidential  ·  Generated locally  ·  Not transmitted", 7, (0.72, 0.78, 0.88), "F1")
        self._text(PAGE_W - MARGIN - 48, 11, f"Page {self.page_no}", 7, (0.72, 0.78, 0.88), "F1")
        self.y = PAGE_H - 58

    def ensure(self, h: float) -> None:
        if self.y - h < FOOT + 12:
            self.new_page()

    def title_block(self, title: str, when: str) -> None:
        self.ensure(44)
        self._text(MARGIN, self.y, title, 18, INK, "F2")
        self.y -= 16
        self._text(MARGIN, self.y, f"Generated  {when}", 9, DIM, "F1")
        self.y -= 18
        self.rule()

    def section(self, title: str) -> None:
        self.ensure(28)
        self.gap(6)
        self._text(MARGIN, self.y, title.upper(), 8, ACCENT, "F2")
        self.y -= 14

    def kpis(self, items: list[tuple[str, str, str]]) -> None:
        n = max(1, len(items))
        gap = 8
        inner = PAGE_W - 2 * MARGIN
        w = (inner - gap * (n - 1)) / n
        h = 56
        self.ensure(h + 10)
        top = self.y
        x = MARGIN
        for label, value, hint in items:
            self._fill(x, top - h, w, h, PAPER)
            self._rect(x, top - h, w, h, LINE)
            self._text(x + 10, top - 14, _clip(label.upper(), 22), 7, DIM, "F2")
            self._text(x + 10, top - 32, _clip(value, 16), 13, INK, "F2")
            self._text(x + 10, top - 46, _clip(hint, 28), 7, DIM, "F1")
            x += w + gap
        self.y -= h + 14

    def note(self, s: str) -> None:
        self.ensure(16)
        self.line(s, size=8, color=DIM, leading=12)

    def kv(self, k: str, v: str) -> None:
        self.ensure(14)
        self._text(MARGIN, self.y, _clip(k, 22), 9, DIM, "F2")
        self._text(MARGIN + 88, self.y, _clip(str(v), 80), 9, INK, "F1")
        self.y -= 14

    def line(self, s: str, size: int = 10, color: tuple[float, float, float] = INK, leading: float | None = None) -> None:
        leading = leading or size + 5
        for chunk in _wrap(str(s), 108):
            self.ensure(leading)
            self._text(MARGIN, self.y, chunk, size, color, "F1")
            self.y -= leading

    def rule(self) -> None:
        self.ensure(10)
        y = self.y + 2
        self.ops.append(
            f"{LINE[0]:.3f} {LINE[1]:.3f} {LINE[2]:.3f} RG 0.5 w {MARGIN:.1f} {y:.1f} m {PAGE_W - MARGIN:.1f} {y:.1f} l S 0 0 0 RG"
        )
        self.y -= 8

    def gap(self, n: float) -> None:
        self.y -= n

    def table(self, headers: list[str], rows: list[list[str]], widths: list[float] | None = None) -> None:
        inner = PAGE_W - 2 * MARGIN
        if not widths:
            widths = [inner / max(1, len(headers))] * len(headers)
        row_h = 16
        self.ensure(row_h + 4)
        self._fill(MARGIN, self.y - 4, inner, row_h, NAVY_MID)
        x = MARGIN
        for h, w in zip(headers, widths):
            self._text(x + 6, self.y, _clip(h, max(8, int(w / 5))), 8, WHITE, "F2")
            x += w
        self.y -= row_h
        for i, row in enumerate(rows):
            self.ensure(row_h)
            if i % 2 == 0:
                self._fill(MARGIN, self.y - 4, inner, row_h, PAPER)
            x = MARGIN
            for j, cell in enumerate(row):
                w = widths[j] if j < len(widths) else 80
                self._text(x + 6, self.y, _clip(str(cell), max(8, int(w / 5))), 9, INK, "F1")
                x += w
            self.y -= row_h
        self.gap(8)

    def _fill(self, x: float, y: float, w: float, h: float, rgb: tuple[float, float, float]) -> None:
        r, g, b = rgb
        self.ops.append(f"{r:.3f} {g:.3f} {b:.3f} rg {x:.1f} {y:.1f} {w:.1f} {h:.1f} re f 0 0 0 rg")

    def _rect(self, x: float, y: float, w: float, h: float, rgb: tuple[float, float, float]) -> None:
        r, g, b = rgb
        self.ops.append(f"{r:.3f} {g:.3f} {b:.3f} RG 0.4 w {x:.1f} {y:.1f} {w:.1f} {h:.1f} re S 0 0 0 RG")

    def _text(self, x: float, y: float, s: str, size: int, rgb: tuple[float, float, float], font: str) -> None:
        r, g, b = rgb
        self.ops.append(
            f"{r:.3f} {g:.3f} {b:.3f} rg BT /{font} {size} Tf {x:.1f} {y:.1f} Td ({_esc(s)}) Tj ET 0 0 0 rg"
        )

    def dumps(self) -> bytes:
        if self.ops:
            self.pages.append(self.ops)
        n = len(self.pages)
        font1 = 3 + 2 * n
        font2 = 4 + 2 * n
        objs: list[bytes] = [b""]
        objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
        kids = " ".join(f"{3 + i} 0 R" for i in range(n))
        objs.append(f"<< /Type /Pages /Count {n} /Kids [{kids}] >>".encode())
        streams = []
        for ops in self.pages:
            body = ("\n".join(ops) + "\n").encode("latin-1", "replace")
            streams.append(body)
        for i, body in enumerate(streams):
            content_obj = 3 + n + i
            objs.append(
                (
                    f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W:.2f} {PAGE_H:.2f}] "
                    f"/Resources << /Font << /F1 {font1} 0 R /F2 {font2} 0 R >> >> /Contents {content_obj} 0 R >>"
                ).encode()
            )
        for body in streams:
            objs.append(f"<< /Length {len(body)} >>\nstream\n".encode() + body + b"endstream")
        objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
        objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")

        out = bytearray(b"%PDF-1.4\n")
        offsets = [0]
        for i, obj in enumerate(objs[1:], start=1):
            offsets.append(len(out))
            out.extend(f"{i} 0 obj\n".encode())
            out.extend(obj)
            if not obj.endswith(b"\n"):
                out.extend(b"\n")
            out.extend(b"endobj\n")
        xref = len(out)
        out.extend(f"xref\n0 {len(objs)}\n".encode())
        out.extend(b"0000000000 65535 f \n")
        for off in offsets[1:]:
            out.extend(f"{off:010d} 00000 n \n".encode())
        out.extend(f"trailer << /Size {len(objs)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
        return bytes(out)


def _esc(s: str) -> str:
    s = _safe(s)
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _safe(s: str) -> str:
    return "".join(ch if 32 <= ord(ch) < 127 else "?" for ch in str(s or ""))


def _clip(s: str, n: int) -> str:
    s = _safe(s)
    return s if len(s) <= n else s[: n - 1] + "..."


def _wrap(s: str, width: int) -> list[str]:
    s = _safe(s)
    out: list[str] = []
    while s:
        out.append(s[:width])
        s = s[width:]
    return out or [""]
