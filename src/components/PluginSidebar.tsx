import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api, type CellHighlight, type PluginView, type PluginViewField, type PluginViewOption } from "../ipc/client";
import { BUILTIN_RULES, type LibRule } from "../lib/builtinRules";
import { AiWorkerCleanerPluginView } from "./AiWorkerCleanerPluginView";
import { DatabaseImportPluginView } from "./DatabaseImportPluginView";
import { AiCodeGeneratorPluginView } from "./AiCodeGeneratorPluginView";
import { useAuth } from "../store/auth";
import { usePlugins } from "../store/plugins";
import { useUI } from "../store/ui";
import { useWorkspace } from "../store/workspace";

function pluginText(raw: string) {
  return String(raw || "")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
}

function fieldVisible(field: PluginViewField, form: Record<string, string>) {
  const w = field.when;
  if (!w) return true;
  const cur = String(form[String(w.field)] ?? "");
  if (w.equals != null) return cur === String(w.equals);
  if (Array.isArray(w.in)) return w.in.map(String).includes(cur);
  return true;
}

function optionList(field: PluginViewField) {
  return (field.options || []).map((o) =>
    typeof o === "string" ? { value: o, label: o } : { value: String(o.value), label: String(o.label || o.value) },
  );
}

function emptyForm(fields: PluginViewField[]) {
  const next: Record<string, string> = { id: "" };
  for (const f of fields) next[f.id] = f.default != null ? String(f.default) : "";
  if (!next.kind) next.kind = "universal";
  return next;
}

