import { create } from "zustand";
import { api, ensureSidecar, restoreHint, setRestoreHint, clearRestoreHint, type Metrics, type SchemaCol, type LogItem, type ProfileCol, type CellHighlight } from "../ipc/client";
import { resolveColumnRules, findRuleSpec, specToPayload, type LibRule } from "../lib/builtinRules";
import { useUniversal } from "./universal";
import { useUI } from "./ui";
import { useLicense } from "./license";
import { beginBasicFileImport, finishBasicFileImport } from "../license/importQuota";

export type View = "workspace" | "ai" | "settings" | "library" | "lineage" | "versions";

type State = {
  view: View;
  sessionId: string | null;
  columns: string[];
  schema: SchemaCol[];
  total: number;
  rowCache: Record<number, unknown[]>;
  metrics: Metrics | null;
  profile: ProfileCol[];
  logs: LogItem[];
  clearConsole: () => void;
  sql: string;
  javascript: string;
  python: string;
  rowLimit: number;
  running: boolean;
  error: string;
  status: string;
  restoring: boolean;
  setRestoring: (restoring: boolean) => void;
  probeRestore: () => Promise<void>;
  tabs: { id: string; label: string }[];
  rememberTab: (id: string, label: string) => void;
  switchTab: (id: string) => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  connectOpen: boolean;
  exportOpen: boolean;
  pushOpen: boolean;
  columnRules: Record<string, string>;
  libraryRules: LibRule[];
  highlights: Record<string, string>;
  mergeHighlights: (items: CellHighlight[]) => void;
  clearHighlights: () => void;
  selectedCell: { row: number; column: string } | null;
  selectedColumns: string[];
  selectedRows: number[];
  setSelectedCell: (cell: { row: number; column: string } | null) => void;
  setSelectedRange: (rows: number[], columns: string[]) => void;
  setColumnType: (column: string, active: string) => Promise<void>;
  deleteColumns: (columns?: string[]) => Promise<void>;
  addColumn: (name: string, type?: string, after?: string) => Promise<void>;
  applySchemaTemplate: (mapping: Array<Record<string, unknown>>, label?: string) => Promise<void>;
  setColumnRule: (column: string, ruleName: string) => void;
  assignColumnRule: (column: string, ruleName: string, apply?: boolean) => Promise<void>;
  assignRuleToAll: (ruleName: string, apply?: boolean) => Promise<void>;
  autoCleanAll: () => Promise<void>;
  refreshLibrary: () => Promise<void>;
  saveEditorToLibrary: (kind: "sql" | "javascript" | "python", name: string, description?: string) => Promise<void>;
  insertLibraryRule: (rule: LibRule) => void;
  setView: (v: View) => void;
  setConnectOpen: (v: boolean) => void;
  setExportOpen: (v: boolean) => void;
  setPushOpen: (v: boolean) => void;
  setEditors: (p: Partial<Pick<State, "sql" | "javascript" | "python">>) => void;
  setRowLimit: (n: number) => void;
  refresh: () => Promise<void>;
  loadViewport: (offset?: number, limit?: number) => Promise<void>;
  ensureRange: (y: number, h: number) => Promise<void>;
  openPath: (path: string) => Promise<void>;
  openFile: (file: File) => Promise<void>;
  resumeLast: () => Promise<void>;
  downloadCleaningReport: () => Promise<void>;
  openDatabase: (kind: string, config: Record<string, unknown>, query: string) => Promise<void>;
  run: (kind: "sql" | "javascript" | "python" | "pipeline" | "rules") => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  restoreVersion: (versionId: number) => Promise<void>;
  stop: () => void;
  edit: (row: number, column: string, value: unknown) => Promise<void>;
  searchReplace: (find: string, replace: string, doReplace: boolean, regex: boolean) => Promise<number>;
};

let workspaceTimer = 0;
function queueWorkspaceMeta() {
  if (workspaceTimer) window.clearTimeout(workspaceTimer);
  workspaceTimer = window.setTimeout(() => {
    const s = useWorkspace.getState();
    if (!s.sessionId) return;
    void api.saveWorkspace(s.sessionId, {
      sql: s.sql,
      javascript: s.javascript,
      python: s.python,
      column_rules: s.columnRules,
    });
  }, 900);
}

