import { useEffect, useState } from "react";
import { useWorkspace } from "../store/workspace";
import { api } from "../ipc/client";

type Ver = { id?: number; name?: string; created_at?: string; snapshot_path?: string };

export function VersionsPage() {
  const sessionId = useWorkspace((s) => s.sessionId);
  const restoreVersion = useWorkspace((s) => s.restoreVersion);
  const running = useWorkspace((s) => s.running);
  const [rows, setRows] = useState<Ver[]>([]);
  const reload = () => {
    if (sessionId) api.versions(sessionId).then((r) => setRows((r as Ver[]) || [])).catch(() => undefined);
  };
  useEffect(() => {
    reload();
  }, [sessionId]);
  if (!sessionId) {
    return <div style={{ padding: 16, fontSize: 12, color: "var(--text-dim)" }}>Open a dataset to see snapshots.</div>;
  }
  return (
    <div style={{ padding: 16, color: "var(--text)", fontSize: 13 }}>
      <h1 style={{ fontSize: 16, fontWeight: 650, margin: "0 0 12px" }}>Dataset versions</h1>
      <div style={{ display: "grid", gap: 8 }}>
        {rows.map((r, i) => (
          <div key={r.id ?? i} style={{ padding: 12, borderRadius: 12, border: "1px solid var(--border)", background: "var(--bg)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ fontWeight: 600, flex: 1 }}>{r.name || `v${r.id}`}</div>
              <button
                disabled={running || r.id == null}
                onClick={async () => {
                  if (r.id == null) return;
                  await restoreVersion(r.id);
                  reload();
                }}
                style={{
                  padding: "5px 9px",
                  borderRadius: 8,
                  border: "none",
                  background: "var(--accent)",
                  color: "#fff",
                  fontSize: 11,
                  opacity: running ? 0.4 : 1,
                }}
              >
                Restore
              </button>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{r.created_at}</div>
            <div style={{ fontSize: 10, fontFamily: "ui-monospace, monospace", color: "var(--text-dim)", marginTop: 2 }}>{r.snapshot_path}</div>
          </div>
        ))}
        {!rows.length && <div style={{ color: "var(--text-dim)", fontSize: 12 }}>Snapshots appear after import and pipeline runs.</div>}
      </div>
    </div>
  );
}
