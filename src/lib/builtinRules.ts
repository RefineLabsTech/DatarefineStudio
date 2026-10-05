import { BUILTIN_UNIVERSAL } from "./universalRules";

export type LibRule = {
  id?: number;
  name: string;
  kind: "universal" | "sql" | "javascript" | "python" | "regex" | string;
  body: string;
  description?: string;
  category?: string;
  parameters?: Record<string, unknown>;
};

export type ColumnRuleChoice = LibRule & { source: "builtin" | "library" };

/** Always-on pack: applied to every column unless a run is a single assigned extra. */
export const AUTO_CLEAN_STEPS: LibRule[] = [
  { name: "auto_clean", kind: "universal", body: "auto_clean", description: "Trim, hidden Unicode, NFC, spaces, line endings, blank lines, empty→NULL" },
];

export const BUILTIN_RULES: LibRule[] = BUILTIN_UNIVERSAL.filter((u) => u.key !== "standardize").map((u) => ({
  name: u.name,
  kind: "universal",
  body: u.key,
  description: u.description,
  category: "universal",
}));

export function specToPayload(spec: LibRule | undefined, raw: string, columns?: string[]): Record<string, unknown> {
  const kind = (spec?.kind || guessKind(raw, spec)).toLowerCase();
  const body = spec?.body || raw;
  const params = spec?.parameters || {};
  const named = kind !== "regex" && kind !== "python" && kind !== "javascript" && kind !== "sql" && isNamedBody(body);
  return {
    name: kind === "regex" ? "regex" : named ? String(body).trim() : spec?.name || raw,
    kind,
    body,
    columns,
    pattern: (params.pattern as string) || (kind === "regex" ? body : undefined),
    replacement: (params.replacement as string) || "",
    parameters: params,
    plugin: params.plugin,
    python: params.python,
  };
}

function guessKind(raw: string, spec?: LibRule): string {
  if (spec?.kind) return spec.kind;
  if (isNamedBody(raw)) return "universal";
  return "universal";
}

function isNamedBody(body?: string) {
  const s = (body || "").trim();
  return Boolean(s) && /^[A-Za-z0-9_\-]+$/.test(s);
}

export function ruleValue(r: LibRule): string {
  if (typeof r.id === "number") return `id:${r.id}`;
  const body = (r.body || "").trim();
  if (isNamedBody(body)) return body;
  return r.name;
}

export function findRuleSpec(raw: string, library: LibRule[]): LibRule | undefined {
  const catalog = [...BUILTIN_RULES, ...library];
  const s = (raw || "").trim();
  if (!s || s === "none") return undefined;
  if (s.startsWith("id:")) {
    const id = s.slice(3);
    return catalog.find((r) => String(r.id ?? "") === id);
  }
  return catalog.find((r) => r.name === s || (r.body || "").trim() === s || String(r.id ?? "") === s);
}

export function resolveColumnRules(
  columnRules: Record<string, string>,
  library: LibRule[],
): Array<Record<string, unknown>> {
  const extras: Array<Record<string, unknown>> = [];
  for (const [column, raw] of Object.entries(columnRules)) {
    if (!raw || raw === "none" || raw === "auto_clean") continue;
    const spec = findRuleSpec(raw, library);
    const kind = (spec?.kind || "").toLowerCase();
    if (kind === "sql") continue;
    extras.push(specToPayload(spec, raw, [column]));
  }
  return extras;
}

export function columnRuleOptions(library: LibRule[]): ColumnRuleChoice[] {
  const out: ColumnRuleChoice[] = [];
  const seen = new Set<string>();
  const push = (r: LibRule, source: "builtin" | "library") => {
    const k = (r.kind || "").toLowerCase();
    if (k === "sql") return;
    const sig = `${source}|${k}|${(r.name || "").toLowerCase()}|${(r.body || "").trim()}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    out.push({ ...r, source });
  };
  for (const r of BUILTIN_RULES) push(r, "builtin");
  for (const r of library || []) {
    const k = (r.kind || "").toLowerCase();
    if (k === "universal" && isNamedBody(r.body) && BUILTIN_RULES.some((b) => b.body === r.body.trim())) {
      continue;
    }
    push(r, "library");
  }
  return out;
}

export function kindSuffix(kind?: string) {
  const k = (kind || "").toLowerCase();
  if (k === "regex") return " (regex)";
  if (k === "python") return " (python)";
  if (k === "javascript" || k === "js") return " (js)";
  if (k === "plugin") return " (plugin)";
  return "";
}
