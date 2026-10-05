/* Remote announcements — styled in-app popup (info / warning / critical).
   Priority-ordered; dismissals persist in Rust (id + updatedAt). */

import { useEffect } from "react";
import { CalendarRange, ExternalLink, Info, OctagonAlert, TriangleAlert, X } from "lucide-react";
import { activeAnnouncements, useLicense } from "../../store/license";
import type { Announcement } from "../../license/types";

function palette(type: string) {
  if (type === "critical") return { c: "var(--danger, #ef4444)", label: "Critical notice", Icon: OctagonAlert };
  if (type === "warning") return { c: "var(--warn, #f59e0b)", label: "Warning", Icon: TriangleAlert };
  return { c: "var(--accent, #3b82f6)", label: "Notice", Icon: Info };
}

export function AnnouncementModal() {
  const snap = useLicense((s) => s.snap);
  const dismiss = useLicense((s) => s.dismiss);
  const openUrl = useLicense((s) => s.openUrl);
  const a: Announcement | undefined = activeAnnouncements(snap).filter((x) => x.type === "critical")[0];
  const dismissible = a?.dismissible !== false;
  const close = () => {
    if (a) void dismiss(a);
  };

  useEffect(() => {
    if (!a || !dismissible) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  if (!a) return null;
  const { c, label, Icon } = palette(String(a.type || "info"));
  const start = a.startDate ? a.startDate.slice(0, 10) : null;
  const end = a.endDate ? a.endDate.slice(0, 10) : null;
  const actionUrl = a.buttonUrl || a.link;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 150,
        background: "rgba(4,6,10,0.62)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={() => dismissible && close()}
    >
      <style>{"@keyframes annpop{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}"}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 460,
          maxWidth: "calc(100vw - 48px)",
          background: "var(--panel, #151a23)",
          border: `1px solid color-mix(in srgb, ${c} 40%, var(--border))`,
          borderRadius: 14,
          boxShadow: `0 24px 80px rgba(0,0,0,0.6), 0 0 42px color-mix(in srgb, ${c} 15%, transparent)`,
          color: "var(--text)",
          overflow: "hidden",
          animation: "annpop .18s ease-out",
        }}
      >
        <div style={{ height: 3, background: `linear-gradient(90deg, ${c}, transparent 70%)` }} />
        <div style={{ padding: "18px 20px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                flexShrink: 0,
                display: "grid",
                placeItems: "center",
                color: c,
                background: `color-mix(in srgb, ${c} 15%, transparent)`,
                border: `1px solid color-mix(in srgb, ${c} 35%, transparent)`,
              }}
            >
              <Icon size={17} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 800,
                  letterSpacing: "0.09em",
                  textTransform: "uppercase",
                  color: c,
                }}
              >
                {label}
              </div>
              <div style={{ fontSize: 14.5, fontWeight: 750, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {a.title || "Announcement"}
              </div>
            </div>
            {dismissible && (
              <button
                type="button"
                title="Dismiss"
                onClick={close}
                style={{
                  width: 26,
                  height: 26,
                  flexShrink: 0,
                  border: "none",
                  borderRadius: 8,
                  background: "transparent",
                  color: "var(--text-dim)",
                  display: "grid",
                  placeItems: "center",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <X size={14} />
              </button>
            )}
          </div>

          {a.message && (
            <div style={{ marginTop: 12, fontSize: 12.5, lineHeight: 1.65, color: "var(--text-dim)", whiteSpace: "pre-wrap" }}>
              {a.message}
            </div>
          )}

          {(start || end) && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 12, fontSize: 11, color: "var(--text-dim)" }}>
              <CalendarRange size={12} style={{ opacity: 0.8 }} />
              <span>
                {start || "now"} → {end || "until further notice"}
              </span>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            {actionUrl && (
              <button
                type="button"
                onClick={() => void openUrl(actionUrl)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  fontWeight: 650,
                  color: "#fff",
                  background: "var(--accent, #3b82f6)",
                  border: "none",
                  borderRadius: 9,
                  padding: "7px 14px",
                  cursor: "pointer",
                }}
              >
                <ExternalLink size={12} />
                {a.buttonText || "Details"}
              </button>
            )}
            {dismissible ? (
              <button
                type="button"
                onClick={close}
                style={{
                  fontSize: 12,
                  fontWeight: 650,
                  color: "var(--text)",
                  background: "transparent",
                  border: "1px solid var(--border)",
                  borderRadius: 9,
                  padding: "7px 16px",
                  cursor: "pointer",
                }}
              >
                Got it
              </button>
            ) : (
              <span style={{ fontSize: 11, color: "var(--text-dim)", alignSelf: "center" }}>
                This notice stays visible while it is live.
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
