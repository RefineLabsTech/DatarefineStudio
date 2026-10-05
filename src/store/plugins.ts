import { create } from "zustand";
import { api, type PluginRec, type PluginUI, type PluginCommandError, type PluginCommandResult } from "../ipc/client";
import { applyTheme, registerExtraThemes, type ExtraTheme } from "../theme/themes";
import { useUI } from "./ui";
import { setPluginSnippets } from "../editors/intellisense";
import { useWorkspace } from "./workspace";
import { isPluginSidebar, pluginSidebarId } from "../lib/pluginIcons";

type State = {
  plugins: PluginRec[];
  ui: PluginUI;
  activeView: { id: string; title: string; body: string } | null;
  error: string;
  refresh: () => Promise<void>;
  setEnabled: (id: string, enabled: boolean, trust?: boolean) => Promise<void>;
  unload: (id: string) => Promise<void>;
  installFile: (file: File) => Promise<void>;
  installPath: (path: string) => Promise<void>;
  runCommand: (pluginId: string, commandId: string, extra?: Record<string, unknown>) => Promise<PluginCommandResult>;
  openView: (id: string) => void;
  closeView: () => void;
};

const EMPTY_UI: PluginUI = {
  commands: [],
  themes: [],
  statusBar: [],
  snippets: [],
  views: [],
  exporters: [],
  ingest: [],
  aiSteps: [],
  aiPrompts: {},
};

function dropStaleSidebar(ui: PluginUI, plugins: PluginRec[]) {
  try {
    const cur = useUI.getState().sidebar;
    if (!isPluginSidebar(cur)) return;
    const live = new Set(
      (ui.views || [])
        .filter((v) => v && v.id && v.sidebar !== false)
        .map((v) => pluginSidebarId(String(v.id))),
    );
    if (live.has(String(cur))) return;

    // `/plugins` and `/plugins/ui` are separate reads. During startup or an
    // install, the UI read can briefly be empty while the installed plugin is
    // already present. Keep the user's sidebar in that case; close it only
    // when a successful refresh also proves that the owning plugin is gone or
    // disabled.
    if (!ui.views?.length) {
      const previous = usePlugins.getState().ui.views || [];
      const previousView = previous.find((v) => pluginSidebarId(String(v.id)) === String(cur));
      const owner = previousView?.extension_id ? String(previousView.extension_id) : "";
      const stillEnabled = owner && plugins.some((p) => p.id === owner && p.enabled !== false);
      if (stillEnabled) return;
    }
    useUI.getState().setSidebar("explorer");
  } catch {
    /* ignore */
  }
}

let refreshSequence = 0;

function applyUi(ui: PluginUI) {
  const themes: ExtraTheme[] = (ui.themes || []).map((t) => ({
    id: String(t.id),
    label: String(t.label || t.id),
    hint: String(t.hint || "Plugin theme"),
    monaco: t.monaco === "vs" ? "vs" : "vs-dark",
    swatches: Array.isArray(t.swatches) ? (t.swatches as [string, string, string]) : undefined,
    colors: (t.colors as Record<string, string>) || undefined,
    grid: t.grid as ExtraTheme["grid"],
  }));
  registerExtraThemes(themes);
  const style = document.getElementById("drs-plugin-themes") || document.createElement("style");
  style.id = "drs-plugin-themes";
  style.textContent = themes
    .map((t) => {
      const vars = Object.entries(t.colors || {})
        .map(([k, v]) => `--${k.replace(/^--/, "")}: ${v};`)
        .join(" ");
      return vars ? `[data-theme="${t.id}"] { ${vars} }` : "";
    })
    .filter(Boolean)
    .join("\n");
  if (!style.parentNode) document.head.appendChild(style);
  setPluginSnippets(
    (ui.snippets || []).map((s) => ({
      language: String(s.language || "python"),
      label: String(s.label || "plugin snippet"),
      insertText: String(s.insertText || ""),
      detail: String(s.detail || s.extension || "plugin"),
    })),
  );
  try {
    applyTheme(useUI.getState().theme);
  } catch {
    /* ignore */
  }
}

