import { useEffect, useState } from "react";
import { useWorkspace } from "../store/workspace";
import { api } from "../ipc/client";

export function LineagePage() {
  const sessionId = useWorkspace((s) => s.sessionId);
  const [nodes, setNodes] = useState<unknown[]>([]);
  useEffect(() => {
    if (sessionId) api.lineage(sessionId).then(setNodes).catch(() => undefined);
  }, [sessionId]);
  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold mb-4">Operation graph</h1>
      <div className="flex flex-wrap gap-3">
        {nodes.map((n, i) => (
          <div key={i} className="rounded-xl border border-slate-700 bg-ink-900 px-4 py-3 min-w-40">
            <div className="text-[10px] uppercase text-slate-500">{(n as { stage?: string }).stage}</div>
            <div className="font-medium">{(n as { title?: string }).title}</div>
            <div className="text-xs text-slate-400">{(n as { runtime_ms?: number }).runtime_ms} ms</div>
          </div>
        ))}
        {!nodes.length && <div className="text-slate-500 text-sm">Run a pipeline to build the DAG.</div>}
      </div>
    </div>
  );
}
