import {
  Database,
  FileUp,
  Play,
  Square,
  Undo2,
  Redo2,
  Download,
  Settings,
  Sparkles,
  Library,
  GitBranch,
  History,
} from "lucide-react";
import { useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkspace } from "../store/workspace";

const LIMITS = [5000, 10000, 50000, 100000, 0];

export function Header() {
  const input = useRef<HTMLInputElement>(null);
  const { openFile, run, running, rowLimit, setRowLimit, setView, sessionId, status, setConnectOpen } =
    useWorkspace(
      useShallow((s) => ({
        openFile: s.openFile,
        run: s.run,
        running: s.running,
        rowLimit: s.rowLimit,
        setRowLimit: s.setRowLimit,
        setView: s.setView,
        sessionId: s.sessionId,
        status: s.status,
        setConnectOpen: s.setConnectOpen,
      })),
    );

  return (
    <header className="h-12 shrink-0 border-b border-slate-800 bg-ink-900 flex items-center gap-2 px-3">
      <button
        className="font-semibold tracking-tight text-slate-100 mr-2"
        onClick={() => setView("workspace")}
      >
        DataRefine Studio
      </button>
      <input
        ref={input}
        type="file"
        className="hidden"
        accept=".csv,.tsv,.xlsx,.xls,.json,.parquet,.feather,.arrow,.ipc"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void openFile(f);
          e.target.value = "";
        }}
      />
      <Tool onClick={() => input.current?.click()} icon={<FileUp size={15} />} label="Import" />
      <Tool onClick={() => setConnectOpen(true)} icon={<Database size={15} />} label="Connect" />
      <select
        className="bg-ink-800 border border-slate-700 rounded-md text-xs px-2 py-1 text-slate-200"
        value={rowLimit}
        onChange={(e) => setRowLimit(Number(e.target.value))}
      >
        {LIMITS.map((n) => (
          <option key={n} value={n}>
            {n === 0 ? "All rows" : `${n.toLocaleString()} rows`}
          </option>
        ))}
      </select>
      <div className="w-px h-5 bg-slate-700 mx-1" />
      <Tool
        onClick={() => void run("pipeline")}
        icon={<Play size={15} />}
        label="Run Pipeline"
        accent
        disabled={running || !sessionId}
      />
      <Tool onClick={() => {}} icon={<Square size={15} />} label="Stop" />
      <Tool onClick={() => {}} icon={<Undo2 size={15} />} label="Undo" />
      <Tool onClick={() => {}} icon={<Redo2 size={15} />} label="Redo" />
      <Tool
        onClick={() => {
          if (!sessionId) return;
          const dest = prompt("Export path", "exports/clean.csv");
          if (dest) void import("../ipc/client").then(({ api }) => api.export(sessionId, "csv", dest));
        }}
        icon={<Download size={15} />}
        label="Export"
      />
      <div className="flex-1" />
      <span className="text-[11px] text-slate-500 truncate max-w-md">{status}</span>
      <Tool onClick={() => setView("ai")} icon={<Sparkles size={15} />} label="AI" />
      <Tool onClick={() => setView("library")} icon={<Library size={15} />} label="Library" />
      <Tool onClick={() => setView("lineage")} icon={<GitBranch size={15} />} label="Lineage" />
      <Tool onClick={() => setView("versions")} icon={<History size={15} />} label="Versions" />
      <Tool onClick={() => setView("settings")} icon={<Settings size={15} />} label="Settings" />
    </header>
  );
}

function Tool({
  icon,
  label,
  onClick,
  accent,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  accent?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border transition ${
        accent
          ? "bg-blue-600 border-blue-500 text-white hover:bg-blue-500"
          : "bg-ink-800 border-slate-700 text-slate-200 hover:bg-slate-800"
      } disabled:opacity-40`}
    >
      {icon}
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}
