import type { LibRule } from "./builtinRules";

export type UniLang = "python" | "javascript";

export type UniRule = {
  key: string;
  name: string;
  description: string;
  language: UniLang;
  body: string;
  builtin: boolean;
  pack: boolean;
  id?: number;
  overridden?: boolean;
};

const PY_ALL = (expr: string) =>
  `df = df.with_columns([${expr} for c in df.columns])`;

export const BUILTIN_UNIVERSAL: UniRule[] = [
  {
    key: "trim",
    name: "Trim whitespace",
    description: "Strip leading and trailing spaces on every column.",
    language: "python",
    pack: true,
    builtin: true,
    body: PY_ALL("pl.col(c).cast(pl.Utf8, strict=False).str.strip_chars()"),
  },
  {
    key: "hidden_unicode",
    name: "Hidden Unicode",
    description: "Remove zero-width characters and BOM.",
    language: "python",
    pack: true,
    builtin: true,
    body: `import re, unicodedata
HIDDEN = re.compile(r"[\\u200b-\\u200f\\u202a-\\u202e\\ufeff\\u00a0]")
def _cell(v):
    if v is None:
        return None
    return unicodedata.normalize("NFC", HIDDEN.sub("", str(v)))
df = df.with_columns([pl.col(c).cast(pl.Utf8, strict=False).map_elements(_cell, return_dtype=pl.Utf8) for c in df.columns])`,
  },
  {
    key: "normalize_unicode",
    name: "Unicode NFC",
    description: "Normalize text to Unicode NFC.",
    language: "python",
    pack: true,
    builtin: true,
    body: `import unicodedata
def _nfc(v):
    if v is None:
        return None
    return unicodedata.normalize("NFC", str(v))
df = df.with_columns([pl.col(c).cast(pl.Utf8, strict=False).map_elements(_nfc, return_dtype=pl.Utf8) for c in df.columns])`,
  },
  {
    key: "collapse_spaces",
    name: "Collapse spaces",
    description: "Collapse repeated spaces and tabs.",
    language: "python",
    pack: true,
    builtin: true,
    body: PY_ALL('pl.col(c).cast(pl.Utf8, strict=False).str.replace_all(r"[ \\t]+", " ", literal=False)'),
  },
  {
    key: "line_endings",
    name: "Line endings",
    description: "Normalize CR/LF to \\\\n.",
    language: "python",
    pack: true,
    builtin: true,
    body: `df = df.with_columns([
    pl.col(c).cast(pl.Utf8, strict=False).str.replace_all("\\r\\n", "\\n", literal=True).str.replace_all("\\r", "\\n", literal=True)
    for c in df.columns
])`,
  },
  {
    key: "blank_lines",
    name: "Blank lines",
    description: "Collapse duplicate blank lines.",
    language: "python",
    pack: true,
    builtin: true,
    body: PY_ALL('pl.col(c).cast(pl.Utf8, strict=False).str.replace_all(r"\\n{3,}", "\\n\\n", literal=False)'),
  },
  {
    key: "empty_to_null",
    name: "Empty → NULL",
    description: "Blank, NA, N/A, dash → NULL.",
    language: "python",
    pack: true,
    builtin: true,
    body: `EMPTY = {"", "na", "n/a", "null", "none", "-", "--", "nan", "#n/a", "#null"}
def _empty(v):
    if v is None:
        return None
    s = str(v).strip()
    return None if s.lower() in EMPTY else s
df = df.with_columns([pl.col(c).cast(pl.Utf8, strict=False).map_elements(_empty, return_dtype=pl.Utf8) for c in df.columns])`,
  },
  {
    key: "normalize_case",
    name: "Lowercase",
    description: "Lowercase every text cell.",
    language: "python",
    pack: false,
    builtin: true,
    body: PY_ALL("pl.col(c).cast(pl.Utf8, strict=False).str.to_lowercase()"),
  },
  {
    key: "upper",
    name: "Uppercase",
    description: "Uppercase every text cell.",
    language: "python",
    pack: false,
    builtin: true,
    body: PY_ALL("pl.col(c).cast(pl.Utf8, strict=False).str.to_uppercase()"),
  },
  {
    key: "email_cleanup",
    name: "Email cleanup",
    description: "Trim and lowercase emails.",
    language: "python",
    pack: false,
    builtin: true,
    body: PY_ALL("pl.col(c).cast(pl.Utf8, strict=False).str.strip_chars().str.to_lowercase()"),
  },
  {
    key: "phone_normalize",
    name: "Phone E.164",
    description: "International E.164 on Phone columns only (240+ countries). Invalid numbers stay as-is.",
    language: "python",
    pack: false,
    builtin: true,
    body: "phone_normalize",
  },
  {
    key: "date_normalize",
    name: "Date ISO 8601",
    description: "Worldwide dates → YYYY-MM-DD on Date columns. Unrecognized values stay as-is.",
    language: "python",
    pack: false,
    builtin: true,
    body: "date_normalize",
  },
  {
    key: "currency_normalize",
    name: "Amount ISO 4217",
    description: "Parse $1,250.99 / 1.250,99 € / ₹1,25,000 on Amount and Currency columns.",
    language: "python",
    pack: false,
    builtin: true,
    body: "currency_normalize",
  },
  {
    key: "country_mapping",
    name: "Country ISO 3166",
    description: "Country names and codes → ISO 3166-1 alpha-2 on Country columns.",
    language: "python",
    pack: false,
    builtin: true,
    body: "country_mapping",
  },
  {
    key: "standardize",
    name: "Industrial standardize",
    description: "Phone E.164 + Date ISO 8601 + Amount + Country on typed columns. Locale is detected from the sheet. Never guesses below 80%.",
    language: "python",
    pack: false,
    builtin: true,
    body: "standardize",
  },
];

