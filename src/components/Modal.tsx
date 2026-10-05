import { useEffect, useState } from "react";

/* Shared in-app modal chrome (no native browser dialogs anywhere). */

export function ModalShell(props: { title: string; onClose: () => void; children: React.ReactNode }) {
  const { title, onClose, children } = props;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div style={backdrop} onClick={onClose}>
      <div style={modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={modalTitle}>{title}</div>
        {children}
      </div>
    </div>
  );
}

export function InputModal(props: {
  title: string;
  initial?: string;
  placeholder?: string;
  submitLabel: string;
  numeric?: boolean;
  hint?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [val, setVal] = useState(props.initial ?? "");
  const submit = () => props.onSubmit(val);
  return (
    <ModalShell title={props.title} onClose={props.onClose}>
      {props.hint && <div style={modalHint}>{props.hint}</div>}
      <input
        style={modalInput}
        type={props.numeric ? "number" : "text"}
        min={props.numeric ? 1 : undefined}
        value={val}
        autoFocus
        placeholder={props.placeholder}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <div style={modalRow}>
        <button type="button" style={modalBtn} onClick={props.onClose}>Cancel</button>
        <button type="button" style={modalBtnPrimary} onClick={submit}>{props.submitLabel}</button>
      </div>
    </ModalShell>
  );
}

/* ------------------------------ styles ------------------------------ */

export const modalRow: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 8 };
export const modalBtn: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "var(--text)",
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 7,
  padding: "4px 10px",
  cursor: "pointer",
};
export const modalBtnPrimary: React.CSSProperties = {
  ...modalBtn,
  color: "#fff",
  background: "var(--accent, #3b82f6)",
  borderColor: "transparent",
};
export const modalBtnDanger: React.CSSProperties = {
  ...modalBtn,
  color: "#fff",
  background: "var(--danger, #ef4444)",
  borderColor: "transparent",
};

const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 90,
  background: "rgba(4, 6, 10, 0.62)",
  backdropFilter: "blur(3px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
const modalCard: React.CSSProperties = {
  width: 340,
  maxWidth: "calc(100vw - 48px)",
  background: "var(--panel, #151a23)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "14px 16px 14px",
  boxShadow: "0 18px 50px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.4)",
  color: "var(--text)",
  fontSize: 12,
};
const modalTitle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--text-dim)",
  marginBottom: 10,
};
const modalHint: React.CSSProperties = {
  color: "var(--text-dim)",
  fontSize: 11,
  lineHeight: 1.5,
  marginBottom: 8,
};
const modalInput: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--bg, #0d1117)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text)",
  fontSize: 12,
  padding: "7px 9px",
  outline: "none",
  marginBottom: 12,
};
