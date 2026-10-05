import { useShallow } from "zustand/react/shallow";
import { useWorkspace } from "../store/workspace";

export function MetricsPanel() {
  const { metrics, error, run } = useWorkspace(useShallow((s) => ({ metrics: s.metrics, error: s.error, run: s.run })));
  const items = [
    ["Rows", metrics?.rows],
    ["Columns", metrics?.columns],
    ["Missing", metrics?.missing],
    ["Duplicates", metrics?.duplicates],
    ["Invalid", metrics?.invalid],
    ["Runtime ms", metrics?.runtime_ms],
  ] as const;
  const health = metrics?.health ?? 0;
  return (
    <div className="h-full flex flex-col text-xs" style={{ color: "var(--text)" }}>
      <div className="p-3 space-y-3 overflow-auto">
        <div>
          <div className="flex justify-between mb-1" style={{ color: "var(--text-dim)" }}>
            <span>Health</span>
            <span className="font-mono">{health.toFixed(1)}</span>
          </div>
          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--bg-input)" }}>
            <div className="h-full" style={{ width: `${Math.min(100, health)}%`, background: "var(--ok)" }} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {items.map(([k, v]) => (
            <div key={k} className="rounded px-2 py-2" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
              <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-dim)" }}>
                {k}
              </div>
              <div className="font-mono">{v?.toLocaleString?.() ?? "—"}</div>
            </div>
          ))}
        </div>
        <button
          onClick={() => void run("rules")}
          className="w-full py-1.5 rounded"
          style={{ background: "var(--bg-input)", border: "1px solid var(--border)" }}
        >
          Run Stage 1 · Rules
        </button>
        {error && (
          <pre className="text-[11px] whitespace-pre-wrap rounded p-2" style={{ color: "var(--danger)" }}>
            {error}
          </pre>
        )}
      </div>
    </div>
  );
}
