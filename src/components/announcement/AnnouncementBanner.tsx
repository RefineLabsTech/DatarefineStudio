/* Remote announcement strip (info / warning). Critical notices use the modal.
   Edge-to-edge bar; every element sits on one vertically-centered baseline. */

import { Info, TriangleAlert, X } from "lucide-react";
import { activeAnnouncements, useLicense } from "../../store/license";
import type { Announcement } from "../../license/types";

function palette(type: string) {
  if (type === "warning") return { c: "var(--warn, #f59e0b)", Icon: TriangleAlert };
  return { c: "var(--accent, #3b82f6)", Icon: Info };
}

function Strip({ a }: { a: Announcement }) {
  const dismiss = useLicense((s) => s.dismiss);
  const openUrl = useLicense((s) => s.openUrl);
  const { c, Icon } = palette(String(a.type || "info"));
  const actionUrl = a.buttonUrl || a.link;

  return (
    <div
      style={{
        pointerEvents: "auto",
        width: "100%",
        height: 38,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0 12px 0 16px",
        borderLeft: `3px solid ${c}`,
        borderBottom: "1px solid var(--border)",
        background: `color-mix(in srgb, ${c} 9%, var(--panel, #151a23))`,
        color: "var(--text)",
        animation: "anndrop .2s ease-out",
      }}
    >
      <span style={{ color: c, display: "grid", placeItems: "center", width: 16, height: 16, flexShrink: 0 }}>
        <Icon size={14} />
      </span>
      <span style={{ fontSize: 12, fontWeight: 750, lineHeight: 1, flexShrink: 0, letterSpacing: "0.01em" }}>
        {a.title || String(a.type || "info").toUpperCase()}
      </span>
      {a.message && (
        <>
          <span style={{ color: "var(--border)", lineHeight: 1, flexShrink: 0 }}>·</span>
          <span
            style={{
              fontSize: 12,
              lineHeight: 1,
              color: "var(--text-dim)",
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {a.message}
          </span>
        </>
      )}
      {actionUrl && (
        <button
          type="button"
          onClick={() => void openUrl(actionUrl)}
          style={{
            height: 24,
            display: "inline-flex",
            alignItems: "center",
            fontSize: 11,
            fontWeight: 700,
            lineHeight: 1,
            color: c,
            background: `color-mix(in srgb, ${c} 12%, transparent)`,
            border: `1px solid color-mix(in srgb, ${c} 30%, transparent)`,
            borderRadius: 7,
            padding: "0 10px",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          {a.buttonText || "Details"}
        </button>
      )}
      {a.dismissible !== false && (
        <button
          type="button"
          title="Dismiss"
          onClick={() => void dismiss(a)}
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
          <X size={13} />
        </button>
      )}
    </div>
  );
}

export function AnnouncementBanner() {
  const snap = useLicense((s) => s.snap);
  const active = activeAnnouncements(snap).filter((a) => a.type !== "critical");
  if (!active.length) return null;
  return (
    <div
      style={{
        position: "fixed",
        top: 40,
        left: 0,
        right: 0,
        zIndex: 80,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <style>{"@keyframes anndrop{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}"}</style>
      {active.slice(0, 3).map((a) => (
        <Strip key={a.id} a={a} />
      ))}
    </div>
  );
}