type ViewportJob = {
  sessionId: string;
  start: number;
  end: number;
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
  timer: number;
};

// One active request plus a small queue per sheet prevents scroll events from
// creating overlapping sidecar calls. Nearby queued ranges are merged before
// they are sent, while distant jumps remain separate and cannot strand a
// caller's promise.
const viewportPending = new Map<string, ViewportJob[]>();
const viewportInFlight = new Map<string, ViewportJob>();
const VIEWPORT_COALESCE_MS = 16;
const VIEWPORT_MERGE_GAP = 80;

function viewportRangesNear(a: ViewportJob, start: number, end: number) {
  return start <= a.end + VIEWPORT_MERGE_GAP && end >= a.start - VIEWPORT_MERGE_GAP;
}

function scheduleNextViewport(
  sessionId: string,
  fetch: (start: number, end: number) => Promise<void>,
) {
  if (viewportInFlight.has(sessionId)) return;
  const queue = viewportPending.get(sessionId);
  const job = queue?.[0];
  if (!job || job.timer) return;
  job.timer = window.setTimeout(() => {
    job.timer = 0;
    const current = viewportPending.get(sessionId);
    if (!current || current[0] !== job) return;
    if (viewportInFlight.has(sessionId)) return;
    current.shift();
    if (!current.length) viewportPending.delete(sessionId);
    runViewportJob(job, fetch);
  }, VIEWPORT_COALESCE_MS);
}

function runViewportJob(job: ViewportJob, fetch: (start: number, end: number) => Promise<void>) {
  viewportInFlight.set(job.sessionId, job);
  void fetch(job.start, job.end)
    .then(() => job.resolve())
    .catch((error) => job.reject(error))
    .finally(() => {
      if (viewportInFlight.get(job.sessionId) === job) viewportInFlight.delete(job.sessionId);
      scheduleNextViewport(job.sessionId, fetch);
    });
}

function enqueueViewport(
  sessionId: string,
  offset: number,
  limit: number,
  fetch: (start: number, end: number) => Promise<void>,
): Promise<void> {
  const start = Math.max(0, Math.floor(offset));
  const end = start + Math.max(1, Math.floor(limit));
  const inFlight = viewportInFlight.get(sessionId);
  if (inFlight && start >= inFlight.start && end <= inFlight.end) return inFlight.promise;

  const queue = viewportPending.get(sessionId) || [];
  const pending = queue.find((job) => viewportRangesNear(job, start, end));
  if (pending) {
    pending.start = Math.min(pending.start, start);
    pending.end = Math.max(pending.end, end);
    return pending.promise;
  }

  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  queue.push({ sessionId, start, end, promise, resolve, reject, timer: 0 });
  viewportPending.set(sessionId, queue);
  scheduleNextViewport(sessionId, fetch);
  return promise;
}

