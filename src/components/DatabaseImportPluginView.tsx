import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { api } from "../ipc/client";
import {
  COLORS,
  EMPTY_FORM,
  KINDS,
  formToConfig,
  loadConnections,
  saveConnections,
  type ConnForm,
  type DbKind,
  type SavedConn,
} from "../lib/db";
import { useWorkspace } from "../store/workspace";

type ImportMode = "top" | "bottom" | "all" | "custom";

type DatabaseResult = {
  session_id?: string;
  rows?: number;
  columns?: string[];
};

const FILE_KINDS = new Set<DbKind>(["sqlite", "duckdb"]);

function emptyConnection(): ConnForm {
  return {
    ...EMPTY_FORM,
    query: "",
    table: "",
    ssh: { ...EMPTY_FORM.ssh },
  };
}

function copyConnection(value: Partial<ConnForm>): ConnForm {
  const fresh = emptyConnection();
  return {
    ...fresh,
    ...value,
    ssh: { ...fresh.ssh, ...(value.ssh || {}) },
  } as ConnForm;
}

function redactUrlPassword(raw: string) {
  const value = String(raw || "");
  if (!value) return value;
  try {
    const parsed = new URL(value.replace(/^jdbc:/i, ""));
    parsed.password = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/(\/\/[^/:\s]+:)[^@\s]+@/g, "$1@");
  }
}

