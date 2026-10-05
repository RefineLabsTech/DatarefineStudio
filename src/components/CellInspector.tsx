import { X } from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { useAiPipeline } from "../store/aiPipeline";

export function CellInspector() {
  const selected = useWorkspace((s) => s.selectedCell);
  const schema = useWorkspace((s) => s.schema);
  const profile = useWorkspace((s) => s.profile);
  const highlights = useWorkspace((s) => s.highlights);
  const setSelectedCell = useWorkspace((s) => s.setSelectedCell);
  const diffs = useAiPipeline((s) => s.diffs);
  const acceptCell = useAiPipeline((s) => s.acceptCell);
  const rejectCell = useAiPipeline((s) => s.rejectCell);

  if (!selected) return null;
  const key = `${selected.row}:${selected.column}`;
  const stage = highlights[key] || "";
  const diff = diffs.find((d) => d.row === selected.row && d.column === selected.column);
  const col = schema.find((s) => s.name === selected.column);
  const prof = profile.find((p) => p.name === selected.column);
  const meaning =
    stage === "ai"
      ? "AI suggestion accepted"
      : stage === "review" || stage === "preview"
        ? "Needs human review"
        : stage === "error" || stage === "invalid"
          ? "Validation error"
          : stage
            ? "Auto-fixed by deterministic rule"
            : "No pipeline mark";

  return (
    <aside className="drs-inspector">
      <div className="drs-inspector-h">
        <span>Inspector</span>
        <button type="button" onClick={() => setSelectedCell(null)} title="Close">
          <X size={13} />
        </button>
      </div>
      <div className="drs-inspector-b">
        <div className="k">{selected.column}</div>
        <div className="dim">Row {selected.row + 1}</div>
        <div className={`mark is-${stage || "none"}`}>{meaning}</div>
        {diff ? (
          <>
            <div className="label">Why this suggestion</div>
            <div className="reason">{diff.reason || "Pattern match from the quality plan."}</div>
            <div className="pair">
              <span>Original</span>
              <code>{String(diff.original ?? "∅")}</code>
            </div>
            <div className="pair">
              <span>Suggested</span>
              <code>{String(diff.suggested ?? "∅")}</code>
            </div>
            <div className="pair">
              <span>Confidence</span>
              <b>{Math.round(diff.confidence * 100)}%</b>
            </div>
            {(diff.status || "pending") === "pending" && (
              <div className="acts">
                <button type="button" className="ok" onClick={() => acceptCell(selected.row, selected.column)}>
                  Accept
                </button>
                <button type="button" onClick={() => rejectCell(selected.row, selected.column)}>
                  Reject
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="dim">No pending AI suggestion for this cell.</div>
        )}
        <div className="label">Column</div>
        <div className="dim">
          Type {col?.active || col?.inferred || "—"}
          {prof ? ` · ${Number(prof.null_pct || 0).toFixed(0)}% empty · ${prof.unique_count} unique` : ""}
        </div>
      </div>
    </aside>
  );
}
