import { lazy, memo, Suspense, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { BookmarkPlus, ChevronsDownUp, Eraser, Library, Play } from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { useUI, type BottomTab } from "../store/ui";
import { Console } from "../components/Console";
import { HistoryPanel } from "../components/HistoryPanel";
import { Terminal } from "../components/Terminal";
import { AIPlanDock } from "../components/AIPlanDock";
import { themeDef } from "../theme/themes";
import { api } from "../ipc/client";
import { registerIntellisense, setInstalledLibraries, setIntellisenseColumns } from "./intellisense";

const Editor = lazy(() => import("@monaco-editor/react"));

const TABS: { id: BottomTab; label: string; hint: string }[] = [
  { id: "sql", label: "SQL", hint: "DuckDB" },
  { id: "javascript", label: "JavaScript", hint: "V8" },
  { id: "python", label: "Python", hint: "Polars" },
  { id: "console", label: "Console", hint: "" },
  { id: "aiplan", label: "AI Plan", hint: "" },
  { id: "history", label: "History", hint: "undo points" },
];

export const BottomEditors = memo(function BottomEditors() {
  const { sql, javascript, python, setEditors, run, running, libraryRules, insertLibraryRule, columns } = useWorkspace(
    useShallow((s) => ({
      sql: s.sql,
      javascript: s.javascript,
      python: s.python,
      setEditors: s.setEditors,
      run: s.run,
      running: s.running,
      libraryRules: s.libraryRules,
      insertLibraryRule: s.insertLibraryRule,
      columns: s.columns,
    })),
  );
  const { bottomTab, setBottomTab, bottomOpen, setBottomOpen, theme, toggleSidebar, terminalEnabled, openRuleDialog } = useUI(
    useShallow((s) => ({
      bottomTab: s.bottomTab,
      setBottomTab: s.setBottomTab,
      bottomOpen: s.bottomOpen,
      setBottomOpen: s.setBottomOpen,
      theme: s.theme,
      toggleSidebar: s.toggleSidebar,
      terminalEnabled: s.terminalEnabled,
      openRuleDialog: s.openRuleDialog,
    })),
  );
  const monacoTheme = themeDef(theme).monaco;
  const matching = libraryRules.filter((r) => (r.kind || "").toLowerCase() === bottomTab);

  useEffect(() => {
    setIntellisenseColumns(columns);
  }, [columns]);

  useEffect(() => {
    if (bottomTab !== "python" && bottomTab !== "javascript" && bottomTab !== "terminal") return;
    void api
      .runtime()
      .then((info) => setInstalledLibraries(info))
      .catch(() => {
        /* sidecar down */
      });
  }, [bottomTab]);

  const saveCurrent = () => {
    if (bottomTab !== "sql" && bottomTab !== "javascript" && bottomTab !== "python") return;
    const body = bottomTab === "sql" ? sql : bottomTab === "javascript" ? javascript : python;
    openRuleDialog({
      language: bottomTab,
      body,
      destination: "library",
    });
  };

  const codeTab = bottomTab === "sql" || bottomTab === "javascript" || bottomTab === "python";

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg-elev)" }}>
      <div className={`drs-bottom-bar${bottomOpen ? "" : " is-fill"}`}>
        <div className="drs-bottom-tabs">
          {[...TABS, ...(terminalEnabled ? [{ id: "terminal" as const, label: "Terminal", hint: "" }] : [])].map((t) => (
            <button
              key={t.id}
              type="button"
              className={bottomTab === t.id ? "drs-bottom-tab is-on" : "drs-bottom-tab"}
              onClick={() => {
                setBottomTab(t.id);
                if (!bottomOpen) setBottomOpen(true);
              }}
            >
              {t.label}
              {t.hint ? <span className="hint">{t.hint}</span> : null}
            </button>
          ))}
        </div>
        <div className="drs-bottom-actions">
          {codeTab && bottomOpen && (
            <>
              {matching.length > 0 && (
                <select
                  className="field field-sm"
                  title="Insert a saved rule"
                  value=""
                  onChange={(e) => {
                    const id = e.target.value;
                    const rule = matching.find((r) => String(r.id) === id || r.name === id);
                    if (rule) insertLibraryRule(rule);
                  }}
                >
                  <option value="">Insert from library…</option>
                  {matching.map((r) => (
                    <option key={String(r.id ?? r.name)} value={String(r.id ?? r.name)}>
                      {r.name}
                    </option>
                  ))}
                </select>
              )}
              <button type="button" className="drs-bottom-btn" title="Save as a universal rule or library snippet" onClick={() => saveCurrent()}>
                <BookmarkPlus size={12} /> Save rule
              </button>
              <button type="button" className="drs-bottom-btn ghost" title="Open library" onClick={() => toggleSidebar("library")}>
                <Library size={13} />
              </button>
              <button
                type="button"
                className="drs-bottom-btn"
                title={`Clear ${bottomTab} editor`}
                onClick={() => {
                  if (bottomTab === "sql") setEditors({ sql: "" });
                  else if (bottomTab === "javascript") setEditors({ javascript: "" });
                  else setEditors({ python: "" });
                }}
              >
                <Eraser size={12} /> Clear
              </button>
              <button
                type="button"
                className="drs-bottom-btn run"
                disabled={running}
                onClick={() => void run(bottomTab === "sql" ? "sql" : bottomTab === "javascript" ? "javascript" : "python")}
              >
                <Play size={11} /> Run
              </button>
            </>
          )}
          <button type="button" className="drs-bottom-btn ghost" title="Collapse panel" onClick={() => setBottomOpen(!bottomOpen)}>
            <ChevronsDownUp size={14} />
          </button>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: bottomOpen ? "block" : "none" }}>
        {bottomTab === "sql" && <EditorPane language="sql" value={sql} onChange={(v) => setEditors({ sql: v })} theme={monacoTheme} />}
        {bottomTab === "javascript" && (
          <EditorPane language="javascript" value={javascript} onChange={(v) => setEditors({ javascript: v })} theme={monacoTheme} />
        )}
        {bottomTab === "python" && <EditorPane language="python" value={python} onChange={(v) => setEditors({ python: v })} theme={monacoTheme} />}
        {bottomTab === "console" && <Console />}
        {bottomTab === "aiplan" && <AIPlanDock />}
        {bottomTab === "history" && <HistoryPanel />}
        {terminalEnabled && (
          <div style={{ height: "100%", display: bottomTab === "terminal" ? "block" : "none" }}>
            <Terminal />
          </div>
        )}
      </div>
    </div>
  );
});

function EditorPane({
  language,
  value,
  onChange,
  theme,
}: {
  language: string;
  value: string;
  onChange: (v: string) => void;
  theme: "vs-dark" | "vs";
}) {
  return (
    <div style={{ height: "100%" }}>
      <Suspense fallback={null}>
        <Editor
          language={language}
          value={value}
          onChange={(v) => onChange(v || "")}
          theme={theme}
          beforeMount={(monaco) => registerIntellisense(monaco)}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
            automaticLayout: true,
            scrollBeyondLastLine: false,
            padding: { top: 12, bottom: 12 },
            lineNumbersMinChars: 3,
            suggestOnTriggerCharacters: true,
            quickSuggestions: { other: true, comments: false, strings: true },
            tabCompletion: "on",
            wordBasedSuggestions: "off",
            snippetSuggestions: "inline",
            parameterHints: { enabled: true },
            suggest: { preview: true, showWords: false, snippetsPreventQuickSuggestions: false },
          }}
        />
      </Suspense>
    </div>
  );
}
