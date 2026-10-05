import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useUI } from "../store/ui";
import { useWorkspace } from "../store/workspace";

const TYPES = [
  "Text",
  "Name",
  "Gender",
  "Integer",
  "Decimal",
  "Amount",
  "Currency",
  "Percent",
  "Boolean",
  "Date",
  "DateTime",
  "Year",
  "Email",
  "Phone",
  "URL",
  "Country",
  "City",
  "Postal Code",
  "Address",
  "UUID",
  "Category",
  "JSON",
  "ID",
];

export function AddColumnDialog() {
  const spec = useUI((s) => s.columnDialog);
  const close = useUI((s) => s.closeColumnDialog);
  const { columns, addColumn, running, sessionId } = useWorkspace(
    useShallow((s) => ({ columns: s.columns, addColumn: s.addColumn, running: s.running, sessionId: s.sessionId })),
  );
  const input = useRef<HTMLInputElement>(null);
  const suggestion = useMemo(() => {
    let n = columns.length + 1;
    let name = `column_${n}`;
    while (columns.includes(name)) {
      n += 1;
      name = `column_${n}`;
    }
    return name;
  }, [columns]);
  const [name, setName] = useState(suggestion);
  const [type, setType] = useState("Text");

  useEffect(() => {
    if (!spec) return;
    setName(suggestion);
    setType("Text");
    window.setTimeout(() => {
      input.current?.focus();
      input.current?.select();
    }, 20);
  }, [spec, suggestion]);

  useEffect(() => {
    if (!spec) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [spec, close]);

  if (!spec) return null;

  const taken = columns.includes(name.trim());
  const blocked = name.trim() === "_r";
  const can = Boolean(sessionId) && Boolean(name.trim()) && !taken && !blocked && !running;

  const submit = () => {
    if (!can) return;
    void addColumn(name.trim(), type, spec.after);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="drs-addcol-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 20000,
        background: "rgba(6,8,12,0.62)",
        backdropFilter: "blur(10px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      onClick={() => close()}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        style={{
          width: 440,
          maxWidth: "100%",
          borderRadius: 20,
          border: "1px solid var(--border)",
          background: "var(--bg-elev)",
          color: "var(--text)",
          padding: 22,
          display: "grid",
          gap: 14,
          boxShadow: "0 24px 64px rgba(0,0,0,0.45)",
        }}
      >
        <div>
          <div id="drs-addcol-title" style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.03em" }}>
            Add column
          </div>
          <div style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 6, lineHeight: 1.5 }}>
            {spec.after ? `Insert to the right of “${spec.after}”. Cells start empty.` : "New empty column on this sheet. Undo removes it."}
          </div>
        </div>
        <label style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--text-dim)" }}>
          Name
          <input
            ref={input}
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="column_10"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--text-dim)" }}>
          Type
          <select className="field" value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        {(taken || blocked) && (
          <div style={{ fontSize: 12, color: "var(--danger)" }}>
            {blocked ? "That name is reserved." : `“${name.trim()}” already exists.`}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button
            type="button"
            onClick={() => close()}
            style={{
              padding: "8px 14px",
              borderRadius: 10,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text)",
              fontWeight: 600,
              fontSize: 13,
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!can}
            style={{
              padding: "8px 16px",
              borderRadius: 10,
              border: "none",
              background: "var(--accent)",
              color: "#fff",
              fontWeight: 700,
              fontSize: 13,
              opacity: can ? 1 : 0.45,
            }}
          >
            Add column
          </button>
        </div>
      </form>
    </div>
  );
}
