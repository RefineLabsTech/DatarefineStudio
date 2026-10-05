import { useEffect, useState, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronRight } from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { api } from "../ipc/client";
import {
  COLORS,
  EMPTY_FORM,
  KINDS,
  formToConfig,
  loadConnections,
  parseDbUrl,
  saveConnections,
  type ConnForm,
  type SavedConn,
} from "../lib/db";
import { useLicense } from "../store/license";
import { canUseFeature, PREMIUM_FEATURE } from "../license/features";
import { PremiumFeatureGate } from "./license/PremiumFeatureGate";

export function ConnectDialog() {
  const { connectOpen, setConnectOpen, openDatabase, running, setPushOpen } = useWorkspace(
    useShallow((s) => ({
      connectOpen: s.connectOpen,
      setConnectOpen: s.setConnectOpen,
      openDatabase: s.openDatabase,
      running: s.running,
      setPushOpen: s.setPushOpen,
    })),
  );
  const license = useLicense((s) => s.snap);
  const canConnect = canUseFeature(license, PREMIUM_FEATURE.connectDb);
  const [form, setForm] = useState<ConnForm>(EMPTY_FORM);
  const [sslOpen, setSslOpen] = useState(false);
  const [sshOpen, setSshOpen] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [savePw, setSavePw] = useState(true);
  const [color, setColor] = useState(COLORS[0]);
  const [saved, setSaved] = useState<SavedConn[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (connectOpen) loadConnections().then(setSaved).catch(() => undefined);
  }, [connectOpen]);

  if (!connectOpen) return null;
  if (!canConnect) {
    return (
      <div style={{ position: "absolute", inset: 0, zIndex: 40, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }} onClick={() => setConnectOpen(false)}>
        <div onClick={(e) => e.stopPropagation()} style={{ width: 520, maxWidth: "100%", borderRadius: 16, border: "1px solid var(--border)", background: "var(--bg-elev)", overflow: "auto" }}>
          <PremiumFeatureGate feature={PREMIUM_FEATURE.connectDb} title="Connect database is a Professional feature" />
        </div>
      </div>
    );
  }

  const set = (p: Partial<ConnForm>) => setForm((f) => ({ ...f, ...p }));
  const fileKind = form.kind === "sqlite" || form.kind === "duckdb";
  const cfg = formToConfig(form);

  const test = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await api.dbTest(form.kind, cfg);
      setMsg(`Connected · ${r.ms ?? 0} ms`);
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    const q = form.query.trim() || (form.table.trim() ? `SELECT * FROM ${form.table.trim()} LIMIT 10000` : "");
    if (!q) {
      setMsg("Enter a SQL query or table name to load rows.");
      return;
    }
    await openDatabase(form.kind, cfg, q);
  };

  const save = async () => {
    const item: SavedConn = {
      id: crypto.randomUUID?.() || String(Date.now()),
      name: name.trim() || `${form.kind}-${form.host || form.path || "db"}`,
      color,
      savePassword: savePw,
      form: savePw ? form : { ...form, password: "", ssh: { ...form.ssh, password: "" } },
    };
    const next = [item, ...saved.filter((s) => s.name !== item.name)];
    await saveConnections(next);
    setSaved(next);
    setMsg(`Saved “${item.name}”`);
  };

  return (
    <div
      style={{ position: "absolute", inset: 0, zIndex: 40, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
      onClick={() => setConnectOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxWidth: "100%",
          maxHeight: "92vh",
          overflow: "auto",
          borderRadius: 16,
          border: "1px solid var(--border)",
          background: "var(--bg-elev)",
          color: "var(--text)",
          padding: 22,
          display: "grid",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 700, flex: 1 }}>New Connection</div>
          <button
            type="button"
            onClick={() => setUrlOpen(!urlOpen)}
            style={{ border: "none", background: "none", color: "var(--accent)", fontSize: 12 }}
          >
            Import from URL
          </button>
        </div>

        {urlOpen && (
          <div style={{ display: "flex", gap: 8 }}>
            <input className="field" placeholder="postgres://user:pass@host:5432/db" value={url} onChange={(e) => setUrl(e.target.value)} />
            <button
              type="button"
              onClick={() => {
                set({ ...parseDbUrl(url) });
                setMsg("URL applied.");
              }}
              style={{ padding: "8px 12px", borderRadius: 8, border: "none", background: "var(--accent)", color: "#fff", fontSize: 12 }}
            >
              Apply
            </button>
          </div>
        )}

        {saved.length > 0 && (
          <label style={{ display: "grid", gap: 6, fontSize: 11, color: "var(--text-dim)" }}>
            Saved
            <select
              className="field"
              defaultValue=""
              onChange={(e) => {
                const hit = saved.find((s) => s.id === e.target.value);
                if (hit) {
                  setForm(hit.form);
                  setName(hit.name);
                  setColor(hit.color);
                  setSavePw(hit.savePassword);
                }
              }}
            >
              <option value="">Load a saved connection…</option>
              {saved.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <Field label="Connection Type">
          <select
            className="field"
            value={form.kind}
            onChange={(e) => {
              const id = e.target.value as ConnForm["kind"];
              const spec = KINDS.find((k) => k.id === id);
              set({
                kind: id,
                port: spec?.port || form.port,
                mode: id === "sqlite" || id === "duckdb" ? "file" : form.mode === "file" ? "host" : form.mode,
              });
            }}
          >
            {KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>

        {!fileKind && (
          <Field label="Connection Mode">
            <select className="field" value={form.mode} onChange={(e) => set({ mode: e.target.value as ConnForm["mode"] })}>
              <option value="host">Host and Port</option>
              <option value="url">Connection URL</option>
            </select>
          </Field>
        )}

        {fileKind || form.mode === "file" ? (
          <Field label="File path">
            <input className="field" value={form.path} onChange={(e) => set({ path: e.target.value })} placeholder="C:\\data\\app.db" />
          </Field>
        ) : form.mode === "url" ? (
          <Field label="Connection URL">
            <input className="field" value={form.uri} onChange={(e) => set({ uri: e.target.value })} placeholder="postgres://user:pass@localhost:5432/app" />
          </Field>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 10 }}>
            <Field label="Host">
              <input className="field" value={form.host} onChange={(e) => set({ host: e.target.value })} />
            </Field>
            <Field label="Port">
              <input className="field" value={form.port} onChange={(e) => set({ port: e.target.value })} />
            </Field>
          </div>
        )}

        {!fileKind && (
          <Bar title="Enable SSL" open={sslOpen} onOpen={() => setSslOpen(!sslOpen)} on={form.ssl} setOn={(v) => set({ ssl: v })} />
        )}

        {!fileKind && form.mode !== "url" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="User">
                <input className="field" value={form.user} onChange={(e) => set({ user: e.target.value })} autoComplete="off" />
              </Field>
              <Field label="Password">
                <input className="field" type="password" value={form.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" />
              </Field>
            </div>
            <Field label="Default Database">
              <input className="field" value={form.database} onChange={(e) => set({ database: e.target.value })} />
            </Field>
          </>
        )}

        {!fileKind && (
          <div>
            <Bar
              title="SSH Tunnel"
              open={sshOpen || form.ssh.enabled}
              onOpen={() => setSshOpen(!sshOpen)}
              on={form.ssh.enabled}
              setOn={(v) => {
                set({ ssh: { ...form.ssh, enabled: v } });
                if (v) setSshOpen(true);
              }}
            />
            {form.ssh.enabled && (sshOpen || true) && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 100px", gap: 8, marginTop: 8 }}>
                <input className="field" placeholder="SSH host" value={form.ssh.host} onChange={(e) => set({ ssh: { ...form.ssh, host: e.target.value } })} />
                <input className="field" placeholder="22" value={form.ssh.port} onChange={(e) => set({ ssh: { ...form.ssh, port: e.target.value } })} />
                <input className="field" placeholder="SSH user" value={form.ssh.user} onChange={(e) => set({ ssh: { ...form.ssh, user: e.target.value } })} />
                <input className="field" type="password" placeholder="SSH password" value={form.ssh.password} onChange={(e) => set({ ssh: { ...form.ssh, password: e.target.value } })} />
                <input className="field" style={{ gridColumn: "1 / -1" }} placeholder="Private key path (optional)" value={form.ssh.key} onChange={(e) => set({ ssh: { ...form.ssh, key: e.target.value } })} />
              </div>
            )}
          </div>
        )}

        <Field label="SQL query (Connect loads these rows)">
          <textarea className="field" style={{ minHeight: 64, fontFamily: "ui-monospace, monospace", fontSize: 12 }} value={form.query} onChange={(e) => set({ query: e.target.value })} />
        </Field>
        <Field label="Or table name">
          <input className="field" placeholder="public.customers" value={form.table} onChange={(e) => set({ table: e.target.value })} />
        </Field>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" disabled={busy || running} onClick={() => void test()} style={btnGhost}>
            Test
          </button>
          <button type="button" disabled={busy || running} onClick={() => void connect()} style={btnSolid}>
            Connect
          </button>
        </div>

        {msg && <div style={{ fontSize: 12, color: msg.startsWith("Connected") || msg.startsWith("Saved") ? "var(--ok)" : "var(--danger)" }}>{msg}</div>}

        <div style={{ height: 1, background: "var(--border)" }} />
        <div style={{ fontWeight: 700, fontSize: 14 }}>Save Connection</div>
        <Field label="Connection Name">
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Production Postgres" />
        </Field>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, flex: 1 }}>
            <input type="checkbox" checked={savePw} onChange={(e) => setSavePw(e.target.checked)} />
            Save Passwords
          </label>
          <div style={{ display: "flex", gap: 6 }}>
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                title={c}
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 99,
                  border: color === c ? "2px solid #fff" : "1px solid transparent",
                  background: c,
                  padding: 0,
                  boxShadow: color === c ? "0 0 0 1px var(--border)" : "none",
                }}
              />
            ))}
          </div>
          <button type="button" onClick={() => void save()} style={{ ...btnGhost, padding: "6px 14px" }}>
            Save
          </button>
        </div>
        <button type="button" onClick={() => setPushOpen(true)} style={{ border: "none", background: "none", color: "var(--accent)", fontSize: 12, textAlign: "left" }}>
          Push cleaned data to a table…
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 6, fontSize: 11, color: "var(--text-dim)" }}>
      {label}
      {children}
    </label>
  );
}

