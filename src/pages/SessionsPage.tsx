import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "../store/workspace";
import { api } from "../ipc/client";
import { ModalShell, InputModal, modalRow, modalBtn, modalBtnDanger } from "../components/Modal";

type Live = {
  id: string;
  label: string;
  source: string;
  rows: number;
  cols: number;
  created_at: string;
  exported: boolean;
  dirty: number;
};
type Disk = {
  session_id: string;
  label?: string;
  exported?: boolean;
  closed?: boolean;
  snapshots: number;
  bytes: number;
  latest: string;
};

export function SessionsPage() {
  const [live, setLive] = useState<Live[]>([]);
  const [disk, setDisk] = useState<Disk[]>([]);
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<{ id: string; label: string } | null>(null);
  const switchTab = useWorkspace((s) => s.switchTab);
  const closeTab = useWorkspace((s) => s.closeTab);
  const rememberTab = useWorkspace((s) => s.rememberTab);

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([api.sessions(), api.diskSessions()]);
      setLive(a as unknown as Live[]);
      setDisk(b as unknown as Disk[]);
    } catch {
      /* engine warming up */
    }
  }, []);

  useEffect(() => {
    void load();
    const iv = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(iv);
  }, [load]);

  const submitRename = async (value: string) => {
    if (!renaming) return;
    const label = value.trim();
    const { id, label: fallback } = renaming;
    setRenaming(null);
    await api.renameSession(id, label || fallback);
    rememberTab(id, label || fallback);
    void load();
  };

  const submitDelete = async () => {
    if (!confirmDel) return;
    const id = confirmDel.id;
    setConfirmDel(null);
    await api.deleteDiskSession(id);
    void load();
  };

  return (
    <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--text)" }}>
      <div style={head}>Open sheets</div>
      {live.length === 0 && <div style={dim}>No sheets open in this run.</div>}
      {live.map((s) => (
        <div key={s.id} style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flex: 1, fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {s.label}
            </span>
            {s.dirty > 0 && <span style={pillWarn}>unsaved</span>}
            {s.exported && <span style={pillOk}>exported</span>}
          </div>
          <div style={dim}>
            {s.rows.toLocaleString()} rows × {s.cols} cols · {s.created_at.replace("T", " ")}
          </div>
          <div style={dimTitle}>{s.source}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <button type="button" style={btn} onClick={() => void switchTab(s.id)}>Open</button>
            <button
              type="button"
              style={btn}
              onClick={() => setRenaming({ id: s.id, label: s.label })}
            >
              Rename
            </button>
            <button type="button" style={btn} onClick={() => void closeTab(s.id)}>Close</button>
          </div>
        </div>
      ))}

      <div style={{ ...head, marginTop: 18 }}>Snapshots on disk</div>
      {disk.length === 0 && <div style={dim}>No version snapshots stored.</div>}
      {disk.map((d) => (
        <div key={d.session_id} style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flex: 1, fontWeight: 650 }}>{d.label || d.session_id}</span>
            <span style={pill}>{d.snapshots} snapshot{d.snapshots === 1 ? "" : "s"}</span>
          </div>
          <div style={dim}>
            {(d.bytes / 1024).toFixed(0)} KB · latest {d.latest.replace("T", " ")}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <button
              type="button"
              style={btnDanger}
              onClick={() => setConfirmDel({ id: d.session_id, label: d.label || d.session_id })}
            >
              Delete
            </button>
          </div>
        </div>
      ))}

      {renaming && (
        <InputModal
          title="Rename sheet"
          initial={renaming.label}
          placeholder="Sheet name"
          submitLabel="Rename"
          onClose={() => setRenaming(null)}
          onSubmit={(v) => void submitRename(v)}
        />
      )}

      {confirmDel && (
        <ModalShell title="Delete snapshots" onClose={() => setConfirmDel(null)}>
          <div style={{ lineHeight: 1.5 }}>
            Delete all snapshots of <span style={{ fontWeight: 700 }}>{confirmDel.label}</span>?
            <div style={{ ...dim, marginTop: 6 }}>This removes the stored crash-recovery copies for this sheet.</div>
          </div>
          <div style={modalRow}>
            <button type="button" style={modalBtn} onClick={() => setConfirmDel(null)}>Cancel</button>
            <button type="button" style={modalBtnDanger} onClick={() => void submitDelete()}>Delete</button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}

/* ------------------------------ styles ------------------------------ */

const head: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--text-dim)",
  marginBottom: 8,
};
const dim: React.CSSProperties = { color: "var(--text-dim)", fontSize: 11, marginTop: 2 };
const dimTitle: React.CSSProperties = {
  color: "var(--text-dim)",
  fontSize: 10.5,
  marginTop: 2,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const card: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "10px 10px",
  marginBottom: 8,
  background: "color-mix(in srgb, var(--bg) 45%, transparent)",
};
const pill: React.CSSProperties = {
  fontSize: 10,
  border: "1px solid var(--border)",
  borderRadius: 999,
  padding: "2px 8px",
  color: "var(--text-dim)",
};
const pillWarn: React.CSSProperties = { ...pill, color: "var(--warn, #f59e0b)", borderColor: "color-mix(in srgb, #f59e0b 45%, transparent)" };
const pillOk: React.CSSProperties = { ...pill, color: "var(--ok)", borderColor: "color-mix(in srgb, var(--ok) 45%, transparent)" };
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
const btnDanger: React.CSSProperties = {
  ...btn,
  color: "var(--danger, #ef4444)",
  borderColor: "color-mix(in srgb, #ef4444 45%, transparent)",
};
