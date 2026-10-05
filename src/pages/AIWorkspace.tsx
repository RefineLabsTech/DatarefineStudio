import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { Lock, LockOpen, ShoppingCart, Sparkles } from "lucide-react";
import { nativeAiCreditPurchase } from "../license/native";
import { useLicense } from "../store/license";
import { useWorkspace } from "../store/workspace";
import { useUI } from "../store/ui";
import { acceptPct, useAiPipeline } from "../store/aiPipeline";
import { api } from "../ipc/client";

const PHASES = ["Detect", "Plan", "Preview", "Apply"] as const;

export function AIWorkspace() {
  const { sessionId, metrics, profile, selectedColumns, selectedRows } = useWorkspace(
    useShallow((s) => ({
      sessionId: s.sessionId,
      metrics: s.metrics,
      profile: s.profile,
      selectedColumns: s.selectedColumns,
      selectedRows: s.selectedRows,
    })),
  );
  const setSidebar = useUI((s) => s.setSidebar);
  const openUrl = useLicense((s) => s.openUrl);
  const {
    phase,
    busy,
    progress,
    error,
    quota,
    quotaUpgradeUrl,
    locked,
    extra,
    useLlm,
    scope,
    acceptMin,
    plan,
    buckets,
    history,
    profiles,
    generate,
    refreshQuota,
    setScope,
    setExtra,
    setUseLlm,
    setLocked,
    setAcceptMin,
    loadLock,
  } = useAiPipeline();

  useEffect(() => {
    void loadLock();
    void refreshQuota();
  }, [loadLock, refreshQuota]);

  const cols = profiles.length ? profiles : profile;
  const auto = buckets.auto || 0;
  const review = buckets.review || 0;
  const ignore = buckets.ignore || 0;
  const pct = acceptPct(acceptMin);
  const reviewFloor = Math.max(50, pct - 15);
  const activePhase = phase === "idle" ? (plan.length ? 2 : 0) : phase === "detect" ? 0 : phase === "plan" ? 1 : phase === "preview" ? 2 : 3;

  const toggleLock = async () => {
    const next = !locked;
    setLocked(next);
    try {
      const s = await api.settings();
      const ai = { ...((s.ai as Record<string, unknown>) || {}), config_locked: next, workspace: { extra } };
      await api.saveSettings({ ...s, ai });
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="drs-ai-side">
      <div className="drs-ai-head">
        <Sparkles size={15} color="var(--accent)" />
        <div style={{ flex: 1, fontWeight: 650 }}>Quality pipeline</div>
        <button type="button" title={locked ? "Unlock" : "Lock"} className="drs-ai-iconbtn" onClick={() => void toggleLock()}>
          {locked ? <Lock size={12} /> : <LockOpen size={12} />}
        </button>
      </div>
      <p className="drs-ai-lead">
        Spreadsheet stays source of truth. Detect → Plan → Preview, then Apply as one undoable transaction.
      </p>

      <div className="drs-ai-steps">
        {PHASES.map((label, i) => (
          <div key={label} className={`drs-ai-step${i === activePhase ? " is-on" : ""}${i < activePhase ? " is-done" : ""}`}>
            <span>{i + 1}</span>
            {label}
          </div>
        ))}
      </div>

      <div className="drs-ai-stat">
        <div>
          <b>{sessionId ? (metrics?.health ?? 0).toFixed(0) : "—"}</b>
          <span>Health</span>
        </div>
        <div>
          <b>{auto.toLocaleString()}</b>
          <span>Auto ≥{pct}%</span>
        </div>
        <div>
          <b>{review.toLocaleString()}</b>
          <span>Review</span>
        </div>
        <div>
          <b>{ignore.toLocaleString()}</b>
          <span>Ignore</span>
        </div>
      </div>

      {quota && (
        <div className="drs-ai-quota" style={{ display: "grid", gap: 4, padding: "9px 10px", border: "1px solid var(--border)", borderRadius: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700 }}>AI file cleanings</div>
          <div className="dim" style={{ fontSize: 11 }}>
            {quota.unlimited || quota.limit === null
              ? `${quota.plan || "Professional"} · unlimited${quota.month ? ` · ${quota.month}` : ""}`
              : `${quota.plan || "Community"} · ${quota.used}/${quota.limit} this month${quota.month ? ` · ${quota.month}` : ""}`}
          </div>
        </div>
      )}

      <div className="drs-ai-conf">
        <div className="drs-ai-label" style={{ marginTop: 0 }}>Accept when ≥ {pct}%</div>
        <div className="drs-ai-conf-row">
          <input
            type="range"
            min={50}
            max={100}
            step={1}
            value={pct}
            disabled={locked}
            onChange={(e) => setAcceptMin(Number(e.target.value) / 100)}
          />
          <b>{pct}%</b>
        </div>
        <div className="hint">
          Auto-apply ≥{pct}%. Review {reviewFloor}–{pct - 1}%. Ignore below {reviewFloor}%. Hand-accepted cells still apply.
        </div>
      </div>

      <div className="drs-ai-label">Scope</div>
      <div className="drs-ai-scope">
        {(
          [
            ["sheet", "Entire sheet"],
            ["columns", `Columns${selectedColumns.length ? ` · ${selectedColumns.length}` : ""}`],
            ["rows", `Rows${selectedRows.length ? ` · ${selectedRows.length}` : ""}`],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" className={scope === id ? "is-on" : ""} onClick={() => setScope(id)} disabled={locked}>
            {label}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="drs-ai-cta"
        disabled={!sessionId || busy}
        onClick={() => void generate()}
      >
        {busy ? progress || "Working…" : "Generate AI Preview"}
      </button>
      <div className="drs-ai-hint">Does not edit the sheet. Opens the AI Plan dock.</div>

      {error ? (
        <div className="drs-ai-err">
          <div>{error}</div>
          {quotaUpgradeUrl && (
            <button type="button" className="drs-ai-link" onClick={() => void openUrl(quotaUpgradeUrl)}>
              Upgrade License Cloud
            </button>
          )}
          {error === "Your Cloud AI credits are exhausted." && (
            <button
              type="button"
              className="drs-ai-link"
              onClick={() => void nativeAiCreditPurchase("cloud", false).catch(() => undefined)}
            >
              <ShoppingCart size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} /> Buy AI Credits
            </button>
          )}
        </div>
      ) : null}
      {!busy && progress ? <div className="drs-ai-ok">{progress}</div> : null}

      <div className="drs-ai-label">Column profiles</div>
      <div className="drs-ai-prof">
        {!cols.length && <div className="dim">Import data to profile columns.</div>}
        {cols.slice(0, 24).map((p) => (
          <div key={p.name} className="drs-ai-prow">
            <span className="name">{p.name}</span>
            <span className="type">{p.active || p.inferred}</span>
            <span className="dim">{Number(p.null_pct || 0).toFixed(0)}% empty</span>
          </div>
        ))}
      </div>

      {plan.length > 0 && (
        <>
          <div className="drs-ai-label">Plan · {plan.length} operations</div>
          <div className="dim" style={{ fontSize: 11, marginBottom: 8 }}>
            Acceptance happens in the bottom dock, not here.
          </div>
        </>
      )}

      {history.length > 0 && (
        <>
          <div className="drs-ai-label">Apply history</div>
          {history.map((h) => (
            <div key={h.id} className="drs-ai-hist">
              <span>{h.title}</span>
              <span className="dim">{h.cells.toLocaleString()} cells</span>
            </div>
          ))}
        </>
      )}

      <details className="drs-ai-policy">
        <summary>Policy</summary>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginTop: 8 }}>
          <input type="checkbox" checked={useLlm} disabled={locked || busy} onChange={(e) => setUseLlm(e.target.checked)} />
          Ask model to refine plan titles (optional)
        </label>
        <textarea
          className="field"
          disabled={locked || busy}
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          placeholder="Optional constraints. Providers and prompts live in Settings."
          style={{ minHeight: 64, fontSize: 12, resize: "vertical", marginTop: 8 }}
        />
        <button type="button" className="drs-ai-link" onClick={() => setSidebar("settings")}>
          Open Settings → AI provider
        </button>
      </details>
    </div>
  );
}
