/* Extensions side panel — management of installed plugins only.
   The marketplace (search + install) lives in its own dedicated side panel.
   This panel intentionally exposes only enable/trust/unload controls. */

import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { pluginIcon } from "../lib/pluginIcons";
import { usePlugins } from "../store/plugins";
import { useUI } from "../store/ui";
import { useLicense } from "../store/license";
import { canUseFeature, PREMIUM_FEATURE } from "../license/features";
import { PremiumFeatureGate } from "../components/license/PremiumFeatureGate";

const card: React.CSSProperties = {
  borderRadius: 12,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  padding: 12,
  display: "grid",
  gap: 8,
};
const dimTxt: React.CSSProperties = { fontSize: 11, color: "var(--text-dim)" };
const ghostBtn: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  fontSize: 11,
  cursor: "pointer",
};
const primaryBtn: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 8,
  border: "none",
  background: "var(--accent)",
  color: "#fff",
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
};

export function PluginsPage() {
  const { plugins, error, refresh, setEnabled, unload } = usePlugins(
    useShallow((s) => ({
      plugins: s.plugins,
      error: s.error,
      refresh: s.refresh,
      setEnabled: s.setEnabled,
      unload: s.unload,
    })),
  );
  const askConfirm = useUI((s) => s.askConfirm);
  const license = useLicense((s) => s.snap);
  const orderedPlugins = [...plugins].sort((a, b) =>
    String(a.displayName || a.id).localeCompare(String(b.displayName || b.id), undefined, {
      sensitivity: "base",
      numeric: true,
    }),
  );

  useEffect(() => {
    if (canUseFeature(license, PREMIUM_FEATURE.installedPlugins)) void refresh();
  }, [refresh, license?.decision, license?.requireLicense, license?.enforcement]);

  if (!canUseFeature(license, PREMIUM_FEATURE.installedPlugins)) {
    return <PremiumFeatureGate feature={PREMIUM_FEATURE.installedPlugins} title="Extensions are disabled in Basic mode" description="Marketplace extensions are disabled until a Professional license is active. Your local files and cleaning workflows remain available." />;
  }

  return (
    <div style={{ padding: 16, fontSize: 13, color: "var(--text)", display: "grid", gap: 12 }}>
      <div>
        <h1 style={{ fontSize: 16, fontWeight: 650, margin: 0 }}>Extensions</h1>
        <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--text-dim)", lineHeight: 1.45 }}>
          Manage installed plugins — enable, trust or unload them. New plugins are installed from the Marketplace panel. Installed plugins are shown A–Z.
        </p>
      </div>

      {!plugins.length && !error && (
        <div style={dimTxt}>
          Installed plugins appear here. Bundled Clean Kit and Studio UI Kit show once the Python engine is up.
        </div>
      )}
      {orderedPlugins.map((p) => {
        const Icon = pluginIcon(p.icon);
        return (
          <div key={p.id} style={card}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <span style={{ width: 24, height: 24, flexShrink: 0, display: "grid", placeItems: "center", borderRadius: 6, color: "var(--accent)", background: "var(--bg-input)", border: "1px solid var(--border)" }}>
                <Icon size={15} strokeWidth={1.8} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 650 }}>{p.displayName}</div>
              <div style={dimTxt}>
                {p.id} · v{p.version}
                {p.publisher ? ` · ${p.publisher}` : ""}
                {p.bundled ? " · bundled" : ""}
              </div>
            </div>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={p.enabled}
                disabled={p.needsTrust && !p.enabled}
                onChange={(e) => void setEnabled(p.id, e.target.checked)}
              />
              On
            </label>
          </div>
          {p.description ? <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.45 }}>{p.description}</div> : null}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {(p.levels || []).map((lv) => (
              <span key={lv} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 99, background: "var(--bg-input)", color: "var(--text-dim)", textTransform: "uppercase" }}>
                {lv}
              </span>
            ))}
            {p.needsTrust && (
              <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 99, background: "color-mix(in srgb, var(--danger) 18%, var(--bg))", color: "var(--danger)" }}>
                needs trust
              </span>
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {p.needsTrust && (
              <button type="button" onClick={() => void setEnabled(p.id, true, true)} style={primaryBtn}>
                Trust & enable
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (p.bundled) {
                  void setEnabled(p.id, false);
                  return;
                }
                void (async () => {
                  const ok = await askConfirm({
                    title: `Unload “${p.displayName}”?`,
                    message: "This removes the extension from DataRefine Studio. You can install it again from the Marketplace.",
                    detail: "Files on disk are deleted. The extra sidebar icon disappears immediately.",
                    confirmLabel: "Unload",
                    danger: true,
                  });
                  if (ok) {
                    await unload(p.id);
                    await refresh();
                  }
                })();
              }}
              style={ghostBtn}
            >
              {p.bundled ? "Disable" : "Unload"}
            </button>
          </div>
          </div>
        );
      })}
      {error && <div style={{ fontSize: 11, color: "var(--danger)" }}>{error}</div>}
    </div>
  );
}