function safeError(error: unknown, form: ConnForm) {
  let message = error instanceof Error ? error.message : String(error || "Database operation failed.");
  const secrets = [form.password, form.ssh.password].filter((item) => String(item || "").length > 0);
  for (const secret of secrets) message = message.split(secret).join("[redacted]");
  message = message.replace(/(["']?password["']?\s*[:=]\s*["']?)[^,"'\s}]+/gi, "$1[redacted]");
  message = message.replace(/(["']?pwd["']?\s*[:=]\s*["']?)[^,"'\s}]+/gi, "$1[redacted]");
  message = message.replace(/(\/\/[^/:\s]+:)[^@\s]+@/g, "$1[redacted]@");
  return message || "Database operation failed.";
}

function queryForImport(form: ConnForm, mode: ImportMode, countText: string, orderBy: string) {
  const raw = form.query.trim() || (form.table.trim() ? `SELECT * FROM ${form.table.trim()}` : "");
  if (!raw) throw new Error("Enter a SQL query or table name before importing.");
  const source = raw.replace(/;\s*$/, "").trim();
  if (mode === "all") return source;

  const count = Number(countText);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("Row count must be a positive whole number.");
  }

  const alias = "_drs_import";
  const sqlServer = form.kind === "sqlserver";
  if (mode === "bottom" && !orderBy.trim()) {
    throw new Error("Bottom N needs an Order by column or expression so the last rows are deterministic.");
  }

  if (mode === "bottom") {
    return sqlServer
      ? `SELECT TOP ${count} * FROM (${source}) AS ${alias} ORDER BY ${orderBy.trim()} DESC`
      : `SELECT * FROM (${source}) AS ${alias} ORDER BY ${orderBy.trim()} DESC LIMIT ${count}`;
  }

  if (mode === "top" || mode === "custom") {
    return sqlServer
      ? `SELECT TOP ${count} * FROM (${source}) AS ${alias}`
      : `SELECT * FROM (${source}) AS ${alias} LIMIT ${count}`;
  }

  return source;
}

function modeLabel(mode: ImportMode, count: string) {
  if (mode === "all") return "All rows";
  if (mode === "bottom") return `Bottom ${count || "N"}`;
  if (mode === "custom") return `Custom row count · first ${count || "N"}`;
  return `Top ${count || "N"}`;
}

export function DatabaseImportPluginView() {
  const [form, setForm] = useState<ConnForm>(emptyConnection);
  const [saved, setSaved] = useState<SavedConn[]>([]);
  const [savedId, setSavedId] = useState("");
  const [name, setName] = useState("");
  const [savePw, setSavePw] = useState(true);
  const [color, setColor] = useState(COLORS[0]);
  const [mode, setMode] = useState<ImportMode>("top");
  const [count, setCount] = useState("1000");
  const [orderBy, setOrderBy] = useState("");
  const [sshOpen, setSshOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"info" | "ok" | "error">("info");
  const running = useWorkspace((state) => state.running);

  useEffect(() => {
    let active = true;
    void loadConnections().then((rows) => {
      if (active) setSaved(rows);
    });
    return () => {
      active = false;
    };
  }, []);

  const fileKind = FILE_KINDS.has(form.kind);
  const urlMode = !fileKind && form.mode === "url";
  const importDescription = useMemo(() => {
    if (mode === "bottom") return "Uses the highest values in the order expression and returns those rows.";
    if (mode === "all") return "No row limit is sent to the database session. Use this deliberately for large tables.";
    if (mode === "custom") return "Imports the requested count from the beginning of the query result.";
    return "Imports the first rows in the query result order.";
  }, [mode]);

  const set = (patch: Partial<ConnForm>) => setForm((current) => ({ ...current, ...patch }));

  const changeKind = (value: string) => {
    const kind = value as DbKind;
    const spec = KINDS.find((item) => item.id === kind);
    setForm((current) => ({
      ...current,
      kind,
      port: spec?.port || "",
      mode: FILE_KINDS.has(kind) ? "file" : current.mode === "file" ? "host" : current.mode,
    }));
  };

  const testConnection = async () => {
    setBusy(true);
    setMessageKind("info");
    setMessage("Testing connection…");
    try {
      const result = await api.dbTest(form.kind, formToConfig(form));
      setMessageKind("ok");
      setMessage(`Connected · ${result.ms ?? 0} ms`);
    } catch (error) {
      setMessageKind("error");
      setMessage(safeError(error, form));
    } finally {
      setBusy(false);
    }
  };

  const importRows = async () => {
    let query = "";
    try {
      query = queryForImport(form, mode, count, orderBy);
    } catch (error) {
      setMessageKind("error");
      setMessage(safeError(error, form));
      return;
    }

    if (mode === "all" && typeof window !== "undefined") {
      const confirmed = window.confirm("Import all rows returned by this query? Large results may use substantial memory.");
      if (!confirmed) return;
    }

    setBusy(true);
    setMessageKind("info");
    setMessage(`Importing · ${modeLabel(mode, count)}…`);
    useWorkspace.setState({ running: true, error: "", status: `Importing ${modeLabel(mode, count)}…` });
    try {
      const result = (await api.database(form.kind, formToConfig(form), query, 0)) as DatabaseResult;
      if (!result.session_id) throw new Error("The database did not return a workspace session.");
      await useWorkspace.getState().switchTab(result.session_id);
      if (useWorkspace.getState().sessionId !== result.session_id) {
        throw new Error("The rows were imported, but the workspace could not be opened.");
      }
      const rows = Number(result.rows || 0);
      setMessageKind("ok");
      setMessage(`Imported ${rows.toLocaleString()} rows · ${modeLabel(mode, count)}`);
      useWorkspace.setState({ running: false, error: "", status: `Imported ${rows.toLocaleString()} rows from ${form.kind}` });
    } catch (error) {
      const text = safeError(error, form);
      setMessageKind("error");
      setMessage(text);
      useWorkspace.setState({ running: false, error: text, status: "Database import failed" });
    } finally {
      setBusy(false);
    }
  };

  const saveConnection = async () => {
    const storedForm = savePw
      ? copyConnection(form)
      : {
          ...copyConnection(form),
          password: "",
          uri: redactUrlPassword(form.uri),
          ssh: { ...form.ssh, password: "" },
        };
    const item: SavedConn = {
      id: crypto.randomUUID?.() || String(Date.now()),
      name: name.trim() || `${form.kind}-${form.host || form.path || "db"}`,
      color,
      savePassword: savePw,
      form: storedForm,
    };
    try {
      const next = [item, ...saved.filter((row) => row.name !== item.name)];
      await saveConnections(next);
      setSaved(next);
      setSavedId(item.id);
      setMessageKind("ok");
      setMessage(`Saved “${item.name}”`);
    } catch (error) {
      setMessageKind("error");
      setMessage(safeError(error, form));
    }
  };

  const loadSaved = (id: string) => {
    setSavedId(id);
    const hit = saved.find((row) => row.id === id);
    if (!hit) return;
    setForm(copyConnection(hit.form));
    setName(hit.name);
    setColor(hit.color || COLORS[0]);
    setSavePw(Boolean(hit.savePassword));
    setMessageKind("info");
    setMessage(`Loaded “${hit.name}”`);
  };

  const inputDisabled = busy || running;

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <div>
          <div style={styles.eyebrow}>FIRST-PARTY DATAREFINE PLUGIN</div>
          <div style={styles.title}>Database Import</div>
        </div>
        <span style={styles.localChip}>LOCAL</span>
      </div>
      <div style={styles.intro}>
        Connect to a supported database, choose the rows to bring in, and open the result as a normal DataRefine workspace session.
        Credentials stay on the local connection path and are never included in status messages.
      </div>

      <Section title="Connection">
        {saved.length > 0 ? (
          <Field label="Saved connection">
            <select className="field" value={savedId} disabled={inputDisabled} onChange={(event) => loadSaved(event.target.value)}>
              <option value="">Choose a saved connection…</option>
              {saved.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        <Field label="Database type">
          <select className="field" value={form.kind} disabled={inputDisabled} onChange={(event) => changeKind(event.target.value)}>
            {KINDS.map((kind) => (
              <option key={kind.id} value={kind.id}>
                {kind.label}
              </option>
            ))}
          </select>
        </Field>

        {!fileKind ? (
          <Field label="Connection mode">
            <select className="field" value={form.mode} disabled={inputDisabled} onChange={(event) => set({ mode: event.target.value as ConnForm["mode"] })}>
              <option value="host">Host and port</option>
              <option value="url">Connection URL</option>
            </select>
          </Field>
        ) : null}

        {fileKind ? (
          <Field label="Database file path">
            <input className="field" value={form.path} disabled={inputDisabled} onChange={(event) => set({ path: event.target.value })} placeholder="C:\\data\\warehouse.duckdb" />
          </Field>
        ) : urlMode ? (
          <Field label="Connection URL">
            <input className="field" value={form.uri} disabled={inputDisabled} onChange={(event) => set({ uri: event.target.value })} placeholder="postgres://user:password@host:5432/database" autoComplete="off" />
          </Field>
        ) : (
          <div style={styles.twoColumns}>
            <Field label="Host">
              <input className="field" value={form.host} disabled={inputDisabled} onChange={(event) => set({ host: event.target.value })} autoComplete="off" />
            </Field>
            <Field label="Port">
              <input className="field" value={form.port} disabled={inputDisabled} onChange={(event) => set({ port: event.target.value })} inputMode="numeric" />
            </Field>
          </div>
        )}

        {!fileKind && !urlMode ? (
          <div style={styles.twoColumns}>
            <Field label="User">
              <input className="field" value={form.user} disabled={inputDisabled} onChange={(event) => set({ user: event.target.value })} autoComplete="off" />
            </Field>
            <Field label="Password">
              <input className="field" type="password" value={form.password} disabled={inputDisabled} onChange={(event) => set({ password: event.target.value })} autoComplete="new-password" />
            </Field>
          </div>
        ) : null}

        {!fileKind && !urlMode ? (
          <Field label="Default database">
            <input className="field" value={form.database} disabled={inputDisabled} onChange={(event) => set({ database: event.target.value })} />
          </Field>
        ) : null}

        {!fileKind ? (
          <label style={styles.checkRow}>
            <input type="checkbox" checked={form.ssl} disabled={inputDisabled} onChange={(event) => set({ ssl: event.target.checked })} />
            <span>Use SSL</span>
          </label>
        ) : null}

        {!fileKind ? (
          <details open={sshOpen} onToggle={(event) => setSshOpen((event.currentTarget as HTMLDetailsElement).open)} style={styles.details}>
            <summary style={styles.summary}>SSH tunnel (optional)</summary>
            <div style={styles.detailBody}>
              <label style={styles.checkRow}>
                <input type="checkbox" checked={form.ssh.enabled} disabled={inputDisabled} onChange={(event) => set({ ssh: { ...form.ssh, enabled: event.target.checked } })} />
                <span>Enable SSH tunnel</span>
              </label>
              {form.ssh.enabled ? (
                <>
                  <div style={styles.twoColumns}>
                    <input className="field" placeholder="SSH host" value={form.ssh.host} disabled={inputDisabled} onChange={(event) => set({ ssh: { ...form.ssh, host: event.target.value } })} />
                    <input className="field" placeholder="22" value={form.ssh.port} disabled={inputDisabled} onChange={(event) => set({ ssh: { ...form.ssh, port: event.target.value } })} />
                    <input className="field" placeholder="SSH user" value={form.ssh.user} disabled={inputDisabled} onChange={(event) => set({ ssh: { ...form.ssh, user: event.target.value } })} />
                    <input className="field" type="password" placeholder="SSH password" value={form.ssh.password} disabled={inputDisabled} onChange={(event) => set({ ssh: { ...form.ssh, password: event.target.value } })} autoComplete="new-password" />
                  </div>
                  <input className="field" placeholder="Private key path (optional)" value={form.ssh.key} disabled={inputDisabled} onChange={(event) => set({ ssh: { ...form.ssh, key: event.target.value } })} />
                </>
              ) : null}
            </div>
          </details>
        ) : null}
      </Section>

      <Section title="Source">
        <Field label="SQL query">
          <textarea className="field" value={form.query} disabled={inputDisabled} onChange={(event) => set({ query: event.target.value })} placeholder="SELECT * FROM public.customers" style={styles.query} />
        </Field>
        <Field label="Or table name">
          <input className="field" value={form.table} disabled={inputDisabled} onChange={(event) => set({ table: event.target.value })} placeholder="public.customers" />
        </Field>
        <div style={styles.hint}>If both are supplied, the SQL query is used. Top and custom modes wrap the query with a database-side limit.</div>
      </Section>

      <Section title="Row selection">
        <Field label="Import mode">
          <select className="field" value={mode} disabled={inputDisabled} onChange={(event) => setMode(event.target.value as ImportMode)}>
            <option value="top">Top N</option>
            <option value="bottom">Bottom N</option>
            <option value="all">All rows</option>
            <option value="custom">Custom row count</option>
          </select>
        </Field>
        {mode !== "all" ? (
          <Field label={mode === "custom" ? "Requested row count" : "N rows"}>
            <input className="field" type="number" min="1" step="1" value={count} disabled={inputDisabled} onChange={(event) => setCount(event.target.value)} inputMode="numeric" />
          </Field>
        ) : null}
        {mode === "bottom" ? (
          <Field label="Order by column or expression">
            <input className="field" value={orderBy} disabled={inputDisabled} onChange={(event) => setOrderBy(event.target.value)} placeholder="created_at" />
          </Field>
        ) : null}
        <div style={styles.selectionNote}>
          <strong>{modeLabel(mode, count)}</strong>
          <span>{importDescription}</span>
        </div>
      </Section>

      <div style={styles.actions}>
        <button type="button" className="button" disabled={inputDisabled} onClick={() => void testConnection()}>
          Test connection
        </button>
        <button type="button" className="button primary" disabled={inputDisabled} onClick={() => void importRows()}>
          Import rows
        </button>
      </div>

      <Section title="Save connection">
        <Field label="Connection name">
          <input className="field" value={name} disabled={inputDisabled} onChange={(event) => setName(event.target.value)} placeholder="Production Postgres" />
        </Field>
        <div style={styles.saveRow}>
          <label style={styles.checkRow}>
            <input type="checkbox" checked={savePw} disabled={inputDisabled} onChange={(event) => setSavePw(event.target.checked)} />
            <span>Save password</span>
          </label>
          <div style={styles.colors} aria-label="Connection color">
            {COLORS.map((value) => (
              <button key={value} type="button" disabled={inputDisabled} aria-label={`Use ${value}`} onClick={() => setColor(value)} style={{ ...styles.color, background: value, outline: color === value ? "2px solid var(--text)" : "none" }} />
            ))}
          </div>
          <button type="button" className="button" disabled={inputDisabled} onClick={() => void saveConnection()}>
            Save
          </button>
        </div>
      </Section>

      {message ? <div style={{ ...styles.message, color: messageKind === "error" ? "var(--danger)" : messageKind === "ok" ? "var(--ok)" : "var(--text-dim)" }}>{message}</div> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={styles.section}>
      <div style={styles.sectionTitle}>{title}</div>
      <div style={styles.sectionBody}>{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={styles.fieldLabel}>
      <span>{label}</span>
      {children}
    </label>
  );
}

const styles: Record<string, CSSProperties> = {
  root: { padding: 14, display: "grid", gap: 10, color: "var(--text)", fontSize: 12 },
  header: { display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between" },
  eyebrow: { fontSize: 9, letterSpacing: "0.12em", fontWeight: 750, color: "var(--text-dim)" },
  title: { fontSize: 17, fontWeight: 750, marginTop: 3 },
  localChip: { fontSize: 9, letterSpacing: "0.08em", fontWeight: 750, border: "1px solid var(--border)", color: "var(--text-dim)", padding: "4px 7px", borderRadius: 6 },
  intro: { color: "var(--text-dim)", lineHeight: 1.45, padding: "9px 10px", borderLeft: "3px solid var(--accent)", background: "var(--bg)", borderTop: "1px solid var(--border)", borderRight: "1px solid var(--border)", borderBottom: "1px solid var(--border)" },
  section: { border: "1px solid var(--border)", background: "var(--bg)", borderRadius: 9, overflow: "hidden" },
  sectionTitle: { padding: "8px 10px", borderBottom: "1px solid var(--border)", fontSize: 10, fontWeight: 750, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)" },
  sectionBody: { padding: 10, display: "grid", gap: 9 },
  fieldLabel: { display: "grid", gap: 5, fontSize: 10, color: "var(--text-dim)" },
  twoColumns: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 8 },
  query: { minHeight: 82, resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: 11 },
  hint: { color: "var(--text-dim)", fontSize: 10, lineHeight: 1.4 },
  checkRow: { display: "flex", alignItems: "center", gap: 7, color: "var(--text-dim)", fontSize: 11 },
  details: { border: "1px solid var(--border)", borderRadius: 7, padding: "7px 9px" },
  summary: { cursor: "pointer", color: "var(--text-dim)", fontSize: 11 },
  detailBody: { display: "grid", gap: 8, paddingTop: 8 },
  selectionNote: { display: "grid", gap: 3, padding: "8px 9px", borderLeft: "3px solid var(--accent)", background: "var(--bg-elev)", color: "var(--text-dim)", fontSize: 10, lineHeight: 1.4 },
  actions: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  saveRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  colors: { display: "flex", gap: 5, marginLeft: "auto" },
  color: { width: 13, height: 13, borderRadius: 99, border: "1px solid var(--border)", padding: 0, cursor: "pointer" },
  message: { border: "1px solid var(--border)", background: "var(--bg)", borderRadius: 7, padding: "9px 10px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.4 },
};
