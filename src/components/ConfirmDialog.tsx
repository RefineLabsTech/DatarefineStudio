import { useEffect } from "react";
import { useUI } from "../store/ui";

export function ConfirmDialog() {
  const confirm = useUI((s) => s.confirm);
  const answerConfirm = useUI((s) => s.answerConfirm);

  useEffect(() => {
    if (!confirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        answerConfirm(false);
      }
      if (e.key === "Enter") {
        e.preventDefault();
        answerConfirm(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, answerConfirm]);

  if (!confirm) return null;

  const accent = confirm.danger ? "var(--danger)" : "var(--accent)";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="drs-confirm-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 20000,
        background: "rgba(6,8,12,0.62)",
        backdropFilter: "blur(10px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      onClick={() => answerConfirm(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 440,
          maxWidth: "100%",
          borderRadius: 20,
          border: "1px solid var(--border)",
          background: "var(--bg-elev)",
          color: "var(--text)",
          padding: 22,
          display: "grid",
          gap: 14,
          boxShadow: "0 24px 64px rgba(0,0,0,0.45)",
        }}
      >
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          <div
            style={{
              width: 44,
              height: 44,
              flexShrink: 0,
              borderRadius: 14,
              display: "grid",
              placeItems: "center",
              background: `color-mix(in srgb, ${accent} 18%, var(--bg))`,
              color: accent,
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div id="drs-confirm-title" style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1.25 }}>
              {confirm.title}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 6, lineHeight: 1.5 }}>{confirm.message}</div>
          </div>
        </div>

        {confirm.detail ? (
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              border: `1px solid color-mix(in srgb, ${accent} 35%, var(--border))`,
              background: `color-mix(in srgb, ${accent} 12%, var(--bg))`,
              fontSize: 12,
              color: "var(--text)",
              lineHeight: 1.45,
              whiteSpace: "pre-line",
            }}
          >
            {confirm.detail}
          </div>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button
            type="button"
            onClick={() => answerConfirm(false)}
            style={{
              padding: "8px 14px",
              borderRadius: 10,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text)",
              fontWeight: 600,
              fontSize: 13,
            }}
          >
            {confirm.cancelLabel || "Cancel"}
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => answerConfirm(true)}
            style={{
              padding: "8px 16px",
              borderRadius: 10,
              border: "none",
              background: accent,
              color: "#fff",
              fontWeight: 700,
              fontSize: 13,
            }}
          >
            {confirm.confirmLabel || "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
