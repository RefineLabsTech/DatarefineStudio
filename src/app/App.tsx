import { lazy, Suspense, useEffect, useState, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import { TitleBar } from "../components/TitleBar";
import { ActivityBar } from "../components/ActivityBar";
import { Sidebar } from "../components/Sidebar";
import { StatusBar } from "../components/StatusBar";
import { SplitSash } from "../components/SplitSash";
import { TabStrip } from "../components/TabStrip";
import { DataGrid } from "../grid/DataGrid";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { AddColumnDialog } from "../components/AddColumnDialog";
import { SaveRuleDialog } from "../components/SaveRuleDialog";
import { useUI } from "../store/ui";
import { useWorkspace } from "../store/workspace";
import { useAuth } from "../store/auth";
import { usePlugins } from "../store/plugins";
import { useUniversal } from "../store/universal";
import { api, ensureSidecar, sidecarRestart, sidecarStatus } from "../ipc/client";
import { useLicense } from "../store/license";
import { canUseFeature, PREMIUM_FEATURE } from "../license/features";

const ENGINE_READY_KEY = "drs.engineReady";

function engineWasReady() {
  try {
    return localStorage.getItem(ENGINE_READY_KEY) === "1";
  } catch {
    return false;
  }
}

function markEngineReady() {
  try {
    localStorage.setItem(ENGINE_READY_KEY, "1");
  } catch {
    /* ignore */
  }
}

const BottomEditors = lazy(() => import("../editors/BottomEditors").then((m) => ({ default: m.BottomEditors })));
const ConnectDialog = lazy(() => import("../components/ConnectDialog").then((m) => ({ default: m.ConnectDialog })));
const ExportDialog = lazy(() => import("../components/ExportDialog").then((m) => ({ default: m.ExportDialog })));
const PushDialog = lazy(() => import("../components/PushDialog").then((m) => ({ default: m.PushDialog })));
const AuthDialog = lazy(() => import("../components/AuthDialog").then((m) => ({ default: m.AuthDialog })));
const CommandPalette = lazy(() => import("../components/CommandPalette").then((m) => ({ default: m.CommandPalette })));
const PluginHost = lazy(() => import("../components/PluginHost").then((m) => ({ default: m.PluginHost })));

const shell: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100vh",
  width: "100vw",
  overflow: "hidden",
  background: "var(--bg, #0f1115)",
  color: "var(--text, #e8eaed)",
};

