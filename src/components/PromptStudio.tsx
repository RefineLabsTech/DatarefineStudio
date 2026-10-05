import { useMemo, useRef, useState, type CSSProperties } from "react";
import { AlertCircle, Check, ChevronDown, ChevronRight, Eye, Info, RotateCcw, Save, Sparkles } from "lucide-react";

export type PromptStepId = "structural" | "semantic" | "validation";

export type PromptMap = Record<string, string>;

type PromptStudioProps = {
  prompts: PromptMap;
  onChange: (next: PromptMap) => void;
  onSave: () => Promise<void>;
  message: string;
  loading?: boolean;
};

type PromptStep = {
  id: PromptStepId;
  label: string;
  short: string;
  purpose: string;
  guidance: string;
};

const PROMPT_STEPS: PromptStep[] = [
  {
    id: "structural",
    label: "Structural",
    short: "Schema & types",
    purpose: "Repair headers, types, and schema mapping without inventing data.",
    guidance: "Ask for deterministic, reversible fixes to column names, data types, and structural inconsistencies.",
  },
  {
    id: "semantic",
    label: "Semantic",
    short: "Meaning & entities",
    purpose: "Improve missing values, categories, and entity consistency.",
    guidance: "Describe how the model should interpret values while preferring reusable rules over one-off edits.",
  },
  {
    id: "validation",
    label: "Validation",
    short: "Rules & quality",
    purpose: "Identify business-rule violations, compliance risks, and outliers.",
    guidance: "Define the quality checks that matter and when a clear suggested replacement is safe.",
  },
];

const VARIABLES = [
  { token: "{step}", label: "Step", description: "Current pipeline stage" },
  { token: "{columns}", label: "Columns", description: "Active column names" },
  { token: "{sample}", label: "Sample", description: "Local sample rows" },
  { token: "{extra}", label: "Extra", description: "User instructions" },
];

const SAMPLE_CONTEXT = {
  step: "semantic",
  columns: "customer_id, email, signup_date, country",
  sample: '[{"customer_id":"C-1042","email":" JANE@EXAMPLE.COM ","country":"BD"}]',
  extra: "Keep changes deterministic, explain confidence, and do not invent rows.",
};

const MAX_PROMPT_CHARS = 12000;

const panel: CSSProperties = {
  borderRadius: 12,
  padding: 14,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  display: "grid",
  gap: 12,
};

const subtleButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  border: "1px solid var(--border)",
  borderRadius: 7,
  background: "var(--bg-elev)",
  color: "var(--text)",
  padding: "5px 8px",
  fontSize: 10.5,
  fontWeight: 650,
  cursor: "pointer",
};

const chip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  border: "1px solid var(--border)",
  borderRadius: 999,
  background: "var(--bg-elev)",
  color: "var(--text-dim)",
  padding: "3px 7px",
  fontSize: 10,
  cursor: "pointer",
};

export function analyzePrompt(template: string) {
  const matches = [...template.matchAll(/\{([a-zA-Z][\w]*)\}/g)].map((m) => m[1]);
  const unique = [...new Set(matches)];
  const allowed = new Set(VARIABLES.map((v) => v.token.slice(1, -1)));
  const unknown = unique.filter((token) => !allowed.has(token));
  const warnings: string[] = [];
  const open = (template.match(/\{/g) || []).length;
  const close = (template.match(/\}/g) || []).length;

  if (template.length > MAX_PROMPT_CHARS) {
    warnings.push(`Prompt is longer than ${MAX_PROMPT_CHARS.toLocaleString()} characters.`);
  }
  if (open !== close) {
    warnings.push("Unbalanced braces detected. Escape literal braces as {{ and }} when needed.");
  }
  if (unknown.length) {
    warnings.push(`Unknown placeholder${unknown.length === 1 ? "" : "s"}: ${unknown.map((x) => `{${x}}`).join(", ")}.`);
  }
  if (template.trim() && !matches.some((token) => token === "columns" || token === "sample")) {
    warnings.push("This template does not include dataset context ({columns} or {sample}).");
  }

  return { matches: unique, unknown, warnings };
}

function previewPrompt(template: string, step: PromptStepId) {
  if (!template.trim()) {
    return "Built-in default prompt is active. Add an override above to preview your customized instruction with sample context.";
  }
  const values: Record<string, string> = { ...SAMPLE_CONTEXT, step };
  return template.replace(/\{(step|columns|sample|extra)\}/g, (_, key: string) => values[key] || "");
}

