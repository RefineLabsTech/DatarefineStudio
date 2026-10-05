import { usePlugins } from "../store/plugins";

export function PluginHost() {
  const activeView = usePlugins((s) => s.activeView);
  const closeView = usePlugins((s) => s.closeView);
  if (!activeView) return null;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 70,
        background: "rgba(6,8,12,0.55)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      onClick={closeView}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxWidth: "92vw",
          maxHeight: "78vh",
          overflow: "auto",
          borderRadius: 16,
          border: "1px solid var(--border)",
          background: "var(--bg-elev)",
          color: "var(--text)",
          padding: 20,
          display: "grid",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 16, flex: 1 }}>{activeView.title}</div>
          <button
            type="button"
            onClick={closeView}
            style={{
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text)",
              borderRadius: 8,
              padding: "4px 10px",
              fontSize: 12,
            }}
          >
            Close
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            fontFamily: "Inter, Segoe UI, system-ui, sans-serif",
            fontSize: 13,
            lineHeight: 1.5,
            color: "var(--text-dim)",
          }}
        >
          {activeView.body}
        </pre>
      </div>
    </div>
  );
}
