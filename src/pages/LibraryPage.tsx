import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { BookmarkPlus, Play, Plus, Search, X } from "lucide-react";
import { api } from "../ipc/client";
import { useWorkspace } from "../store/workspace";
import { useUI, type BottomTab } from "../store/ui";
import { type LibRule, ruleValue } from "../lib/builtinRules";

const KINDS = ["sql", "javascript", "python", "regex"] as const;

export function LibraryPage() {
  const {
    sessionId,
    schema,
    libraryRules,
    refreshLibrary,
    insertLibraryRule,
    run,
    assignColumnRule,
    assignRuleToAll,
    applySchemaTemplate,
    columns,
    columnRules,
    status,
    error,
    running,
  } = useWorkspace(
    useShallow((s) => ({
      sessionId: s.sessionId,
      schema: s.schema,
      libraryRules: s.libraryRules,
      refreshLibrary: s.refreshLibrary,
      insertLibraryRule: s.insertLibraryRule,
      run: s.run,
      assignColumnRule: s.assignColumnRule,
      assignRuleToAll: s.assignRuleToAll,
      applySchemaTemplate: s.applySchemaTemplate,
      columns: s.columns,
      columnRules: s.columnRules,
      status: s.status,
      error: s.error,
      running: s.running,
    })),
  );
  const { setBottomTab, setBottomOpen } = useUI(
    useShallow((s) => ({ setBottomTab: s.setBottomTab, setBottomOpen: s.setBottomOpen })),
  );
  const [tab, setTab] = useState<"rules" | "schemas">("rules");
  const [templates, setTemplates] = useState<unknown[]>([]);
  const [addingSchema, setAddingSchema] = useState(false);
  const [addingRule, setAddingRule] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mappingText, setMappingText] = useState("[]");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("sql");
  const [body, setBody] = useState("");
  const [replacement, setReplacement] = useState("");
  const [msg, setMsg] = useState("");
  const [query, setQuery] = useState("");

  const reload = () => {
    void refreshLibrary();
    api.templates().then(setTemplates).catch(() => undefined);
  };
  useEffect(() => {
    reload();
  }, []);

  const fillFromSession = () => {
    const mapping = schema.map((s) => ({ column: s.name, type: s.active, manual: true }));
    setMappingText(JSON.stringify(mapping, null, 2));
    if (!name) setName("schema-from-grid");
  };

  const needle = query.trim().toLowerCase();
  const shownRules: LibRule[] = useMemo(() => {
    const all: LibRule[] = libraryRules.filter((r) => (r.kind || "").toLowerCase() !== "universal");
    if (!needle) return all;
    return all.filter((r) =>
      [r.name, r.kind, r.description, r.body, r.category].filter(Boolean).join(" ").toLowerCase().includes(needle),
    );
  }, [libraryRules, needle]);
  const shownTemplates = useMemo(() => {
    if (!needle) return templates;
    return templates.filter((t) => JSON.stringify(t).toLowerCase().includes(needle));
  }, [templates, needle]);

  const useInEditor = (rule: LibRule) => {
    const k = (rule.kind || "").toLowerCase();
    if (k === "sql" || k === "javascript" || k === "python") {
      insertLibraryRule(rule);
      setBottomTab(k as BottomTab);
      setBottomOpen(true);
    }
  };

  return (
    <div style={{ padding: 16, fontSize: 13, color: "var(--text)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <h1 style={{ fontSize: 16, fontWeight: 650, flex: 1, margin: 0 }}>Library</h1>
        <button
          className="ws-icon"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "6px 10px",
            borderRadius: 8,
            border: "none",
            background: "var(--accent)",
            color: "#fff",
            fontSize: 12,
          }}
          onClick={() => {
            if (tab === "schemas") {
              setAddingSchema(true);
              if (sessionId && schema.length) fillFromSession();
            } else setAddingRule(true);
          }}
        >
          <Plus size={14} /> Add
        </button>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        {(["rules", "schemas"] as const).map((id) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{
              padding: "6px 12px",
              borderRadius: 8,
              border: "none",
              background: tab === id ? "var(--bg-input)" : "transparent",
              color: tab === id ? "var(--text)" : "var(--text-dim)",
              fontWeight: tab === id ? 600 : 500,
              fontSize: 12,
            }}
          >
            {id === "rules" ? "Rules" : "Schemas"}
          </button>
        ))}
      </div>
      <div className="field-wrap" style={{ marginBottom: 14 }}>
        <Search
          size={13}
          style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)", pointerEvents: "none" }}
        />
        <input
          className="field"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tab === "rules" ? "Search rules by name, kind, or code…" : "Search schemas…"}
          style={{ paddingLeft: 30, paddingRight: query ? 30 : 12 }}
        />
        {query && (
          <button type="button" className="field-clear" title="Clear search" onClick={() => setQuery("")}>
            <X size={12} />
          </button>
        )}
      </div>

      {tab === "rules" && addingRule && (
        <div
          style={{
            marginBottom: 16,
            padding: 14,
            borderRadius: 12,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            display: "grid",
            gap: 10,
          }}
        >
          <div style={{ fontWeight: 600 }}>New rule</div>
          <input className="field" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <select className="field" value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k === "javascript" ? "JavaScript" : k === "sql" ? "SQL" : k === "python" ? "Python" : k === "regex" ? "Regex" : "Universal"}
              </option>
            ))}
          </select>
          <input className="field" placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
          <textarea
            className="field"
            style={{ fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: 11, minHeight: 88, resize: "vertical" }}
            placeholder={
              kind === "regex"
                ? "Regex pattern, e.g. \\s+$"
                : kind === "sql"
                  ? "SELECT * FROM data WHERE …"
                  : kind === "javascript"
                    ? "return row;"
                    : "# df = df.with_columns(…)"
            }
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          {kind === "regex" && (
            <input className="field" placeholder="Replacement (can be empty)" value={replacement} onChange={(e) => setReplacement(e.target.value)} />
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              style={{ padding: "7px 12px", borderRadius: 8, border: "none", background: "var(--accent)", color: "#fff", fontSize: 12 }}
              onClick={async () => {
                try {
                  if (!name.trim()) throw new Error("Name required");
                  if (!body.trim()) throw new Error("Body required");
                  await api.saveRule({
                    name: name.trim(),
                    kind,
                    body: body.trim(),
                    description,
                    category: kind,
                    parameters: kind === "regex" ? { pattern: body.trim(), replacement } : {},
                  });
                  setMsg("Rule saved.");
                  setName("");
                  setBody("");
                  setDescription("");
                  setReplacement("");
                  reload();
                } catch (e) {
                  setMsg(String(e));
                }
              }}
            >
              Save rule
            </button>
            <button
              className="ws-icon"
              style={{ padding: "7px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", fontSize: 12 }}
              onClick={() => setAddingRule(false)}
            >
              Cancel
            </button>
          </div>
          {msg && <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{msg}</div>}
        </div>
      )}

      {tab === "rules" && (
        <div style={{ display: "grid", gap: 10 }}>
          {needle && !shownRules.length && (
            <div style={{ color: "var(--text-dim)", fontSize: 12 }}>No rules match “{query.trim()}”.</div>
          )}
          {!shownRules.length && !needle && (
            <div style={{ color: "var(--text-dim)", fontSize: 12 }}>
              SQL, JavaScript, Python, and regex snippets live here. Universal rules are in the Rules side panel.
            </div>
          )}
          {shownRules.map((r, i) => {
            const k = (r.kind || "").toLowerCase();
            const code = k === "sql" || k === "javascript" || k === "python";
            return (
              <div key={r.id ?? i} style={{ padding: 12, borderRadius: 12, background: "var(--bg)", border: "1px solid var(--border)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <div style={{ fontWeight: 600, flex: 1 }}>{r.name}</div>
                  <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 99, background: "var(--bg-input)", color: "var(--text-dim)" }}>{r.kind}</span>
                </div>
                {r.description ? <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>{r.description}</div> : null}
                <pre
                  style={{
                    fontSize: 11,
                    margin: 0,
                    overflow: "auto",
                    maxHeight: 88,
                    fontFamily: "JetBrains Mono, ui-monospace, monospace",
                    color: "var(--text-dim)",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {r.body}
                </pre>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                  {code && (
                    <button
                      style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 9px", borderRadius: 8, border: "none", background: "var(--accent)", color: "#fff", fontSize: 11 }}
                      onClick={() => useInEditor(r)}
                    >
                      <BookmarkPlus size={12} /> Insert in editor
                    </button>
                  )}
                  {code && (
                    <button
                      className="ws-icon"
                      style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 9px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", fontSize: 11 }}
                      onClick={() => {
                        useInEditor(r);
                        void run(k as "sql" | "javascript" | "python");
                      }}
                    >
                      <Play size={12} /> Insert & Run
                    </button>
                  )}
                  {(k === "universal" || k === "regex" || k === "plugin" || k === "python" || k === "javascript" || k === "js") && (
                    <>
                      <select
                        className="field"
                        style={{ width: "auto", padding: "4px 8px", fontSize: 11 }}
                        value=""
                        disabled={running || !(columns.length || schema.length)}
                        onChange={(e) => {
                          const col = e.target.value;
                          if (col === "__all__") void assignRuleToAll(ruleValue(r), true);
                          else if (col) void assignColumnRule(col, ruleValue(r), true);
                        }}
                      >
                        <option value="">{sessionId ? "Assign & apply…" : "Open a file first"}</option>
                        <option value="__all__">All columns</option>
                        {(columns.length ? columns : schema.map((s) => s.name)).map((c) => (
                          <option key={c} value={c}>
                            {c}
                            {columnRules[c] === ruleValue(r) ? " ✓" : ""}
                          </option>
                        ))}
                      </select>
                      {Object.entries(columnRules)
                        .filter(([, n]) => n === ruleValue(r))
                        .map(([c]) => (
                          <span key={c} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 99, background: "var(--bg-input)", color: "var(--text-dim)" }}>
                            {c}
                          </span>
                        ))}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === "schemas" && addingSchema && (
        <div style={{ marginBottom: 16, padding: 14, borderRadius: 12, background: "var(--bg)", border: "1px solid var(--border)", display: "grid", gap: 10 }}>
          <div style={{ fontWeight: 600 }}>New schema template</div>
          <input className="field" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="field" placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
          <button onClick={fillFromSession} style={{ border: "none", background: "none", color: "var(--accent)", fontSize: 12, textAlign: "left" }}>
            Use current grid columns
          </button>
          <textarea className="field" style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, minHeight: 96 }} value={mappingText} onChange={(e) => setMappingText(e.target.value)} />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              style={{ padding: "7px 12px", borderRadius: 8, border: "none", background: "var(--accent)", color: "#fff", fontSize: 12 }}
              onClick={async () => {
                try {
                  const mapping = JSON.parse(mappingText || "[]");
                  if (!name.trim()) throw new Error("Name required");
                  await api.saveTemplate(name.trim(), mapping, description);
                  setMsg("Schema saved.");
                  setAddingSchema(false);
                  setName("");
                  reload();
                } catch (e) {
                  setMsg(String(e));
                }
              }}
            >
              Save schema
            </button>
            <button className="ws-icon" style={{ padding: "7px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", fontSize: 12, color: "var(--text)" }} onClick={() => setAddingSchema(false)}>
              Cancel
            </button>
          </div>
          {msg && <div style={{ fontSize: 11 }}>{msg}</div>}
        </div>
      )}

      {tab === "rules" && (error || /assign|applied|auto-clean|failed/i.test(status)) && (
        <div style={{ marginTop: 10, fontSize: 11, color: error ? "var(--danger)" : "var(--text-dim)" }}>{error || status}</div>
      )}

      {tab === "schemas" && (
        <div style={{ display: "grid", gap: 10 }}>
          {!templates.length && !addingSchema && !needle && (
            <div style={{ color: "var(--text-dim)", fontSize: 12 }}>No schema templates. Click Add.</div>
          )}
          {needle && !shownTemplates.length && <div style={{ color: "var(--text-dim)", fontSize: 12 }}>No schemas match “{query.trim()}”.</div>}
          {shownTemplates.map((raw, i) => {
            const t = raw as {
              id?: string;
              name?: string;
              description?: string;
              industry?: string;
              builtin?: boolean;
              mapping?: Array<{ column?: string; name?: string; type?: string; active?: string }>;
            };
            const mapping = Array.isArray(t.mapping) ? t.mapping : [];
            return (
              <div key={t.id || t.name || i} style={{ padding: 12, borderRadius: 12, background: "var(--bg)", border: "1px solid var(--border)", fontSize: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <div style={{ fontWeight: 600, flex: 1 }}>{t.name}</div>
                  {t.industry ? (
                    <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 99, background: "var(--bg-input)", color: "var(--text-dim)" }}>{t.industry}</span>
                  ) : null}
                  {t.builtin ? (
                    <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 99, background: "color-mix(in srgb, var(--accent) 18%, transparent)", color: "var(--text)" }}>Built-in</span>
                  ) : null}
                </div>
                {t.description ? <div style={{ color: "var(--text-dim)", margin: "0 0 8px", lineHeight: 1.45 }}>{t.description}</div> : null}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                  {mapping.slice(0, 18).map((m, j) => (
                    <span key={`${m.column || m.name}-${j}`} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 99, background: "var(--bg-input)", color: "var(--text-dim)", fontFamily: "JetBrains Mono, ui-monospace, monospace" }}>
                      {m.column || m.name} · {m.type || m.active}
                    </span>
                  ))}
                  {mapping.length > 18 ? <span style={{ fontSize: 10, color: "var(--text-dim)" }}>+{mapping.length - 18}</span> : null}
                </div>
                <button
                  type="button"
                  disabled={running || !sessionId || !mapping.length}
                  onClick={() => void applySchemaTemplate(mapping as Array<Record<string, unknown>>, t.name)}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 8,
                    border: "none",
                    background: "var(--accent)",
                    color: "#fff",
                    fontSize: 11,
                    fontWeight: 600,
                    opacity: running || !sessionId || !mapping.length ? 0.4 : 1,
                  }}
                >
                  {sessionId ? "Apply to sheet" : "Open a file first"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