export const usePlugins = create<State>((set, get) => ({
  plugins: [],
  ui: EMPTY_UI,
  activeView: null,
  error: "",
  refresh: async () => {
    const sequence = ++refreshSequence;
    try {
      const [plugins, ui] = await Promise.all([api.plugins(), api.pluginUi()]);
      // Startup discovery and an install-triggered refresh can overlap. Do not
      // let an older, slower response replace a newer plugin UI and close the
      // sidebar the user just opened.
      if (sequence !== refreshSequence) return;
      const nextPlugins = plugins || [];
      const nextUi = ui || EMPTY_UI;
      applyUi(nextUi);
      dropStaleSidebar(nextUi, nextPlugins);
      set({ plugins: nextPlugins, ui: nextUi, error: "" });
    } catch (e) {
      if (sequence !== refreshSequence) return;
      // A transient sidecar failure must not turn a valid plugin catalogue into
      // an empty one. Keep the last known views/sidebar until a successful
      // refresh proves that a plugin was actually removed or disabled.
      set({ error: String(e) });
    }
  },
  setEnabled: async (id, enabled, trust = false) => {
    set({ error: "" });
    try {
      await api.pluginEnable(id, enabled, trust);
      await get().refresh();
      await useWorkspace.getState().refreshLibrary();
    } catch (e) {
      set({ error: String(e) });
    }
  },
  unload: async (id) => {
    set({ error: "" });
    try {
      await api.pluginUnload(id);
      await get().refresh();
      await useWorkspace.getState().refreshLibrary();
    } catch (e) {
      set({ error: String(e) });
    }
  },
  installFile: async (file) => {
    set({ error: "" });
    try {
      await api.pluginInstallFile(file);
      await get().refresh();
      await useWorkspace.getState().refreshLibrary();
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },
  installPath: async (path) => {
    set({ error: "" });
    try {
      await api.pluginInstallPath(path);
      await get().refresh();
      await useWorkspace.getState().refreshLibrary();
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },
  runCommand: async (pluginId, commandId, extra = {}) => {
    const cmd = get().ui.commands.find((c) => c.id === commandId && (c.extension_id === pluginId || !pluginId));
    const hit = cmd || get().ui.commands.find((c) => c.id === commandId);
    if (hit?.view) {
      get().openView(String(hit.view));
      return {};
    }
    if (hit?.theme) {
      useUI.getState().setTheme(String(hit.theme));
      return {};
    }
    const sid = useWorkspace.getState().sessionId;
    if (!hit?.python) {
      if (hit) get().openView(String(hit.view || commandId));
      return {};
    }
    const result = (await api.pluginCommand(sid, pluginId || String(hit.extension_id || ""), commandId, extra)) as PluginCommandResult;
    if (result.ok === false || result.error) {
      const failure = result.error || {
        type: "plugin_error",
        message: "Plugin command failed.",
        details: "The plugin returned an unsuccessful result.",
      };
      const error = new Error(failure.message || "Plugin command failed.") as Error & {
        pluginError?: PluginCommandError;
      };
      error.pluginError = failure;
      // Plugin failures belong to the originating command. Do not write them
      // to the shared workspace error/status fields, which are consumed by
      // unrelated views such as Universal Rules.
      throw error;
    }
    const n = result.changed ?? 0;
    if (n > 0) {
      if (result.highlights?.length) useWorkspace.getState().mergeHighlights(result.highlights);
      useWorkspace.setState({ rowCache: {} });
      await useWorkspace.getState().loadViewport(0);
      await useWorkspace.getState().refresh();
    }
    const output = String(result.output || result.message || "").trim();
    useWorkspace.setState({
      error: "",
      status: n ? `Plugin · ${n.toLocaleString()} cells` : output ? output.split("\n").slice(-1)[0] : "Plugin command complete",
    });
    return { ok: true, output, message: result.message, changed: n };
  },
  openView: (id) => {
    const v = get().ui.views.find((x) => x.id === id);
    if (v && v.sidebar !== false) {
      useUI.getState().setSidebar(pluginSidebarId(String(v.id)));
      set({ activeView: null });
      return;
    }
    if (!v) {
      set({ activeView: { id, title: id, body: "No view body." } });
      return;
    }
    set({ activeView: { id: String(v.id), title: String(v.title || v.id), body: String(v.body || "") } });
  },
  closeView: () => set({ activeView: null }),
}));
