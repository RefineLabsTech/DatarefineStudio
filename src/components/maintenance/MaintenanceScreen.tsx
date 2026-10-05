/* Full-screen maintenance page (remote maintenance.enabled == true).
   This is NOT a license denial — it blocks entry for everyone. */

import { useLicense } from "../../store/license";
import { nativeExit } from "../../license/native";

export function MaintenanceScreen() {
  const snap = useLicense((s) => s.snap);
  const cfg = snap?.config;
  const message = cfg?.maintenance?.message || snap?.message || "We are upgrading our services. Please check back shortly.";
  const support = cfg?.links?.supportEmail || "";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "var(--bg, #0b0e14)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text)",
      }}
    >
      <div
        style={{
          width: 420,
          maxWidth: "calc(100vw - 48px)",
          background: "var(--panel, #151a23)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          padding: "26px 26px 22px",
          textAlign: "center",
          boxShadow: "0 24px 70px rgba(0,0,0,0.5)",
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            margin: "0 auto 14px",
            borderRadius: 14,
            background: "var(--accent, #3b82f6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 26,
            fontWeight: 800,
            color: "#fff",
          }}
        >
          D
        </div>
        <div style={{ fontSize: 17, fontWeight: 800 }}>Under maintenance</div>
        <div style={{ marginTop: 10, fontSize: 12.5, lineHeight: 1.6, color: "var(--text-dim)", whiteSpace: "pre-wrap" }}>
          {message}
        </div>
        {support && (
          <div style={{ marginTop: 12, fontSize: 12 }}>
            Need help? <span style={{ color: "var(--accent, #3b82f6)", fontWeight: 600 }}>{support}</span>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "center", marginTop: 18 }}>
          <button
            type="button"
            onClick={() => void nativeExit()}
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--text)",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "6px 18px",
              cursor: "pointer",
            }}
          >
            Exit
          </button>
        </div>
      </div>
    </div>
  );
}
