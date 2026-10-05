import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import { TabulatorFull as Tabulator } from "../vendor/tabulator-tables/tabulator_esm.min.mjs";
import type { CellComponent, ColumnComponent, ColumnDefinition } from "tabulator-tables";
import "../vendor/tabulator-tables/tabulator.min.css";
import { useWorkspace } from "../store/workspace";
import { useUI } from "../store/ui";

function RestoreNotice() {
  return (
    <div className="drs-sheet-fill" style={{ display: "grid", placeItems: "center", padding: 24 }}>
      <style>{`
        @keyframes rnRing { to { transform: rotate(360deg); } }
        @keyframes rnPulse { 0%,100% { opacity:.6; transform:scale(.98);} 50% { opacity:1; transform:scale(1.02);} }
        @keyframes rnBar { 0% { background-position:-180px 0; } 100% { background-position:180px 0; } }
      `}</style>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 14,
          animation: "rnPulse 2.4s ease-in-out infinite",
        }}
      >
        <div style={{ position: "relative", width: 56, height: 56 }}>
          <div
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: 999,
              border: "2px solid color-mix(in srgb, var(--accent) 20%, transparent)",
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: 999,
              border: "2px solid transparent",
              borderTopColor: "var(--accent)",
              borderRightColor: "color-mix(in srgb, var(--accent) 45%, transparent)",
              animation: "rnRing 1.1s linear infinite",
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              color: "var(--accent)",
              fontWeight: 800,
              fontSize: 19,
            }}
          >
            D
          </div>
        </div>
        <div style={{ fontSize: 13.5, color: "var(--text-dim)", textAlign: "center", maxWidth: 440, lineHeight: 1.55 }}>
          If you had a sheet that was lost, please wait — it’s being restored…
        </div>
        <div
          style={{
            width: 180,
            height: 3,
            borderRadius: 999,
            background: "linear-gradient(90deg, transparent, var(--accent), transparent)",
            backgroundSize: "180px 100%",
            backgroundRepeat: "no-repeat",
            animation: "rnBar 1.2s linear infinite",
            opacity: 0.85,
          }}
        />
      </div>
    </div>
  );
}

function EmptyState() {
  const openFile = useWorkspace((s) => s.openFile);
  return (
    <div className="drs-sheet-fill" style={emptyWrap}>
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 16,
          background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
          display: "grid",
          placeItems: "center",
          color: "#fff",
          fontWeight: 800,
          fontSize: 22,
        }}
      >
        D
      </div>
      <div style={{ textAlign: "center", maxWidth: 420 }}>
        <div style={{ color: "var(--text)", fontSize: 20, fontWeight: 650 }}>Open a workspace</div>
        <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.5, color: "var(--text-dim)" }}>
          Drop in CSV, Parquet, JSON or Excel. Clean with rules, DuckDB SQL, JavaScript and Polars — all local.
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          style={btnAccent}
          onClick={async () => {
            const res = await fetch("/sample-customers.csv");
            const blob = await res.blob();
            void openFile(new File([blob], "sample-customers.csv", { type: "text/csv" }));
          }}
        >
          Load sample
        </button>
        <label style={btnGhost}>
          Import file
          <input
            type="file"
            accept=".csv,.tsv,.xlsx,.xls,.json,.parquet,.feather,.arrow,.ipc,.md,.markdown"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void openFile(f);
              e.target.value = "";
            }}
          />
        </label>
      </div>
    </div>
  );
}

const emptyWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 16,
  background:
    "radial-gradient(1200px 400px at 50% 0%, color-mix(in srgb, var(--accent) 16%, transparent), transparent)",
};

const btnAccent: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 10,
  border: "none",
  background: "var(--accent)",
  color: "#fff",
  fontWeight: 600,
  fontSize: 13,
};

const btnGhost: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
};

function kindOf(active: string): "number" | "bool" | "text" {
  const t = (active || "").toLowerCase();
  if (t === "boolean" || t === "bool") return "bool";
  if (t === "number" || t === "integer" || t === "float" || t === "currency" || t === "int" || t === "double") return "number";
  return "text";
}

type CellEditor = (
  cell: CellComponent,
  onRendered: (callback: () => void) => void,
  success: (value: unknown) => void,
  cancel: () => void,
) => HTMLInputElement;