export const useWorkspace = create<State>((set, get) => ({
  view: "workspace",
  sessionId: null,
  columns: [],
  schema: [],
  total: 0,
  rowCache: {},
  metrics: null,
  profile: [],
  logs: [],
  clearConsole: () => set({ logs: [], error: "", status: "Ready" }),
  sql: "-- DuckDB tables: data, df\n-- SELECT * FROM data WHERE email IS NOT NULL;\n",
  javascript: "// row is an object. Mutate and return it.\n// Terminal: npm install lodash   (saved under libraries/)\n// const _ = require('lodash');\n// row.email = String(row.email || '').trim().toLowerCase();\nreturn row;",
  python: "# df, pl, np, pa are injected — import is optional. Assign back to df.\n# Terminal uses this engine:  pip install phonenumbers\n# Then:  import phonenumbers\ndf = df.with_columns(pl.all())\n",
  rowLimit: 10000,
  running: false,
  error: "",
  status: "Ready",
  restoring: restoreHint(),
  tabs: [],
  connectOpen: false,
  exportOpen: false,
  pushOpen: false,
  columnRules: {},
  libraryRules: [],
  highlights: {},
  selectedCell: null,
  selectedColumns: [],
  selectedRows: [],
  setSelectedCell: (selectedCell) => set({ selectedCell }),
  setSelectedRange: (selectedRows, selectedColumns) => set({ selectedRows, selectedColumns }),
  mergeHighlights: (items) => {
    if (!items?.length) return;
    const highlights = { ...get().highlights };
    for (const h of items) {
      if (h && typeof h.row === "number" && h.column) highlights[`${h.row}:${h.column}`] = h.stage || "rules";
    }
    set({ highlights });
  },
  setRestoring: (restoring) => set({ restoring }),
  probeRestore: async () => {
    /* Cheap probe: knows instantly whether a sheet is restorable, without
       waiting for the heavy engine (polars) to finish importing. */
    if (get().sessionId) return;
    try {
      const p = await api.peek();
      if (get().sessionId) return;
      if (p?.restorable) {
        set({ restoring: true });
        setRestoreHint();
      } else {
        clearRestoreHint();
        set({ restoring: false });
      }
    } catch {
      set({ restoring: false });
    }
  },
  rememberTab: (id, label) => {
    const exists = get().tabs.some((t) => t.id === id);
    const tabs = exists
      ? get().tabs.map((t) => (t.id === id ? { ...t, label } : t))
      : [...get().tabs, { id, label }];
    set({ tabs });
  },
  switchTab: async (id) => {
    const cur = get().sessionId;
    if (cur === id) {
      set({ view: "workspace" });
      return;
    }
    try {
      if (cur) {
        await api.saveWorkspace(cur, {
          sql: get().sql,
          javascript: get().javascript,
          python: get().python,
          column_rules: get().columnRules,
        });
      }
      const [ws, vp] = await Promise.all([api.sessionWorkspace(id), api.viewport(id, 0, 120)]);
      const rowCache: Record<number, unknown[]> = {};
      vp.rows.forEach((r: unknown[], i: number) => {
        rowCache[vp.offset + i] = r;
      });
      set({
        sessionId: id,
        view: "workspace",
        sql: typeof ws.sql === "string" ? ws.sql : get().sql,
        javascript: typeof ws.javascript === "string" ? ws.javascript : get().javascript,
        python: typeof ws.python === "string" ? ws.python : get().python,
        columnRules:
          ws.column_rules && typeof ws.column_rules === "object"
            ? (ws.column_rules as Record<string, string>)
            : {},
        highlights: {},
        rowCache,
        columns: vp.columns,
        schema: vp.schema,
        total: vp.total,
        status: `Switched to ${ws.label || id}`,
      });
      if (Array.isArray(ws.highlights) && ws.highlights.length) get().mergeHighlights(ws.highlights);
      await get().refresh();
      const lbl = String(ws.label || "").trim();
      if (lbl) get().rememberTab(id, lbl);
    } catch (e) {
      set({ error: String(e), status: "Switch failed" });
    }
  },
  closeTab: async (id) => {
    const tabs = get().tabs.filter((t) => t.id !== id);
    set({ tabs });
    if (tabs.length === 0) clearRestoreHint();
    void api.deleteSession(id).catch(() => {});
    if (get().sessionId !== id) return;
    const nxt = tabs[tabs.length - 1];
    if (nxt) {
      await get().switchTab(nxt.id);
      return;
    }
    set({
      sessionId: null,
      columns: [],
      schema: [],
      total: 0,
      rowCache: {},
      metrics: null,
      profile: [],
      logs: [],
      highlights: {},
      view: "workspace",
      status: "Ready",
    });
  },
  clearHighlights: () => set({ highlights: {} }),
  applySchemaTemplate: async (mapping, label) => {
    const cols = get().columns.length ? get().columns : get().schema.map((s) => s.name);
    const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const byNorm = new Map<string, Record<string, unknown>>();
    for (const m of mapping || []) {
      const key = norm(String(m.column || m.name || ""));
      if (key) byNorm.set(key, m);
    }
    const schema = get().schema.map((s) => {
      const hit = byNorm.get(norm(s.name));
      if (!hit) return s;
      const active = String(hit.type || hit.active || s.active);
      return { ...s, active, manual: true };
    });
    const hits = schema.filter((s, i) => s.active !== get().schema[i]?.active || s.manual !== get().schema[i]?.manual).length;
    set({ schema, status: label ? `Applying “${label}”…` : "Applying schema…" });
    const sid = get().sessionId;
    if (!sid) {
      set({ error: "Open a dataset first, then apply the schema." });
      return;
    }
    try {
      const r = (await api.applyTemplate(sid, mapping)) as { count?: number };
      await get().loadViewport(0);
      await get().refresh();
      const n = r.count ?? hits;
      set({ status: n ? `Schema applied · ${n} column${n === 1 ? "" : "s"} locked` : "Schema applied · no matching columns" });
    } catch (e) {
      set({ error: String(e), status: "Schema apply failed" });
    }
  },
  setColumnType: async (column, active) => {
    const schema = get().schema.map((s) =>
      s.name === column ? { ...s, active, manual: true } : s,
    );
    set({ schema, status: `Type ${column} → ${active}` });
    const sid = get().sessionId;
    if (!sid) return;
    try {
      await api.schema(sid, column, { active, manual: true, locked: true });
    } catch (e) {
      set({ error: String(e), status: "Type update failed" });
    }
  },
  deleteColumns: async (columns) => {
    const sid = get().sessionId;
    if (!sid) {
      set({ error: "Open a dataset first." });
      return;
    }
    const all = get().columns;
    const seen = new Set<string>();
    const picked: string[] = [];
    for (const c of columns?.length ? columns : get().selectedColumns) {
      if (!all.includes(c) || seen.has(c)) continue;
      seen.add(c);
      picked.push(c);
    }
    if (!picked.length) {
      set({ error: "Select a column first." });
      return;
    }
    if (all.length - picked.length < 1) {
      set({ error: "Keep at least one column." });
      return;
    }
    const label = picked.length === 1 ? `"${picked[0]}"` : `${picked.length} columns`;
    const ok = await useUI.getState().askConfirm({
      title: picked.length === 1 ? "Delete column" : "Delete columns",
      message: `Remove ${label} from this sheet? Undo restores the column${picked.length === 1 ? "" : "s"} and their values.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    set({ running: true, error: "", status: `Deleting ${label}…` });
    try {
      await api.dropColumns(sid, picked);
      useUI.getState().forgetColumns(picked);
      const drop = new Set(picked);
      const columnRules = { ...get().columnRules };
      for (const c of picked) delete columnRules[c];
      const highlights: Record<string, string> = {};
      for (const [k, v] of Object.entries(get().highlights)) {
        const col = k.includes(":") ? k.slice(k.indexOf(":") + 1) : k;
        if (!drop.has(col)) highlights[k] = v;
      }
      const cell = get().selectedCell;
      set({
        columnRules,
        highlights,
        selectedCell: cell && drop.has(cell.column) ? null : cell,
        selectedColumns: get().selectedColumns.filter((c) => !drop.has(c)),
        rowCache: {},
      });
      await get().loadViewport(0);
      await get().refresh();
      set({
        status: picked.length === 1 ? `Deleted column ${picked[0]}` : `Deleted ${picked.length} columns`,
      });
    } catch (e) {
      set({ error: String(e), status: "Delete column failed" });
    } finally {
      set({ running: false });
    }
  },
  addColumn: async (name, type = "Text", after) => {
    const sid = get().sessionId;
    if (!sid) {
      set({ error: "Open a dataset first." });
      return;
    }
    const label = String(name || "").trim();
    if (!label) {
      set({ error: "Name the column first." });
      return;
    }
    set({ running: true, error: "", status: `Adding column ${label}…` });
    try {
      const r = await api.addColumn(sid, label, type || "Text", after);
      const added = r.added || label;
      useUI.getState().closeColumnDialog();
      const expanded = useUI.getState().expandedFields;
      if (!expanded.includes(added)) {
        useUI.getState().toggleField(added);
      }
      set({ rowCache: {}, selectedColumns: [added] });
      await get().loadViewport(0);
      await get().refresh();
      set({ status: `Added column ${added}` });
    } catch (e) {
      set({ error: String(e), status: "Add column failed" });
    } finally {
      set({ running: false });
    }
  },
  setColumnRule: (column, ruleName) => {
    set({ columnRules: { ...get().columnRules, [column]: ruleName } });
    queueWorkspaceMeta();
  },
  assignColumnRule: async (column, ruleName, apply = true) => {
    get().setColumnRule(column, ruleName);
    set({ status: `Assigned “${ruleName}” → ${column}` });
    if (!apply) return;
    const sid = get().sessionId;
    if (!sid) {
      set({ error: "Open a dataset first, then assign again." });
      return;
    }
    const spec = findRuleSpec(ruleName, get().libraryRules);
    const payload = specToPayload(spec, ruleName, [column]);
    set({ running: true, error: "" });
    try {
      const result = (await api.rules(sid, [payload])) as { highlights?: CellHighlight[] };
      if (result.highlights?.length) get().mergeHighlights(result.highlights);
      set({ rowCache: {} });
      await get().loadViewport(0);
      await get().refresh();
      set({ status: `Applied “${ruleName}” on ${column}` });
    } catch (e) {
      set({ error: String(e), status: "Assign failed" });
    } finally {
      set({ running: false });
    }
  },
  assignRuleToAll: async (ruleName, apply = true) => {
    const cols = get().columns;
    const next = { ...get().columnRules };
    for (const c of cols) next[c] = ruleName;
    set({ columnRules: next, status: `Assigned “${ruleName}” to ${cols.length} columns` });
    if (!apply) return;
    const sid = get().sessionId;
    if (!sid) {
      set({ error: "Open a dataset first." });
      return;
    }
    const spec = findRuleSpec(ruleName, get().libraryRules);
    const payload = specToPayload(spec, ruleName, cols.length ? cols : undefined);
    set({ running: true, error: "" });
    try {
      const result = (await api.rules(sid, [payload])) as { highlights?: CellHighlight[] };
      if (result.highlights?.length) get().mergeHighlights(result.highlights);
      set({ rowCache: {} });
      await get().loadViewport(0);
      await get().refresh();
      set({ status: `Applied “${ruleName}” on all columns` });
    } catch (e) {
      set({ error: String(e), status: "Assign failed" });
    } finally {
      set({ running: false });
    }
  },
  autoCleanAll: async () => {
    const sid = get().sessionId;
    if (!sid) {
      set({ error: "Open a dataset first." });
      return;
    }
    const uni = useUniversal.getState().payloads(get().libraryRules);
    if (!uni.length) {
      set({ error: "", status: "No universal rules enabled. Open the Rules panel to turn some on." });
      return;
    }
    set({ running: true, error: "", status: "Running enabled universal rules…" });
    try {
      const result = (await api.rules(sid, uni)) as {
        highlights?: CellHighlight[];
        changed?: number;
      };
      if (result.highlights?.length) get().mergeHighlights(result.highlights);
      set({ rowCache: {} });
      await get().loadViewport(0);
      await get().refresh();
      const changed = result.changed ?? get().metrics?.cells_cleaned ?? Object.keys(get().highlights).length;
      set({ status: changed ? `Auto-clean complete · ${changed.toLocaleString()} cells cleaned` : "Auto-clean complete" });
    } catch (e) {
      set({ error: String(e), status: "Auto-clean failed" });
    } finally {
      set({ running: false });
    }
  },
  refreshLibrary: async () => {
    try {
      const rows = (await api.libraryRules()) as LibRule[];
      set({ libraryRules: rows || [] });
    } catch {
      /* sidecar down */
    }
  },
  saveEditorToLibrary: async (kind, name, description = "") => {
    const body = kind === "sql" ? get().sql : kind === "javascript" ? get().javascript : get().python;
    await api.saveRule({
      name,
      kind,
      body,
      description: description || `Saved from ${kind} editor`,
      category: kind,
    });
    await get().refreshLibrary();
    set({ status: `Saved “${name}” to library` });
  },
  insertLibraryRule: (rule) => {
    const kind = (rule.kind || "").toLowerCase();
    const snippet = (rule.body || "").trim();
    if (!snippet) return;
    if (kind === "sql") set({ sql: `${get().sql.replace(/\s+$/, "")}\n\n${snippet}\n` });
    else if (kind === "javascript") set({ javascript: `${get().javascript.replace(/\s+$/, "")}\n\n${snippet}\n` });
    else if (kind === "python") set({ python: `${get().python.replace(/\s+$/, "")}\n\n${snippet}\n` });
    set({ status: `Inserted “${rule.name}” into ${kind || "editor"}` });
    queueWorkspaceMeta();
  },
  setView: (view) => set({ view }),
  setConnectOpen: (connectOpen) => set({ connectOpen }),
  setExportOpen: (exportOpen) => set({ exportOpen }),
  setPushOpen: (pushOpen) => set({ pushOpen }),
  setEditors: (p) => {
    set(p);
    queueWorkspaceMeta();
  },
  setRowLimit: (rowLimit) => set({ rowLimit }),
  refresh: async () => {
    const sid = get().sessionId;
    if (!sid) return;
    setRestoreHint();
    const [metrics, profile, logs] = await Promise.all([
      api.metrics(sid),
      api.profile(sid),
      api.logs(sid),
    ]);
    set({ metrics, profile, logs });
  },
  loadViewport: (offset = 0, limit = 120) => {
    const sid = get().sessionId;
    if (!sid) return Promise.resolve();
    return enqueueViewport(sid, offset, limit, async (start, end) => {
      const vp = await api.viewport(sid, start, end - start);
      // A tab switch can finish while an older sidecar request is still in
      // flight. Never let that response overwrite the active sheet.
      if (get().sessionId !== sid) return;
      const rowCache = { ...get().rowCache };
      vp.rows.forEach((r, i) => {
        rowCache[vp.offset + i] = r;
      });
      set({
        columns: vp.columns,
        schema: vp.schema,
        total: vp.total,
        rowCache,
      });
    });
  },
  ensureRange: async (y, h) => {
    const { sessionId, total, rowCache } = get();
    if (!sessionId || total === 0) return;
    const end = Math.min(total, y + h + 40);
    let miss = -1;
    for (let i = Math.max(0, y); i < end; i++) {
      if (!(i in rowCache)) {
        miss = i;
        break;
      }
    }
    if (miss < 0) return;
    await get().loadViewport(miss, Math.max(80, h + 40));
  },
  resumeLast: async () => {
    if (get().sessionId) return;
    try {
      await ensureSidecar();
      if (get().sessionId) return;
      const r = await api.resume();
      if (!r?.restored || !r.session_id || get().sessionId) {
        clearRestoreHint();
        set({ restoring: false });
        return;
      }
      setRestoreHint();
      set({
        restoring: true,
        sessionId: r.session_id,
        view: "workspace",
        sql: typeof r.sql === "string" ? r.sql : get().sql,
        javascript: typeof r.javascript === "string" ? r.javascript : get().javascript,
        python: typeof r.python === "string" ? r.python : get().python,
        columnRules: r.column_rules && typeof r.column_rules === "object" ? r.column_rules : {},
        rowCache: {},
        highlights: {},
        status: "Restoring unsaved sheet…",
        error: "",
      });
      if (r.highlights?.length) get().mergeHighlights(r.highlights);
      await get().loadViewport(0);
      await get().refresh();
      const name0 = String(r.source || "").split(/[/\\]/).pop() || "sheet";
      get().rememberTab(r.session_id, name0);
      const cleaned = get().metrics?.cells_cleaned ?? r.clean_total ?? 0;
      const src = String(r.source || "");
      const name = name0;
      const rows = Number(r.rows ?? get().total);
      set({
        status: cleaned
          ? `Restored ${name} · ${rows.toLocaleString()} rows · ${Number(cleaned).toLocaleString()} cells cleaned`
          : `Restored ${name} · ${rows.toLocaleString()} rows`,
        restoring: false,
      });
      /* Crash-left siblings: bring every other unexported sheet back as a tab. */
      try {
        const disk = (await api.diskSessions()) as Array<{ session_id?: string; label?: string; exported?: boolean; closed?: boolean }>;
        const others = (disk || []).filter((d) => d.session_id && d.session_id !== r.session_id && !d.exported && !d.closed);
        let extra = 0;
        for (const d of others) {
          const rr = await api.restoreDiskSession(String(d.session_id));
          if (rr?.session_id) {
            get().rememberTab(rr.session_id, String(rr.label || d.label || rr.session_id));
            extra += 1;
          }
        }
        if (extra > 0) {
          set({ status: `${get().status} · +${extra} more sheet${extra === 1 ? "" : "s"} recovered` });
        }
      } catch {
        /* single-sheet restore already succeeded; sibling recovery is best-effort */
      }
    } catch (e) {
      /* No session to restore -> Welcome screen. But if we already committed
         to a restored session, surface the failure instead of dying silently. */
      const msg = String(e).replace(/^Error:\s*/, "");
      set({ restoring: false });
      if (get().sessionId) {
        set({ status: `Resume incomplete: ${msg}`, error: msg });
        try {
          await get().loadViewport(0);
          await get().refresh();
        } catch {
          /* keep the diagnostic status */
        }
      }
    }
  },
  openPath: async (path) => {
    const quota = beginBasicFileImport(useLicense.getState().snap);
    if (!quota.allowed) {
      set({ error: quota.reason || "Basic file import limit reached.", status: "Import unavailable" });
      return;
    }
    set({ running: true, error: "", status: "Connecting to Python engine…", rowCache: {}, highlights: {}, restoring: false });
    try {
      await ensureSidecar();
      set({ status: "Opening…" });
      const r = await api.open(path, get().rowLimit);
      finishBasicFileImport(quota.reservation, true);
      set({ sessionId: r.session_id, view: "workspace" });
      get().rememberTab(r.session_id, path.split(/[/\\]/).pop() || r.session_id);
      setRestoreHint();
      await get().loadViewport(0);
      await get().refresh();
      set({ status: `Loaded ${r.rows.toLocaleString()} rows` });
      queueWorkspaceMeta();
      await get().autoCleanAll();
    } catch (e) {
      finishBasicFileImport(quota.reservation, false);
      set({ error: String(e), status: "Open failed" });
    } finally {
      set({ running: false });
    }
  },
  downloadCleaningReport: async () => {
    const sid = get().sessionId;
    if (!sid) {
      set({ error: "Open a dataset first, then File → Cleaning report." });
      return;
    }
    set({ status: "Building cleaning report…", error: "" });
    try {
      const r = (await api.downloadReport(sid, "cleaning-report.pdf")) as { path?: string };
      set({ status: r?.path ? `Cleaning report saved · ${r.path}` : "Cleaning report ready" });
    } catch (e) {
      set({ error: String(e), status: "Report failed" });
    }
  },
  openFile: async (file) => {
    const quota = beginBasicFileImport(useLicense.getState().snap);
    if (!quota.allowed) {
      set({ error: quota.reason || "Basic file import limit reached.", status: "Import unavailable" });
      return;
    }
    set({ running: true, error: "", status: "Connecting to Python engine…", rowCache: {}, highlights: {}, restoring: false });
    try {
      await ensureSidecar();
      set({ status: `Importing ${file.name}…` });
      const r = await api.upload(file, get().rowLimit);
      finishBasicFileImport(quota.reservation, true);
      set({ sessionId: r.session_id, view: "workspace" });
      get().rememberTab(r.session_id, file.name);
      setRestoreHint();
      await get().loadViewport(0);
      await get().refresh();
      set({ status: `Loaded ${r.rows.toLocaleString()} rows from ${file.name}` });
      queueWorkspaceMeta();
      await get().autoCleanAll();
    } catch (e) {
      finishBasicFileImport(quota.reservation, false);
      set({ error: String(e), status: "Import failed" });
    } finally {
      set({ running: false });
    }
  },
  openDatabase: async (kind, config, query) => {
    set({ running: true, error: "", status: `Connecting ${kind}…`, rowCache: {}, highlights: {}, restoring: false });
    try {
      const r = await api.database(kind, config, query, get().rowLimit);
      set({ sessionId: r.session_id, view: "workspace", connectOpen: false });
      get().rememberTab(r.session_id, `${kind} query`);
      setRestoreHint();
      await get().loadViewport(0);
      await get().refresh();
      set({ status: `Loaded ${r.rows.toLocaleString()} rows from ${kind}` });
      await get().autoCleanAll();
    } catch (e) {
      set({ error: String(e), status: "Connect failed" });
    } finally {
      set({ running: false });
    }
  },
  run: async (kind) => {
    const sid = get().sessionId;
    if (!sid) {
      set({ error: "Open a dataset first." });
      return;
    }
    set({ running: true, error: "", status: `Running ${kind}…` });
    try {
      const s = get();
      const uni = useUniversal.getState().payloads(s.libraryRules);
      const extras = resolveColumnRules(s.columnRules, s.libraryRules);
      const rules = [...uni, ...extras];
      let result: unknown;
      if (kind === "sql") result = await api.sql(sid, s.sql);
      else if (kind === "javascript") result = await api.javascript(sid, s.javascript);
      else if (kind === "python") result = await api.python(sid, s.python);
      else if (kind === "rules") {
        if (!rules.length) {
          set({ status: "No universal rules enabled. Open the Rules panel to turn some on.", running: false });
          return;
        }
        result = await api.rules(sid, rules);
      }
      else
        result = await api.pipeline(sid, {
          rules,
          sql: s.sql,
          javascript: s.javascript,
          python: s.python,
        });
      const pack = result as { highlights?: CellHighlight[]; changed?: number };
      if (pack.highlights?.length) get().mergeHighlights(pack.highlights);
      set({ rowCache: {} });
      await get().loadViewport(0);
      await get().refresh();
      const changed = pack.changed ?? get().metrics?.cells_cleaned ?? Object.keys(get().highlights).length;
      set({ status: changed ? `${kind} complete · ${changed.toLocaleString()} cells cleaned` : `${kind} complete` });
    } catch (e) {
      set({ error: String(e), status: `${kind} failed` });
    } finally {
      set({ running: false });
    }
  },
  undo: async () => {
    const sid = get().sessionId;
    if (!sid) return;
    set({ running: true, error: "", status: "Undo…" });
    try {
      await api.undo(sid);
      set({ rowCache: {}, highlights: {} });
      await get().loadViewport(0);
      await get().refresh();
      set({ status: "Undo" });
    } catch (e) {
      set({ error: String(e), status: "Undo failed" });
    } finally {
      set({ running: false });
    }
  },
  redo: async () => {
    const sid = get().sessionId;
    if (!sid) return;
    set({ running: true, error: "", status: "Redo…" });
    try {
      await api.redo(sid);
      set({ rowCache: {}, highlights: {} });
      await get().loadViewport(0);
      await get().refresh();
      set({ status: "Redo" });
    } catch (e) {
      set({ error: String(e), status: "Redo failed" });
    } finally {
      set({ running: false });
    }
  },
  restoreVersion: async (versionId) => {
    const sid = get().sessionId;
    if (!sid) return;
    set({ running: true, error: "", status: "Restoring snapshot…" });
    try {
      await api.restore(sid, versionId);
      set({ rowCache: {}, highlights: {} });
      await get().loadViewport(0);
      await get().refresh();
      set({ status: "Snapshot restored" });
    } catch (e) {
      set({ error: String(e), status: "Restore failed" });
    } finally {
      set({ running: false });
    }
  },
  stop: () => set({ running: false, status: "Stopped" }),
  edit: async (row, column, value) => {
    const sid = get().sessionId;
    if (!sid) return;
    const cols = get().columns;
    const cache = { ...get().rowCache };
    const rec = cache[row] ? [...cache[row]] : cols.map(() => null);
    const idx = cols.indexOf(column);
    if (idx >= 0) rec[idx] = value;
    cache[row] = rec;
    const highlights = { ...get().highlights, [`${row}:${column}`]: "manual" };
    set({ rowCache: cache, highlights });
    try {
      await api.edit(sid, row, column, value);
    } catch (e) {
      set({ error: String(e), status: "Edit failed" });
    }
  },
  searchReplace: async (find, replace, doReplace, regex) => {
    const sid = get().sessionId;
    if (!sid) return 0;
    const r = await api.search(sid, { find, replace, do_replace: doReplace, regex });
    if (doReplace) {
      const hl = (r as { highlights?: CellHighlight[] }).highlights;
      if (hl?.length) get().mergeHighlights(hl);
      set({ rowCache: {} });
      await get().loadViewport(0);
      await get().refresh();
    }
    return r.matches;
  },
}));
