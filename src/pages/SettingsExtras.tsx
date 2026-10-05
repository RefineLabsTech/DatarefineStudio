/* Settings panels: AI (single professional card) + Updates (only when the
   cloud publishes a newer build; downloads in-app). Plugins live in their
   dedicated side panel; diagnostics are confidential and not shown here.
   All cloud facts come from the Rust snapshot; BYOK keys never touch settings
   files (OS credential manager via Rust commands). */

import { useEffect, useState } from "react";
import { Cloud, Cpu, KeyRound, RefreshCw, ShoppingCart, Sparkles } from "lucide-react";
import { api, tauriInvoke } from "../ipc/client";
import { useLicense } from "../store/license";
import { nativeAiCreditPurchase, nativeUpdateDownload } from "../license/native";
import { ModalShell, modalBtn, modalBtnPrimary, modalRow } from "../components/Modal";
import { datarefineAi, type RouterDecision } from "../services/ai";
import { useAiCreditVisibility } from "../services/aiCredits";

/* ---------- design tokens (match app styling) ---------- */
const section: React.CSSProperties = {
  borderRadius: 12,
  padding: 16,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  display: "grid",
  gap: 14,
};
const h2: React.CSSProperties = { fontSize: 13, fontWeight: 700, margin: 0, letterSpacing: "0.01em" };
const groupTitle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  color: "var(--text-dim)",
};
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, flexWrap: "wrap" };
const dim: React.CSSProperties = { color: "var(--text-dim)" };
const fieldLabel: React.CSSProperties = { fontSize: 10.5, color: "var(--text-dim)", fontWeight: 600 };
const btn: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  padding: "5px 9px",
  borderRadius: 7,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  cursor: "pointer",
};
const btnPrimary: React.CSSProperties = { ...btn, background: "var(--accent, #3b82f6)", border: "none", color: "#fff" };
const input: React.CSSProperties = {
  background: "var(--panel, #151a23)",
  border: "1px solid var(--border)",
  borderRadius: 7,
  color: "var(--text)",
  fontSize: 11,
  padding: "5px 8px",
  width: "100%",
  boxSizing: "border-box",
  outline: "none",
};
const chip = (color: string): React.CSSProperties => ({
  fontSize: 9.5,
  fontWeight: 700,
  padding: "2px 7px",
  borderRadius: 999,
  color,
  background: `color-mix(in srgb, ${color} 12%, transparent)`,
  border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
  whiteSpace: "nowrap",
});

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 5, borderTop: "1px solid var(--border)", paddingTop: 7 }}>
      <div style={{ ...groupTitle, fontSize: 9 }}>{title}</div>
      {children}
    </div>
  );
}

function Field({ label, children, style }: { label: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <label style={{ display: "grid", gap: 3, ...style }}>
      <span style={{ ...fieldLabel, fontSize: 10 }}>{label}</span>
      {children}
    </label>
  );
}

const PROVIDERS = ["ollama", "openai", "anthropic", "gemini", "openrouter"];
const BASE_SOURCES: { id: string; label: string }[] = [
  { id: "", label: "Auto" },
  { id: "local", label: "Run AI locally" },
  { id: "byok", label: "Your API key" },
];
const clampAccept = (v: number) => Math.min(1, Math.max(0.5, v));

