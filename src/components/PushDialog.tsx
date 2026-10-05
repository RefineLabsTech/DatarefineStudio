import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkspace } from "../store/workspace";
import { api } from "../ipc/client";
import { EMPTY_FORM, formToConfig, loadConnections, type ConnForm, type SavedConn } from "../lib/db";
import { useLicense } from "../store/license";
import { canUseFeature, PREMIUM_FEATURE } from "../license/features";
import { PremiumFeatureGate } from "./license/PremiumFeatureGate";

export function PushDialog() {
  const { pushOpen, setPushOpen, sessionId, running, total, columns } = useWorkspace(
    useShallow((s) => ({
      pushOpen: s.pushOpen,
      setPushOpen: s.setPushOpen,
      sessionId: s.sessionId,
      running: s.running,
      total: s.total,
      columns: s.columns,
    })),
  );
  const license = useLicense((s) => s.snap);
  const canPush = canUseFeature(license, PREMIUM_FEATURE.push);
  const [saved, setSaved] = useState<SavedConn[]>([]);
  const [pick, setPick] = useState("");
  const [table, setTable] = useState("cleaned");
  const [schema, setSchema] = useState("");
  const [mode, setMode] = useState<"replace" | "append" | "fail">("replace");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<ConnForm>(EMPTY_FORM);

  useEffect(() => {
    if (pushOpen) loadConnections().then(setSaved).catch(() => undefined);
  }, [pushOpen]);

  if (!pushOpen) return null;
  if (!canPush) {
    return (
      <div style={{ position: "absolute", inset: 0, zIndex: 45, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }} onClick={() => setPushOpen(false)}>
        <div onClick={(e) => e.stopPropagation()} style={{ width: 520, maxWidth: "100%", borderRadius: 16, border: "1px solid var(--border)", background: "var(--bg-elev)", overflow: "auto" }}>
          <PremiumFeatureGate feature={PREMIUM_FEATURE.push} title="Push is a Professional feature" />
        </div>
      </div>
    );
  }

  const cfg = formToConfig(form);

  const applySaved = (id: string) => {
    setPick(id);
    const hit = saved.find((s) => s.id === id);
    if (hit) setForm(hit.form);
  };

  const go = async () => {
    if (!sessionId) {
      setMsg("Open a dataset first.");
      return;
    }
    if (!table.trim()) {
      setMsg("Table name required.");
      return;
    }
    setBusy(true);
    setMsg("");
    try {
      const r = await api.push(sessionId, {
        kind: form.kind,
        config: cfg,
        table: table.trim(),
        mode,
        schema_name: schema.trim(),
      });
      setMsg(`Pushed ${r.rows.toLocaleString()} rows → ${schema ? schema + "." : ""}${r.table} (${r.mode})`);
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{ position: "absolute", inset: 0, zIndex: 45, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
      onClick={() => setPushOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 480,
          maxWidth: "100%",
          borderRadius: 16,
          border: "1px solid var(--border)",
          background: "var(--bg-elev)",
          color: "var(--text)",
          padding: 22,
          display: "grid",
          gap: 12,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700 }}>Push to database</div>
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
          Writes the current cleaned grid ({total.toLocaleString()} × {columns.length}) to a table. The frame stays on the engine — never sent as JSON.
        </div>
        <label style={{ display: "grid", gap: 6, fontSize: 11, color: "var(--text-dim)" }}>
          Connection
          <select className="field" value={pick} onChange={(e) => applySaved(e.target.value)}>
            <option value="">Use form below / saved…</option>
            {saved.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <input className="field" placeholder="Host" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
          <input className="field" placeholder="Port" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
          <input className="field" placeholder="User" value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} />
          <input className="field" type="password" placeholder="Password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <input className="field" style={{ gridColumn: "1 / -1" }} placeholder="Database" value={form.database} onChange={(e) => setForm({ ...form, database: e.target.value })} />
        </div>
        <label style={{ display: "grid", gap: 6, fontSize: 11, color: "var(--text-dim)" }}>
          Schema (optional)
          <input className="field" value={schema} onChange={(e) => setSchema(e.target.value)} placeholder="public" />
        </label>
        <label style={{ display: "grid", gap: 6, fontSize: 11, color: "var(--text-dim)" }}>
          Table
          <input className="field" value={table} onChange={(e) => setTable(e.target.value)} />
        </label>
        <label style={{ display: "grid", gap: 6, fontSize: 11, color: "var(--text-dim)" }}>
          If table exists
          <select className="field" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="replace">Replace</option>
            <option value="append">Append</option>
            <option value="fail">Fail if exists</option>
          </select>
        </label>
        {msg && <div style={{ fontSize: 12, color: msg.startsWith("Pushed") ? "var(--ok)" : "var(--danger)" }}>{msg}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={() => setPushOpen(false)} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--text)" }}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || running || !sessionId}
            onClick={() => void go()}
            style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "var(--accent)", color: "#fff", fontWeight: 650, opacity: !sessionId || busy ? 0.4 : 1 }}
          >
            {busy ? "Pushing…" : "Push"}
          </button>
        </div>
      </div>
    </div>
  );
}
