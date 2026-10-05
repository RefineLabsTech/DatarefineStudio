/* Update system.
   - mandatory (below remote minimum): full-screen blocker with download CTA.
   - optional (newer exists): non-blocking dialog, dismissible for the session. */

import { useState } from "react";
import { useLicense } from "../../store/license";

const btn: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text)",
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "6px 14px",
  cursor: "pointer",
};
const btnPrimary: React.CSSProperties = {
  ...btn,
  color: "#fff",
  background: "var(--accent, #3b82f6)",
  borderColor: "transparent",
};

export function UpdateDialog() {
  const snap = useLicense((s) => s.snap);
  const openUrl = useLicense((s) => s.openUrl);
  const [hidden, setHidden] = useState(false);
  const u = snap?.update;
  if (!u || u.mandatory || hidden) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 140,
        background: "rgba(4,6,10,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={() => setHidden(true)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 400,
          maxWidth: "calc(100vw - 48px)",
          background: "var(--panel, #151a23)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: "18px 20px 16px",
          boxShadow: "0 24px 70px rgba(0,0,0,0.5)",
          color: "var(--text)",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 800 }}>Update available — v{u.latest}</div>
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-dim)", lineHeight: 1.6 }}>
          You are on v{u.current}.
          {u.releaseNotes ? ` Release notes: ${u.releaseNotes}` : ""}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button type="button" style={btn} onClick={() => setHidden(true)}>
            Later
          </button>
          <button type="button" style={btnPrimary} onClick={() => void openUrl(u.downloadUrl)}>
            Download
          </button>
        </div>
      </div>
    </div>
  );
}

/** Full-screen mandatory update blocker (app below remote minimum version). */
export function MandatoryUpdateScreen() {
  const snap = useLicense((s) => s.snap);
  const openUrl = useLicense((s) => s.openUrl);
  const u = snap?.update;
  if (!u) return null;
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
          width: 430,
          maxWidth: "calc(100vw - 48px)",
          background: "var(--panel, #151a23)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          padding: "24px 26px 20px",
          textAlign: "center",
          boxShadow: "0 24px 70px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 800 }}>Update required</div>
        <div style={{ marginTop: 10, fontSize: 12.5, color: "var(--text-dim)", lineHeight: 1.6 }}>
          This build (v{u.current}) is below the minimum supported version (v{u.minimum}).
          <br />
          Update to continue — your projects and datasets stay on this computer.
        </div>
        {u.releaseNotes && (
          <div
            style={{
              marginTop: 12,
              fontSize: 11.5,
              color: "var(--text-dim)",
              background: "color-mix(in srgb, var(--bg) 50%, transparent)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "8px 10px",
              textAlign: "left",
              whiteSpace: "pre-wrap",
              maxHeight: 140,
              overflow: "auto",
            }}
          >
            {u.releaseNotes}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
          <button type="button" style={btnPrimary} onClick={() => void openUrl(u.downloadUrl)}>
            Download v{u.latest || u.minimum}
          </button>
        </div>
      </div>
    </div>
  );
}
