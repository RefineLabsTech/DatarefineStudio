/* Premium activation dialog + lock screens (blocked / expired / mismatch /
   offline-grace). Renders serialized Rust state only. */

import { useState } from "react";
import { useLicense } from "../../store/license";
import { nativeExit } from "../../license/native";

const card: React.CSSProperties = {
  width: 400,
  maxWidth: "calc(100vw - 48px)",
  background: "var(--panel, #151a23)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  padding: "22px 24px 20px",
  boxShadow: "0 24px 70px rgba(0,0,0,0.55)",
  color: "var(--text)",
};
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

export function LicenseActivationDialog() {
  const snap = useLicense((s) => s.snap);
  const busy = useLicense((s) => s.busy);
  const activateError = useLicense((s) => s.activateError);
  const activate = useLicense((s) => s.activate);
  const continueBasic = useLicense((s) => s.continueBasic);
  const setActivationOpen = useLicense((s) => s.setActivationOpen);
  const openUrl = useLicense((s) => s.openUrl);
  const checkNow = useLicense((s) => s.checkNow);
  const [key, setKey] = useState("");

  const decision = snap?.decision || "license_required";
  const cfg = snap?.config;
  const buyUrl = cfg?.links?.buyUrl || cfg?.buyUrl || "";
  const githubUrl = cfg?.links?.githubUrl || "";

  const info = lockInfo(decision, snap?.message || "");
  const showForm = decision === "license_required" || decision === "license_invalid" || decision === "token_invalid" || decision === "basic";
  const showBasicChoice = decision !== "basic" && Boolean(snap?.requireLicense);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "rgba(4,6,10,0.72)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              background: "var(--accent, #3b82f6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 17,
              fontWeight: 800,
              color: "#fff",
            }}
          >
            D
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800 }}>{info.title}</div>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>DataRefine Studio</div>
          </div>
        </div>

        <div style={{ fontSize: 12.5, lineHeight: 1.6, color: "var(--text-dim)", marginTop: 8, minHeight: 34 }}>
          {info.body}
        </div>

        {showForm && (
          <>
            <input
              value={key}
              autoFocus
              placeholder="XXXX-XXXX-XXXX-XXXX"
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) void activate(key);
              }}
              style={{
                width: "100%",
                boxSizing: "border-box",
                marginTop: 12,
                background: "var(--bg, #0d1117)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                color: "var(--text)",
                fontSize: 12.5,
                padding: "8px 10px",
                outline: "none",
                letterSpacing: "0.04em",
              }}
            />
            {activateError && (
              <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--danger, #ef4444)" }}>{activateError}</div>
            )}
          </>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
          {showForm && (
            <button type="button" style={btnPrimary} disabled={busy} onClick={() => void activate(key)}>
              {busy ? "Activating…" : "Activate Professional"}
            </button>
          )}
          {showBasicChoice && (
            <button type="button" style={btn} disabled={busy} onClick={() => void continueBasic()}>
              {busy ? "Opening Basic…" : "Continue with Basic"}
            </button>
          )}
          {decision === "basic" && (
            <button type="button" style={btn} disabled={busy} onClick={() => setActivationOpen(false)}>
              Back to Basic
            </button>
          )}
          {decision === "grace_expired" && (
            <button type="button" style={btnPrimary} disabled={busy} onClick={() => void checkNow()}>
              Retry
            </button>
          )}
          {(decision === "license_expired" || decision === "license_blocked") && buyUrl && (
            <button type="button" style={btnPrimary} onClick={() => void openUrl(buyUrl)}>
              {decision === "license_expired" ? "Renew license" : "Buy license"}
            </button>
          )}
          {showForm && buyUrl && (
            <button type="button" style={btn} onClick={() => void openUrl(buyUrl)}>
              Buy License
            </button>
          )}
          {githubUrl && (
            <button type="button" style={btn} onClick={() => void openUrl(githubUrl)}>
              GitHub
            </button>
          )}
          <button type="button" style={btn} onClick={() => void nativeExit()}>
            Exit
          </button>
        </div>

        {snap?.offline && (
          <div style={{ marginTop: 12, fontSize: 11, color: "var(--warn, #f59e0b)" }}>
            You appear to be offline — activation needs a connection.
          </div>
        )}
      </div>
    </div>
  );
}

function lockInfo(decision: string, message: string): { title: string; body: string } {
  switch (decision) {
    case "license_blocked":
      return {
        title: "License blocked",
        body: message || "This license has been blocked. Contact support or purchase a new license.",
      };
    case "license_expired":
      return {
        title: "License expired",
        body: message || "Your license has expired. Renew it to keep using DataRefine Studio. Your projects and datasets remain untouched.",
      };
    case "device_mismatch":
      return {
        title: "Device mismatch",
        body: message || "This license is activated on a different machine. Deactivate it there or contact support.",
      };
    case "grace_expired":
      return {
        title: "Offline grace expired",
        body: message || "Connect to the internet and retry. Your projects and datasets are never deleted.",
      };
    case "license_invalid":
      return { title: "Activate DataRefine Studio", body: message || "Enter your license key to continue." };
    case "token_invalid":
      return {
        title: "Activate DataRefine Studio",
        body: "Your previous activation could not be validated. Please activate again with your license key.",
      };
    case "basic":
      return {
        title: "Upgrade to Professional",
        body: message || "Basic mode keeps local cleaning available. Activate a valid Professional license to unlock cloud-controlled premium features.",
      };
    default:
      return {
        title: "Activate DataRefine Studio",
        body: "This deployment requires a license. Enter your key below — your data never leaves this computer.",
      };
  }
}
