import type { Monaco } from "@monaco-editor/react";

type Range = {
  startLineNumber: number;
  endLineNumber: number;
  startColumn: number;
  endColumn: number;
};

let columns: string[] = [];
let monacoRef: Monaco | null = null;
let extraLib: { dispose: () => void } | null = null;
let pluginSnippets: { language: string; label: string; insertText: string; detail?: string }[] = [];
let pyInstalled: [string, string, string][] = [];
let jsInstalled: string[] = [];

export function setInstalledLibraries(info: {
  packages?: Array<{ name: string; version?: string; import?: string }>;
  node_modules?: Array<{ name: string }>;
} | null) {
  pyInstalled = (info?.packages || [])
    .map((p) => {
      const raw = (p.import || p.name || "").trim();
      const mod = raw.replace(/-/g, "_").replace(/[^\w.]/g, "");
      if (!mod || !/^[A-Za-z_]/.test(mod)) return null;
      const ver = p.version ? ` ${p.version}` : "";
      return [mod, `import ${mod}`, `Installed${ver}`] as [string, string, string];
    })
    .filter((x): x is [string, string, string] => Boolean(x));
  jsInstalled = (info?.node_modules || []).map((n) => n.name).filter(Boolean);
}

export function setPluginSnippets(rows: { language: string; label: string; insertText: string; detail?: string }[]) {
  pluginSnippets = Array.isArray(rows) ? rows.filter((s) => s && s.insertText) : [];
}

export function setIntellisenseColumns(cols: string[]) {
  columns = Array.isArray(cols) ? cols.filter(Boolean) : [];
  refreshJsLib();
}

function refreshJsLib() {
  if (!monacoRef) return;
  const fields = columns
    .filter((c) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c))
    .map((c) => `  ${JSON.stringify(c)}?: any;`)
    .join("\n");
  const dts = `/** Current row. Mutate fields, then return the object. */
interface DataRefineRow {
${fields}
  [column: string]: any;
}
declare var row: DataRefineRow;
`;
  try {
    extraLib?.dispose();
    extraLib = monacoRef.languages.typescript.javascriptDefaults.addExtraLib(dts, "ts:datarefine-row.d.ts");
  } catch {
    /* language not ready */
  }
}

function wordRange(model: { getWordUntilPosition: (p: { lineNumber: number; column: number }) => { startColumn: number; endColumn: number } }, pos: { lineNumber: number; column: number }): Range {
  const w = model.getWordUntilPosition(pos);
  return {
    startLineNumber: pos.lineNumber,
    endLineNumber: pos.lineNumber,
    startColumn: w.startColumn,
    endColumn: w.endColumn,
  };
}

/** Object name immediately before the last `.member` (works for `df.` and `df.with`). */
function lastRoot(line: string): string {
  const m = line.match(/([A-Za-z_]\w*)\s*\.\s*[A-Za-z_]\w*$/) || line.match(/([A-Za-z_]\w*)\s*\.\s*$/);
  return m ? m[1] : "";
}

const PY_MODULES: [string, string, string][] = [
  ["polars", "import polars as pl", "Polars DataFrame library (also injected as pl)"],
  ["numpy", "import numpy as np", "NumPy (also injected as np)"],
  ["pyarrow", "import pyarrow as pa", "PyArrow (also injected as pa)"],
  ["rapidfuzz", "import rapidfuzz", "Fuzzy string matching"],
  ["datetime", "from datetime import datetime, date", "Dates"],
  ["re", "import re", "Regular expressions"],
  ["json", "import json", "JSON"],
  ["math", "import math", "Math"],
  ["collections", "from collections import Counter, defaultdict", "Collections"],
  ["itertools", "import itertools", "Iterators"],
  ["functools", "import functools", "Function tools"],
  ["decimal", "from decimal import Decimal", "Decimals"],
  ["statistics", "import statistics", "Stats"],
  ["string", "import string", "String constants"],
  ["typing", "from typing import Any, Optional", "Typing"],
  ["unicodedata", "import unicodedata", "Unicode normalize"],
  ["hashlib", "import hashlib", "Hashes"],
  ["base64", "import base64", "Base64"],
  ["csv", "import csv", "CSV helpers"],
];

