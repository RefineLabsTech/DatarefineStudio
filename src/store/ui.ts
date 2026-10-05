import { create } from "zustand";
import { applyTheme, loadTheme, type ThemeKey } from "../theme/themes";

export type BuiltinSidebar = "explorer" | "search" | "library" | "rules" | "ai" | "lineage" | "versions" | "sessions" | "marketplace" | "extensions" | "settings";

export type RuleDialogDraft = {
  name?: string;
  description?: string;
  category?: string;
  language: "sql" | "javascript" | "python";
  body: string;
  destination?: "library" | "universal";
};
export type SidebarId = BuiltinSidebar | string;
export type BottomTab = "sql" | "javascript" | "python" | "console" | "terminal" | "aiplan" | "history";

function loadBool(key: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(key);
    if (v === "1" || v === "true") return true;
    if (v === "0" || v === "false") return false;
  } catch {
    /* ignore */
  }
  return fallback;
}

function saveBool(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export type ConfirmSpec = {
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

function loadNum(key: string, fallback: number) {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

function saveNum(key: string, n: number) {
  try {
    localStorage.setItem(key, String(n));
  } catch {
    /* ignore */
  }
}

type UI = {
  theme: ThemeKey;
  setTheme: (t: ThemeKey) => void;
  sidebar: SidebarId | null;
  toggleSidebar: (id: SidebarId) => void;
  setSidebar: (id: SidebarId | null) => void;
  sidebarWidth: number;
  setSidebarWidth: (w: number) => void;
  bottomOpen: boolean;
  setBottomOpen: (v: boolean) => void;
  bottomHeight: number;
  setBottomHeight: (h: number) => void;
  bottomTab: BottomTab;
  setBottomTab: (t: BottomTab) => void;
  stripOpen: boolean;
  setStripOpen: (v: boolean) => void;
  metricsOpen: boolean;
  setMetricsOpen: (v: boolean) => void;
  metricsHeight: number;
  setMetricsHeight: (h: number) => void;
  hiddenCols: string[];
  toggleHidden: (col: string) => void;
  showAllCols: () => void;
  forgetColumns: (cols: string[]) => void;
  colWidths: Record<string, number>;
  setColWidth: (col: string, w: number) => void;
  expandedFields: string[];
  toggleField: (col: string) => void;
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
  confirm: ConfirmSpec | null;
  askConfirm: (spec: ConfirmSpec) => Promise<boolean>;
  answerConfirm: (ok: boolean) => void;
  _confirmResolve: ((ok: boolean) => void) | null;
  columnDialog: { after?: string } | null;
  openColumnDialog: (spec?: { after?: string }) => void;
  closeColumnDialog: () => void;
  terminalEnabled: boolean;
  setTerminalEnabled: (v: boolean) => void;
  ruleDialog: RuleDialogDraft | null;
  openRuleDialog: (d: RuleDialogDraft) => void;
  closeRuleDialog: () => void;
};

export const useUI = create<UI>((set, get) => ({
  theme: loadTheme(),
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
  sidebar: "explorer",
  toggleSidebar: (id) => set({ sidebar: get().sidebar === id ? null : id }),
  setSidebar: (sidebar) => set({ sidebar }),
  sidebarWidth: loadNum("drs.sidebarWidth", 320),
  setSidebarWidth: (w) => {
    const sidebarWidth = Math.max(200, Math.min(520, Math.round(w)));
    saveNum("drs.sidebarWidth", sidebarWidth);
    set({ sidebarWidth });
  },
  bottomOpen: true,
  setBottomOpen: (bottomOpen) => set({ bottomOpen }),
  bottomHeight: loadNum("drs.bottomHeight", 260),
  setBottomHeight: (h) => {
    const bottomHeight = Math.max(120, Math.min(560, Math.round(h)));
    saveNum("drs.bottomHeight", bottomHeight);
    set({ bottomHeight, bottomOpen: true });
  },
  bottomTab: "sql",
  setBottomTab: (bottomTab) => set({ bottomTab, bottomOpen: true }),
  stripOpen: true,
  setStripOpen: (stripOpen) => set({ stripOpen }),
  metricsOpen: true,
  setMetricsOpen: (metricsOpen) => set({ metricsOpen }),
  metricsHeight: loadNum("drs.metricsHeight", 220),
  setMetricsHeight: (h) => {
    const metricsHeight = Math.max(120, Math.min(420, Math.round(h)));
    saveNum("drs.metricsHeight", metricsHeight);
    set({ metricsHeight, metricsOpen: true });
  },
  hiddenCols: [],
  toggleHidden: (col) => {
    const cur = get().hiddenCols;
    set({ hiddenCols: cur.includes(col) ? cur.filter((c) => c !== col) : [...cur, col] });
  },
  showAllCols: () => set({ hiddenCols: [] }),
  forgetColumns: (cols) => {
    const drop = new Set(cols);
    const colWidths = { ...get().colWidths };
    for (const c of cols) delete colWidths[c];
    set({
      hiddenCols: get().hiddenCols.filter((c) => !drop.has(c)),
      expandedFields: get().expandedFields.filter((c) => !drop.has(c)),
      colWidths,
    });
  },
  colWidths: {},
  setColWidth: (col, w) => set({ colWidths: { ...get().colWidths, [col]: Math.max(64, w) } }),
  expandedFields: [],
  toggleField: (col) => {
    const cur = get().expandedFields;
    set({ expandedFields: cur.includes(col) ? cur.filter((c) => c !== col) : [...cur, col] });
  },
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  confirm: null,
  _confirmResolve: null,
  askConfirm: (spec) =>
    new Promise<boolean>((resolve) => {
      get()._confirmResolve?.(false);
      set({ confirm: spec, _confirmResolve: resolve });
    }),
  answerConfirm: (ok) => {
    const resolve = get()._confirmResolve;
    set({ confirm: null, _confirmResolve: null });
    resolve?.(ok);
  },
  columnDialog: null,
  openColumnDialog: (spec) => set({ columnDialog: spec || {} }),
  closeColumnDialog: () => set({ columnDialog: null }),
  ruleDialog: null,
  openRuleDialog: (ruleDialog) => set({ ruleDialog }),
  closeRuleDialog: () => set({ ruleDialog: null }),
  terminalEnabled: loadBool("drs.terminal", true),
  setTerminalEnabled: (terminalEnabled) => {
    saveBool("drs.terminal", terminalEnabled);
    const patch: Partial<UI> = { terminalEnabled };
    if (!terminalEnabled && get().bottomTab === "terminal") patch.bottomTab = "console";
    set(patch);
  },
}));