export const PACK_KEYS = new Set(BUILTIN_UNIVERSAL.filter((r) => r.pack).map((r) => r.key));
const BUILTIN_KEYS = new Set(BUILTIN_UNIVERSAL.map((r) => r.key));

export function isNamedBody(body?: string) {
  const s = (body || "").trim();
  return Boolean(s) && /^[A-Za-z0-9_\-]+$/.test(s);
}

function langOf(r: LibRule): UniLang {
  const p = r.parameters || {};
  const lang = String(p.language || "").toLowerCase();
  if (lang === "javascript" || lang === "js") return "javascript";
  const kind = (r.kind || "").toLowerCase();
  if (kind === "javascript" || kind === "js") return "javascript";
  const body = r.body || "";
  if (/return row|typeof |Object\.keys/.test(body)) return "javascript";
  return "python";
}

export function mergeUniversal(library: LibRule[]): UniRule[] {
  const customs = (library || []).filter((r) => (r.kind || "").toLowerCase() === "universal");
  const byKey = new Map<string, LibRule>();
  for (const r of customs) {
    const key = String((r.parameters || {}).key || "");
    if (key && BUILTIN_KEYS.has(key)) byKey.set(key, r);
  }
  const builtins = BUILTIN_UNIVERSAL.map((b) => {
    const ov = byKey.get(b.key);
    const edited = Boolean(ov && ov.body && !isNamedBody(ov.body));
    return {
      ...b,
      name: ov?.name || b.name,
      description: ov?.description || b.description,
      body: edited ? String(ov?.body) : b.body,
      id: typeof ov?.id === "number" ? ov.id : undefined,
      overridden: edited,
      language: "python" as const,
    };
  });
  const extra: UniRule[] = [];
  for (const r of customs) {
    const key = String((r.parameters || {}).key || "");
    if (key && BUILTIN_KEYS.has(key)) continue;
    if (isNamedBody(r.body) && BUILTIN_KEYS.has(r.body.trim())) continue;
    extra.push({
      key: typeof r.id === "number" ? `id:${r.id}` : r.name,
      name: r.name,
      description: r.description || "",
      language: langOf(r),
      body: r.body,
      builtin: false,
      pack: false,
      id: typeof r.id === "number" ? r.id : undefined,
    });
  }
  return [...builtins, ...extra];
}

export function defaultEnabled(key: string) {
  return PACK_KEYS.has(key);
}

export function toUniversalPayload(rule: UniRule): Record<string, unknown> {
  if (rule.builtin && !rule.overridden) {
    return { name: rule.key, kind: "universal", body: rule.key };
  }
  return {
    name: rule.name,
    kind: "universal",
    body: rule.body,
    parameters: { language: rule.language, key: rule.builtin ? rule.key : undefined },
  };
}