const PL_NS: [string, string, string][] = [
  ["col", 'col("${1:column}")', "Column expression"],
  ["lit", "lit(${1:value})", "Literal"],
  ["when", "when(${1:cond})", "Conditional"],
  ["all", "all()", "All columns"],
  ["exclude", 'exclude("${1:column}")', "All except"],
  ["concat", "concat([${1:df}])", "Stack frames"],
  ["concat_str", "concat_str([${1:exprs}])", "Concatenate strings"],
  ["coalesce", "coalesce(${1:exprs})", "First non-null"],
  ["element", "element()", "List.eval element"],
  ["len", "len()", "Length / count"],
  ["count", "count()", "Count non-null"],
  ["sum", "sum()", "Sum"],
  ["mean", "mean()", "Mean"],
  ["min", "min()", "Min"],
  ["max", "max()", "Max"],
  ["DataFrame", "DataFrame(${1:data})", "Construct a DataFrame"],
  ["Series", "Series(${1:name}, ${2:values})", "Construct a Series"],
  ["LazyFrame", "LazyFrame()", "Lazy plan"],
  ["read_csv", 'read_csv("${1:path}")', "Read CSV"],
  ["read_parquet", 'read_parquet("${1:path}")', "Read Parquet"],
  ["read_json", 'read_json("${1:path}")', "Read JSON"],
  ["read_ndjson", 'read_ndjson("${1:path}")', "Read NDJSON"],
  ["read_excel", 'read_excel("${1:path}")', "Read Excel"],
  ["from_pandas", "from_pandas(${1:pdf})", "From pandas"],
  ["from_numpy", "from_numpy(${1:arr})", "From numpy"],
  ["from_arrow", "from_arrow(${1:table})", "From PyArrow"],
  ["from_dicts", "from_dicts(${1:rows})", "From list of dicts"],
  ["selectors", "selectors", "Column selectors"],
  ["Utf8", "Utf8", "String dtype"],
  ["String", "String", "String dtype"],
  ["Int64", "Int64", "Int64"],
  ["Int32", "Int32", "Int32"],
  ["Float64", "Float64", "Float64"],
  ["Boolean", "Boolean", "Boolean"],
  ["Date", "Date", "Date"],
  ["Datetime", "Datetime", "Datetime"],
  ["Duration", "Duration", "Duration"],
  ["List", "List", "List dtype"],
  ["Struct", "Struct", "Struct dtype"],
  ["Null", "Null", "Null dtype"],
  ["sql", "sql(${1:query})", "SQL against frames"],
  ["int_range", "int_range(${1:0}, ${2:10})", "Integer range"],
  ["date_range", "date_range(${1:start}, ${2:end})", "Date range"],
];

const DF_NS: [string, string, string][] = [
  ["with_columns", "with_columns(${1:exprs})", "Add / replace columns"],
  ["select", "select(${1:exprs})", "Project columns"],
  ["filter", "filter(${1:predicate})", "Keep matching rows"],
  ["sort", 'sort("${1:column}")', "Sort rows"],
  ["group_by", 'group_by("${1:column}")', "Group then .agg()"],
  ["agg", "agg(${1:exprs})", "Aggregate"],
  ["join", "join(${1:other}, on=${2:None})", "Join"],
  ["unique", "unique()", "Distinct rows"],
  ["drop", 'drop("${1:column}")', "Drop columns"],
  ["drop_nulls", "drop_nulls()", "Drop null rows"],
  ["fill_null", "fill_null(${1:value})", "Fill nulls"],
  ["rename", "rename({${1:old}: ${2:new}})", "Rename columns"],
  ["head", "head(${1:10})", "First n rows"],
  ["tail", "tail(${1:10})", "Last n rows"],
  ["slice", "slice(${1:0}, ${2:10})", "Slice rows"],
  ["limit", "limit(${1:10})", "Limit rows"],
  ["height", "height", "Row count"],
  ["width", "width", "Column count"],
  ["columns", "columns", "Column names"],
  ["schema", "schema", "Name → dtype"],
  ["dtypes", "dtypes", "List of dtypes"],
  ["null_count", "null_count()", "Nulls per column"],
  ["is_empty", "is_empty()", "True if no rows"],
  ["clone", "clone()", "Copy"],
  ["explode", 'explode("${1:column}")', "Explode a list column"],
  ["unpivot", "unpivot()", "Unpivot"],
  ["pivot", "pivot(${1:args})", "Pivot"],
  ["hstack", "hstack(${1:columns})", "Horizontal concat"],
  ["vstack", "vstack(${1:other})", "Vertical concat"],
  ["with_row_index", 'with_row_index("${1:index}")', "Add row index"],
  ["shift", "shift(${1:1})", "Shift values"],
  ["reverse", "reverse()", "Reverse rows"],
  ["sample", "sample(${1:n})", "Random sample"],
  ["describe", "describe()", "Summary stats"],
  ["to_numpy", "to_numpy()", "To numpy"],
  ["to_dicts", "to_dicts()", "List of dicts"],
  ["write_csv", 'write_csv("${1:path}")', "Write CSV"],
  ["write_parquet", 'write_parquet("${1:path}")', "Write Parquet"],
  ["lazy", "lazy()", "Lazy frame"],
  ["cast", "cast(${1:dtype})", "Cast"],
];

