import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { BrainCircuit, Check, CircleAlert, Play, RefreshCw, ScanSearch, Square, Sparkles } from "lucide-react";
import { api, type Metrics } from "../ipc/client";
import { datarefineAi, type RouterDecision } from "../services/ai";
import { useAiPipeline, type AiPhase } from "../store/aiPipeline";
import { useWorkspace } from "../store/workspace";

type WorkerState = "idle" | "working" | "complete" | "waiting";

const AUTO_OPERATION_LABELS = [
  "Normalize Emails",
  "Standardize Phone Numbers",
  "Fill Missing Country",
  "Review Entity Names",
];

function operationKey(operation: { title?: string }) {
  return String(operation.title || "").trim().toLowerCase();
}

const terminalCloudStatuses = new Set(["completed", "failed", "cancelled", "expired"]);

function phaseLabel(phase: AiPhase, busy: boolean) {
  if (!busy && phase === "idle") return "Ready";
  if (phase === "detect") return "Detecting issues";
  if (phase === "plan") return "Building cleaning plan";
  if (phase === "preview") return "Review ready";
  if (phase === "apply") return "Applying changes";
  return "Working";
}

function workerBadge(state: WorkerState) {
  if (state === "working") return "Working";
  if (state === "complete") return "Complete";
  if (state === "waiting") return "Waiting";
  return "Ready";
}

function workerColor(state: WorkerState) {
  if (state === "working") return "var(--accent, #60a5fa)";
  if (state === "complete") return "var(--ok, #4ade80)";
  return "var(--text-dim)";
}

function safeScanError(error: unknown) {
  return error instanceof Error ? error.message : String(error || "The sheet could not be scanned.");
}