/**
 * Tabulator's range selector listens on the row container.  Its built-in
 * editors normally protect themselves while editing, but horizontal keys and
 * mouse presses can still reach that selector in the custom, virtualized
 * sheet layout.  Keep those events inside the native input so the browser can
 * move the caret and place it where the user clicks.
 */
function protectCellEditorInput(input: HTMLInputElement, finish: (commit: boolean) => void) {
  input.addEventListener("mousedown", (event) => event.stopPropagation());
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("keydown", (event) => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      // Do not prevent the browser default: it is what moves the caret.
      event.stopPropagation();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  });
}

function makeCellEditor(parse: (value: string) => unknown = (value) => value): CellEditor {
  return (cell, onRendered, success, cancel) => {
    const input = document.createElement("input");
    const original = cell.getValue();
    let finished = false;

    input.type = "text";
    input.className = "tabulator-edit-input";
    input.value = original == null ? "" : String(original);
    input.autocomplete = "off";
    input.spellcheck = false;
    input.style.padding = "4px 8px";
    input.style.width = "100%";
    input.style.height = "100%";
    input.style.boxSizing = "border-box";

    const finish = (commit: boolean) => {
      if (finished) return;
      finished = true;
      if (!commit) {
        cancel();
        return;
      }
      const value = parse(input.value);
      if (Object.is(value, original) || (value === "" && (original == null || original === ""))) {
        cancel();
      } else {
        success(value);
      }
    };

    onRendered(() => {
      input.focus({ preventScroll: true });
      // Keep the caret where the user clicked.  This only provides a fallback
      // when the webview has not supplied a selection yet; it does not select
      // the whole cell contents like the old editor path did.
      if (document.activeElement !== input) input.setSelectionRange(input.value.length, input.value.length);
    });
    input.addEventListener("change", () => finish(true));
    input.addEventListener("blur", () => finish(true));
    protectCellEditorInput(input, finish);
    return input;
  };
}

const textCellEditor = makeCellEditor();
const numberCellEditor = makeCellEditor((value) => {
  if (value.trim() === "") return "";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
});

function packRow(i: number, columns: string[], rec?: unknown[]) {
  const row: Record<string, unknown> = { _r: i };
  if (rec) {
    for (let c = 0; c < columns.length; c++) row[columns[c]] = rec[c] ?? null;
  }
  return row;
}

type TableUi = {
  groupBy: string | boolean;
  sorters: { field: string; dir: string }[];
  filters: { field: string; type: string; value: unknown }[];
  session?: string | null;
};

function snapshotUi(table: Tabulator): TableUi {
  try {
    const groupBy = (table.options?.groupBy as string | boolean) || false;
    const sorters = (table.getSorters?.() || [])
      .map((s: { field?: string; dir?: string }) => ({ field: String(s.field || ""), dir: String(s.dir || "") }))
      .filter((s: { field: string; dir: string }) => s.field);
    const filters = table.getFilters?.(true) || [];
    return { groupBy, sorters, filters };
  } catch {
    return { groupBy: false, sorters: [], filters: [] };
  }
}

function restoreUi(table: Tabulator, ui: TableUi) {
  try {
    if (ui.groupBy) table.setGroupBy(ui.groupBy);
    if (ui.sorters.length) table.setSort(ui.sorters.map((s) => ({ column: s.field, dir: s.dir })));
    if (ui.filters.length) {
      for (const f of ui.filters) {
        if (f?.field) table.setFilter(f.field, f.type, f.value);
      }
    }
  } catch {
    /* table not ready */
  }
}

function hlClass(stage?: string) {
  if (!stage) return "";
  if (stage === "ai") return "is-hl-ai";
  if (stage === "review" || stage === "preview") return "is-hl-review";
  if (stage === "error" || stage === "invalid" || stage === "validation") return "is-hl-error";
  return "is-mod";
}

function paintCellEl(eln: HTMLElement, stage?: string) {
  eln.classList.remove("is-mod", "is-hl-ai", "is-hl-review", "is-hl-error");
  const cls = hlClass(stage);
  if (cls) eln.classList.add(cls);
}