const EXPR: [string, string, string][] = [
  ["alias", 'alias("${1:name}")', "Rename expression"],
  ["cast", "cast(pl.${1:Utf8}, strict=False)", "Cast dtype"],
  ["fill_null", "fill_null(${1:value})", "Fill nulls"],
  ["is_null", "is_null()", "Null mask"],
  ["is_not_null", "is_not_null()", "Not-null mask"],
  ["is_in", "is_in(${1:values})", "Membership"],
  ["is_between", "is_between(${1:lo}, ${2:hi})", "Between"],
  ["abs", "abs()", "Absolute value"],
  ["round", "round(${1:0})", "Round"],
  ["clip", "clip(${1:lo}, ${2:hi})", "Clip"],
  ["unique", "unique()", "Unique values"],
  ["sort", "sort()", "Sort this column"],
  ["shift", "shift(${1:1})", "Shift"],
  ["diff", "diff()", "Difference"],
  ["rank", "rank()", "Rank"],
  ["over", 'over("${1:column}")', "Window"],
  ["replace", "replace(${1:old}, ${2:new})", "Replace values"],
  ["str", "str", "String namespace"],
  ["dt", "dt", "Datetime namespace"],
  ["list", "list", "List namespace"],
  ["arr", "arr", "Array namespace"],
  ["struct", "struct", "Struct namespace"],
  ["cat", "cat", "Categorical namespace"],
  ["sum", "sum()", "Sum"],
  ["mean", "mean()", "Mean"],
  ["min", "min()", "Min"],
  ["max", "max()", "Max"],
  ["count", "count()", "Count"],
  ["n_unique", "n_unique()", "N unique"],
  ["first", "first()", "First"],
  ["last", "last()", "Last"],
  ["explode", "explode()", "Explode list"],
  ["map_elements", "map_elements(${1:fn})", "Python udf (slow)"],
];

const STR: [string, string, string][] = [
  ["to_lowercase", "to_lowercase()", "Lowercase"],
  ["to_uppercase", "to_uppercase()", "Uppercase"],
  ["to_titlecase", "to_titlecase()", "Title case"],
  ["strip_chars", "strip_chars()", "Trim"],
  ["strip_chars_start", "strip_chars_start()", "Ltrim"],
  ["strip_chars_end", "strip_chars_end()", "Rtrim"],
  ["len_chars", "len_chars()", "Character length"],
  ["contains", 'contains("${1:pattern}")', "Contains pattern"],
  ["starts_with", 'starts_with("${1:prefix}")', "Prefix"],
  ["ends_with", 'ends_with("${1:suffix}")', "Suffix"],
  ["replace", 'replace("${1:old}", "${2:new}")', "Replace first"],
  ["replace_all", 'replace_all("${1:old}", "${2:new}")', "Replace all"],
  ["extract", 'extract("${1:pattern}")', "Regex extract"],
  ["split", 'split("${1:,}")', "Split to list"],
  ["slice", "slice(${1:0}, ${2:None})", "Substring"],
  ["head", "head(${1:n})", "First n chars"],
  ["tail", "tail(${1:n})", "Last n chars"],
  ["zfill", "zfill(${1:width})", "Zero pad"],
  ["to_integer", "to_integer()", "Parse int"],
  ["to_datetime", "to_datetime()", "Parse datetime"],
  ["strptime", 'strptime("${1:%Y-%m-%d}")', "Parse with format"],
  ["normalize", 'normalize("NFC")', "Unicode NFC"],
  ["json_decode", "json_decode()", "Parse JSON"],
];