export function App() {
  const sidebar = useUI((s) => s.sidebar);
  const sidebarWidth = useUI((s) => s.sidebarWidth);
  const setSidebarWidth = useUI((s) => s.setSidebarWidth);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const setSidebar = useUI((s) => s.setSidebar);
  const bottomOpen = useUI((s) => s.bottomOpen);
  const bottomHeight = useUI((s) => s.bottomHeight);
  const setBottomHeight = useUI((s) => s.setBottomHeight);
  const setBottomOpen = useUI((s) => s.setBottomOpen);
  const stripOpen = useUI((s) => s.stripOpen);
  const setStripOpen = useUI((s) => s.setStripOpen);
  const { status, total, columns, metrics, sessionId, refreshLibrary } = useWorkspace(
    useShallow((s) => ({
      status: s.status,
      total: s.total,
      columns: s.columns,
      metrics: s.metrics,
      sessionId: s.sessionId,
      refreshLibrary: s.refreshLibrary,
    })),
  );
  const refreshAuth = useAuth((s) => s.refresh);
  const refreshPlugins = usePlugins((s) => s.refresh);
  const loadUniversal = useUniversal((s) => s.load);
  const license = useLicense((s) => s.snap);
  const pluginsAllowed = canUseFeature(license, PREMIUM_FEATURE.installedPlugins);
  const [engine, setEngine] = useState<"quiet" | "starting" | "up" | "down">("quiet");
  const [engineHint, setEngineHint] = useState("");
  const [engineBusy, setEngineBusy] = useState(false);

  useEffect(() => {
    if (pluginsAllowed) {
      void refreshPlugins();
      return;
    }
    usePlugins.setState({
      plugins: [],
      ui: { commands: [], themes: [], statusBar: [], snippets: [], views: [], exporters: [], ingest: [], aiSteps: [], aiPrompts: {} },
    });
  }, [pluginsAllowed, refreshPlugins]);

  useEffect(() => {
    let cancelled = false;
    const started = Date.now();
    let extras = false;
    let timer = 0;
    let extrasTimer = 0;

    const ping = async () => {
      try {
        const st = await sidecarStatus();
        if (st?.error && !st.running) setEngineHint(st.error);
        await api.health();
        if (cancelled) return true;
        markEngineReady();
        setEngine("up");
        setEngineHint("");
        if (!extras) {
          extras = true;
          // Health is the critical first paint. Defer the non-critical library,
          // plugin, auth, and restore reads by one task so the shell and the
          // first user click are responsive while the engine warms up.
          extrasTimer = window.setTimeout(() => {
            if (cancelled) return;
            void Promise.allSettled([
              refreshLibrary(),
              pluginsAllowed ? refreshPlugins() : Promise.resolve(),
              refreshAuth(),
              loadUniversal(),
              useWorkspace.getState().probeRestore(),
              useWorkspace.getState().resumeLast(),
            ]);
          }, 160);
        }
        return true;
      } catch {
        if (cancelled) return false;
        const ms = Date.now() - started;
        if (ms >= 25000) {
          setEngine("down");
          useWorkspace.getState().setRestoring(false);
        }
        else if (!engineWasReady() && ms > 400) setEngine("starting");
        return false;
      }
    };

    const loop = async () => {
      const up = await ping();
      if (cancelled) return;
      timer = window.setTimeout(() => void loop(), up ? 4000 : 1000);
    };
    void loop();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.clearTimeout(extrasTimer);
    };
  }, []);

  return (
    <div style={shell}>
      <TitleBar />
      {(engine === "starting" || engine === "down") && (
        <div
          style={{
            flexShrink: 0,
            fontSize: 12,
            padding: "8px 16px",
            background: engine === "starting" ? "#92400e" : "#b91c1c",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span style={{ flex: 1, lineHeight: 1.45 }}>
            {engine === "starting"
              ? "First launch — installing Python packages. This only happens once."
              : engineHint ||
                "Python engine is not running. Install Python 3.11–3.13 (not 3.14) from python.org, tick “Add python.exe to PATH”, then run setup.bat"}
          </span>
          {engine === "down" && (
            <button
              type="button"
              disabled={engineBusy}
              onClick={async () => {
                setEngineBusy(true);
                if (!engineWasReady()) setEngine("starting");
                try {
                  await sidecarRestart();
                  await ensureSidecar();
                  markEngineReady();
                  setEngine("up");
                  setEngineHint("");
                  void useWorkspace.getState().resumeLast();
                } catch (e) {
                  setEngine("down");
                  useWorkspace.getState().setRestoring(false);
                  setEngineHint(String(e).replace(/^Error:\s*/, ""));
                } finally {
                  setEngineBusy(false);
                }
              }}
              style={{
                flexShrink: 0,
                padding: "5px 12px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,.55)",
                background: "transparent",
                color: "#fff",
                fontSize: 12,
                fontWeight: 600,
                opacity: engineBusy ? 0.6 : 1,
              }}
            >
              {engineBusy ? "Starting…" : "Retry"}
            </button>
          )}
        </div>
      )}
      <div style={{ display: "flex", flex: 1, minHeight: 0, minWidth: 0 }}>
        <ActivityBar />
        {sidebar ? (
          <div
            style={{
              width: sidebarWidth,
              flexShrink: 0,
              display: "flex",
              minWidth: 0,
              minHeight: 0,
            }}
          >
            <div
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                overflow: "hidden",
                margin: 0,
                borderRadius: 0,
                border: "none",
                borderRight: "1px solid var(--border)",
                background: "var(--bg-elev)",
              }}
            >
              <Sidebar />
            </div>
            <SplitSash
              axis="x"
              onDrag={(d) => {
                const next = sidebarWidth + d;
                if (next < 168) setSidebar(null);
                else setSidebarWidth(next);
              }}
              onToggle={() => toggleSidebar(sidebar)}
            />
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflow: "hidden",
            padding: sidebar ? "8px 12px 0 8px" : "8px 12px 0 4px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              height: stripOpen ? 40 : 22,
              flexShrink: 0,
              padding: stripOpen ? "0 14px" : "0 10px",
              marginBottom: 8,
              borderRadius: 10,
              background: "var(--bg-elev)",
              border: "1px solid var(--border)",
              fontSize: 12,
              gap: 10,
            }}
          >
            <button
              title={stripOpen ? "Collapse status strip" : "Expand status strip"}
              onClick={() => setStripOpen(!stripOpen)}
              style={{
                border: "none",
                background: "var(--bg-input)",
                color: "var(--text)",
                fontWeight: 600,
                padding: stripOpen ? "4px 10px" : "2px 8px",
                borderRadius: 8,
                fontSize: 12,
              }}
            >
              {sessionId ? "Workspace" : "Welcome"}
            </button>
            {stripOpen && (
              <>
                <span style={{ color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {status}
                </span>
                <div style={{ flex: 1 }} />
                {sessionId && (
                  <span style={{ color: "var(--text-dim)" }}>
                    {total.toLocaleString()} × {columns.length}
                    {metrics ? ` · health ${metrics.health.toFixed(0)}` : ""}
                  </span>
                )}
              </>
            )}
            {!stripOpen && <div style={{ flex: 1 }} />}
          </div>
          <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <TabStrip />
            <div
              style={{
                flex: 1,
                minWidth: 0,
                position: "relative",
                borderRadius: 12,
                overflow: "hidden",
                border: "1px solid var(--border)",
                background: "var(--bg-elev)",
              }}
            >
              <DataGrid />
            </div>
          </div>
          <SplitSash
            axis="y"
            onDrag={(d) => {
              const next = (bottomOpen ? bottomHeight : 36) - d;
              if (next < 72) setBottomOpen(false);
              else setBottomHeight(next);
            }}
            onToggle={() => setBottomOpen(!bottomOpen)}
          />
          <div
            className={bottomOpen ? "drs-bottom-shell" : "drs-bottom-shell is-collapsed"}
            style={{ height: bottomOpen ? bottomHeight : 36 }}
          >
            <Suspense fallback={null}>
              <BottomEditors />
            </Suspense>
          </div>
        </div>
      </div>
      <StatusBar />
      <Suspense fallback={null}>
        <ConnectDialog />
        <ExportDialog />
        <PushDialog />
        <AuthDialog />
        <CommandPalette />
        <PluginHost />
      </Suspense>
      <div id="portal" style={{ position: "fixed", left: 0, top: 0, zIndex: 9999 }} />
      <SaveRuleDialog />
      <ConfirmDialog />
      <AddColumnDialog />
    </div>
  );
}
