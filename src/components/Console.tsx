import { Eraser } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useWorkspace } from "../store/workspace";

export function Console() {
  const { logs, error, clearConsole } = useWorkspace(
    useShallow((s) => ({ logs: s.logs, error: s.error, clearConsole: s.clearConsole })),
  );
  return (
    <div className="h-full text-[11px] font-mono" style={{ background: "var(--bg)", color: "var(--text-dim)", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          minHeight: 30,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "4px 8px",
          borderBottom: "1px solid var(--border)",
          color: "var(--text-dim)",
          fontFamily: "Inter, Segoe UI, system-ui, sans-serif",
          fontSize: 11,
        }}
      >
        <span>Output — SQL, Python, AI, warnings, performance.</span>
        <button
          type="button"
          title="Clear console output"
          onClick={clearConsole}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "4px 8px",
            background: "transparent",
            color: "var(--text-dim)",
            fontSize: 11,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <Eraser size={12} /> Clear
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 8 }}>
        {error && (
          <div className="mb-2" style={{ color: "var(--danger)" }}>
            {error}
          </div>
        )}
        {logs.map((l, i) => (
          <div key={i}>
            <span className="opacity-50">{l.ts}</span>{" "}
            <span style={{ color: "var(--accent)" }}>[{l.channel}]</span> {l.message}
          </div>
        ))}
        {!logs.length && !error && <div>Console cleared. New output will appear here.</div>}
      </div>
    </div>
  );
}