function Bar({ title, open, onOpen, on, setOn }: { title: string; open: boolean; onOpen: () => void; on: boolean; setOn: (v: boolean) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 10, background: "var(--bg)", border: "1px solid var(--border)" }}>
      <button type="button" onClick={onOpen} style={{ border: "none", background: "none", color: "var(--text)", display: "inline-flex", alignItems: "center", gap: 6, flex: 1, fontSize: 13 }}>
        <ChevronRight size={14} style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }} />
        {title}
      </button>
      <Switch on={on} set={setOn} />
    </div>
  );
}

function Switch({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => set(!on)}
      style={{
        width: 40,
        height: 22,
        borderRadius: 99,
        border: "none",
        background: on ? "var(--ok)" : "var(--bg-input)",
        position: "relative",
        padding: 0,
      }}
    >
      <span style={{ position: "absolute", top: 2, left: on ? 20 : 2, width: 18, height: 18, borderRadius: 99, background: "#fff", display: "block", transition: "left 0.15s" }} />
    </button>
  );
}

const btnGhost: CSSProperties = {
  padding: "8px 16px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 13,
  fontWeight: 600,
};

const btnSolid: CSSProperties = {
  padding: "8px 16px",
  borderRadius: 8,
  border: "none",
  background: "#f4f4f5",
  color: "#111",
  fontSize: 13,
  fontWeight: 700,
};
