/* License status panel (sidebar page). Read-only view of Rust state. */

import { useState } from "react";
import { ModalShell, modalBtn, modalBtnDanger, modalRow } from "../Modal";
import { useLicense } from "../../store/license";
import { basicFileImportStatus } from "../../license/importQuota";

const row: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 10,
  padding: "7px 0",
  borderBottom: "1px solid var(--border)",
  fontSize: 12,
};

function expiryColor(days: number): string {
  if (days <= 7) return "var(--danger, #ef4444)";
  if (days <= 30) return "var(--warn, #f59e0b)";
  return "var(--ok, #22c55e)";
}

export function LicenseStatusPanel() {
  const snap = useLicense((s) => s.snap);
  const busy = useLicense((s) => s.busy);
  const checkNow = useLicense((s) => s.checkNow);
  const removeLicense = useLicense((s) => s.removeLicense);
  const setActivationOpen = useLicense((s) => s.setActivationOpen);
  const lic = snap?.license;
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeError, setRemoveError] = useState("");

  if (!snap) return null;

  if (snap.basicMode || snap.decision === "basic") {
    const limit = snap.featurePolicy?.basicImportRowLimit || 5000;
    const importQuota = basicFileImportStatus(snap);
    return (
      <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--text)" }}>
        <div style={head}>License</div>
        <div style={{ color: "var(--warn, #f59e0b)", fontWeight: 750, marginBottom: 6 }}>Basic mode</div>
        <div style={{ color: "var(--text-dim)", lineHeight: 1.6 }}>
          Local data cleaning remains available. Professional-only features are disabled while the cloud license requirement is active.
        </div>
        <div style={{ ...row, marginTop: 10 }}>
          <span style={{ color: "var(--text-dim)" }}>Import limit</span>
          <span>{Number(limit).toLocaleString()} rows</span>
        </div>
        <div style={row}>
          <span style={{ color: "var(--text-dim)" }}>File imports</span>
          <span>
            {importQuota.storageAvailable
              ? `${importQuota.remaining}/${importQuota.limit} left · rolling 30 days`
              : "Unavailable"}
          </span>
        </div>
        <div style={{ ...row, borderBottom: "none" }}>
          <span style={{ color: "var(--text-dim)" }}>Available export</span>
          <span>CSV</span>
        </div>
        <button type="button" onClick={() => setActivationOpen(true)} style={{ marginTop: 12, fontSize: 11, fontWeight: 700, color: "#fff", background: "var(--accent, #3b82f6)", border: "none", borderRadius: 7, padding: "7px 12px", cursor: "pointer" }}>
          Activate Professional
        </button>
      </div>
    );
  }

  if (!snap.requireLicense) {
    return (
      <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--text)" }}>
        <div style={head}>License</div>
        <div style={{ color: "var(--text-dim)", lineHeight: 1.6 }}>
          This deployment runs in <span style={{ color: "var(--ok, #22c55e)", fontWeight: 700 }}>free mode</span> — the
          remote license requirement is off. All features are available.
        </div>
        <div style={{ ...row, marginTop: 10 }}>
          <span style={{ color: "var(--text-dim)" }}>Device ID</span>
          <span style={{ fontFamily: "monospace", fontSize: 11 }}>{snap.deviceId.slice(0, 13)}…</span>
        </div>
      </div>
    );
  }

  const days = lic?.daysRemaining ?? 0;
  return (
    <>
      <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--text)" }}>
      <div style={head}>License</div>
      <div style={row}>
        <span style={{ color: "var(--text-dim)" }}>Plan</span>
        <span style={{ fontWeight: 700 }}>{lic?.plan || "—"}</span>
      </div>
      <div style={row}>
        <span style={{ color: "var(--text-dim)" }}>Status</span>
        <span style={{ fontWeight: 700, color: snap.decision === "granted" ? "var(--ok, #22c55e)" : "var(--warn, #f59e0b)" }}>
          {snap.decision.replace(/_/g, " ")}
        </span>
      </div>
      <div style={row}>
        <span style={{ color: "var(--text-dim)" }}>Expires</span>
        <span>{lic?.expiresAt ? lic.expiresAt.replace("T", " ").replace("Z", "") : "—"}</span>
      </div>
      <div style={row}>
        <span style={{ color: "var(--text-dim)" }}>Days remaining</span>
        <span style={{ fontWeight: 800, color: expiryColor(days) }}>{days > 36500 ? "∞" : days}</span>
      </div>
      <div style={row}>
        <span style={{ color: "var(--text-dim)" }}>License</span>
        <span style={{ fontFamily: "monospace", fontSize: 11 }}>{lic?.masked || "—"}</span>
      </div>
      <div style={row}>
        <span style={{ color: "var(--text-dim)" }}>Device ID</span>
        <span style={{ fontFamily: "monospace", fontSize: 11 }}>{snap.deviceId.slice(0, 13)}…</span>
      </div>
      <div style={row}>
        <span style={{ color: "var(--text-dim)" }}>Connection</span>
        <span style={{ color: lic?.offline || snap.offline ? "var(--warn, #f59e0b)" : "var(--ok, #22c55e)", fontWeight: 700 }}>
          {lic?.offline || snap.offline ? "Offline (grace)" : "Online"}
        </span>
      </div>
      <div style={{ ...row, borderBottom: "none" }}>
        <span style={{ color: "var(--text-dim)" }}>Last verification</span>
        <span>{lic?.lastVerification ? lic.lastVerification.replace("T", " ").replace("Z", "") : "—"}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => void checkNow()}
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "#fff",
            background: "var(--accent, #3b82f6)",
            border: "none",
            borderRadius: 7,
            padding: "6px 14px",
            cursor: "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? "Checking…" : "Check now"}
        </button>
        {lic && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setRemoveError("");
              setRemoveOpen(true);
            }}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--danger, #ef4444)",
              background: "transparent",
              border: "1px solid color-mix(in srgb, var(--danger, #ef4444) 45%, var(--border))",
              borderRadius: 7,
              padding: "5px 11px",
              cursor: "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            Remove license
          </button>
        )}
      </div>
      </div>
      {removeOpen && (
        <ModalShell title="Remove license" onClose={() => setRemoveOpen(false)}>
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Remove this license from this device?</div>
            <div style={{ color: "var(--text-dim)", lineHeight: 1.55 }}>
              This clears the local activation and Cloud AI access. Your local projects and datasets will not be changed, and the Cloud license record will not be deleted.
            </div>
            {removeError && <div style={{ color: "var(--danger, #ef4444)", fontSize: 11 }}>{removeError}</div>}
            <div style={modalRow}>
              <button type="button" style={modalBtn} onClick={() => setRemoveOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                style={modalBtnDanger}
                disabled={busy}
                onClick={async () => {
                  const removed = await removeLicense();
                  if (removed) setRemoveOpen(false);
                  else setRemoveError("The license could not be removed from this device.");
                }}
              >
                {busy ? "Removing…" : "Remove license"}
              </button>
            </div>
          </div>
        </ModalShell>
      )}
    </>
  );
}

const head: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--text-dim)",
  marginBottom: 8,
};