export function AiSection() {
  const snap = useLicense((s) => s.snap);
  const [source, setSource] = useState("");
  const [decision, setDecision] = useState<RouterDecision | null>(null);
  const [provider, setProvider] = useState("ollama");
  const [model, setModel] = useState("");
  const [temperature, setTemperature] = useState(0.2);
  const [acceptPct, setAcceptPct] = useState(95);
  const [key, setKey] = useState("");
  const [byok, setByok] = useState(false);
  const [ollama, setOllama] = useState(false);
  const [credits, setCredits] = useState<number | null>(null);
  const [creditsBusy, setCreditsBusy] = useState(false);
  const [creditsError, setCreditsError] = useState("");
  const [zeroCreditsOpen, setZeroCreditsOpen] = useState(false);
  const [msg, setMsg] = useState("");

  const reload = async () => {
    const s = (await api.settings().catch(() => ({}))) as Record<string, unknown>;
    const ai = (s.ai as Record<string, unknown>) || {};
    const nextProvider = String(ai.provider || provider || "ollama");
    setSource(String(ai.source || ""));
    if (ai.provider) setProvider(nextProvider);
    if (ai.model) setModel(String(ai.model));
    if (typeof ai.temperature === "number") setTemperature(ai.temperature);
    if (typeof ai.accept_confidence === "number") setAcceptPct(Math.round(clampAccept(ai.accept_confidence) * 100));
    setOllama(Boolean(await tauriInvoke<boolean>("ai_local_status")));
    setByok(nextProvider !== "ollama" && Boolean(await tauriInvoke<boolean>("ai_byok_status", { provider: nextProvider })));
    setDecision(await datarefineAi.router());
  };
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const saveSource = async (v: string) => {
    setSource(v);
    await api.saveSettings({ ai: { source: v || null } }).catch(() => undefined);
    setDecision(await datarefineAi.router());
  };

  const saveEngine = async () => {
    const live = (await api.settings().catch(() => ({}))) as Record<string, unknown>;
    const ai = {
      ...((live.ai as Record<string, unknown>) || {}),
      provider,
      model,
      temperature,
      accept_confidence: clampAccept(acceptPct / 100),
    };
    await api.saveSettings({ ...live, ai }).catch(() => undefined);
    setMsg("Engine settings saved.");
  };

  const unrestricted = Boolean(snap && (!snap.requireLicense || snap.enforcement === "unrestricted"));
  // Cloud surfaces appear only in licensed mode and when the server grants cloud AI.
  // Read entitlement directly from the live Rust license snapshot. The old
  // local `ent` state could remain false when verification completed after the
  // AI card mounted, leaving Cloud hidden until another provider reload.
  const cloudEntitled = Boolean(snap?.entitlements?.cloudAi && !unrestricted);
  const visibleBaseSources = unrestricted ? BASE_SOURCES.filter((s) => s.id !== "") : BASE_SOURCES;
  const sources = cloudEntitled ? [...visibleBaseSources, { id: "cloud", label: "DataRefine Cloud AI" }] : visibleBaseSources;
  const effSource = source === "cloud" && !cloudEntitled ? "" : source;
  // With licensing off, Auto would still imply a hidden cloud fallback. Show
  // the actual local choice instead, and do not expose an Auto button.
  const displaySource = unrestricted && !effSource ? "local" : effSource;
  const creditVisibility = useAiCreditVisibility({
    source: displaySource,
    byokConfigured: byok,
    decision,
  });
  // Show only the controls that apply to the selected/effective runtime.
  // Auto follows the central router; an explicit source wins immediately.
  const runtimeMode = (effSource || decision?.source || "local") as "cloud" | "local" | "byok";

  const refreshCredits = async () => {
    if (!creditVisibility.visible) {
      setCredits(null);
      setZeroCreditsOpen(false);
      return;
    }
    setCreditsBusy(true);
    setCreditsError("");
    try {
      const c = await datarefineAi.getCredits();
      if (!c) {
        setCredits(null);
        return;
      }
      setCredits(c.balance);
      setZeroCreditsOpen(c.balance <= 0);
    } catch (e) {
      setCredits(null);
      setZeroCreditsOpen(false);
      setCreditsError(String((e as Error)?.message || e));
    } finally {
      setCreditsBusy(false);
    }
  };

  const buyCredits = async () => {
    if (!creditVisibility.purchaseEnabled) return;
    setCreditsError("");
    try {
      const activeByok = runtimeMode === "byok" || runtimeMode === "local";
      await nativeAiCreditPurchase(runtimeMode, activeByok);
      // The purchase page owns the transaction; re-read the server wallet
      // afterward rather than fabricating a local credit increase.
      await refreshCredits();
    } catch (e) {
      setCreditsError(String((e as Error)?.message || e));
    }
  };

  useEffect(() => {
    if (!creditVisibility.visible) {
      setCredits(null);
      setZeroCreditsOpen(false);
      setCreditsError("");
      return;
    }
    void refreshCredits();
    // The centralized visibility boolean is the only wallet-fetch trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creditVisibility.visible]);

  useEffect(() => {
    const onCredits = (event: Event) => {
      const detail = (event as CustomEvent<{ balance?: number }>).detail;
      if (!creditVisibility.visible || typeof detail?.balance !== "number") return;
      setCredits(detail.balance);
      setZeroCreditsOpen(detail.balance <= 0);
    };
    window.addEventListener("datarefine-cloud-ai-credits", onCredits);
    return () => window.removeEventListener("datarefine-cloud-ai-credits", onCredits);
  }, [creditVisibility.visible]);

  return (
    <section
      style={{
        ...section,
        position: "relative",
        overflow: "hidden",
        borderRadius: 8,
        borderColor: "var(--border)",
        borderLeft: "3px solid var(--accent, #3b82f6)",
        background: "var(--bg)",
        padding: 9,
        gap: 7,
      }}
      className="ai-card"
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span
          style={{
            width: 21,
            height: 21,
            flexShrink: 0,
            display: "grid",
            placeItems: "center",
            borderRadius: 5,
            color: "var(--accent, #60a5fa)",
            background: "var(--bg-input, #1b2433)",
            border: "1px solid color-mix(in srgb, var(--accent, #3b82f6) 35%, var(--border))",
          }}
        >
          <Sparkles size={12} />
        </span>
        <div style={{ display: "grid", gap: 1, minWidth: 0 }}>
          <h2 style={{ ...h2, fontSize: 12, letterSpacing: "0.01em" }}>AI runtime</h2>
          <span style={{ fontSize: 9, ...dim }}>Policy-controlled inference</span>
        </div>
        {decision && (
          <span style={{ marginLeft: "auto", ...chip(runtimeMode === "cloud" ? "var(--accent, #60a5fa)" : "var(--ok, #4ade80)") }}>
            {runtimeMode === "cloud" ? "Cloud active" : `routing → ${runtimeMode}`}
          </span>
        )}
      </div>
      <div style={{ fontSize: 9.5, ...dim, lineHeight: 1.25, margin: "-1px 0 0", maxWidth: 520 }}>
        Choose local, BYOK, or server-authorized Cloud AI.
      </div>

      <Group title="Runtime source">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${sources.length}, minmax(0, 1fr))`,
            border: "1px solid var(--border)",
            borderRadius: 7,
            overflow: "hidden",
            background: "var(--panel, #151a23)",
          }}
        >
          {sources.map((s, idx) => {
            const active = displaySource === s.id;
            return (
              <button
                key={s.id || "auto"}
                type="button"
                title={s.label}
                onClick={() => void saveSource(s.id)}
                style={{
                  padding: "5px 3px",
                  fontSize: 10,
                  fontWeight: 650,
                  cursor: "pointer",
                  background: active ? "var(--bg-input, #1b2433)" : "transparent",
                  color: active ? "var(--text)" : "var(--text-dim)",
                  border: "none",
                  borderBottom: active ? "2px solid var(--accent, #3b82f6)" : "2px solid transparent",
                  borderLeft: idx === 0 ? "none" : "1px solid var(--border)",
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {s.id === "cloud" ? "Cloud AI" : s.label}
              </button>
            );
          })}
        </div>
        {decision && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              fontSize: 9.5,
              color: runtimeMode === "cloud" ? "var(--accent, #60a5fa)" : "var(--text-dim)",
            }}
          >
            <span
              aria-hidden="true"
              style={{ width: 6, height: 6, borderRadius: 99, background: runtimeMode === "cloud" ? "var(--accent, #60a5fa)" : "var(--text-dim)" }}
            />
            {runtimeMode === "cloud" ? "Cloud AI is active · server-authorized" : decision.reason}
          </div>
        )}
      </Group>

      {runtimeMode === "cloud" && creditVisibility.visible && (
        <div
          className="ai-credit-card"
          style={{
            display: "grid",
            gap: 4,
            padding: 6,
            borderRadius: 6,
            border: "1px solid var(--border)",
            borderLeft: "3px solid var(--accent, #3b82f6)",
            background: "var(--panel, #151a23)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
            <span
              style={{
                width: 18,
                height: 18,
                flexShrink: 0,
                display: "grid",
                placeItems: "center",
                borderRadius: 4,
                color: "var(--accent, #60a5fa)",
                background: "var(--bg-input, #1b2433)",
                border: "1px solid var(--border)",
              }}
            >
              <Sparkles size={10} />
            </span>
            <div style={{ minWidth: 0, display: "flex", alignItems: "baseline", gap: 4 }}>
              <strong style={{ fontSize: 10.5, lineHeight: 1.1, whiteSpace: "nowrap" }}>Cloud AI Credits</strong>
              <span style={{ fontSize: 8.5, ...dim, whiteSpace: "nowrap" }}>server-authorized</span>
            </div>
            <span style={{ marginLeft: "auto", ...chip("var(--accent, #60a5fa)") }}>Live</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 4, minWidth: 0 }}>
              <strong style={{ fontSize: 20, lineHeight: 1, letterSpacing: "-0.04em" }}>
                {credits === null ? "—" : credits.toLocaleString()}
              </strong>
              <span style={{ fontSize: 9, ...dim }}>credits</span>
            </div>
            <div style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
              <button type="button" style={{ ...btn, padding: "3px 6px", fontSize: 10 }} disabled={creditsBusy} onClick={() => void refreshCredits()}>
                <RefreshCw size={11} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                {creditsBusy ? "Refreshing…" : "Refresh"}
              </button>
              {creditVisibility.purchaseEnabled && (
                <button type="button" style={{ ...btnPrimary, padding: "3px 7px", fontSize: 10 }} onClick={() => void buyCredits()}>
                  <ShoppingCart size={11} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                  Buy credits
                </button>
              )}
            </div>
          </div>
          {creditsError && <div style={{ fontSize: 10, color: "var(--danger, #ef4444)" }}>{creditsError}</div>}
        </div>
      )}

      {runtimeMode === "byok" && (
        <Group title="Provider & key">
          <div className="ai-kv">
          <Field label="Provider">
            <select style={input} value={provider} onChange={(e) => setProvider(e.target.value)}>
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <Field label="API key — OS credential manager only">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                style={{ ...input, flex: 1, minWidth: 120 }}
                type="password"
                placeholder={byok ? "••••  key stored securely" : "paste provider key…"}
                value={key}
                disabled={byok}
                onChange={(e) => setKey(e.target.value)}
              />
              {byok ? (
                <button
                  type="button"
                  style={btn}
                  onClick={async () => {
                    await tauriInvoke("ai_byok_delete", { provider });
                    setByok(false);
                    setMsg("Key removed.");
                  }}
                >
                  Remove
                </button>
              ) : (
                <button
                  type="button"
                  style={btnPrimary}
                  onClick={async () => {
                    if (!key.trim()) return;
                    const ok = await tauriInvoke<null>("ai_byok_save", { provider, key });
                    if (ok === null) setMsg("Could not store the key (OS credential manager unavailable).");
                    else {
                      setMsg("Key stored locally — never sent to DataRefine Cloud.");
                      setKey("");
                    }
                    setByok(Boolean(await tauriInvoke<boolean>("ai_byok_status", { provider })));
                  }}
                >
                  Save key
                </button>
              )}
            </div>
          </Field>
        </div>
        {byok && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ color: "var(--ok, #22c55e)", display: "grid", placeItems: "center" }}>
              <KeyRound size={12} />
            </span>
            <span style={chip("var(--ok, #22c55e)")}>{provider} key stored</span>
            <span style={{ fontSize: 11, ...dim }}>injected at request time by Rust</span>
          </div>
        )}
        </Group>
      )}

      {runtimeMode === "local" && (
        <Group title="Availability">
          <div style={{ ...row, gap: 6, fontSize: 10.5 }}>
          <span style={{ color: "var(--text-dim)", display: "grid", placeItems: "center", width: 13 }}>
            <Cpu size={12} />
          </span>
          <span style={{ fontSize: 11, fontWeight: 650, minWidth: 40 }}>Ollama</span>
          <span style={chip(ollama ? "var(--ok, #22c55e)" : "var(--text-dim)")}>
            {ollama ? "Ollama detected" : "Ollama not running"}
          </span>
        </div>
        {!unrestricted && (
          <div style={{ ...row, gap: 6, fontSize: 10.5 }}>
            <span style={{ color: "var(--text-dim)", display: "grid", placeItems: "center", width: 13 }}>
              <Cloud size={12} />
            </span>
            <span style={{ fontSize: 11, fontWeight: 650, minWidth: 40 }}>DataRefine Cloud AI</span>
            {snap?.entitlements?.cloudAi ? (
              <>
                <span style={chip("var(--accent, #3b82f6)")}>{snap?.license?.plan || "Cloud AI enabled"}</span>
                {snap.entitlements.agents && <span style={chip("var(--accent, #3b82f6)")}>agents</span>}
              </>
            ) : (
              <span style={{ fontSize: 11, ...dim }}>Standard license — cloud AI hidden; local & BYOK stay available.</span>
            )}
          </div>
        )}
        </Group>
      )}

      {runtimeMode !== "cloud" && (
        <Group title="Engine">
          <div className="ai-eng">
          <Field label="Model">
            <input style={input} value={model} placeholder="e.g. llama3.1 · gpt-4o-mini" onChange={(e) => setModel(e.target.value)} />
          </Field>
          <Field label="Temperature">
            <input
              style={input}
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
            />
          </Field>
        </div>
        <Field label={`Auto-accept fixes at confidence ≥ ${acceptPct}%`}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <input
              type="range"
              min={50}
              max={100}
              step={1}
              value={acceptPct}
              style={{ flex: 1, minWidth: 100 }}
              onChange={(e) => setAcceptPct(Number(e.target.value))}
            />
            <b style={{ fontSize: 11, minWidth: 34, textAlign: "right" }}>{acceptPct}%</b>
          </div>
        </Field>
        <div style={{ fontSize: 10, ...dim, margin: "-2px 0 0" }}>
          Proposals below the threshold wait for manual review.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button type="button" style={btnPrimary} onClick={() => void saveEngine()}>
            Save engine settings
          </button>
          {msg && <span style={{ fontSize: 11, ...dim }}>{msg}</span>}
        </div>
        </Group>
      )}

      {zeroCreditsOpen && creditVisibility.visible && credits === 0 && (
        <ModalShell title="Cloud AI Credits" onClose={() => setZeroCreditsOpen(false)}>
          <div style={{ display: "grid", gap: 8 }}>
            <strong style={{ fontSize: 14 }}>Your Cloud AI credits are exhausted.</strong>
            <div style={{ ...dim, lineHeight: 1.5 }}>Your Cloud AI credit balance is 0.</div>
            <div style={modalRow}>
              <button type="button" style={modalBtn} onClick={() => setZeroCreditsOpen(false)}>
                Cancel
              </button>
              {creditVisibility.purchaseEnabled && (
                <button type="button" style={modalBtnPrimary} onClick={() => void buyCredits()}>
                  Buy AI Credits
                </button>
              )}
            </div>
          </div>
        </ModalShell>
      )}
    </section>
  );
}

export function UpdatesSection() {
  const snap = useLicense((s) => s.snap);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  // Card exists only when the cloud published a newer (or mandatory) build —
  // `snap.update` is null when current == latest.
  const u = snap?.update;
  if (!u) return null;

  return (
    <section style={section}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h2 style={h2}>Update available</h2>
        <span style={chip(u.mandatory ? "var(--warn, #f59e0b)" : "var(--accent, #3b82f6)")}>
          {u.current} → {u.latest}
        </span>
        {u.mandatory && <span style={chip("var(--warn, #f59e0b)")}>required</span>}
      </div>
      {u.releaseNotes && (
        <div style={{ fontSize: 11.5, ...dim, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{u.releaseNotes}</div>
      )}
      <div style={row}>
        <button
          type="button"
          style={btnPrimary}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setMsg("Downloading update…");
            try {
              const path = await nativeUpdateDownload();
              setMsg(path ? `Downloaded — installer starting (${path}).` : "Download finished.");
            } catch (e) {
              setMsg(String((e as Error)?.message || e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Downloading…" : "Download & install"}
        </button>
        <span style={{ fontSize: 11, ...dim }}>
          {busy ? "fetching installer from your cloud…" : "downloads in-app, verifies checksum, then launches the installer"}
        </span>
      </div>
      {msg && <div style={{ fontSize: 11, ...dim }}>{msg}</div>}
    </section>
  );
}
