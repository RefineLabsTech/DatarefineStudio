import { Database, Download, FileUp, Github, Play, Redo2, RefreshCw, Square, Undo2, Upload } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { InputModal } from "./Modal";
import { useWorkspace } from "../store/workspace";
import { THEMES, extraThemes, type ThemeId } from "../theme/themes";
import { usePlugins } from "../store/plugins";
import { useUI } from "../store/ui";
import { useAuth } from "../store/auth";
import { api, winClose, winMinimize, winToggleMaximize } from "../ipc/client";
import { nativeUpdateDownload } from "../license/native";
import { useLicense } from "../store/license";
import { basicImportRowLimit, canUseFeature, PREMIUM_FEATURE } from "../license/features";
import { basicFileImportMessage, basicFileImportStatus } from "../license/importQuota";

const LIMITS = [5000, 10000, 50000, 100000, 500000, 1000000, 0];

export function TitleBar() {
  const input = useRef<HTMLInputElement>(null);
  const { openFile, openPath, run, running, rowLimit, setRowLimit, sessionId, setConnectOpen, setExportOpen, setPushOpen, undo, redo, stop, highlights, downloadCleaningReport, deleteColumns } =
    useWorkspace(
      useShallow((s) => ({
        openFile: s.openFile,
        openPath: s.openPath,
        run: s.run,
        running: s.running,
        rowLimit: s.rowLimit,
        setRowLimit: s.setRowLimit,
        sessionId: s.sessionId,
        setConnectOpen: s.setConnectOpen,
        setExportOpen: s.setExportOpen,
        setPushOpen: s.setPushOpen,
        undo: s.undo,
        redo: s.redo,
        stop: s.stop,
        highlights: s.highlights,
        downloadCleaningReport: s.downloadCleaningReport,
        deleteColumns: s.deleteColumns,
      })),
    );
  const [recents, setRecents] = useState<Array<{ path: string; opened_at: string }>>([]);
  const [customLimitOpen, setCustomLimitOpen] = useState(false);
  const openColumnDialog = useUI((s) => s.openColumnDialog);
  const { theme, setTheme, setPaletteOpen } = useUI(
    useShallow((s) => ({ theme: s.theme, setTheme: s.setTheme, setPaletteOpen: s.setPaletteOpen })),
  );
  const { account, setAuthOpen } = useAuth(
    useShallow((s) => ({ account: s.account, setAuthOpen: s.setAuthOpen })),
  );
  const license = useLicense((s) => s.snap);
  const update = license?.update;
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState("");
  const ingest = usePlugins((s) => s.ui.ingest);
  const extraExt = ingest
    .flatMap((i) => i.extensions || [])
    .map((e) => (String(e).startsWith(".") ? String(e) : `.${e}`))
    .join(",");
  const modified = Object.keys(highlights).length;
  const [menu, setMenu] = useState<string | null>(null);
  const connectAllowed = canUseFeature(license, PREMIUM_FEATURE.connectDb);
  const pushAllowed = canUseFeature(license, PREMIUM_FEATURE.push);
  const importLargeAllowed = canUseFeature(license, PREMIUM_FEATURE.importLarge);
  const exportNonCsvAllowed = canUseFeature(license, PREMIUM_FEATURE.exportNonCsv);
  const importLimit = basicImportRowLimit(license);
  const availableLimits = importLargeAllowed ? LIMITS : [importLimit];
  const fileImportQuota = basicFileImportStatus(license);
  const fileImportAllowed = !fileImportQuota.limited || (fileImportQuota.storageAvailable && fileImportQuota.remaining > 0);
  const fileImportTitle = fileImportQuota.limited ? basicFileImportMessage(license) : undefined;
  useEffect(() => {
    if (!importLargeAllowed && (rowLimit <= 0 || rowLimit > importLimit)) setRowLimit(importLimit);
  }, [importLargeAllowed, importLimit, rowLimit, setRowLimit]);
  useEffect(() => {
    if (menu !== "file") return;
    let on = true;
    api
      .recents()
      .then((r) => on && setRecents(r))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [menu]);

  const installUpdate = async () => {
    if (!update || updateBusy) return;
    setUpdateBusy(true);
    setUpdateError("");
    try {
      await nativeUpdateDownload();
    } catch (e) {
      setUpdateError(String((e as Error)?.message || e));
    } finally {
      setUpdateBusy(false);
    }
  };

  return (
    <div
      className="drs-titlebar"
      data-tauri-drag-region
      onDoubleClick={() => void winToggleMaximize()}
      style={{
        height: 44,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 0 0 12px",
        fontSize: 13,
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-elev)",
        color: "var(--text)",
        userSelect: "none",
      }}
    >
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
          display: "grid",
          placeItems: "center",
          color: "#fff",
          fontSize: 11,
          fontWeight: 700,
        }}
      >
        D
      </div>
      <span style={{ fontWeight: 650, letterSpacing: "-0.02em", marginRight: 4 }}>DataRefine</span>
      <MenuBar open={menu} setOpen={setMenu}>
        <Menu id="file" label="File">
          <Item disabled={!fileImportAllowed} onClick={() => fileImportAllowed && input.current?.click()}>
            Import file{!fileImportAllowed ? " · Basic limit reached" : ""}
          </Item>
          {menu === "file" &&
            recents.slice(0, 8).map((r) => (
              <Item key={r.path} disabled={!fileImportAllowed} onClick={() => fileImportAllowed && void openPath(r.path)}>
                ↳ {r.path.split(/[/\\]/).pop()}
              </Item>
            ))}
          <Item disabled={!connectAllowed} onClick={() => connectAllowed && setConnectOpen(true)}>Connect database{!connectAllowed ? " · Professional" : ""}</Item>
          <Item onClick={() => sessionId && setExportOpen(true)}>Export{!exportNonCsvAllowed ? " · CSV only" : ""}</Item>
          <Item disabled={!pushAllowed} onClick={() => pushAllowed && sessionId && setPushOpen(true)}>Push to database{!pushAllowed ? " · Professional" : ""}</Item>
          <Item disabled={!exportNonCsvAllowed} onClick={() => exportNonCsvAllowed && void downloadCleaningReport()}>Cleaning report (PDF){!exportNonCsvAllowed ? " · Professional" : ""}</Item>
          <Item onClick={() => sessionId && openColumnDialog()}>Add column</Item>
          <Item onClick={() => sessionId && void deleteColumns()}>Delete column</Item>
          <Item onClick={() => setAuthOpen(true)}>{account.signed_in ? "GitHub account" : "Sign in with GitHub"}</Item>
        </Menu>
        <Menu id="view" label="View">
          <Item onClick={() => setPaletteOpen(true)}>Command palette (Ctrl+K)</Item>
          {(Object.keys(THEMES) as ThemeId[]).map((id) => (
            <Item key={id} onClick={() => setTheme(id)}>
              {theme === id ? "● " : "○ "}
              {THEMES[id].label}
            </Item>
          ))}
          {extraThemes().map((t) => (
            <Item key={t.id} onClick={() => setTheme(t.id)}>
              {theme === t.id ? "● " : "○ "}
              {t.label}
            </Item>
          ))}
        </Menu>
        <Menu id="run" label="Run">
          <Item onClick={() => void run("pipeline")}>Run pipeline</Item>
          <Item onClick={() => void run("rules")}>Stage 1 · Rules</Item>
          <Item onClick={() => void run("sql")}>Stage 2 · SQL</Item>
        </Menu>
      </MenuBar>
      <input
        ref={input}
        type="file"
        className="hidden"
        accept=".csv,.tsv,.xlsx,.xls,.json,.parquet,.feather,.arrow,.ipc,.psv,.md"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void openFile(f);
          e.target.value = "";
        }}
      />
      <div style={{ width: 1, height: 18, background: "var(--border)", margin: "0 4px" }} />
      <Pill disabled={!fileImportAllowed} title={fileImportTitle} onClick={() => fileImportAllowed && input.current?.click()}>
        <FileUp size={14} /> Import
      </Pill>
      {fileImportQuota.limited && (
        <span title={fileImportTitle} style={{ fontSize: 10, color: fileImportAllowed ? "var(--text-dim)" : "var(--danger)" }}>
          {fileImportQuota.remaining}/{fileImportQuota.limit} imports
        </span>
      )}
      <Pill disabled={!connectAllowed} title={!connectAllowed ? "Connect database is a Professional feature" : undefined} onClick={() => connectAllowed && setConnectOpen(true)}>
        <Database size={14} /> Connect
      </Pill>
      <Pill disabled={!pushAllowed} title={!pushAllowed ? "Push is a Professional feature" : undefined} onClick={() => pushAllowed && sessionId && setPushOpen(true)}>
        <Upload size={14} /> Push
      </Pill>
      <select
        className="field"
        style={{ width: "auto", padding: "4px 8px", fontSize: 11 }}
        value={importLargeAllowed ? rowLimit : importLimit}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "custom") {
            setCustomLimitOpen(true);
            return;
          }
          setRowLimit(importLargeAllowed ? Number(v) : Math.min(Number(v), importLimit));
        }}
      >
        {availableLimits.map((n) => (
          <option key={n} value={n}>
            {n === 0 ? "All rows" : `${n.toLocaleString()} rows`}
          </option>
        ))}
        {!LIMITS.includes(rowLimit) && (
          <option key="current-custom" value={rowLimit}>
            {rowLimit.toLocaleString()} rows (custom)
          </option>
        )}
        <option value="custom">Custom…</option>
      </select>
      {customLimitOpen && (
        <InputModal
          title="Custom row limit"
          numeric
          initial={rowLimit > 0 ? String(rowLimit) : ""}
          placeholder="e.g. 250000"
          submitLabel="Set limit"
          hint={importLargeAllowed ? "How many rows to load on the next import or open. Any whole number from 1 up — lakhs welcome." : `Basic mode allows up to ${importLimit.toLocaleString()} rows per import.`}
          onClose={() => setCustomLimitOpen(false)}
          onSubmit={(v) => {
            const n = Math.floor(Number(v));
            if (Number.isFinite(n) && n >= 1) setRowLimit(importLargeAllowed ? n : Math.min(n, importLimit));
            setCustomLimitOpen(false);
          }}
        />
      )}
      <button
        disabled={running || !sessionId}
        onClick={() => void run("pipeline")}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 12px",
          border: "none",
          borderRadius: 8,
          background: "var(--accent)",
          color: "#fff",
          fontWeight: 600,
          fontSize: 12,
          opacity: running || !sessionId ? 0.4 : 1,
        }}
      >
        <Play size={13} /> Run pipeline
      </button>
      <IconBtn title="Stop" onClick={() => stop()}>
        <Square size={14} />
      </IconBtn>
      <IconBtn title="Undo" onClick={() => sessionId && void undo()}>
        <Undo2 size={14} />
      </IconBtn>
      <IconBtn title="Redo" onClick={() => sessionId && void redo()}>
        <Redo2 size={14} />
      </IconBtn>
      <IconBtn title="Export" onClick={() => sessionId && setExportOpen(true)}>
        <Download size={14} />
      </IconBtn>
      <div style={{ flex: 1 }} />
      {modified > 0 && (
        <span
          title={`${modified.toLocaleString()} modified cells`}
          style={{
            padding: "4px 10px",
            borderRadius: 99,
            background: "color-mix(in srgb, var(--ok) 32%, var(--bg-elev))",
            color: "var(--text)",
            fontSize: 11,
            fontWeight: 650,
            whiteSpace: "nowrap",
            border: "1px solid color-mix(in srgb, var(--ok) 45%, var(--border))",
          }}
        >
          {modified.toLocaleString()} modified
        </span>
      )}
      {update && (
        <button
          type="button"
          disabled={updateBusy}
          aria-busy={updateBusy}
          title={updateError || `Update DataRefine Studio to v${update.latest || update.minimum}`}
          aria-label={updateError || `Update DataRefine Studio to v${update.latest || update.minimum}`}
          onClick={() => void installUpdate()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 10px",
            borderRadius: 8,
            border: "1px solid color-mix(in srgb, var(--accent) 70%, var(--border))",
            background: "color-mix(in srgb, var(--accent) 18%, var(--bg-elev))",
            color: "var(--text)",
            fontSize: 11,
            fontWeight: 700,
            whiteSpace: "nowrap",
            opacity: updateBusy ? 0.65 : 1,
          }}
        >
          <RefreshCw size={13} style={{ animation: updateBusy ? "drs-update-spin 1s linear infinite" : undefined }} />
          {updateBusy ? "Updating…" : updateError ? "Retry update" : "Update"}
        </button>
      )}
      <button
        type="button"
        title={account.user ? `GitHub: ${account.user.login}` : "Sign in with GitHub"}
        onClick={() => setAuthOpen(true)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: account.user ? "3px 8px 3px 3px" : "6px 10px",
          borderRadius: 99,
          border: "1px solid var(--border)",
          background: "transparent",
          color: "var(--text)",
          fontSize: 12,
        }}
      >
        {account.user?.avatar_url ? (
          <img src={account.user.avatar_url} alt="" width={18} height={18} style={{ borderRadius: 99 }} />
        ) : (
          <Github size={14} />
        )}
        {account.user ? account.user.login : "GitHub"}
      </button>
      <WindowControls />
    </div>
  );
}