function parseColumns(raw: string) {
  return String(raw || "")
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

type LocalPluginFailure = {
  message: string;
  details?: string;
};

export function PluginSidebar({ viewId }: { viewId: string }) {
  const views = usePlugins((s) => s.ui.views) || [];
  const runCommand = usePlugins((s) => s.runCommand);
  const setTheme = useUI((s) => s.setTheme);
  const { account, setAuthOpen } = useAuth(
    useShallow((s) => ({ account: s.account, setAuthOpen: s.setAuthOpen })),
  );
  const { running, sessionId, libraryRules, refreshLibrary, mergeHighlights, loadViewport, refresh } = useWorkspace(
    useShallow((s) => ({
      running: s.running,
      sessionId: s.sessionId,
      libraryRules: s.libraryRules,
      refreshLibrary: s.refreshLibrary,
      mergeHighlights: s.mergeHighlights,
      loadViewport: s.loadViewport,
      refresh: s.refresh,
    })),
  );
  const v = views.find((x) => x.id === viewId) as PluginView | undefined;
  const fields = Array.isArray(v?.fields) ? v!.fields : [];
  const [form, setForm] = useState<Record<string, string>>(() => emptyForm(fields));
  const [msg, setMsg] = useState("");
  const [failure, setFailure] = useState<LocalPluginFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setForm(emptyForm(fields));
    setMsg("");
    setFailure(null);
    setQuery("");
    if (v?.catalog === "rules") void refreshLibrary();
    // fields identity follows the view
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewId]);

  const catalog = useMemo(() => {
    if (v?.catalog !== "rules") return [];
    const extra = (libraryRules || []).filter((r) => !BUILTIN_RULES.some((b) => b.name === r.name && !r.id));
    const all: LibRule[] = [...BUILTIN_RULES, ...extra];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) =>
      [r.name, r.kind, r.description, r.body].filter(Boolean).join(" ").toLowerCase().includes(q),
    );
  }, [v?.catalog, libraryRules, query]);

  if (!v) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: "var(--text-dim)", lineHeight: 1.45 }}>
        This plugin was turned off or unloaded. The extra sidebar option is gone.
      </div>
    );
  }

  // Privileged core-rendered views are allow-listed by first-party plugin id;
  // an arbitrary imported plugin must not be able to request database UI.
  if (v.component === "database-import" && v.extension_id === "datarefine.database-importer") {
    return <DatabaseImportPluginView />;
  }
  if (v.component === "ai-worker-cleaner" && v.extension_id === "datarefine.ai-worker-cleaner") {
    return <AiWorkerCleanerPluginView />;
  }
  if (v.component === "ai-code-generator" && v.extension_id === "datarefine.ai-code-generator") {
    return <AiCodeGeneratorPluginView />;
  }

  const options = Array.isArray(v.options) ? v.options : [];
  const body = pluginText(String(v.body || ""));
  const setField = (id: string, value: string) => setForm((cur) => ({ ...cur, [id]: value }));
  const ghKey = `${String(v.account || "")} ${String(v.icon || "")}`.toLowerCase();
  const showGithub = /\bgit(hub)?\b/.test(ghKey);
  const ghUser = account.user;

  const loadRule = (r: LibRule) => {
    const params = (r.parameters || {}) as Record<string, unknown>;
    setForm({
      id: typeof r.id === "number" ? String(r.id) : "",
      name: r.name || "",
      kind: String(r.kind || "universal").toLowerCase(),
      description: r.description || "",
      body: r.body || "",
      replacement: String(params.replacement ?? ""),
      columns: "",
    });
    setMsg(typeof r.id === "number" ? `Editing “${r.name}”` : `Loaded built-in “${r.name}” — Save stores a copy`);
  };

  const saveRule = async () => {
    const name = String(form.name || "").trim();
    const bodyText = String(form.body || "").trim();
    const kind = String(form.kind || "universal").toLowerCase();
    if (!name) throw new Error("Name required");
    if (!bodyText) throw new Error("Rule body required");
    const idRaw = String(form.id || "").trim();
    const id = /^\d+$/.test(idRaw) ? Number(idRaw) : undefined;
    await api.saveRule({
      ...(id ? { id } : {}),
      name,
      kind,
      body: bodyText,
      description: String(form.description || ""),
      category: kind,
      parameters: kind === "regex" ? { pattern: bodyText, replacement: String(form.replacement || "") } : {},
    });
    await refreshLibrary();
    setMsg(id ? `Updated “${name}”` : `Saved “${name}” to library`);
  };

  const applyRule = async () => {
    if (!sessionId) throw new Error("Open a dataset first.");
    const kind = String(form.kind || "universal").toLowerCase();
    const bodyText = String(form.body || "").trim();
    if (!bodyText) throw new Error("Rule body required");
    const cols = parseColumns(form.columns);
    let result: { highlights?: CellHighlight[]; changed?: number } = {};
    if (kind === "sql") result = (await api.sql(sessionId, bodyText)) as typeof result;
    else if (kind === "javascript") result = (await api.javascript(sessionId, bodyText)) as typeof result;
    else if (kind === "python") result = (await api.python(sessionId, bodyText)) as typeof result;
    else {
      result = (await api.rules(sessionId, [
        {
          name: kind === "regex" ? "regex" : bodyText,
          kind,
          body: bodyText,
          columns: cols.length ? cols : undefined,
          pattern: kind === "regex" ? bodyText : undefined,
          replacement: form.replacement || "",
          parameters: kind === "regex" ? { pattern: bodyText, replacement: form.replacement || "" } : {},
        },
      ])) as typeof result;
    }
    if (result.highlights?.length) mergeHighlights(result.highlights);
    useWorkspace.setState({ rowCache: {} });
    await loadViewport(0);
    await refresh();
    const n = result.changed ?? 0;
    setMsg(n ? `Applied · ${n.toLocaleString()} cells` : "Applied");
    useWorkspace.setState({ status: n ? `Rule Lab · ${n.toLocaleString()} cells` : "Rule applied", error: "" });
  };

  const runOption = async (opt: PluginViewOption) => {
    setMsg("");
    setFailure(null);
    setBusy(true);
    try {
      if (opt.theme) setTheme(String(opt.theme));
      const action = String(opt.action || "");
      if (action === "newRule") {
        setForm(emptyForm(fields));
        setMsg("New rule");
        return;
      }
      if (action === "saveRule") {
        await saveRule();
        return;
      }
      if (action === "applyRule") {
        await applyRule();
        return;
      }
      if (opt.command) {
        const r = await runCommand(String(v.extension_id || ""), String(opt.command), { ...form });
        const out = String(r?.output || r?.message || "").trim();
        setMsg(out || "Done");
      }
    } catch (e) {
      const pluginError = e && typeof e === "object" ? (e as Error & { pluginError?: LocalPluginFailure }).pluginError : undefined;
      if (pluginError) {
        setFailure(pluginError);
        setMsg(pluginError.message);
      } else {
        setMsg(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: 16, fontSize: 13, color: "var(--text)", display: "grid", gap: 12 }}>
      {v.extension && v.extension !== (v.title || v.id) ? (
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{v.extension}</div>
      ) : null}
      {showGithub ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: 10,
            borderRadius: 12,
            border: "1px solid var(--border)",
            background: "var(--bg)",
          }}
        >
          {ghUser?.avatar_url ? (
            <img src={ghUser.avatar_url} alt="" width={28} height={28} style={{ borderRadius: 99 }} />
          ) : (
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 99,
                background: "var(--bg-input)",
                display: "grid",
                placeItems: "center",
                fontSize: 11,
                color: "var(--text-dim)",
              }}
            >
              GH
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 650, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {ghUser ? ghUser.name || ghUser.login : "GitHub not signed in"}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {ghUser ? `@${ghUser.login} · used for push / pull` : "Sign in so HTTPS GitHub remotes work"}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setAuthOpen(true)}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text)",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {ghUser ? "Account" : "Sign in"}
          </button>
        </div>
      ) : null}
      {body ? (
        <div
          style={{
            padding: 12,
            borderRadius: 12,
            border: "1px solid var(--border)",
            background: "var(--bg)",
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--text-dim)",
            whiteSpace: "pre-wrap",
          }}
        >
          {body}
        </div>
      ) : null}

      {v.catalog === "rules" && (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-dim)" }}>
            All rules
          </div>
          <input
            className="field"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search universal, SQL, JS, Python, regex…"
          />
          <div style={{ display: "grid", gap: 6, maxHeight: 180, overflow: "auto" }}>
            {catalog.map((r, i) => (
              <button
                key={String(r.id ?? `${r.name}-${i}`)}
                type="button"
                onClick={() => loadRule(r)}
                style={{
                  textAlign: "left",
                  padding: "8px 10px",
                  borderRadius: 10,
                  border: "1px solid var(--border)",
                  background: "var(--bg)",
                  color: "var(--text)",
                }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontWeight: 650, fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                  <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 99, background: "var(--bg-input)", color: "var(--text-dim)" }}>
                    {r.kind}
                  </span>
                </div>
                {r.description ? (
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.description}
                  </div>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      )}

      {fields.length > 0 && (
        <div style={{ display: "grid", gap: 10, padding: 12, borderRadius: 12, border: "1px solid var(--border)", background: "var(--bg)" }}>
          {v.catalog === "rules" ? (
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-dim)" }}>
              {form.id ? "Edit rule" : "Write rule"}
            </div>
          ) : null}
          {fields.filter((f) => f?.id && fieldVisible(f, form)).map((f) => {
            const type = String(f.type || "text");
            return (
              <label key={f.id} style={{ display: "grid", gap: 6, fontSize: 11, color: "var(--text-dim)" }}>
                {f.label || f.id}
                {type === "select" ? (
                  <select className="field" value={form[f.id] ?? ""} onChange={(e) => setField(f.id, e.target.value)}>
                    {optionList(f).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : type === "textarea" ? (
                  <textarea
                    className="field"
                    value={form[f.id] ?? ""}
                    onChange={(e) => setField(f.id, e.target.value)}
                    placeholder={f.placeholder || ""}
                    style={{ minHeight: 88, fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: 11, resize: "vertical" }}
                  />
                ) : (
                  <input
                    className="field"
                    type={type === "password" ? "password" : "text"}
                    autoComplete={type === "password" ? "off" : undefined}
                    value={form[f.id] ?? ""}
                    onChange={(e) => setField(f.id, e.target.value)}
                    placeholder={f.placeholder || ""}
                  />
                )}
                {f.hint ? <span>{f.hint}</span> : null}
              </label>
            );
          })}
        </div>
      )}

      {options.map((opt) => {
        const action = String(opt.action || "");
        const needsData =
          action === "applyRule" ||
          (Boolean(opt.command) && opt.session !== false && action !== "saveRule" && action !== "newRule" && !opt.theme);
        const blocked = busy || running || (needsData && !sessionId);
        const primary = action === "saveRule" || action === "applyRule";
        return (
          <button
            key={String(opt.id || opt.label)}
            type="button"
            disabled={blocked}
            onClick={() => void runOption(opt)}
            style={{
              textAlign: "left",
              padding: "10px 12px",
              borderRadius: 12,
              border: primary ? "none" : "1px solid var(--border)",
              background: primary ? "var(--accent)" : "var(--bg)",
              color: primary ? "#fff" : "var(--text)",
              opacity: blocked ? 0.45 : 1,
            }}
          >
            <div style={{ fontWeight: 650, fontSize: 12 }}>{opt.label}</div>
            <div style={{ fontSize: 11, marginTop: 4, opacity: 0.85 }}>
              {opt.hint || (needsData && !sessionId ? "Open a dataset first" : "")}
            </div>
          </button>
        );
      })}
      {msg && (
        <pre
          style={{
            margin: 0,
            padding: 12,
            borderRadius: 12,
            border: "1px solid var(--border)",
            background: "var(--bg)",
            fontSize: 11,
            lineHeight: 1.45,
            color: failure ? "var(--danger)" : "var(--text-dim)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 280,
            overflow: "auto",
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
          }}
        >
          {msg}
        </pre>
      )}
      {failure?.details ? (
        <details style={{ fontSize: 11, color: "var(--text-dim)" }}>
          <summary style={{ cursor: "pointer" }}>Technical details</summary>
          <pre
            style={{
              margin: "8px 0 0",
              padding: 10,
              borderRadius: 10,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 180,
              overflow: "auto",
              fontFamily: "JetBrains Mono, ui-monospace, monospace",
            }}
          >
            {failure.details}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
