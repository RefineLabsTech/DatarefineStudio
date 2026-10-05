import { memo } from "react";
import { X } from "lucide-react";
import { useWorkspace } from "../store/workspace";

export const TabStrip = memo(function TabStrip() {
  const tabs = useWorkspace((s) => s.tabs);
  const sessionId = useWorkspace((s) => s.sessionId);
  const switchTab = useWorkspace((s) => s.switchTab);
  const closeTab = useWorkspace((s) => s.closeTab);
  if (!tabs.length) return null;
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        padding: "8px 10px 0",
        overflowX: "auto",
        flexShrink: 0,
      }}
    >
      {tabs.map((t) => {
        const on = t.id === sessionId;
        return (
          <div
            key={t.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 6px 5px 12px",
              borderRadius: "10px 10px 0 0",
              border: "1px solid var(--border)",
              borderBottom: "none",
              background: on ? "var(--bg-elev)" : "transparent",
              color: on ? "var(--text)" : "var(--text-dim)",
              fontSize: 12,
              fontWeight: on ? 650 : 500,
              maxWidth: 220,
              flexShrink: 0,
            }}
          >
            <button
              type="button"
              title={t.label}
              onClick={() => void switchTab(t.id)}
              style={{
                border: "none",
                background: "transparent",
                color: "inherit",
                fontSize: 12,
                padding: 0,
                cursor: "pointer",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: 170,
              }}
            >
              {t.label}
            </button>
            <button
              type="button"
              title="Close sheet"
              onClick={() => void closeTab(t.id)}
              style={{
                border: "none",
                background: "transparent",
                color: "inherit",
                padding: 2,
                cursor: "pointer",
                display: "grid",
                placeItems: "center",
                borderRadius: 6,
                opacity: 0.7,
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
});
