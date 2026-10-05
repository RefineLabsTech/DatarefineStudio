import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Search } from "lucide-react";
import { useUI, type SidebarId } from "../store/ui";
import { useWorkspace } from "../store/workspace";
import { useAuth } from "../store/auth";
import { THEMES, extraThemes, type ThemeId } from "../theme/themes";
import { usePlugins } from "../store/plugins";

type Item = {
  id: string;
  title: string;
  hint: string;
  group: string;
  run: () => void;
};

export function CommandPalette() {
  const open = useUI((s) => s.paletteOpen);
  const setOpen = useUI((s) => s.setPaletteOpen);
  const { setSidebar, setTheme, setBottomTab, setBottomOpen, theme, openColumnDialog } = useUI(
    useShallow((s) => ({
      setSidebar: s.setSidebar,
      setTheme: s.setTheme,
      setBottomTab: s.setBottomTab,
      setBottomOpen: s.setBottomOpen,
      theme: s.theme,
      openColumnDialog: s.openColumnDialog,
    })),
  );
  const { run, sessionId, setExportOpen, setConnectOpen, setPushOpen, deleteColumns } = useWorkspace(
    useShallow((s) => ({
      run: s.run,
      sessionId: s.sessionId,
      setExportOpen: s.setExportOpen,
      setConnectOpen: s.setConnectOpen,
      setPushOpen: s.setPushOpen,
      deleteColumns: s.deleteColumns,
    })),
  );
  const setAuthOpen = useAuth((s) => s.setAuthOpen);
  const pluginUi = usePlugins((s) => s.ui);
  const runPlugin = usePlugins((s) => s.runCommand);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === "k" || e.key === "K" || e.key === "p" || e.key === "P")) {
        e.preventDefault();
        setOpen(!useUI.getState().paletteOpen);
      }
      if (e.key === "Escape" && useUI.getState().paletteOpen) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
      window.setTimeout(() => input.current?.focus(), 20);
    }
  }, [open]);

  const items = useMemo(() => {
    const go = (id: SidebarId) => () => setSidebar(id);
    const list: Item[] = [
      { id: "run.pipeline", title: "Run pipeline", hint: "Rules → SQL → JS → Python", group: "Run", run: () => void run("pipeline") },
      { id: "run.rules", title: "Run universal rules", hint: "Stage 1", group: "Run", run: () => void run("rules") },
      { id: "file.export", title: "Export cleaned data", hint: "CSV, Excel, Parquet…", group: "File", run: () => setExportOpen(true) },
      { id: "file.add-column", title: "Add column", hint: "Empty column on this sheet", group: "File", run: () => openColumnDialog() },
      { id: "file.delete-column", title: "Delete selected column", hint: "Confirm, then Undo restores", group: "File", run: () => void deleteColumns() },
      { id: "file.connect", title: "Connect database", hint: "Postgres, MySQL, SQLite…", group: "File", run: () => setConnectOpen(true) },
      { id: "file.push", title: "Push to database", hint: "Write the cleaned frame", group: "File", run: () => setPushOpen(true) },
      { id: "view.explorer", title: "Explorer", hint: "Fields and metrics", group: "View", run: go("explorer") },
      { id: "view.library", title: "Library", hint: "SQL, JS, Python, regex, schemas", group: "View", run: go("library") },
      { id: "view.rules", title: "Universal rules", hint: "Toggle, paste Python or JS", group: "View", run: go("rules") },
      { id: "view.ai", title: "AI pipeline", hint: "Detect → Plan → Preview → Apply", group: "View", run: go("ai") },
      { id: "view.extensions", title: "Extensions", hint: "Manage installed plugins", group: "View", run: go("extensions") },
      { id: "view.settings", title: "Settings", hint: "Theme, AI, connections", group: "View", run: go("settings") },
      { id: "auth.github", title: "GitHub account", hint: "Sign in / sign out", group: "Account", run: () => setAuthOpen(true) },
      { id: "editor.sql", title: "Open SQL editor", hint: "DuckDB", group: "Editors", run: () => { setBottomTab("sql"); setBottomOpen(true); } },
      { id: "editor.js", title: "Open JavaScript editor", hint: "V8", group: "Editors", run: () => { setBottomTab("javascript"); setBottomOpen(true); } },
      { id: "editor.py", title: "Open Python editor", hint: "Polars", group: "Editors", run: () => { setBottomTab("python"); setBottomOpen(true); } },
    ];
    (Object.keys(THEMES) as ThemeId[]).forEach((id) => {
      list.push({
        id: `theme.${id}`,
        title: `Theme: ${THEMES[id].label}`,
        hint: theme === id ? "Active" : THEMES[id].hint,
        group: "Themes",
        run: () => setTheme(id),
      });
    });
    extraThemes().forEach((t) => {
      list.push({
        id: `theme.${t.id}`,
        title: `Theme: ${t.label}`,
        hint: theme === t.id ? "Active · plugin" : t.hint,
        group: "Themes",
        run: () => setTheme(t.id),
      });
    });
    pluginUi.views
      .filter((v) => v?.id && v.sidebar !== false)
      .forEach((v) => {
        list.push({
          id: `view.plugin.${v.id}`,
          title: String(v.title || v.id),
          hint: String(v.extension || "plugin"),
          group: "Plugins",
          run: () => setSidebar(`plugin:${v.id}`),
        });
      });
    pluginUi.commands.forEach((cmd) => {
      list.push({
        id: cmd.id,
        title: String(cmd.title || cmd.id),
        hint: String(cmd.extension || "plugin"),
        group: "Plugins",
        run: () => void runPlugin(String(cmd.extension_id || ""), cmd.id),
      });
    });
    const needle = q.trim().toLowerCase();
    return needle ? list.filter((it) => `${it.title} ${it.hint} ${it.group}`.toLowerCase().includes(needle)) : list;
  }, [
    q,
    theme,
    run,
    setExportOpen,
    setConnectOpen,
    setPushOpen,
    setSidebar,
    setAuthOpen,
    setBottomTab,
    setBottomOpen,
    setTheme,
    pluginUi,
    runPlugin,
    deleteColumns,
    openColumnDialog,
  ]);

  useEffect(() => {
    setIdx(0);
  }, [q]);

  if (!open) return null;

  const runAt = (i: number) => {
    const it = items[i];
    if (!it) return;
    setOpen(false);
    it.run();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "rgba(6,8,12,0.55)",
        backdropFilter: "blur(8px)",
        display: "flex",
        justifyContent: "center",
        paddingTop: "12vh",
      }}
      onClick={() => setOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxWidth: "92vw",
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          borderRadius: 16,
          border: "1px solid var(--border)",
          background: "var(--bg-elev)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.45)",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <Search size={15} color="var(--text-dim)" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIdx((i) => Math.min(items.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIdx((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                runAt(idx);
              }
            }}
            placeholder={sessionId ? "Run a command…" : "Commands, views, themes…"}
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              color: "var(--text)",
              fontSize: 14,
            }}
          />
          <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "ui-monospace, monospace" }}>Esc</span>
        </div>
        <div style={{ overflow: "auto", padding: "6px 0" }}>
          {!items.length && <div style={{ padding: "16px 18px", fontSize: 12, color: "var(--text-dim)" }}>No matches.</div>}
          {items.map((it, i) => {
            const on = i === idx;
            const showGroup = i === 0 || items[i - 1].group !== it.group;
            return (
              <div key={it.id}>
                {showGroup && (
                  <div style={{ padding: "8px 16px 4px", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)" }}>
                    {it.group}
                  </div>
                )}
                <button
                  type="button"
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => runAt(i)}
                  style={{
                    display: "flex",
                    width: "100%",
                    textAlign: "left",
                    gap: 10,
                    padding: "8px 16px",
                    border: "none",
                    background: on ? "color-mix(in srgb, var(--accent) 16%, var(--bg))" : "transparent",
                    color: "var(--text)",
                  }}
                >
                  <span style={{ flex: 1, fontSize: 13 }}>{it.title}</span>
                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{it.hint}</span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
