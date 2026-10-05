import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkspace } from "../store/workspace";

export function FindBar() {
  const { sessionId, searchReplace, status } = useWorkspace(useShallow((s) => ({ sessionId: s.sessionId, searchReplace: s.searchReplace, status: s.status })));
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [regex, setRegex] = useState(false);
  const [hits, setHits] = useState<number | null>(null);
  if (!sessionId) {
    return <div style={{ padding: 16, fontSize: 12, color: "var(--text-dim)" }}>Open a dataset to search.</div>;
  }
  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10, fontSize: 12 }}>
      <input className="field" placeholder="Find" value={find} onChange={(e) => setFind(e.target.value)} />
      <input className="field" placeholder="Replace" value={replace} onChange={(e) => setReplace(e.target.value)} />
      <label className="flex items-center gap-1 opacity-70">
        <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} />
        Regex
      </label>
      <div className="flex gap-2">
        <button className="px-3 py-2 rounded" style={{ border: "1px solid var(--border)" }} onClick={async () => setHits(await searchReplace(find, replace, false, regex))}>
          Find
        </button>
        <button className="px-3 py-2 rounded text-white" style={{ background: "var(--accent)" }} onClick={async () => setHits(await searchReplace(find, replace, true, regex))}>
          Replace all
        </button>
      </div>
      <span className="opacity-70">{hits == null ? status : `${hits} matches`}</span>
    </div>
  );
}
