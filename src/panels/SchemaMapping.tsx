import { useShallow } from "zustand/react/shallow";
import { useWorkspace } from "../store/workspace";
import { api } from "../ipc/client";

const TYPES = [
  "Text",
  "Integer",
  "Decimal",
  "Currency",
  "Boolean",
  "Date",
  "DateTime",
  "Email",
  "Phone",
  "URL",
  "Country",
  "UUID",
  "Category",
  "JSON",
  "ID",
];

export function SchemaMapping() {
  const { sessionId, schema, loadViewport, refresh } = useWorkspace(
    useShallow((s) => ({ sessionId: s.sessionId, schema: s.schema, loadViewport: s.loadViewport, refresh: s.refresh })),
  );
  if (!schema.length) {
    return <div className="p-3 text-xs text-slate-500">Schema mapping appears after import.</div>;
  }
  return (
    <div className="h-full overflow-auto text-xs">
      <table className="w-full">
        <thead className="sticky top-0 bg-ink-900 text-slate-500">
          <tr>
            <th className="text-left p-2 font-medium">Column</th>
            <th className="text-left p-2 font-medium">Inferred</th>
            <th className="text-left p-2 font-medium">Active</th>
            <th className="text-left p-2 font-medium">Manual</th>
          </tr>
        </thead>
        <tbody>
          {schema.map((s) => (
            <tr key={s.name} className="border-t border-slate-800">
              <td className="p-2 font-mono text-slate-200">{s.name}</td>
              <td className="p-2 text-slate-400">{s.inferred}</td>
              <td className="p-2">
                <select
                  className="bg-ink-800 border border-slate-700 rounded px-1 py-0.5"
                  value={s.active}
                  onChange={async (e) => {
                    if (!sessionId) return;
                    await api.schema(sessionId, s.name, { active: e.target.value, manual: true });
                    await loadViewport();
                    await refresh();
                  }}
                >
                  {TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </td>
              <td className="p-2">{s.manual ? "Manual" : "Auto"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
