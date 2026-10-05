/* Soft maintenance notice (§41): non-blocking strip. Only cloud-flagged
   HARD maintenance renders the full-screen MaintenanceScreen. Edge-to-edge
   aligned bar, same visual language as the announcement strip. */

import { Wrench } from "lucide-react";
import { useLicense } from "../../store/license";

export function MaintenanceBanner() {
  const snap = useLicense((s) => s.snap);
  const m = snap?.config?.maintenance;
  if (!snap || !m?.enabled || m.hard) return null;
  if (snap.decision === "maintenance") return null; // hard path already blocks

  const c = "var(--warn, #f59e0b)";
  return (
    <div
      role="status"
      style={{
        pointerEvents: "auto",
        width: "100%",
        height: 38,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0 16px",
        borderLeft: `3px solid ${c}`,
        borderBottom: "1px solid var(--border)",
        background: `color-mix(in srgb, ${c} 9%, var(--panel, #151a23))`,
        color: "var(--text)",
      }}
    >
      <span style={{ color: c, display: "grid", placeItems: "center", width: 16, height: 16, flexShrink: 0 }}>
        <Wrench size={14} />
      </span>
      <span style={{ fontSize: 12, fontWeight: 650, lineHeight: 1 }}>
        {m.message || "Scheduled maintenance in progress — some cloud features may be temporarily unavailable. Your local work is unaffected."}
      </span>
    </div>
  );
}