function paintMods(table: Tabulator, highlights: Record<string, string>) {
  try {
    let rows = table.getRows("visible");
    if (!rows?.length) rows = table.getRows();
    for (const row of rows) {
      const r = Number(row.getData?.()._r);
      for (const cell of row.getCells?.() || []) {
        const f = cell.getField?.();
        if (!f || f === "_r") continue;
        const eln = cell.getElement?.();
        if (eln) paintCellEl(eln, highlights[`${r}:${f}`]);
      }
    }
  } catch {
    /* ignore */
  }
}

function titleEl(name: string, type: string) {
  const wrap = document.createElement("span");
  wrap.className = "drs-h";
  const nameEl = document.createElement("span");
  nameEl.className = "drs-h-name";
  nameEl.textContent = name;
  const typeEl = document.createElement("span");
  typeEl.className = "drs-h-type";
  typeEl.textContent = type;
  wrap.append(nameEl, typeEl);
  return wrap;
}

function paintTypes(table: Tabulator, schema: { name: string; active?: string; inferred?: string }[]) {
  const by: Record<string, string> = {};
  for (const s of schema) by[s.name] = s.active || s.inferred || "Text";
  try {
    for (const col of table.getColumns?.() || []) {
      const f = col.getField?.();
      if (!f || f === "_r") continue;
      const el = col.getElement?.()?.querySelector?.(".drs-h-type") as HTMLElement | null;
      if (el && by[f]) el.textContent = by[f];
    }
  } catch {
    /* ignore */
  }
}

function openFilterPop(col: { getField: () => string; getElement: () => HTMLElement; getTable: () => Tabulator }) {
  document.querySelectorAll(".drs-col-pop").forEach((n) => n.remove());
  const field = col.getField();
  const anchor = col.getElement().getBoundingClientRect();
  const box = document.createElement("div");
  box.className = "drs-col-pop";
  const input = document.createElement("input");
  input.placeholder = `Filter ${field}…`;
  input.value = "";
  box.appendChild(input);
  const go = document.createElement("button");
  go.type = "button";
  go.textContent = "Apply";
  box.appendChild(go);
  document.body.appendChild(box);
  box.style.left = `${Math.min(anchor.left, window.innerWidth - 240)}px`;
  box.style.top = `${anchor.bottom + 6}px`;
  const apply = () => {
    const v = input.value.trim();
    const table = col.getTable();
    table.clearFilter(true);
    if (v) table.setFilter(field, "like", v);
    box.remove();
  };
  go.addEventListener("click", apply);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") apply();
    if (e.key === "Escape") box.remove();
  });
  const onDown = (e: MouseEvent) => {
    if (!box.contains(e.target as Node)) {
      box.remove();
      document.removeEventListener("mousedown", onDown);
    }
  };
  document.addEventListener("mousedown", onDown);
  input.focus();
}

