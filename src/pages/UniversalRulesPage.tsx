import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronDown, ChevronRight, Play, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { useUI } from "../store/ui";
import { useUniversal } from "../store/universal";
import { api } from "../ipc/client";
import { themeDef } from "../theme/themes";
import { registerIntellisense, setInstalledLibraries } from "../editors/intellisense";
import type { UniLang, UniRule } from "../lib/universalRules";

const Editor = lazy(() => import("@monaco-editor/react"));

export function UniversalRulesPage() {
  const { libraryRules, refreshLibrary, sessionId, running, autoCleanAll, status, error, setEditors } = useWorkspace(
    useShallow((s) => ({
      libraryRules: s.libraryRules,
      refreshLibrary: s.refreshLibrary,
      sessionId: s.sessionId,
      running: s.running,
      autoCleanAll: s.autoCleanAll,
      status: s.status,
      error: s.error,
      setEditors: s.setEditors,
    })),
  );
  const { askConfirm, setBottomTab, setBottomOpen, theme } = useUI(
    useShallow((s) => ({
      askConfirm: s.askConfirm,
      setBottomTab: s.setBottomTab,
      setBottomOpen: s.setBottomOpen,
      theme: s.theme,
    })),
  );
  const monacoTheme = themeDef(theme).monaco;
  const { load, isOn, setOn, catalog } = useUniversal();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [langs, setLangs] = useState<Record<string, UniLang>>({});
  const [busyKey, setBusyKey] = useState("");

  useEffect(() => {
    void load();
    void refreshLibrary();
    void api
      .runtime()
      .then((info) => setInstalledLibraries(info))
      .catch(() => {
        /* sidecar down */
      });
  }, [load, refreshLibrary]);

  const rules = useMemo(() => catalog(libraryRules), [catalog, libraryRules]);
  const pack = rules.filter((r) => r.builtin);
  const custom = rules.filter((r) => !r.builtin);
  const onCount = rules.filter((r) => isOn(r.key)).length;
  const universalStatus = /^(no universal rules enabled|running enabled universal rules|auto-clean (complete|failed))/i.test(status.trim());
  const universalError = universalStatus && /auto-clean failed/i.test(status) ? error : "";

  const bodyOf = (r: UniRule) => (drafts[r.key] !== undefined ? drafts[r.key] : r.body);
  const langOf = (r: UniRule): UniLang => langs[r.key] || r.language || "python";

  const saveEdit = async (r: UniRule) => {
    const body = bodyOf(r).trim();
    const language = langOf(r);
    if (!body) return;
    setBusyKey(r.key);
    try {
      await api.saveRule({
        id: r.id,
        name: r.name,
        kind: "universal",
        body,
        description: r.description,
        category: "universal",
        parameters: { language, key: r.builtin ? r.key : undefined },
      });
      await refreshLibrary();
      setDrafts((d) => {
        const next = { ...d };
        delete next[r.key];
        return next;
      });
    } catch (e) {
      window.alert(String(e));
    } finally {
      setBusyKey("");
    }
  };

  const resetBuiltin = async (r: UniRule) => {
    if (!r.id) {
      setDrafts((d) => {
        const next = { ...d };
        delete next[r.key];
        return next;
      });
      setLangs((d) => {
        const next = { ...d };
        delete next[r.key];
        return next;
      });
      return;
    }
    const ok = await askConfirm({
      title: "Reset to built-in Python?",
      message: `“${r.name}” will use the original Python again.`,
      confirmLabel: "Reset",
    });
    if (!ok) return;
    setBusyKey(r.key);
    try {
      await api.deleteRule(r.id);
      await refreshLibrary();
      setDrafts((d) => {
        const next = { ...d };
        delete next[r.key];
        return next;
      });
      setLangs((d) => {
        const next = { ...d };
        delete next[r.key];
        return next;
      });
    } catch (e) {
      window.alert(String(e));
    } finally {
      setBusyKey("");
    }
  };

  const removeCustom = async (r: UniRule) => {
    if (!r.id) return;
    const ok = await askConfirm({
      title: "Delete rule?",
      message: `“${r.name}” will be removed from Universal rules.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteRule(r.id);
      await setOn(r.key, false);
      await refreshLibrary();
      if (openKey === r.key) setOpenKey(null);
    } catch (e) {
      window.alert(String(e));
    }
  };

  const addRule = () => {
    setEditors({
      python: "# New universal rule — assign the result back to df\ndf = df.with_columns(pl.all())\n",
    });
    setBottomTab("python");
    setBottomOpen(true);
  };

  return (
    <div className="drs-uni">
      <p className="drs-uni-lead">
        Whole-sheet cleaning. Toggle steps on or off. Expand a rule to edit it as Python or JavaScript.
      </p>
      <div className="drs-uni-bar">
        <button type="button" className="drs-uni-run" disabled={!sessionId || running || !onCount} onClick={() => void autoCleanAll()}>
          <Play size={12} /> Run enabled · {onCount}
        </button>
        <button type="button" className="drs-uni-add" onClick={addRule}>
          <Plus size={12} /> Add rule
        </button>
      </div>
      {universalStatus && (
        <div className={universalError ? "drs-ai-err" : "drs-ai-ok"}>{universalError || status}</div>
      )}

      <div className="drs-uni-label">Built-in</div>
      {pack.map((r) => (
        <RuleCard
          key={r.key}
          r={r}
          on={isOn(r.key)}
          open={openKey === r.key}
          body={bodyOf(r)}
          language={langOf(r)}
          busy={busyKey === r.key}
          monacoTheme={monacoTheme}
          onToggle={(v) => void setOn(r.key, v)}
          onOpen={() => setOpenKey(openKey === r.key ? null : r.key)}
          onBody={(v) => setDrafts((d) => ({ ...d, [r.key]: v }))}
          onLang={(v) => setLangs((d) => ({ ...d, [r.key]: v }))}
          onSave={() => void saveEdit(r)}
          onReset={() => void resetBuiltin(r)}
        />
      ))}

      <div className="drs-uni-label">Custom</div>
      {!custom.length && <div className="dim" style={{ fontSize: 12 }}>None yet. Add a rule or Save rule from the code editor.</div>}
      {custom.map((r) => (
        <RuleCard
          key={r.key}
          r={r}
          on={isOn(r.key)}
          open={openKey === r.key}
          body={bodyOf(r)}
          language={langOf(r)}
          busy={busyKey === r.key}
          monacoTheme={monacoTheme}
          onToggle={(v) => void setOn(r.key, v)}
          onOpen={() => setOpenKey(openKey === r.key ? null : r.key)}
          onBody={(v) => setDrafts((d) => ({ ...d, [r.key]: v }))}
          onLang={(v) => setLangs((d) => ({ ...d, [r.key]: v }))}
          onSave={() => void saveEdit(r)}
          onDelete={() => void removeCustom(r)}
        />
      ))}
    </div>
  );
}

function RuleCard({
  r,
  on,
  open,
  body,
  language,
  busy,
  monacoTheme,
  onToggle,
  onOpen,
  onBody,
  onLang,
  onSave,
  onReset,
  onDelete,
}: {
  r: UniRule;
  on: boolean;
  open: boolean;
  body: string;
  language: UniLang;
  busy: boolean;
  monacoTheme: "vs-dark" | "vs";
  onToggle: (v: boolean) => void;
  onOpen: () => void;
  onBody: (v: string) => void;
  onLang: (v: UniLang) => void;
  onSave: () => void;
  onReset?: () => void;
  onDelete?: () => void;
}) {
  const dirty = body !== r.body || language !== r.language;
  return (
    <div className={`drs-uni-card${on ? " is-on" : ""}`}>
      <div className="drs-uni-row">
        <button type="button" className="drs-uni-chev" onClick={onOpen} title={open ? "Collapse" : "Edit as Python or JavaScript"}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <label className="drs-switch">
          <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} />
          <span />
        </label>
        <button type="button" className="drs-uni-name" onClick={onOpen}>
          <span className="name">{r.name}</span>
          <span className="meta">
            {language === "javascript" ? "JavaScript" : "Python"}
            {r.pack ? " · auto-clean" : ""}
            {r.overridden ? " · edited" : ""}
          </span>
        </button>
      </div>
      {open && (
        <div className="drs-uni-edit">
          {r.description ? <div className="dim">{r.description}</div> : null}
          <div className="drs-uni-lang">
            <button type="button" className={language === "python" ? "is-on" : ""} onClick={() => onLang("python")}>
              Python
            </button>
            <button type="button" className={language === "javascript" ? "is-on" : ""} onClick={() => onLang("javascript")}>
              JavaScript
            </button>
          </div>
          <div className="drs-uni-monaco">
            <Suspense fallback={<div className="dim" style={{ padding: 8, fontSize: 11 }}>Opening {language} editor…</div>}>
              <Editor
                language={language}
                value={body}
                onChange={(v) => onBody(v || "")}
                theme={monacoTheme}
                beforeMount={(monaco) => registerIntellisense(monaco)}
                options={{
                  minimap: { enabled: false },
                  fontSize: 12,
                  fontFamily: "JetBrains Mono, ui-monospace, monospace",
                  automaticLayout: true,
                  scrollBeyondLastLine: false,
                  lineNumbersMinChars: 2,
                  folding: false,
                  wordWrap: "on",
                  padding: { top: 8, bottom: 8 },
                }}
              />
            </Suspense>
          </div>
          <div className="drs-uni-edit-bar">
            <button type="button" className="ok" disabled={busy || !dirty} onClick={onSave}>
              {busy ? "Saving…" : "Save"}
            </button>
            {onReset && (r.overridden || dirty) && (
              <button type="button" onClick={onReset} title="Reset built-in">
                <RotateCcw size={12} /> Reset
              </button>
            )}
            {onDelete && (
              <button type="button" className="danger" onClick={onDelete}>
                <Trash2 size={12} /> Delete
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