function WindowControls() {
  return (
    <div className="drs-no-drag" style={{ display: "flex", alignSelf: "stretch", marginLeft: 8 }} onDoubleClick={(e) => e.stopPropagation()}>
      <button type="button" title="Minimize" className="drs-win-btn" onClick={() => void winMinimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M1 5h8" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      <button type="button" title="Maximize" className="drs-win-btn" onClick={() => void winToggleMaximize()}>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <rect x="1.4" y="1.4" width="7.2" height="7.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      <button type="button" title="Close" className="drs-win-btn drs-win-close" onClick={() => void winClose()}>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
    </div>
  );
}

function Pill({ children, onClick, disabled, title }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; title?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="ws-icon"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "transparent",
        color: "var(--text)",
        fontSize: 12,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

function IconBtn({ children, onClick, title }: { children: React.ReactNode; onClick?: () => void; title?: string }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="ws-icon"
      style={{
        width: 30,
        height: 30,
        borderRadius: 8,
        border: "none",
        background: "transparent",
        color: "var(--text-dim)",
        display: "grid",
        placeItems: "center",
      }}
    >
      {children}
    </button>
  );
}

type MenuBarCtx = {
  open: string | null;
  setOpen: (id: string | null) => void;
};

const MenuCtx = createContext<MenuBarCtx>({ open: null, setOpen: () => undefined });

function MenuBar({
  open,
  setOpen,
  children,
}: {
  open: string | null;
  setOpen: (id: string | null) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  return (
    <MenuCtx.Provider value={{ open, setOpen }}>
      <div ref={ref} className="drs-no-drag" style={{ display: "flex", alignItems: "center", gap: 2 }}>
        {children}
      </div>
    </MenuCtx.Provider>
  );
}

function Menu({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  const { open, setOpen } = useContext(MenuCtx);
  const shown = open === id;
  return (
    <div
      className="drs-no-drag"
      style={{ position: "relative" }}
      onMouseEnter={() => {
        if (open) setOpen(id);
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => setOpen(shown ? null : id)}
        style={{
          padding: "4px 8px",
          border: "none",
          background: shown ? "var(--bg-input)" : "transparent",
          color: shown ? "var(--text)" : "var(--text-dim)",
          borderRadius: 6,
        }}
      >
        {label}
      </button>
      {shown ? (
        <div
          className="drs-no-drag"
          style={{
            position: "absolute",
            left: 0,
            top: "100%",
            zIndex: 80,
            minWidth: 210,
            padding: "6px 0",
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            boxShadow: "0 16px 40px rgba(0,0,0,0.4)",
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

function Item({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) {
  const { setOpen } = useContext(MenuCtx);
  return (
    <button
      type="button"
      className="ws-icon"
      disabled={disabled}
      style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", border: "none", background: "transparent", color: "var(--text)", fontSize: 12, opacity: disabled ? 0.45 : 1, cursor: disabled ? "not-allowed" : "pointer" }}
      onClick={() => {
        if (disabled) return;
        onClick?.();
        setOpen(null);
      }}
    >
      {children}
    </button>
  );
}
