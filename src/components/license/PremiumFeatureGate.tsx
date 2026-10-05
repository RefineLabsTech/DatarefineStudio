import { Lock, Sparkles } from "lucide-react";
import { useLicense } from "../../store/license";
import { featureLabel } from "../../license/features";

export function PremiumFeatureGate({ feature, title, description }: { feature: string; title?: string; description?: string }) {
  const snap = useLicense((s) => s.snap);
  const openUrl = useLicense((s) => s.openUrl);
  const setActivationOpen = useLicense((s) => s.setActivationOpen);
  const purchaseUrl = snap?.config?.links?.buyUrl || snap?.config?.buyUrl || "";
  return (
    <div style={{ padding: 24, display: "grid", placeItems: "center", minHeight: 260, color: "var(--text)" }}>
      <div
        style={{
          width: "min(440px, 100%)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          background: "var(--bg)",
          padding: 22,
          display: "grid",
          gap: 12,
          textAlign: "center",
        }}
      >
        <div style={{ margin: "0 auto", width: 42, height: 42, borderRadius: 12, display: "grid", placeItems: "center", background: "color-mix(in srgb, var(--accent) 16%, transparent)", color: "var(--accent)" }}>
          <Lock size={20} />
        </div>
        <div style={{ fontSize: 16, fontWeight: 750 }}>{title || `${featureLabel(feature)} is a Professional feature`}</div>
        <div style={{ fontSize: 12, lineHeight: 1.55, color: "var(--text-dim)" }}>
          {description || "Continue using Basic mode for local data cleaning, or activate a valid Professional license to unlock this cloud-controlled feature."}
        </div>
        <div style={{ display: "flex", justifyContent: "center", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={() => setActivationOpen(true)} style={primaryButton}>
            <Sparkles size={13} /> Activate Professional
          </button>
          {purchaseUrl ? (
            <button type="button" onClick={() => void openUrl(purchaseUrl)} style={secondaryButton}>
              Purchase license
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const primaryButton: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 12px",
  borderRadius: 8,
  border: "none",
  background: "var(--accent)",
  color: "#fff",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};

const secondaryButton: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  fontSize: 12,
  fontWeight: 650,
  cursor: "pointer",
};
