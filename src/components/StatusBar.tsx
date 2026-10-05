import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkspace } from "../store/workspace";
import { api , clearRestoreHint } from "../ipc/client";
import { useUI } from "../store/ui";
import { themeDef } from "../theme/themes";
import { usePlugins } from "../store/plugins";

function AutosaveDot() {
  const sessionId = useWorkspace((s) => s.sessionId);
  const [st, setSt] = useState<{ dirty: number; saved_at: string } | null>(null);
  useEffect(() => {
    if (!sessionId) {
      setSt(null);
      return;
    }
    let on = true;
    const tick = async () => {
      try {
        const p = await api.peek();
        if (on) {
          setSt({ dirty: Number(p.dirty) || 0, saved_at: String(p.saved_at || "") });
          if (!p.restorable) clearRestoreHint();
        }
      } catch {
        /* engine warming */
      }
    };
    void tick();
    const iv = window.setInterval(tick, 4000);
    return () => {
      on = false;
      window.clearInterval(iv);
    };
  }, [sessionId]);
  if (!sessionId || !st) return null;
  const tstamp = (st.saved_at.split("T")[1] || "").slice(0, 8);
  return st.dirty ? (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} title="Unsaved changes — autosaves within seconds">
      <style>{`@keyframes asPulse{0%,100%{opacity:.35}50%{opacity:1}}`}</style>
      <span style={{ width: 7, height: 7, borderRadius: 99, background: "#f59e0b", animation: "asPulse 1.2s ease-in-out infinite" }} />
      Unsaved changes
    </span>
  ) : (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} title="Autosaved to disk">
      <span style={{ width: 7, height: 7, borderRadius: 99, background: "var(--ok)" }} />
      Saved{tstamp ? ` ${tstamp}` : ""}
    </span>
  );
}

export function StatusBar() {
  const { metrics, status, sessionId, error, total, columns, highlights, clearHighlights } = useWorkspace(
    useShallow((s) => ({
      metrics: s.metrics,
      status: s.status,
      sessionId: s.sessionId,
      error: s.error,
      total: s.total,
      columns: s.columns,
      highlights: s.highlights,
      clearHighlights: s.clearHighlights,
    })),
  );
  const cleaned = metrics?.cells_cleaned ?? Object.keys(highlights).length;
  const { theme, hiddenCols, setBottomOpen, bottomOpen, setPaletteOpen } = useUI(
    useShallow((s) => ({
      theme: s.theme,
      hiddenCols: s.hiddenCols,
      setBottomOpen: s.setBottomOpen,
      bottomOpen: s.bottomOpen,
      setPaletteOpen: s.setPaletteOpen,
    })),
  );
  const statusItems = usePlugins((s) => s.ui.statusBar);
  return (
    <div
      style={{
        height: 24,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        fontSize: 11,
        lineHeight: "24px",
        padding: "0 12px",
        gap: 12,
        overflow: "hidden",
        whiteSpace: "nowrap" as const,
        background: "var(--status)",
        color: "var(--status-fg)",
        borderTop: "1px solid var(--border)",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 99,
          background: error ? "var(--danger)" : "var(--ok)",
          display: "inline-block",
        }}
      />
      <AutosaveDot />
      <span>{themeDef(theme).label}</span>
      {statusItems.map((it, i) => (
        <span key={`${it.text}-${i}`} title={it.tooltip || it.extension}>
          {it.text}
        </span>
      ))}
      <span>{sessionId ? `${total.toLocaleString()} rows × ${columns.length} cols` : "No dataset"}</span>
      {hiddenCols.length > 0 && <span>{hiddenCols.length} hidden</span>}
      {metrics && <span>Health {metrics.health.toFixed(1)}</span>}
      {cleaned > 0 && (
        <button
          title="Clear cleaned-cell highlights"
          onClick={() => clearHighlights()}
          style={{ border: "none", background: "none", color: "var(--ok)", fontSize: 11 }}
        >
          {cleaned} cleaned
        </button>
      )}
      <button
        onClick={() => setBottomOpen(!bottomOpen)}
        style={{ border: "none", background: "none", color: "var(--accent)", fontSize: 11 }}
      >
        {bottomOpen ? "Collapse editors" : "Open editors"}
      </button>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{error || status}</span>
      <button
        type="button"
        title="Command palette (Ctrl+K)"
        onClick={() => setPaletteOpen(true)}
        style={{ border: "none", background: "none", color: "var(--accent)", fontSize: 11 }}
      >
        Ctrl+K
      </button>
    </div>
  );
}