const DT: [string, string, string][] = [
  ["year", "year()", "Year"],
  ["month", "month()", "Month"],
  ["day", "day()", "Day"],
  ["hour", "hour()", "Hour"],
  ["minute", "minute()", "Minute"],
  ["second", "second()", "Second"],
  ["weekday", "weekday()", "Weekday"],
  ["week", "week()", "ISO week"],
  ["strftime", 'strftime("${1:%Y-%m-%d}")', "Format string"],
  ["truncate", 'truncate("${1:1d}")', "Truncate"],
  ["offset_by", 'offset_by("${1:1d}")', "Add interval"],
  ["date", "date()", "Date part"],
  ["time", "time()", "Time part"],
];

const LIST: [string, string, string][] = [
  ["len", "len()", "List length"],
  ["get", "get(${1:0})", "Get index"],
  ["first", "first()", "First element"],
  ["last", "last()", "Last element"],
  ["join", 'join("${1:,}")', "Join to string"],
  ["unique", "unique()", "Unique elements"],
  ["sort", "sort()", "Sort list"],
  ["eval", "eval(${1:expr})", "Eval per-element"],
  ["contains", "contains(${1:value})", "Contains value"],
];

const NP: [string, string, string][] = [
  ["array", "array(${1:obj})", "Create array"],
  ["zeros", "zeros(${1:shape})", "Zeros"],
  ["ones", "ones(${1:shape})", "Ones"],
  ["arange", "arange(${1:0}, ${2:10})", "Range"],
  ["linspace", "linspace(${1:0}, ${2:1}, ${3:50})", "Linear space"],
  ["mean", "mean(${1:a})", "Mean"],
  ["sum", "sum(${1:a})", "Sum"],
  ["min", "min(${1:a})", "Min"],
  ["max", "max(${1:a})", "Max"],
  ["abs", "abs(${1:a})", "Abs"],
  ["sqrt", "sqrt(${1:a})", "Sqrt"],
  ["where", "where(${1:cond}, ${2:x}, ${3:y})", "Where"],
  ["unique", "unique(${1:a})", "Unique"],
  ["isnan", "isnan(${1:a})", "Is NaN"],
  ["nan_to_num", "nan_to_num(${1:a})", "NaN to number"],
];

const PA: [string, string, string][] = [
  ["table", "table", "Table"],
  ["array", "array", "Array"],
  ["schema", "schema", "Schema"],
  ["csv", "csv", "CSV module"],
  ["parquet", "parquet", "Parquet module"],
];

const SQL_KW = [
  "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "LIMIT", "OFFSET", "JOIN",
  "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL OUTER JOIN", "CROSS JOIN", "ON",
  "AS", "AND", "OR", "NOT", "IN", "IS", "NULL", "DISTINCT", "HAVING", "UNION ALL",
  "CASE", "WHEN", "THEN", "ELSE", "END", "WITH", "CAST", "TRY_CAST", "COALESCE",
  "NULLIF", "EXISTS", "BETWEEN", "LIKE", "ILIKE", "TRUE", "FALSE", "ASC", "DESC",
  "OVER", "PARTITION BY", "USING", "QUALIFY", "UNNEST", "WINDOW",
];

const SQL_FN: [string, string, string][] = [
  ["COUNT", "COUNT(${1:*})", "Count"],
  ["SUM", "SUM(${1:col})", "Sum"],
  ["AVG", "AVG(${1:col})", "Average"],
  ["MIN", "MIN(${1:col})", "Min"],
  ["MAX", "MAX(${1:col})", "Max"],
  ["COALESCE", "COALESCE(${1:a}, ${2:b})", "First non-null"],
  ["TRY_CAST", "TRY_CAST(${1:col} AS ${2:VARCHAR})", "Safe cast"],
  ["CAST", "CAST(${1:col} AS ${2:VARCHAR})", "Cast"],
  ["LOWER", "lower(${1:col})", "Lowercase"],
  ["UPPER", "upper(${1:col})", "Uppercase"],
  ["TRIM", "trim(${1:col})", "Trim"],
  ["LENGTH", "length(${1:col})", "Length"],
  ["REPLACE", "replace(${1:col}, ${2:'old'}, ${3:'new'})", "Replace"],
  ["REGEXP_REPLACE", "regexp_replace(${1:col}, ${2:'pattern'}, ${3:'repl'})", "Regex replace"],
  ["DATE_TRUNC", "date_trunc('${1:day}', ${2:col})", "Truncate date"],
  ["STRFTIME", "strftime(${1:col}, '${2:%Y-%m-%d}')", "Format date"],
  ["CONCAT", "concat(${1:a}, ${2:b})", "Concat"],
  ["ROUND", "round(${1:col}, ${2:2})", "Round"],
];