function mountFillHandle(table: Tabulator, persist: (row: number, field: string, value: unknown) => void) {
  const holder = table.element.querySelector(".tabulator-tableholder") as HTMLElement | null;
  if (!holder) return () => undefined;
  const handle = document.createElement("div");
  handle.className = "drs-fill-handle";
  handle.title = "Drag to fill";
  holder.appendChild(handle);

  const place = () => {
    const range = holder.querySelector(".tabulator-range-active") as HTMLElement | null;
    if (!range || range.offsetWidth < 2) {
      handle.classList.remove("is-on");
      return;
    }
    handle.classList.add("is-on");
    handle.style.left = `${range.offsetLeft + range.offsetWidth - 6}px`;
    handle.style.top = `${range.offsetTop + range.offsetHeight - 6}px`;
  };

  const obs = new MutationObserver(place);
  const overlay = holder.querySelector(".tabulator-range-overlay");
  if (overlay) obs.observe(overlay, { attributes: true, subtree: true, attributeFilter: ["style", "class"] });
  holder.addEventListener("scroll", place);
  table.on("scrollVertical", place);
  table.on("cellClick", place);

  const cellAt = (x: number, y: number) => {
    handle.style.pointerEvents = "none";
    const node = document.elementFromPoint(x, y);
    handle.style.pointerEvents = "";
    const cellEl = node?.closest?.(".tabulator-cell") as HTMLElement | null;
    if (!cellEl || cellEl.classList.contains("drs-tab-gutter")) return null;
    try {
      const rows = table.getRows();
      for (const row of rows) {
        const cells = row.getCells?.() || [];
        for (const cell of cells) {
          if (cell.getElement?.() === cellEl) return cell as CellComponent;
        }
      }
    } catch {
      return null;
    }
    return null;
  };

  let drag: { snapshot: { field: string; value: unknown }[][] } | null = null;

  const snapshotRange = () => {
    const ranges = table.getRanges?.() || [];
    const range = ranges[0];
    if (!range) return [];
    const structured = range.getStructuredCells?.() || [];
    if (structured.length) {
      return structured.map((line: CellComponent[]) =>
        line
          .filter((c) => c.getField?.() && c.getField() !== "_r")
          .map((c) => ({ field: c.getField(), value: c.getValue() })),
      );
    }
    const cells = range.getCells?.() || [];
    return [
      cells
        .filter((c: CellComponent) => c.getField?.() && c.getField() !== "_r")
        .map((c: CellComponent) => ({ field: c.getField(), value: c.getValue() })),
    ];
  };

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    drag = { snapshot: snapshotRange() };
    handle.classList.add("is-drag");
  });

  const onMove = (e: MouseEvent) => {
    if (!drag) return;
    const cell = cellAt(e.clientX, e.clientY);
    if (!cell) return;
    const ranges = table.getRanges?.() || [];
    const range = ranges[0];
    if (range?.setEndBound) range.setEndBound(cell);
    place();
  };

  const onUp = (e: MouseEvent) => {
    if (!drag) return;
    handle.classList.remove("is-drag");
    const src = drag.snapshot;
    drag = null;
    const cell = cellAt(e.clientX, e.clientY);
    const ranges = table.getRanges?.() || [];
    const range = ranges[0];
    if (cell && range?.setEndBound) range.setEndBound(cell);
    const structured: CellComponent[][] = range?.getStructuredCells?.() || [];
    if (!src.length || !structured.length) {
      place();
      return;
    }
    const sh = src.length;
    const sw = src[0]?.length || 0;
    if (!sw) {
      place();
      return;
    }
    structured.forEach((line, r) => {
      const usable = line.filter((c) => c.getField?.() && c.getField() !== "_r");
      usable.forEach((c, cidx) => {
        const tile = src[r % sh][cidx % sw];
        if (!tile) return;
        const row = Number(c.getRow().getData()._r);
        const field = c.getField();
        if (field === "_r") return;
        if (c.getValue() === tile.value) return;
        try {
          c.setValue?.(tile.value, true);
        } catch {
          /* ignore */
        }
        persist(row, field, tile.value);
      });
    });
    place();
  };

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
  place();

  return () => {
    obs.disconnect();
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    handle.remove();
  };
}

type Live = {
  columns: string[];
  rowCache: Record<number, unknown[]>;
  highlights: Record<string, string>;
  schema: { name: string; active?: string; inferred?: string }[];
};

type RowWindow = { start: number; end: number };
const GRID_ROW_HEIGHT = 28;
const GRID_BUFFER_ROWS = 36;

function positionTableWindow(host: HTMLElement, total: number, start: number, end: number) {
  host.style.top = "0";
  host.style.height = `${Math.max(GRID_ROW_HEIGHT, total * GRID_ROW_HEIGHT)}px`;
  const holder = host.querySelector<HTMLElement>(".tabulator-tableholder");
  const header = host.querySelector<HTMLElement>(".tabulator-header");
  if (!holder) return;
  holder.style.position = "absolute";
  holder.style.left = "0";
  holder.style.right = "0";
  holder.style.top = `${(header?.offsetHeight || 32) + start * GRID_ROW_HEIGHT}px`;
  holder.style.height = `${Math.max(GRID_ROW_HEIGHT, (end - start) * GRID_ROW_HEIGHT)}px`;
  holder.style.bottom = "auto";
}

