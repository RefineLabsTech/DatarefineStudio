import { useRef } from "react";

export function SplitSash({
  axis,
  onDrag,
  onToggle,
}: {
  axis: "x" | "y";
  onDrag: (delta: number) => void;
  onToggle?: () => void;
}) {
  const last = useRef(0);
  const dragging = useRef(false);
  const vertical = axis === "x";
  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      title="Drag to resize · double-click to collapse"
      onPointerDown={(e) => {
        e.preventDefault();
        dragging.current = true;
        last.current = vertical ? e.clientX : e.clientY;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        document.body.style.cursor = vertical ? "col-resize" : "row-resize";
        document.body.style.userSelect = "none";
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        const pos = vertical ? e.clientX : e.clientY;
        const d = pos - last.current;
        last.current = pos;
        if (d) onDrag(d);
      }}
      onPointerUp={() => {
        dragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }}
      onPointerCancel={() => {
        dragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }}
      onDoubleClick={onToggle}
      style={{
        flexShrink: 0,
        position: "relative",
        zIndex: 3,
        width: vertical ? 8 : "100%",
        height: vertical ? "100%" : 6,
        margin: vertical ? "0 -4px" : 0,
        cursor: vertical ? "col-resize" : "row-resize",
        background: "transparent",
      }}
    >
      <span
        style={{
          position: "absolute",
          inset: vertical ? "12px 3px 12px 3px" : "3px 16px 3px 16px",
          borderRadius: 99,
          background: "var(--sash)",
          opacity: 0.7,
        }}
      />
    </div>
  );
}