const PY_SNIPPETS: [string, string, string][] = [
  ["import polars as pl", "import polars as pl\n", "Polars (also injected as pl)"],
  ["import numpy as np", "import numpy as np\n", "NumPy (also injected as np)"],
  ["import pyarrow as pa", "import pyarrow as pa\n", "PyArrow (also injected as pa)"],
  ["with_columns strip", 'df = df.with_columns(pl.col("${1:column}").cast(pl.Utf8, strict=False).str.strip_chars())', "Strip one column"],
  ["lowercase", 'df = df.with_columns(pl.col("${1:column}").str.to_lowercase())', "Lowercase"],
  ["filter not null", 'df = df.filter(pl.col("${1:column}").is_not_null())', "Drop nulls in a column"],
  ["cast utf8", 'df = df.with_columns(pl.col("${1:column}").cast(pl.Utf8, strict=False))', "Cast to string"],
  ["fill_null", 'df = df.with_columns(pl.col("${1:column}").fill_null(${2:""}))', "Fill nulls"],
];

const JS_SNIPPETS: [string, string, string][] = [
  ["return row", "return row;", "Return the mutated row"],
  ["trim lowercase", "row.${1:col} = String(row.${1:col} ?? '').trim().toLowerCase();\nreturn row;", "Trim + lowercase"],
  ["null if empty", "if (row.${1:col} === '') row.${1:col} = null;\nreturn row;", "Empty string → null"],
];