export const DataGrid = memo(function DataGrid() {
  const { columns, rowCache, schema, total, ensureRange, edit, highlights, sessionId } = useWorkspace(
    useShallow((s) => ({
      columns: s.columns,
      rowCache: s.rowCache,
      schema: s.schema,
      total: s.total,
      ensureRange: s.ensureRange,
      edit: s.edit,
      highlights: s.highlights,
      sessionId: s.sessionId,
    })),
  );
  const { hiddenCols, colWidths, setColWidth, toggleHidden } = useUI(
    useShallow((s) => ({
      hiddenCols: s.hiddenCols,
      colWidths: s.colWidths,
      setColWidth: s.setColWidth,
      toggleHidden: s.toggleHidden,
    })),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<Tabulator | null>(null);
  const live = useRef<Live>({ columns, rowCache, highlights, schema });
  const keepUi = useRef<TableUi>({ groupBy: false, sorters: [], filters: [] });
  const [rowWindow, setRowWindow] = useState<RowWindow>({ start: 0, end: 320 });
  const rowWindowRef = useRef(rowWindow);
  rowWindowRef.current = rowWindow;
  live.current = { columns, rowCache, highlights, schema };

  useEffect(() => {
    const next = { start: 0, end: 320 };
    rowWindowRef.current = next;
    setRowWindow(next);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [sessionId]);

  const visible = useMemo(() => columns.filter((c) => !hiddenCols.includes(c)), [columns, hiddenCols]);
  const colKey = visible.join("\0");

  useEffect(() => {
    const el = hostRef.current;
    if (!el || !visible.length || !total) return;

    const fmt = (cell: CellComponent) => {
      const data = cell.getRow().getData();
      const row = Number(data._r);
      const name = cell.getField();
      const st = live.current;
      const idx = st.columns.indexOf(name);
      const rec = st.rowCache[row];
      let raw: unknown = cell.getValue();
      if (raw === undefined && rec && idx >= 0) raw = rec[idx];
      if (raw === undefined) raw = data[name];
      const empty = raw == null || raw === "";
      const eln = cell.getElement();
      paintCellEl(eln, st.highlights[`${row}:${name}`]);
      eln.classList.toggle("is-null", empty);
      if (empty) return "NULL";
      return String(raw);
    };

    const headerMenu = (field: string) => [
      {
        label: "Sort A → Z",
        action: (_e: unknown, col: { getTable: () => Tabulator; getField: () => string }) => col.getTable().setSort(col.getField(), "asc"),
      },
      {
        label: "Sort Z → A",
        action: (_e: unknown, col: { getTable: () => Tabulator; getField: () => string }) => col.getTable().setSort(col.getField(), "desc"),
      },
      { separator: true },
      {
        label: "Filter…",
        action: (_e: unknown, col: { getField: () => string; getElement: () => HTMLElement; getTable: () => Tabulator }) => openFilterPop(col),
      },
      {
        label: "Clear filter",
        action: (_e: unknown, col: { getTable: () => Tabulator }) => col.getTable().clearFilter(true),
      },
      { separator: true },
      {
        label: "Group by this column",
        action: (_e: unknown, col: { getTable: () => Tabulator; getField: () => string }) => col.getTable().setGroupBy(col.getField()),
      },
      {
        label: "Clear grouping",
        action: (_e: unknown, col: { getTable: () => Tabulator }) => col.getTable().setGroupBy(false),
      },
      { separator: true },
      { label: "Hide column", action: () => toggleHidden(field) },
      {
        label: "Insert column right…",
        action: () => useUI.getState().openColumnDialog({ after: field }),
      },
      {
        label: "Delete column…",
        action: () => void useWorkspace.getState().deleteColumns([field]),
      },
    ];

    const defs: ColumnDefinition[] = visible.map((name) => {
      const s = schema.find((x) => x.name === name);
      const type = s?.active || s?.inferred || "Text";
      const k = kindOf(type);
      const col: ColumnDefinition = {
        title: name,
        field: name,
        width: colWidths[name] || 168,
        minWidth: 96,
        headerSort: true,
        resizable: true,
        headerMenu: headerMenu(name),
        headerTooltip: `${name} · ${type}`,
        formatter: fmt,
        editor: k === "number" ? numberCellEditor : k === "bool" ? "tickCross" : textCellEditor,
        sorter: k === "number" ? "number" : "string",
        hozAlign: k === "number" ? "right" : "left",
        titleFormatter: () => {
          const cur = live.current.schema.find((x) => x.name === name);
          return titleEl(name, cur?.active || cur?.inferred || "Text");
        },
      };
      return col;
    });

    const initialWindow = rowWindowRef.current;
    const initialStart = Math.max(0, Math.min(Math.max(0, total - 1), initialWindow.start));
    const data: Record<string, unknown>[] = [];
    const initialEnd = Math.min(total, Math.max(initialStart + 1, initialWindow.end));
    for (let i = initialStart; i < initialEnd; i++) {
      data.push(packRow(i, columns, live.current.rowCache[i]));
    }
    const table = new Tabulator(el, {
      data,
      columns: defs,
      index: "_r",
      rowHeader: {
        field: "_r",
        title: "#",
        headerSort: false,
        hozAlign: "center",
        headerHozAlign: "center",
        resizable: false,
        frozen: true,
        width: 52,
        minWidth: 48,
        cssClass: "drs-tab-gutter",
        formatter: (cell: CellComponent) => String(Number(cell.getValue()) + 1),
        clipboard: false,
        editable: false,
      },
      height: "100%",
      layout: "fitDataFill",
      responsiveLayout: false,
      renderVertical: "virtual",
      renderHorizontal: "basic",
      rowHeight: 28,
      placeholder: "Loading rows…",
      reactiveData: false,
      movableColumns: true,
      clipboard: true,
      clipboardCopyStyled: false,
      clipboardCopyConfig: { columnHeaders: false },
      clipboardCopyRowRange: "range",
      clipboardPasteParser: "range",
      clipboardPasteAction: "range",
      selectableRange: true,
      selectableRangeColumns: true,
      selectableRangeRows: true,
      selectableRangeClearCells: true,
      editTriggerEvent: "dblclick",
      popupContainer: document.body,
      groupToggleElement: "header",
      columnDefaults: {
        headerSort: true,
        resizable: true,
        vertAlign: "middle",
        headerWordWrap: false,
      },
    });

    let unfill = () => undefined as void;
    table.on("tableBuilt", () => {
      const ui = { ...keepUi.current };
      if (ui.session && ui.session !== sessionId) {
        keepUi.current = { groupBy: false, sorters: [], filters: [] };
      } else {
        if (typeof ui.groupBy === "string" && !visible.includes(ui.groupBy)) ui.groupBy = false;
        ui.filters = ui.filters.filter((f) => !f.field || visible.includes(f.field));
        ui.sorters = ui.sorters.filter((s) => visible.includes(s.field));
        restoreUi(table, ui);
      }
      const start = Math.max(0, rowWindowRef.current.start);
      const end = Math.min(total, Math.max(start + 1, rowWindowRef.current.end));
      positionTableWindow(el, total, start, end);
      void ensureRange(0, Math.min(total, 400));
      unfill = mountFillHandle(table, (row, field, value) => void edit(row, field, value));
    });
    table.on("cellEdited", (cell: CellComponent) => {
      const row = Number(cell.getRow().getData()._r);
      const name = cell.getField();
      if (!name || name === "_r") return;
      const value = cell.getValue();
      const st = live.current;
      const idx = st.columns.indexOf(name);
      if (idx >= 0 && st.rowCache[row]) {
        const next = st.rowCache[row].slice();
        while (next.length <= idx) next.push(null);
        next[idx] = value;
        st.rowCache[row] = next;
      }
      const eln = cell.getElement();
      paintCellEl(eln, "manual");
      eln.classList.toggle("is-null", value == null || value === "");
      void edit(row, name, value);
    });
    table.on("cellClick", (_e: unknown, cell: CellComponent) => {
      const row = Number(cell.getRow().getData()._r);
      const name = cell.getField();
      if (!name || name === "_r") return;
      useWorkspace.getState().setSelectedCell({ row, column: name });
      try {
        const ranges = table.getRanges?.() || [];
        const range = ranges[0];
        const cells = range?.getCells?.() || [cell];
        const rows: number[] = [];
        const cols: string[] = [];
        for (const c of cells) {
          const f = c.getField?.();
          if (!f || f === "_r") continue;
          if (!cols.includes(f)) cols.push(f);
          const rr = Number(c.getRow().getData()._r);
          if (!rows.includes(rr)) rows.push(rr);
        }
        useWorkspace.getState().setSelectedRange(rows, cols);
      } catch {
        useWorkspace.getState().setSelectedRange([row], [name]);
      }
    });
    table.on("columnResized", (column: ColumnComponent) => {
      const field = column.getField();
      if (field && field !== "_r") setColWidth(field, column.getWidth());
    });

    tableRef.current = table;
    return () => {
      keepUi.current = { ...snapshotUi(table), session: sessionId };
      unfill();
      table.destroy();
      tableRef.current = null;
      el.replaceChildren();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, colKey]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !total) return;
    let frame = 0;
    const updateWindow = () => {
      frame = 0;
      const visibleRows = Math.max(1, Math.ceil(scroller.clientHeight / GRID_ROW_HEIGHT));
      const first = Math.max(0, Math.floor(scroller.scrollTop / GRID_ROW_HEIGHT));
      const start = Math.max(0, first - GRID_BUFFER_ROWS);
      const end = Math.min(total, first + visibleRows + GRID_BUFFER_ROWS);
      const next = { start, end: Math.max(start + 1, end) };
      const prev = rowWindowRef.current;
      if (prev.start !== next.start || prev.end !== next.end) {
        rowWindowRef.current = next;
        setRowWindow(next);
      }
      void ensureRange(start, Math.max(1, end - start));
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(updateWindow);
    };
    updateWindow();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", updateWindow);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", updateWindow);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [total, sessionId, ensureRange]);

  useEffect(() => {
    const table = tableRef.current;
    const host = hostRef.current;
    if (!table || !host || !total) return;
    const start = Math.max(0, Math.min(total - 1, rowWindow.start));
    const end = Math.min(total, Math.max(start + 1, rowWindow.end));
    positionTableWindow(host, total, start, end);
    const data: Record<string, unknown>[] = [];
    for (let i = start; i < end; i++) {
      data.push(packRow(i, columns, live.current.rowCache[i]));
    }
    void table
      .replaceData(data)
      .then(() => {
        positionTableWindow(host, total, start, end);
        paintMods(table, highlights);
        paintTypes(table, schema);
      })
      .catch(() => {
        /* table may be tearing down during a fast tab or view change */
      });
  }, [rowWindow, total]);

  useEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    if (table.element?.querySelector(".tabulator-editing")) {
      paintMods(table, highlights);
      return;
    }
    const cols = live.current.columns;
    const packed: Record<string, unknown>[] = [];
    const start = Math.max(0, rowWindowRef.current.start);
    const end = Math.min(total, rowWindowRef.current.end);
    for (let i = start; i < end; i++) {
      if (!(i in rowCache)) continue;
      const row = packRow(i, cols, rowCache[i]);
      try {
        const existing = table.getRow(i);
        if (existing) {
          const data = existing.getData();
          let diff = false;
          for (const c of cols) {
            if (data[c] !== row[c]) {
              diff = true;
              break;
            }
          }
          if (!diff) continue;
        }
        packed.push(row);
      } catch {
        packed.push(row);
      }
    }
    try {
      if (packed.length) void table.updateData(packed).catch(() => undefined);
    } catch {
      /* table tearing down */
    }
    paintMods(table, highlights);
    paintTypes(table, schema);
  }, [rowCache, highlights, schema]);

  const restoring = useWorkspace((s) => s.restoring);
  if (!columns.length) return restoring ? <RestoreNotice /> : <EmptyState />;

  return (
    <div ref={scrollRef} className="drs-sheet-fill" style={{ overflow: "auto", position: "relative" }}>
      <div
        style={{
          position: "relative",
          minWidth: "100%",
          height: `${Math.max(GRID_ROW_HEIGHT, total * GRID_ROW_HEIGHT)}px`,
        }}
      >
        <div
          ref={hostRef}
          className="drs-tabulator"
          style={{
            position: "absolute",
            insetInline: 0,
            top: 0,
            height: `${Math.max(GRID_ROW_HEIGHT, total * GRID_ROW_HEIGHT)}px`,
          }}
        />
      </div>
    </div>
  );
});
