import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "../store/workspace";
import { api } from "../ipc/client";

type Hist = {
  checkpoints: { i: number; rows: number; cols: number; ts: string }[];
  current: { rows: number; cols: number };
};

export function HistoryPanel() {
  const sessionId = useWorkspace((s) => s.sessionId);
  const [data, setData] = useState<Hist | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!sessionId) {
      setData(null);
      return;
    }
    try {
      setData(await api.history(sessionId));
    } catch {
      setData(null);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const jump = async (i: number) => {
    if (!sessionId) return;
    setBusy(i);
    try {
      await api.undoTo(sessionId, i);
      await useWorkspace.getState().loadViewport(0);
      await useWorkspace.getState().refresh();
      await load();
    } catch (e) {
      useWorkspace.setState({ error: String(e) });
    } finally {
      setBusy(null);
    }
  };

  if (!sessionId) return <div style={wrap}>Open a dataset to see undo checkpoints.</div>;
  if (!data) return <div style={wrap}>No checkpoints yet — edit or clean something first.</div>;

  return (
    <div style={{ ...wrap, overflow: "auto" }}>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>
        Jump back to any checkpoint. Newer steps move to redo.
      </div>
      {data.checkpoints.length === 0 && (
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>No checkpoints yet.</div>
      )}
      {data.checkpoints.map((c) => (
        <div key={c.i} style={row}>
          <span style={badge}>#{c.i + 1}</span>
          <span style={{ flex: 1 }}>
            {c.rows.toLocaleString()} rows × {c.cols} cols
            <span style={{ color: "var(--text-dim)", marginLeft: 8, fontSize: 11 }}>{c.ts.replace("T", " ")}</span>
          </span>
          <button type="button" style={btn} disabled={busy !== null} onClick={() => void jump(c.i)}>
            {busy === c.i ? "Jumping…" : "Jump here"}
          </button>
        </div>
      ))}
      <div style={{ ...row, opacity: 0.75 }}>
        <span style={{ ...badge, borderColor: "var(--border)", color: "var(--text-dim)" }}>now</span>
        <span style={{ flex: 1 }}>
          {data.current.rows.toLocaleString()} rows × {data.current.cols} cols
        </span>
      </div>
    </div>
  );
}

const wrap: React.CSSProperties = { padding: "10px 14px", fontSize: 12, color: "var(--text)", height: "100%" };
const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "6px 8px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  marginBottom: 6,
  background: "color-mix(in srgb, var(--bg) 40%, transparent)",
};
const badge: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  color: "var(--accent)",
  border: "1px solid color-mix(in srgb, var(--accent) 45%, transparent)",
  borderRadius: 6,
  padding: "2px 6px",
};
const btn: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "var(--text)",
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 7,
  padding: "4px 10px",
  cursor: "pointer",
};
