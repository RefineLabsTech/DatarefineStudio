import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Check, CircleAlert, Code, Play, ScanSearch, Sparkles } from "lucide-react";
import { api, type Metrics, type ProfileCol } from "../ipc/client";
import { datarefineAi, type RouterDecision } from "../services/ai";
import { useUI } from "../store/ui";
import { useWorkspace } from "../store/workspace";

type CodeLanguage = "python" | "sql" | "javascript";

type CodeScan = {
  sid: string;
  rows: number;
  columns: number;
  missing: number;
  duplicates: number;
  columnNames: string[];
  profiles: ProfileCol[];
  sample: unknown[][];
  scannedAt: string;
  runtime: RouterDecision;
};

const LANGUAGE_LABELS: Record<CodeLanguage, string> = {
  python: "Python",
  sql: "SQL",
  javascript: "JavaScript",
};

function extractCode(raw: string) {
  const value = String(raw || "").trim();
  const fenced = value.match(/```(?:python|py|sql|javascript|js)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : value).trim();
}

function buildPrompt(scan: CodeScan, language: CodeLanguage, instructions: string) {
  const profile = scan.profiles
    .map((item) => ({
      name: item.name,
      inferred: item.inferred,
      active: item.active,
      null_pct: item.null_pct,
      unique_count: item.unique_count,
      dtype: item.dtype,
    }))
    .slice(0, 120);
  const sample = JSON.stringify({ columns: scan.columnNames, rows: scan.sample.slice(0, 20) }, null, 2).slice(0, 16000);
  const languageRules = {
    python: "Generate only executable DataRefine Python editor code. The current Polars DataFrame is named df. Transform it with Polars and assign the result back to df. Do not read files, write files, use network, prompt for input, or import external packages.",
    sql: "Generate only executable DuckDB SQL editor code. The current sheet is available as tables data and df. Return a SELECT statement that produces the cleaned sheet. Do not use network, file paths, or destructive DDL.",
    javascript: "Generate only executable DataRefine JavaScript editor code. It runs once per row with row, rows, and columns available. Mutate or return row with deterministic cleaning changes. Do not use network, filesystem, subprocesses, or browser APIs.",
  }[language];
  return [
    "You are the DataRefine Studio editor-code generator.",
    "The sheet has already been scanned locally. Do not invent columns or rows.",
    languageRules,
    "Return only code. Do not wrap it in Markdown fences. Do not add explanations. Never copy literal cell values from the sample into the code.",
    `Requested language: ${LANGUAGE_LABELS[language]}`,
    `User instructions: ${instructions.trim() || "Use the scan to propose conservative, reversible data-quality cleaning."}`,
    `Whole-sheet metrics: rows=${scan.rows}, columns=${scan.columns}, missing_cells=${scan.missing}, duplicate_rows=${scan.duplicates}`,
    `Column profiles: ${JSON.stringify(profile)}`,
    `Bounded sample from the local sheet: ${sample}`,
  ].join("\n\n");
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Code generation failed.");
}

export function AiCodeGeneratorPluginView() {
  const sessionId = useWorkspace((state) => state.sessionId);
  const workspaceRunning = useWorkspace((state) => state.running);
  const setEditors = useWorkspace((state) => state.setEditors);
  const setBottomTab = useUI((state) => state.setBottomTab);
  const setBottomOpen = useUI((state) => state.setBottomOpen);
  const [scan, setScan] = useState<CodeScan | null>(null);
  const [language, setLanguage] = useState<CodeLanguage>("python");
  const [instructions, setInstructions] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [runtime, setRuntime] = useState<RouterDecision | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const scannedCurrentSheet = Boolean(sessionId && scan?.sid === sessionId);
  const locked = busy || scanBusy || workspaceRunning;
  const languageLabel = LANGUAGE_LABELS[language];
  const codeLines = useMemo(() => code ? code.split("\n").length : 0, [code]);

  useEffect(() => {
    if (scan && scan.sid !== sessionId) {
      setScan(null);
      setCode("");
      setRuntime(null);
    }
  }, [scan, sessionId]);

  useEffect(() => {
    if (!busy || !startedAt) return;
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => window.clearInterval(timer);
  }, [busy, startedAt]);

  const scanSheet = async () => {
    if (!sessionId) {
      setError("Open a data sheet before scanning.");
      return;
    }
    setScanBusy(true);
    setError("");
    setMessage("");
    try {
      const [metrics, profiles, viewport, decision] = await Promise.all([
        api.metrics(sessionId),
        api.profile(sessionId),
        api.viewport(sessionId, 0, 80),
        datarefineAi.router(),
      ]);
      const m = metrics as Metrics;
      const next: CodeScan = {
        sid: sessionId,
        rows: Number(m.rows || viewport.total || 0),
        columns: Number(m.columns || viewport.columns.length || 0),
        missing: Number(m.missing || 0),
        duplicates: Number(m.duplicates || 0),
        columnNames: viewport.columns,
        profiles,
        sample: viewport.rows.slice(0, 20),
        scannedAt: new Date().toLocaleTimeString(),
        runtime: decision,
      };
      setScan(next);
      setRuntime(decision);
      setCode("");
      setMessage(`Whole-sheet scan complete · ${next.rows.toLocaleString()} rows profiled.`);
    } catch (errorValue) {
      setError(safeError(errorValue));
    } finally {
      setScanBusy(false);
    }
  };

  const generateCode = async () => {
    if (!sessionId || !scan || scan.sid !== sessionId) {
      setError("Scan the current sheet before generating code.");
      return;
    }
    setBusy(true);
    setStartedAt(Date.now());
    setElapsed(0);
    setError("");
    setMessage(`Generating ${languageLabel} from the scan…`);
    try {
      const result = await datarefineAi.generateCode({
        sessionId,
        language,
        prompt: buildPrompt(scan, language, instructions),
      });
      const generated = extractCode(result.code);
      if (!generated) throw new Error("The AI runtime returned no usable code.");
      setCode(generated);
      setRuntime({ ...scan.runtime, source: result.source });
      setMessage(`${languageLabel} generated · ${generated.split("\n").length} lines. Review it before running.`);
    } catch (errorValue) {
      setError(safeError(errorValue));
      setMessage("");
    } finally {
      setBusy(false);
    }
  };

  const inject = () => {
    if (!code.trim()) {
      setError("Generate or edit code before injecting it.");
      return false;
    }
    setEditors({ [language]: code } as Partial<Pick<ReturnType<typeof useWorkspace.getState>, "sql" | "javascript" | "python">>);
    setBottomTab(language);
    setBottomOpen(true);
    setError("");
    setMessage(`${languageLabel} injected into the ${languageLabel} editor.`);
    return true;
  };

  const injectAndRun = async () => {
    if (!sessionId || !inject()) return;
    setMessage(`Running generated ${languageLabel}…`);
    try {
      await useWorkspace.getState().run(language);
      setMessage(`${languageLabel} injected and run. Review the edited sheet and undo history.`);
    } catch (errorValue) {
      setError(safeError(errorValue));
    }
  };

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.icon}><Code size={15} /></span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={styles.title}>AI Code Generator</div>
          <div style={styles.subtitle}>Scan → generate → inject → run</div>
        </div>
        <span style={styles.chip}>{runtime?.source ? runtime.source.toUpperCase() : "AI"}</span>
      </div>

      <div style={styles.notice}>
        The whole sheet is profiled locally first. Code generation uses the central AI runtime and only runs after you explicitly choose Inject or Inject & run.
      </div>

      <div style={styles.section}>
        <div style={styles.sectionHead}>
          <span style={styles.sectionTitle}>Whole-sheet scan</span>
          {scan?.scannedAt ? <span style={styles.dim}>Scanned {scan.scannedAt}</span> : null}
        </div>
        {scannedCurrentSheet ? (
          <div style={styles.stats}>
            <Stat label="Rows" value={scan?.rows.toLocaleString() || "—"} />
            <Stat label="Columns" value={scan?.columns.toLocaleString() || "—"} />
            <Stat label="Empty" value={scan?.missing.toLocaleString() || "0"} />
            <Stat label="Duplicates" value={scan?.duplicates.toLocaleString() || "0"} />
          </div>
        ) : <div style={styles.dim}>Scan required before code generation.</div>}
        <button type="button" className="button" disabled={locked || !sessionId} onClick={() => void scanSheet()} style={styles.button}>
          <ScanSearch size={13} />
          {scanBusy ? "Scanning whole sheet…" : "Scan whole sheet"}
        </button>
        {runtime?.source === "cloud" ? <div style={styles.warning}>Cloud AI is active. Editor code generation requires Local or BYOK so the scanned sample does not go to Cloud AI.</div> : null}
      </div>

      <div style={styles.section}>
        <div style={styles.sectionHead}>
          <span style={styles.sectionTitle}>Code target</span>
          {busy ? <span style={styles.status}>Working · {elapsed}s</span> : null}
        </div>
        <select className="field" value={language} disabled={locked} onChange={(event) => { setLanguage(event.target.value as CodeLanguage); setCode(""); }}>
          <option value="python">Python · Polars</option>
          <option value="sql">SQL · DuckDB</option>
          <option value="javascript">JavaScript · V8</option>
        </select>
        <textarea className="field" value={instructions} disabled={locked} onChange={(event) => setInstructions(event.target.value)} placeholder="Optional cleaning instructions…" style={styles.instructions} />
        <button type="button" className="button primary" disabled={locked || !scannedCurrentSheet} onClick={() => void generateCode()} style={styles.button}>
          <Sparkles size={13} />
          {busy ? `Generating ${languageLabel}…` : `Generate ${languageLabel}`}
        </button>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionHead}>
          <span style={styles.sectionTitle}>Generated editor code</span>
          <span style={styles.status}>{code ? `${codeLines} lines` : "Empty"}</span>
        </div>
        <textarea className="field" value={code} disabled={locked} onChange={(event) => setCode(event.target.value)} placeholder="Generated code appears here. You can edit it before injecting." style={styles.code} spellCheck={false} />
        <div style={styles.actions}>
          <button type="button" className="button" disabled={locked || !code.trim()} onClick={inject} style={{ ...styles.button, flex: 1 }}>
            <Check size={13} /> Inject into editor
          </button>
          <button type="button" className="button primary" disabled={locked || !code.trim() || !sessionId} onClick={() => void injectAndRun()} style={{ ...styles.button, flex: 1 }}>
            <Play size={13} /> Inject & run
          </button>
        </div>
        <div style={styles.hint}>Inject opens the {languageLabel} editor. Inject & run executes the current code through the normal DataRefine workspace runner and creates the usual undo/history entry.</div>
      </div>

      {error ? <div style={styles.error}><CircleAlert size={13} /><span>{error}</span></div> : null}
      {message ? <div style={styles.message}>{message}</div> : null}
      {!sessionId ? <div style={styles.empty}>Open a data sheet to start.</div> : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div style={styles.stat}><strong>{value}</strong><span>{label}</span></div>;
}

const styles: Record<string, CSSProperties> = {
  root: { padding: 13, display: "grid", gap: 9, color: "var(--text)", fontSize: 11.5 },
  header: { display: "flex", alignItems: "center", gap: 8 },
  icon: { width: 26, height: 26, display: "grid", placeItems: "center", borderRadius: 6, color: "var(--accent, #60a5fa)", background: "var(--bg-input)", border: "1px solid var(--border)", flexShrink: 0 },
  title: { fontSize: 13, fontWeight: 750 },
  subtitle: { fontSize: 9.5, color: "var(--text-dim)", marginTop: 2 },
  chip: { marginLeft: "auto", fontSize: 9, fontWeight: 750, letterSpacing: "0.06em", color: "var(--accent, #60a5fa)", border: "1px solid color-mix(in srgb, var(--accent, #3b82f6) 35%, var(--border))", borderRadius: 99, padding: "3px 7px" },
  notice: { borderLeft: "3px solid var(--accent, #3b82f6)", borderTop: "1px solid var(--border)", borderRight: "1px solid var(--border)", borderBottom: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-dim)", padding: "8px 9px", lineHeight: 1.4, fontSize: 10 },
  section: { display: "grid", gap: 8, padding: 9, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)" },
  sectionHead: { display: "flex", alignItems: "center", gap: 8 },
  sectionTitle: { fontSize: 9.5, fontWeight: 750, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)" },
  dim: { color: "var(--text-dim)", fontSize: 9.5, marginLeft: "auto" },
  status: { color: "var(--text-dim)", fontSize: 9.5, marginLeft: "auto" },
  stats: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 5 },
  stat: { display: "grid", gap: 2, minWidth: 0, padding: "6px 5px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-elev)" },
  button: { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, padding: "6px 8px", fontSize: 10.5, borderRadius: 6 },
  instructions: { minHeight: 48, resize: "vertical", fontSize: 10.5 },
  code: { minHeight: 170, resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: 10.5, lineHeight: 1.4 },
  actions: { display: "flex", gap: 7, flexWrap: "wrap" },
  hint: { color: "var(--text-dim)", fontSize: 9.5, lineHeight: 1.35 },
  warning: { color: "var(--text-dim)", borderLeft: "3px solid var(--accent, #3b82f6)", paddingLeft: 7, fontSize: 9.5, lineHeight: 1.35 },
  error: { display: "flex", alignItems: "flex-start", gap: 6, color: "var(--danger, #ef4444)", border: "1px solid color-mix(in srgb, var(--danger, #ef4444) 35%, var(--border))", background: "var(--bg)", borderRadius: 7, padding: "7px 8px", fontSize: 10, lineHeight: 1.35 },
  message: { color: "var(--text-dim)", border: "1px solid var(--border)", background: "var(--bg)", borderRadius: 7, padding: "7px 8px", fontSize: 10, lineHeight: 1.35 },
  empty: { color: "var(--text-dim)", fontSize: 10, padding: 7 },
};