export function AiWorkerCleanerPluginView() {
  const sessionId = useWorkspace((state) => state.sessionId);
  const workspaceRunning = useWorkspace((state) => state.running);
  const {
    phase,
    busy,
    progress,
    error,
    plan,
    diffs,
    history,
    scan,
    setScan,
    extra,
    acceptMin,
    cloudJob,
    setCloudJob,
    setScope,
    setExtra,
    setAcceptMin,
    generate,
    apply,
    clearPreview,
  } = useAiPipeline();
  const [runtime, setRuntime] = useState<RouterDecision | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState("");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [editedCells, setEditedCells] = useState(0);
  const [applyBusy, setApplyBusy] = useState(false);
  const [autoOperations, setAutoOperations] = useState<Set<string>>(() => new Set());
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyMessage, setPolicyMessage] = useState("");
  const [autoApplying, setAutoApplying] = useState(false);

  const scannedCurrentSheet = Boolean(sessionId && scan?.sid === sessionId);
  const proposedCells = useMemo(
    () => plan.reduce((total, operation) => total + Math.max(0, Number(operation.cells) || 0), 0),
    [plan],
  );
  const autoPlan = useMemo(() => plan.filter((operation) => autoOperations.has(operationKey(operation))), [plan, autoOperations]);
  const manualPlan = useMemo(() => plan.filter((operation) => !autoOperations.has(operationKey(operation))), [plan, autoOperations]);
  const workerBusy = scanBusy || busy || applyBusy || autoApplying || policyBusy;
  const locked = workerBusy || workspaceRunning;
  const currentCloudJob = cloudJob && !terminalCloudStatuses.has(String(cloudJob.status).toLowerCase()) ? cloudJob : null;

  useEffect(() => {
    let active = true;
    void api.settings().then((settings) => {
      const ai = (settings.ai as Record<string, unknown>) || {};
      const raw = ai.worker_auto_operations;
      if (!active || !Array.isArray(raw)) return;
      setAutoOperations(new Set(raw.map((value) => String(value).toLowerCase())));
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (scan && scan.sid !== sessionId) {
      setScan(null);
      setRuntime(null);
      setEditedCells(0);
      setStartedAt(null);
      setElapsed(0);
    }
  }, [sessionId, scan, setScan]);

  useEffect(() => {
    if (!busy || !startedAt) return;
    const timer = window.setInterval(() => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000))), 500);
    return () => window.clearInterval(timer);
  }, [busy, startedAt]);

  useEffect(() => {
    if (!cloudJob || terminalCloudStatuses.has(String(cloudJob.status).toLowerCase())) return;
    let active = true;
    const poll = async () => {
      try {
        const next = await datarefineAi.jobs.get(cloudJob.id);
        if (active && next) setCloudJob(next);
      } catch {
        // A transient polling failure must not erase the last known job state.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [cloudJob?.id, cloudJob?.status, setCloudJob]);

  const scanSheet = async () => {
    if (!sessionId) {
      setScanError("Open a data sheet before scanning.");
      return;
    }
    setScanBusy(true);
    setScanError("");
    setEditedCells(0);
    try {
      const [nextMetrics, profiles, viewport, decision] = await Promise.all([
        api.metrics(sessionId),
        api.profile(sessionId),
        api.viewport(sessionId, 0, 80),
        datarefineAi.router(),
      ]);
      const m = nextMetrics as Metrics;
      setScan({
        sid: sessionId,
        rows: Number(m.rows || viewport.total || 0),
        columns: Number(m.columns || viewport.columns.length || 0),
        missing: Number(m.missing || 0),
        duplicates: Number(m.duplicates || 0),
        profileCount: profiles.length,
        sampleRows: viewport.rows.length,
        profiles,
        scannedAt: new Date().toLocaleTimeString(),
      });
      setRuntime(decision);
    } catch (errorValue) {
      setScanError(safeScanError(errorValue));
    } finally {
      setScanBusy(false);
    }
  };

  const savePolicy = async () => {
    setPolicyBusy(true);
    setPolicyMessage("");
    try {
      const settings = await api.settings();
      const ai = (settings.ai as Record<string, unknown>) || {};
      await api.saveSettings({
        ...settings,
        ai: { ...ai, worker_auto_operations: Array.from(autoOperations) },
      });
      setPolicyMessage(`${autoOperations.size} operation type${autoOperations.size === 1 ? "" : "s"} pre-approved.`);
    } catch (errorValue) {
      setPolicyMessage(safeScanError(errorValue));
    } finally {
      setPolicyBusy(false);
    }
  };

  const autoApplyPolicy = async () => {
    const current = useAiPipeline.getState();
    const ids = current.plan
      .filter((operation) => autoOperations.has(operationKey(operation)))
      .map((operation) => operation.id);
    if (!ids.length) return;
    setAutoApplying(true);
    const before = Number(useWorkspace.getState().metrics?.cells_cleaned || 0);
    const beforeHistoryId = current.history[0]?.id || "";
    try {
      await apply("policy", ids);
      const nextHistory = useAiPipeline.getState().history;
      const after = Number(useWorkspace.getState().metrics?.cells_cleaned || 0);
      const applied = nextHistory[0] && nextHistory[0].id !== beforeHistoryId;
      if (applied) setEditedCells(Math.max(0, after - before, Number(nextHistory[0]?.cells || 0)));
    } finally {
      setAutoApplying(false);
    }
  };

  const startCleaning = async () => {
    if (!sessionId) {
      setScanError("Open a data sheet before starting workers.");
      return;
    }
    if (!scannedCurrentSheet) {
      setScanError("Scan the current sheet first. Workers will not start on an unscanned sheet.");
      return;
    }
    setScanError("");
    setEditedCells(0);
    setStartedAt(Date.now());
    setElapsed(0);
    clearPreview();
    setScope("sheet");
    await generate();
    await autoApplyPolicy();
  };

  const applyCleaning = async () => {
    if (!manualPlan.length || !diffs.length) return;
    const manualIds = manualPlan.map((operation) => operation.id);
    setApplyBusy(true);
    const before = Number(useWorkspace.getState().metrics?.cells_cleaned || 0);
    const beforeHistoryId = useAiPipeline.getState().history[0]?.id || "";
    try {
      await apply("auto", manualIds);
      const nextHistory = useAiPipeline.getState().history;
      const after = Number(useWorkspace.getState().metrics?.cells_cleaned || 0);
      const applied = nextHistory[0] && nextHistory[0].id !== beforeHistoryId;
      setEditedCells(applied ? Math.max(0, after - before, Number(nextHistory[0]?.cells || 0)) : 0);
    } finally {
      setApplyBusy(false);
    }
  };

  const cancelCloud = async () => {
    if (!cloudJob) return;
    try {
      const next = await datarefineAi.jobs.cancel(cloudJob.id);
      if (next) setCloudJob(next);
    } catch (errorValue) {
      setScanError(safeScanError(errorValue));
    }
  };

  const scanState: WorkerState = scanBusy ? "working" : scannedCurrentSheet ? "complete" : "idle";
  const plannerState: WorkerState = busy ? "working" : plan.length || cloudJob ? "complete" : scannedCurrentSheet ? "waiting" : "idle";
  const cleanerState: WorkerState = phase === "apply" || applyBusy || autoApplying ? "working" : editedCells > 0 ? "complete" : plan.length ? "waiting" : "idle";
  const cloudStatus = cloudJob ? String(cloudJob.status).toLowerCase() : "";
  const progressValue = currentCloudJob
    ? cloudStatus === "running" ? 72 : 64
    : scanBusy ? 18
      : busy && phase === "detect" ? 38
        : busy && phase === "plan" ? 62
          : busy && phase === "preview" ? 78
            : applyBusy || autoApplying || phase === "apply" ? 90
              : editedCells > 0 ? 100
                : plan.length ? 82
                  : scannedCurrentSheet ? 25 : 0;
  const cloudMessage = cloudJob
    ? cloudStatus === "completed"
      ? "Cloud worker completed. Local sheet data was not sent, so no local cells were edited."
      : cloudStatus === "failed" || cloudStatus === "expired"
        ? cloudJob.error || `Cloud worker ${cloudStatus}.`
        : cloudStatus === "cancelled"
          ? "Cloud worker cancelled."
          : `Cloud worker ${cloudJob.id} is ${cloudStatus || "queued"}.`
    : "";

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.icon}><Sparkles size={15} /></span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={styles.title}>AI Worker Cleaner</div>
          <div style={styles.subtitle}>Scan → plan → approve → clean</div>
        </div>
        <span style={styles.chip}>{runtime?.source ? runtime.source.toUpperCase() : "AI"}</span>
      </div>

      <div style={styles.notice}>
        Workers inspect the open sheet first. {autoOperations.size ? `${autoOperations.size} pre-approved operation type${autoOperations.size === 1 ? "" : "s"} will edit directly after planning; all other proposals wait for Apply.` : "No operation is pre-approved yet, so proposals wait for your Apply action."}
      </div>

      <div style={styles.section}>
        <div style={styles.sectionHead}>
          <span style={styles.sectionTitle}>Sheet scan</span>
          {scan?.scannedAt ? <span style={styles.dim}>Scanned {scan.scannedAt}</span> : null}
        </div>
        {scannedCurrentSheet ? (
          <div style={styles.stats}>
            <Stat label="Rows" value={scan?.rows.toLocaleString() || "—"} />
            <Stat label="Columns" value={scan?.columns.toLocaleString() || "—"} />
            <Stat label="Empty" value={scan?.missing.toLocaleString() || "0"} />
            <Stat label="Duplicates" value={scan?.duplicates.toLocaleString() || "0"} />
          </div>
        ) : (
          <div style={styles.dim}>No scan for the current sheet.</div>
        )}
        <button type="button" className="button" disabled={locked || !sessionId} onClick={() => void scanSheet()} style={styles.button}>
          <ScanSearch size={13} />
          {scanBusy ? "Scanning sheet…" : "Scan sheet"}
        </button>
        {scan?.sampleRows ? <div style={styles.hint}>Profiled {scan.profileCount} columns using an {scan.sampleRows}-row local sample.</div> : null}
      </div>

      <div style={styles.section}>
        <div style={styles.sectionHead}>
          <span style={styles.sectionTitle}>Worker activity</span>
          <span style={{ ...styles.status, color: workerBusy ? "var(--accent, #60a5fa)" : editedCells ? "var(--ok, #4ade80)" : "var(--text-dim)" }}>
            {workerBusy ? `${progressValue}% active` : editedCells ? `${editedCells.toLocaleString()} edited` : "Idle"}
          </span>
        </div>
        <div style={styles.progressTrack}><span style={{ ...styles.progressFill, width: `${progressValue}%` }} /></div>
        <div style={styles.workers}>
          <WorkerRow icon={<ScanSearch size={13} />} name="Scanner" detail={scan?.rows ? `${scan.rows.toLocaleString()} rows profiled` : "Waiting for scan"} state={scanState} />
          <WorkerRow icon={<BrainCircuit size={13} />} name="AI planner" detail={phaseLabel(phase, busy)} state={plannerState} />
          <WorkerRow icon={<Sparkles size={13} />} name="Cleaner" detail={editedCells ? `${editedCells.toLocaleString()} cells edited` : plan.length ? `${proposedCells.toLocaleString()} cells proposed` : "Waiting for approval"} state={cleanerState} />
        </div>
        {busy || startedAt ? <div style={styles.workerLine}>{progress || phaseLabel(phase, busy)}{busy ? ` · ${elapsed}s` : ""}</div> : null}
        {cloudMessage ? <div style={{ ...styles.workerLine, color: cloudStatus === "failed" || cloudStatus === "expired" ? "var(--danger)" : "var(--text-dim)" }}>{cloudMessage}</div> : null}
        {currentCloudJob ? (
          <button type="button" className="button" onClick={() => void cancelCloud()} style={styles.button}><Square size={11} /> Cancel cloud worker</button>
        ) : null}
      </div>

      <div style={styles.section}>
        <div style={styles.sectionHead}>
          <span style={styles.sectionTitle}>Cleaning plan</span>
          <span style={styles.status}>{plan.length ? `${plan.length} operations` : "Not started"}</span>
        </div>
        <div style={styles.hint}>The plan is generated after the scan. Keep the panel open or switch panels; the central AI pipeline continues the current job.</div>
        <textarea className="field" value={extra} disabled={locked} onChange={(event) => setExtra(event.target.value)} placeholder="Optional cleaning instructions…" style={styles.textarea} />
        <label style={styles.rangeLabel}>
          Auto-apply confidence for normal approval: {Math.round(acceptMin * 100)}%
          <input type="range" min="50" max="100" step="1" value={Math.round(acceptMin * 100)} disabled={locked} onChange={(event) => setAcceptMin(Number(event.target.value) / 100)} />
        </label>

        <div style={styles.policyBox}>
          <div style={styles.policyHead}>
            <span style={styles.sectionTitle}>Pre-approved operations</span>
            <span style={styles.status}>{autoOperations.size} selected</span>
          </div>
          <div style={styles.policyExplain}>Selected operation types are standing permission to edit automatically after the worker plan completes. Keep this list limited.</div>
          <div style={styles.policyGrid}>
            {AUTO_OPERATION_LABELS.map((label) => {
              const key = label.toLowerCase();
              return (
                <label key={label} style={styles.policyItem}>
                  <input
                    type="checkbox"
                    checked={autoOperations.has(key)}
                    disabled={locked}
                    onChange={() => setAutoOperations((current) => {
                      const next = new Set(current);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })}
                  />
                  <span>{label}</span>
                </label>
              );
            })}
            {plan.filter((operation) => !AUTO_OPERATION_LABELS.some((label) => label.toLowerCase() === operationKey(operation))).map((operation) => {
              const key = operationKey(operation);
              return (
                <label key={operation.id} style={styles.policyItem}>
                  <input
                    type="checkbox"
                    checked={autoOperations.has(key)}
                    disabled={locked}
                    onChange={() => setAutoOperations((current) => {
                      const next = new Set(current);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })}
                  />
                  <span>{operation.title}</span>
                </label>
              );
            })}
          </div>
          <div style={styles.policyActions}>
            <button type="button" className="button" disabled={locked || policyBusy} onClick={() => void savePolicy()} style={styles.button}>
              {policyBusy ? "Saving policy…" : "Save auto policy"}
            </button>
            {policyMessage ? <span style={styles.hint}>{policyMessage}</span> : null}
          </div>
        </div>

        <div style={styles.actions}>
          <button type="button" className="button" disabled={locked || !sessionId || !scannedCurrentSheet} onClick={() => void startCleaning()} style={{ ...styles.button, flex: 1 }}>
            <Play size={13} />
            {autoApplying ? "Applying policy…" : busy ? "Workers running…" : "Start cleaning workers"}
          </button>
          <button type="button" className="button primary" disabled={locked || !manualPlan.length || !diffs.length} onClick={() => void applyCleaning()} style={{ ...styles.button, flex: 1 }}>
            <Check size={13} />
            {applyBusy ? "Applying…" : manualPlan.length ? "Apply remaining" : autoPlan.length ? "Policy applied" : "Apply approved"}
          </button>
        </div>
      </div>

      {(scanError || error) ? (
        <div style={styles.error}><CircleAlert size={13} /><span>{scanError || error}</span></div>
      ) : null}
      {!sessionId ? <div style={styles.empty}><RefreshCw size={13} /> Open a data sheet to start the scanner.</div> : null}
      {history.length > 0 ? <div style={styles.footer}>Last apply: {history[0].cells.toLocaleString()} cells · one undo step</div> : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div style={styles.stat}><strong>{value}</strong><span>{label}</span></div>;
}

function WorkerRow({ icon, name, detail, state }: { icon: React.ReactNode; name: string; detail: string; state: WorkerState }) {
  return (
    <div style={styles.workerRow}>
      <span style={{ ...styles.workerIcon, color: workerColor(state) }}>{icon}</span>
      <div style={{ minWidth: 0, flex: 1 }}><strong>{name}</strong><span>{detail}</span></div>
      <span style={{ ...styles.workerBadge, color: workerColor(state) }}>{workerBadge(state)}</span>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  root: { padding: 13, display: "grid", gap: 9, color: "var(--text)", fontSize: 11.5 },
  header: { display: "flex", alignItems: "center", gap: 8 },
  icon: { width: 26, height: 26, display: "grid", placeItems: "center", borderRadius: 6, color: "var(--accent, #60a5fa)", background: "var(--bg-input)", border: "1px solid var(--border)", flexShrink: 0 },
  title: { fontSize: 13, fontWeight: 750 },
  subtitle: { fontSize: 9.5, color: "var(--text-dim)", marginTop: 2 },
  chip: { marginLeft: "auto", fontSize: 9, fontWeight: 750, letterSpacing: "0.06em", color: "var(--accent, #60a5fa)", border: "1px solid color-mix(in srgb, var(--accent, #3b82f6) 35%, var(--border))", borderRadius: 99, padding: "3px 7px" },
  notice: { borderLeft: "3px solid var(--accent, #3b82f6)", borderTop: "1px solid var(--border)", borderRight: "1px solid var(--border)", borderBottom: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-dim)", padding: "8px 9px", lineHeight: 1.4, fontSize: 10 },
  section: { display: "grid", gap: 8, padding: 9, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)" },
  sectionHead: { display: "flex", alignItems: "center", gap: 8 },
  sectionTitle: { fontSize: 9.5, fontWeight: 750, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)" },
  dim: { color: "var(--text-dim)", fontSize: 9.5, marginLeft: "auto" },
  status: { color: "var(--text-dim)", fontSize: 9.5, marginLeft: "auto" },
  stats: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 5 },
  stat: { display: "grid", gap: 2, minWidth: 0, padding: "6px 5px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-elev)" },
  statStrong: {},
  hint: { color: "var(--text-dim)", fontSize: 9.5, lineHeight: 1.35 },
  button: { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, padding: "6px 8px", fontSize: 10.5, borderRadius: 6 },
  progressTrack: { height: 5, background: "var(--bg-input)", borderRadius: 99, overflow: "hidden", border: "1px solid var(--border)" },
  progressFill: { display: "block", height: "100%", background: "var(--accent, #3b82f6)", borderRadius: 99, transition: "width 0.2s ease" },
  workers: { display: "grid", gap: 5 },
  workerRow: { display: "flex", alignItems: "center", gap: 7, minWidth: 0, padding: "5px 0", borderBottom: "1px solid color-mix(in srgb, var(--border) 60%, transparent)" },
  workerIcon: { width: 18, height: 18, display: "grid", placeItems: "center", flexShrink: 0 },
  workerBadge: { fontSize: 9, fontWeight: 700, whiteSpace: "nowrap" },
  workerLine: { color: "var(--text-dim)", fontSize: 9.5, lineHeight: 1.35 },
  textarea: { minHeight: 48, resize: "vertical", fontSize: 10.5 },
  rangeLabel: { display: "grid", gap: 5, color: "var(--text-dim)", fontSize: 9.5 },
  policyBox: { display: "grid", gap: 7, padding: "8px 9px", border: "1px solid var(--border)", borderLeft: "3px solid var(--accent, #3b82f6)", borderRadius: 7, background: "var(--bg-elev)" },
  policyHead: { display: "flex", alignItems: "center", gap: 8 },
  policyExplain: { color: "var(--text-dim)", fontSize: 9.5, lineHeight: 1.35 },
  policyGrid: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 5 },
  policyItem: { display: "flex", alignItems: "flex-start", gap: 5, color: "var(--text-dim)", fontSize: 9.5, lineHeight: 1.25 },
  policyActions: { display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" },
  actions: { display: "flex", gap: 7, flexWrap: "wrap" },
  error: { display: "flex", alignItems: "flex-start", gap: 6, color: "var(--danger, #ef4444)", border: "1px solid color-mix(in srgb, var(--danger, #ef4444) 35%, var(--border))", background: "var(--bg)", borderRadius: 7, padding: "7px 8px", fontSize: 10, lineHeight: 1.35 },
  empty: { display: "flex", alignItems: "center", gap: 6, color: "var(--text-dim)", fontSize: 10, padding: 7 },
  footer: { color: "var(--text-dim)", fontSize: 9.5, borderTop: "1px solid var(--border)", paddingTop: 8 },
};
