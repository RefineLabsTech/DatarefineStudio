import { Check, Sparkles, X } from "lucide-react";
import { acceptPct, useAiPipeline } from "../store/aiPipeline";
import { useWorkspace } from "../store/workspace";

export function AIPlanDock() {
  const { plan, diffs, buckets, busy, progress, error, acceptMin, setAcceptMin, setOpEnabled, apply, generate } = useAiPipeline();
  const pct = acceptPct(acceptMin);
  const reviewFloor = Math.max(50, pct - 15);
  const sessionId = useWorkspace((s) => s.sessionId);
  const pending = diffs.filter((d) => (d.status || "pending") === "pending");
  const accepted = diffs.filter((d) => d.status === "accepted");

  if (!plan.length && !busy) {
    return (
      <div className="drs-ai-dock-empty">
        <Sparkles size={16} color="var(--accent)" />
        <div>
          <b>Execution plan</b>
          <div>Generate an AI Preview from the AI pipeline. The sheet is not edited until you Apply.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="drs-ai-dock">
      <div className="drs-ai-dock-bar">
        <span className="title">
          Execution Plan <em>AI Generated</em>
        </span>
        <span className="dim">
          ≥{pct}% auto · {reviewFloor}–{pct - 1}% review · &lt;{reviewFloor}% ignore · {pending.length} sample diffs
        </span>
        <label className="drs-ai-dock-conf" title="Minimum confidence to auto-apply">
          <span>Accept</span>
          <input
            type="range"
            min={50}
            max={100}
            step={1}
            value={pct}
            disabled={busy}
            onChange={(e) => setAcceptMin(Number(e.target.value) / 100)}
          />
          <b>{pct}%</b>
        </label>
        <div style={{ flex: 1 }} />
        <button type="button" disabled={!sessionId || busy} onClick={() => void generate()}>
          Refresh preview
        </button>
        <button type="button" className="ok" disabled={busy || !(buckets.auto || accepted.length)} onClick={() => void apply("auto")}>
          Apply auto ≥{pct}%
        </button>
        <button type="button" className="ok" disabled={busy || !accepted.length} onClick={() => void apply("accepted")}>
          Apply accepted
        </button>
      </div>
      {busy ? <div className="drs-ai-dock-prog">{progress || "Working…"}</div> : null}
      {error ? <div className="drs-ai-err" style={{ margin: "0 12px" }}>{error}</div> : null}
      <div className="drs-ai-dock-split">
        <div className="drs-ai-ops">
          {plan.map((op) => (
            <label key={op.id} className={`drs-ai-op is-${op.bucket}`}>
              <input
                type="checkbox"
                checked={op.enabled !== false}
                disabled={op.bucket === "ignore"}
                onChange={(e) => setOpEnabled(op.id, e.target.checked)}
              />
              <span className="body">
                <span className="name">{op.title}</span>
                <span className="meta">
                  {op.cells.toLocaleString()} cells · {Math.round(op.confidence * 100)}% · {op.bucket}
                </span>
              </span>
            </label>
          ))}
        </div>
        <div className="drs-ai-diffs">
          {diffs.slice(0, 200).map((d) => (
            <DiffRow key={`${d.row}:${d.column}:${d.op_id}`} d={d} />
          ))}
          {!diffs.length && <div className="dim">No sample diffs in preview.</div>}
        </div>
      </div>
    </div>
  );
}

function DiffRow({ d }: { d: { row: number; column: string; original?: unknown; suggested?: unknown; status?: string; bucket: string; confidence: number } }) {
  const acceptCell = useAiPipeline((s) => s.acceptCell);
  const rejectCell = useAiPipeline((s) => s.rejectCell);
  const setSelectedCell = useWorkspace((s) => s.setSelectedCell);
  const pending = (d.status || "pending") === "pending";
  return (
    <div className={`drs-ai-diff is-${d.status || "pending"}`} onClick={() => setSelectedCell({ row: d.row, column: d.column })}>
      <span className="cell">
        {d.column}:{d.row + 1}
      </span>
      <span className="old">{String(d.original ?? "∅")}</span>
      <span className="arrow">→</span>
      <span className="new">{String(d.suggested ?? "∅")}</span>
      <span className="pct">{Math.round(d.confidence * 100)}%</span>
      {pending ? (
        <span className="acts">
          <button type="button" title="Accept" onClick={(e) => { e.stopPropagation(); acceptCell(d.row, d.column); }}>
            <Check size={11} />
          </button>
          <button type="button" title="Reject" onClick={(e) => { e.stopPropagation(); rejectCell(d.row, d.column); }}>
            <X size={11} />
          </button>
        </span>
      ) : (
        <span className="dim">{d.status}</span>
      )}
    </div>
  );
}