function statusColor(message: string) {
  if (/failed|error|could not|unable/i.test(message)) return "var(--danger, #ef4444)";
  if (/saved|ready|default/i.test(message)) return "var(--ok, #22c55e)";
  return "var(--text-dim)";
}

export function PromptStudio({ prompts, onChange, onSave, message, loading = false }: PromptStudioProps) {
  const [active, setActive] = useState<PromptStepId>("structural");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const step = PROMPT_STEPS.find((item) => item.id === active) || PROMPT_STEPS[0];
  const value = String(prompts[active] || "");
  const analysis = useMemo(() => analyzePrompt(value), [value]);
  const isDefault = !value.trim();
  const approximateTokens = value.trim() ? Math.ceil(value.length / 4) : 0;

  const updateValue = (next: string) => onChange({ ...prompts, [active]: next });

  const resetCurrent = () => {
    const next = { ...prompts };
    delete next[active];
    onChange(next);
  };

  const insertVariable = (token: string) => {
    const editor = editorRef.current;
    const start = editor?.selectionStart ?? value.length;
    const end = editor?.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}${token}${value.slice(end)}`;
    updateValue(next);
    requestAnimationFrame(() => {
      editor?.focus();
      const cursor = start + token.length;
      editor?.setSelectionRange(cursor, cursor);
    });
  };

  const save = async () => {
    if (saving || loading) return;
    setSaving(true);
    try {
      await onSave();
    } finally {
      setSaving(false);
    }
  };

  return (
    <section style={panel} aria-labelledby="prompt-studio-title">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div
          style={{
            width: 30,
            height: 30,
            flexShrink: 0,
            display: "grid",
            placeItems: "center",
            borderRadius: 8,
            color: "var(--accent)",
            background: "color-mix(in srgb, var(--accent) 14%, var(--bg-elev))",
            border: "1px solid color-mix(in srgb, var(--accent) 30%, var(--border))",
          }}
        >
          <Sparkles size={15} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <h2 id="prompt-studio-title" style={{ fontSize: 13, fontWeight: 700, margin: 0 }}>
              Prompt studio
            </h2>
            <span style={{ ...chip, cursor: "default", color: "var(--accent)" }}>AI quality pipeline</span>
          </div>
          <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>
            Tune the instructions used when the model refines plan titles. Leave a step blank to use DataRefine’s maintained default.
          </div>
        </div>
        <div style={{ ...chip, cursor: "default", color: isDefault ? "var(--text-dim)" : "var(--accent)" }}>
          {loading ? "Loading…" : isDefault ? "Default active" : "Custom override"}
        </div>
      </div>

      <div role="tablist" aria-label="Prompt stages" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 5 }}>
        {PROMPT_STEPS.map((item) => {
          const selected = item.id === active;
          const customized = Boolean(String(prompts[item.id] || "").trim());
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={selected}
              disabled={loading}
              onClick={() => setActive(item.id)}
              style={{
                minWidth: 0,
                textAlign: "left",
                border: selected ? "1px solid var(--accent)" : "1px solid var(--border)",
                borderRadius: 8,
                padding: "7px 8px",
                background: selected ? "color-mix(in srgb, var(--accent) 13%, var(--bg-elev))" : "var(--bg-elev)",
                color: selected ? "var(--text)" : "var(--text-dim)",
                opacity: loading ? 0.55 : 1,
                cursor: loading ? "wait" : "pointer",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10.5, fontWeight: 700 }}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 99,
                    flexShrink: 0,
                    background: customized ? "var(--accent)" : "var(--border)",
                  }}
                />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.label}</span>
              </div>
              <div style={{ marginTop: 3, fontSize: 9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.short}</div>
            </button>
          );
        })}
      </div>

      <div style={{ display: "grid", gap: 9, padding: 10, borderRadius: 9, background: "var(--bg-elev)", border: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, fontWeight: 700 }}>{step.label} prompt</span>
              <span style={{ ...chip, cursor: "default", color: isDefault ? "var(--ok, #22c55e)" : "var(--accent)" }}>
                {isDefault ? "Using built-in" : "Override"}
              </span>
            </div>
            <div style={{ marginTop: 3, fontSize: 10.5, color: "var(--text-dim)", lineHeight: 1.4 }}>{step.purpose}</div>
          </div>
          <button
            type="button"
            title={`Reset ${step.label.toLowerCase()} prompt to the built-in default`}
            aria-label={`Reset ${step.label.toLowerCase()} prompt to the built-in default`}
            disabled={loading || isDefault}
            onClick={resetCurrent}
            style={{ ...subtleButton, opacity: loading || isDefault ? 0.45 : 1 }}
          >
            <RotateCcw size={12} /> Reset
          </button>
        </div>

        <textarea
          ref={editorRef}
          aria-label={`${step.label} prompt template`}
          spellCheck
          disabled={loading}
          value={value}
          onChange={(e) => updateValue(e.target.value)}
          placeholder={`Optional ${step.label.toLowerCase()} instructions. Leave blank to use the built-in default.`}
          style={{
            width: "100%",
            minHeight: 148,
            boxSizing: "border-box",
            resize: "vertical",
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
            fontSize: 11,
            lineHeight: 1.5,
            background: "var(--panel, #151a23)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            color: "var(--text)",
            padding: "10px 11px",
            outline: "none",
            opacity: loading ? 0.55 : 1,
          }}
        />

        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, color: "var(--text-dim)", marginRight: 2 }}>Insert context:</span>
          {VARIABLES.map((variable) => (
            <button
              key={variable.token}
              type="button"
              title={variable.description}
              disabled={loading}
              onClick={() => insertVariable(variable.token)}
              style={{ ...chip, opacity: loading ? 0.5 : 1 }}
            >
              {variable.label}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", fontSize: 10 }}>
          <span style={{ color: "var(--text-dim)" }}>
            {value.length.toLocaleString()} characters · ~{approximateTokens.toLocaleString()} tokens
          </span>
          <span style={{ color: analysis.warnings.length ? "var(--warn, #f59e0b)" : "var(--ok, #22c55e)", display: "inline-flex", alignItems: "center", gap: 4 }}>
            {analysis.warnings.length ? <AlertCircle size={11} /> : <Check size={11} />}
            {analysis.warnings.length ? `${analysis.warnings.length} review note${analysis.warnings.length === 1 ? "" : "s"}` : "Template looks good"}
          </span>
        </div>
      </div>

      {analysis.warnings.length > 0 && (
        <div style={{ display: "grid", gap: 4, padding: "8px 10px", borderRadius: 8, border: "1px solid color-mix(in srgb, var(--warn, #f59e0b) 35%, var(--border))", background: "color-mix(in srgb, var(--warn, #f59e0b) 8%, var(--bg))", color: "var(--text-dim)", fontSize: 10.5, lineHeight: 1.4 }}>
          {analysis.warnings.map((warning) => (
            <div key={warning} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
              <Info size={12} style={{ flexShrink: 0, marginTop: 1, color: "var(--warn, #f59e0b)" }} />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gap: 6 }}>
        <button
          type="button"
          onClick={() => setPreviewOpen((open) => !open)}
          style={{ ...subtleButton, justifyContent: "flex-start", width: "100%", background: "transparent", color: "var(--text-dim)" }}
        >
          {previewOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <Eye size={13} />
          {previewOpen ? "Hide resolved prompt preview" : "Preview resolved prompt"}
          <span style={{ marginLeft: "auto", fontSize: 9 }}>sample context</span>
        </button>
        {previewOpen && (
          <pre style={{ margin: 0, maxHeight: 230, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", padding: 10, borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel, #151a23)", color: "var(--text-dim)", fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: 10.5, lineHeight: 1.5 }}>
            {previewPrompt(value, active)}
          </pre>
        )}
      </div>

      <details open={guideOpen} onToggle={(event) => setGuideOpen((event.currentTarget as HTMLDetailsElement).open)}>
        <summary style={{ cursor: "pointer", color: "var(--text-dim)", fontSize: 10.5, display: "flex", alignItems: "center", gap: 5 }}>
          <Info size={12} /> Writing guidance for {step.label.toLowerCase()} prompts
        </summary>
        <div style={{ marginTop: 7, padding: "8px 10px", borderRadius: 8, background: "var(--bg-elev)", border: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 10.5, lineHeight: 1.5 }}>
          {step.guidance} Keep the response machine-readable: the cleaning pipeline expects a JSON array of proposals with column, original, suggested, confidence, reason, and rule fields.
        </div>
      </details>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", paddingTop: 2 }}>
        <button
          type="button"
          onClick={() => void save()}
          disabled={loading || saving}
          style={{ ...subtleButton, flex: 1, minWidth: 120, background: "var(--accent)", borderColor: "transparent", color: "#fff", opacity: loading || saving ? 0.6 : 1 }}
        >
          <Save size={13} />
          {saving ? "Saving…" : "Save prompt configuration"}
        </button>
        {message && (
          <span role="status" style={{ fontSize: 10.5, color: statusColor(message), maxWidth: "100%" }}>
            {message}
          </span>
        )}
      </div>
    </section>
  );
}