function quoteIdent(name: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

function parsePyImports(src: string) {
  const aliases: Record<string, string> = {
    pl: "polars",
    polars: "polars",
    np: "numpy",
    numpy: "numpy",
    pa: "pyarrow",
    df: "dataframe",
    data: "dataframe",
  };
  const reAs = /(?:^|\n)\s*import\s+([A-Za-z_][\w.]*)(?:\s+as\s+([A-Za-z_]\w*))?/g;
  const reFrom = /(?:^|\n)\s*from\s+([A-Za-z_][\w.]*)\s+import\s+([^\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = reAs.exec(src))) {
    aliases[m[2] || m[1].split(".").pop() || m[1]] = m[1];
  }
  while ((m = reFrom.exec(src))) {
    const mod = m[1];
    for (const part of m[2].split(",")) {
      const bits = part.trim().split(/\s+as\s+/);
      const name = (bits[1] || bits[0] || "").trim();
      if (name && name !== "*") aliases[name] = `${mod}.${bits[0].trim()}`;
    }
  }
  return aliases;
}

function makeItem(
  monaco: Monaco,
  range: Range,
  label: string,
  insert: string,
  detail: string,
  kind: number,
  docs?: string,
  snippet = false,
) {
  const it: Record<string, unknown> = {
    label,
    insertText: insert,
    detail,
    documentation: docs || detail,
    kind,
    range,
    sortText: label.startsWith("_") ? `z${label}` : `0${label}`,
  };
  if (snippet || insert.includes("${")) {
    it.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  }
  return it;
}

function pyCompletions(monaco: Monaco, model: { getValue(): string; getLineContent(n: number): string }, pos: { lineNumber: number; column: number }, range: Range) {
  const K = monaco.languages.CompletionItemKind;
  const src = model.getValue();
  const line = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
  const aliases = parsePyImports(src);
  const out: Record<string, unknown>[] = [];
  const add = (label: string, insert: string, detail: string, kind: number, docs?: string, snippet = false) => {
    out.push(makeItem(monaco, range, label, insert, detail, kind, docs, snippet));
  };

  if (/\bfrom\s+polars\s+import\s+[\w,\s]*$/.test(line)) {
    for (const [n, ins, d] of PL_NS) add(n, n.includes("(") ? n : ins.includes("(") ? n : n, "polars", K.EnumMember, d);
    return out;
  }
  if (/\bfrom\s+numpy\s+import\s+[\w,\s]*$/.test(line)) {
    for (const [n, , d] of NP) add(n, n, "numpy", K.Function, d);
    return out;
  }
  if (/\bimport\s+\w*$/.test(line) || /\bfrom\s+\w*$/.test(line)) {
    const seen = new Set<string>();
    for (const [n, ins, d] of [...pyInstalled, ...PY_MODULES]) {
      if (seen.has(n)) continue;
      seen.add(n);
      add(n, n, d, K.Module, ins);
    }
    return out;
  }

  const root = lastRoot(line);
  if (root) {
    const resolved = aliases[root] || root;
    if (root === "str") {
      for (const [n, ins, d] of STR) add(n, ins, `str.${n}`, K.Method, d, true);
      return out;
    }
    if (root === "dt") {
      for (const [n, ins, d] of DT) add(n, ins, `dt.${n}`, K.Method, d, true);
      return out;
    }
    if (root === "list") {
      for (const [n, ins, d] of LIST) add(n, ins, `list.${n}`, K.Method, d, true);
      return out;
    }
    if (resolved === "polars" || root === "pl" || root === "polars") {
      for (const [n, ins, d] of PL_NS) {
        const snippet = ins.includes("${") || ins.includes("(");
        add(n, ins, `pl.${n}`, n[0] === n[0].toUpperCase() ? K.Class : K.Function, d, snippet);
      }
      return out;
    }
    if (resolved === "dataframe" || root === "df" || root === "data") {
      for (const [n, ins, d] of DF_NS) add(n, ins, `df.${n}`, K.Method, d, ins.includes("(") || ins.includes("${"));
      for (const c of columns) add(c, c, "column", K.Field);
      return out;
    }
    if (resolved === "numpy" || root === "np") {
      for (const [n, ins, d] of NP) add(n, ins, `np.${n}`, K.Function, d, true);
      return out;
    }
    if (resolved === "pyarrow" || root === "pa") {
      for (const [n, ins, d] of PA) add(n, ins, `pa.${n}`, K.Module, d);
      return out;
    }
    for (const [n, ins, d] of EXPR) add(n, ins, n, K.Method, d, ins.includes("(") || ins.includes("${"));
    return out;
  }

  for (const [n, ins, d] of pyInstalled) add(`import ${n}`, ins, d, K.Module, d, true);
  add("df", "df", "Current Polars DataFrame (injected)", K.Variable, "Assign the result back to df.");
  add("data", "data", "Alias of df (injected)", K.Variable);
  add("pl", "pl", "polars (injected — import optional)", K.Module);
  add("polars", "polars", "polars (injected)", K.Module);
  add("np", "np", "numpy (injected)", K.Module);
  add("numpy", "numpy", "numpy (injected)", K.Module);
  add("pa", "pa", "pyarrow (injected)", K.Module);
  add("rapidfuzz", "rapidfuzz", "Fuzzy matching if installed", K.Module);
  for (const c of columns) add(c, `pl.col(${JSON.stringify(c)})`, "column", K.Field, "Current dataset column");
  for (const [label, ins, d] of PY_SNIPPETS) add(label, ins, "snippet", K.Snippet, d, true);
  for (const s of pluginSnippets.filter((x) => (x.language || "python").toLowerCase() === "python")) {
    add(s.label, s.insertText, s.detail || "plugin", K.Snippet, s.detail, true);
  }
  for (const [n, ins, d] of PY_MODULES) add(`import ${n}`, ins, d, K.Module, d, true);
  return out;
}

function sqlCompletions(monaco: Monaco, line: string, range: Range) {
  const K = monaco.languages.CompletionItemKind;
  const out: Record<string, unknown>[] = [];
  const add = (label: string, insert: string, detail: string, kind: number, snippet = false) => {
    out.push(makeItem(monaco, range, label, insert, detail, kind, detail, snippet));
  };
  if (/\b(FROM|JOIN)\s+[A-Za-z0-9_]*$/i.test(line)) {
    add("data", "data", "DuckDB table (current frame)", K.Struct);
    add("df", "df", "Alias of data", K.Struct);
    return out;
  }
  for (const c of columns) add(quoteIdent(c), quoteIdent(c), "column", K.Field);
  add("data", "data", "Current frame", K.Struct);
  add("df", "df", "Current frame", K.Struct);
  for (const kw of SQL_KW) add(kw, kw, "SQL", K.Keyword);
  for (const [n, ins, d] of SQL_FN) add(n, ins, d, K.Function, true);
  for (const s of pluginSnippets.filter((x) => (x.language || "").toLowerCase() === "sql")) {
    add(s.label, s.insertText, s.detail || "plugin", K.Snippet, true);
  }
  if (!line.trim() || /SELECT\s*$/i.test(line)) {
    add("SELECT * FROM data", "SELECT * FROM data", "All rows", K.Snippet, true);
  }
  return out;
}

function jsCompletions(monaco: Monaco, line: string, range: Range) {
  const K = monaco.languages.CompletionItemKind;
  const out: Record<string, unknown>[] = [];
  const add = (label: string, insert: string, detail: string, kind: number, snippet = false) => {
    out.push(makeItem(monaco, range, label, insert, detail, kind, detail, snippet));
  };
  if (/\brequire\s*\(\s*['"][^'"]*$/.test(line)) {
    for (const n of jsInstalled) add(n, n, "libraries/node_modules", K.Module);
    return out;
  }
  if (/\brow\.\s*$/.test(line) || /\brow\.\w*$/.test(line)) {
    for (const c of columns) {
      const ins = /^[A-Za-z_][A-Za-z0-9_]*$/.test(c) ? c : `[${JSON.stringify(c)}]`;
      add(c, ins, "row field", K.Field);
    }
    return out;
  }
  add("require", "require('${1:package}')", "Load an npm package from libraries/", K.Function, true);
  add("row", "row", "Current row object — mutate and return it", K.Variable);
  for (const c of columns) {
    const ins = /^[A-Za-z_][A-Za-z0-9_]*$/.test(c) ? `row.${c}` : `row[${JSON.stringify(c)}]`;
    add(`row.${c}`, ins, "row field", K.Field);
  }
  for (const [label, ins, d] of JS_SNIPPETS) add(label, ins, d, K.Snippet, true);
  for (const s of pluginSnippets.filter((x) => (x.language || "").toLowerCase() === "javascript")) {
    add(s.label, s.insertText, s.detail || "plugin", K.Snippet, true);
  }
  add("Object.keys", "Object.keys(row)", "Column names", K.Function);
  add("String", "String(${1:value})", "To string", K.Function, true);
  add("Number", "Number(${1:value})", "To number", K.Function, true);
  add("JSON.stringify", "JSON.stringify(row)", "Serialize row", K.Function);
  return out;
}

export function registerIntellisense(monaco: Monaco) {
  const g = monaco as Monaco & { __drsIntel?: boolean };
  if (g.__drsIntel) return;
  g.__drsIntel = true;
  monacoRef = monaco;

  monaco.languages.registerCompletionItemProvider("python", {
    triggerCharacters: [".", "_", " ", ",", "(", '"', "'"],
    provideCompletionItems: (model, position) => ({
      suggestions: pyCompletions(monaco, model, position, wordRange(model, position)) as never,
    }),
  });

  monaco.languages.registerHoverProvider("python", {
    provideHover: (model, position) => {
      const w = model.getWordAtPosition(position);
      if (!w) return null;
      const docs: Record<string, string> = {
        df: "Polars DataFrame for this session. Assign the result back to `df`.",
        pl: "The `polars` module (injected — `import polars as pl` is optional).",
        polars: "Polars. Prefer `pl.col`, `df.with_columns`.",
        np: "NumPy (injected as `np`).",
        pa: "PyArrow (injected as `pa`).",
        data: "Alias of `df`.",
      };
      const d = docs[w.word];
      if (!d) return null;
      return { contents: [{ value: `**${w.word}** — ${d}` }] };
    },
  });

  monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: [" ", ".", ",", "("],
    provideCompletionItems: (model, position) => {
      const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      return { suggestions: sqlCompletions(monaco, line, wordRange(model, position)) as never };
    },
  });

  monaco.languages.registerCompletionItemProvider("javascript", {
    triggerCharacters: [".", " ", "("],
    provideCompletionItems: (model, position) => {
      const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      return { suggestions: jsCompletions(monaco, line, wordRange(model, position)) as never };
    },
  });

  try {
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
    });
    monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
      allowNonTsExtensions: true,
      checkJs: true,
      target: monaco.languages.typescript.ScriptTarget.ESNext,
      allowJs: true,
    });
  } catch {
    /* typescript language not loaded yet */
  }
  refreshJsLib();
}
