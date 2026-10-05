import { nativeRequireFeature, nativeState } from "../license/native";
import { effectiveImportRowLimit } from "../license/features";

/** Desktop (Tauri) always hits the Python sidecar. Browser Vite uses the proxy. */
let sidecarPort = 17831;

const RESTORE_HINT_KEY = "drs_restore_hint";
export function restoreHint(): boolean {
  try {
    return localStorage.getItem(RESTORE_HINT_KEY) === "1";
  } catch {
    return false;
  }
}
export function setRestoreHint() {
  try {
    localStorage.setItem(RESTORE_HINT_KEY, "1");
  } catch {
    /* private mode etc. */
  }
}
export function clearRestoreHint() {
  try {
    localStorage.removeItem(RESTORE_HINT_KEY);
  } catch {
    /* private mode etc. */
  }
}
export function setSidecarPort(port: number) {
  if (port >= 1 && port <= 65535) sidecarPort = port;
}

export function getSidecarPort() {
  return sidecarPort;
}

/**
 * Tauri/WebView2 can turn window.open and target=_blank into a second native
 * WebView. Install this before the React tree mounts so a stale plugin or
 * remote announcement cannot create a transient blank child window.
 */
export function installDesktopExternalLinkGuard() {
  if (typeof window === "undefined") return;
  const w = window as Window & { __DRS_EXTERNAL_LINK_GUARD__?: boolean };
  if (w.__DRS_EXTERNAL_LINK_GUARD__) return;
  const tauri = Boolean(
    (w as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }).__TAURI_INTERNALS__
      || (w as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }).__TAURI__,
  );
  // In a packaged build fail closed even if a future Tauri runtime changes
  // when it exposes its globals. This module is also used by browser Vite
  // development, where the normal browser popup behavior is still useful.
  if (!tauri && import.meta.env.DEV) return;
  w.__DRS_EXTERNAL_LINK_GUARD__ = true;

  const external = (value: string | URL | null | undefined) => {
    if (!value) return null;
    try {
      const parsed = new URL(String(value), window.location.href);
      return parsed.protocol === "https:" ? parsed.href : null;
    } catch {
      return null;
    }
  };

  window.open = ((url?: string | URL, ..._args: unknown[]) => {
    const href = external(url);
    if (href) void openUrl(href);
    // Never allow a child WebView in the desktop app, including about:blank.
    return null;
  }) as typeof window.open;

  document.addEventListener(
    "click",
    (event) => {
      const node = event.target instanceof Element ? event.target.closest("a[target='_blank']") : null;
      const href = external(node?.getAttribute("href"));
      if (!href) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void openUrl(href);
    },
    true,
  );
}

function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

function apiBase(): string {
  if (isTauri()) return `http://127.0.0.1:${sidecarPort}`;
  if (import.meta.env.DEV) return "/sidecar";
  return `http://127.0.0.1:${sidecarPort}`;
}

export type SidecarStatus = {
  running: boolean;
  python: string;
  error: string;
  log: string;
  port: number;
};

function tauriInvoker<T>() {
  const w = window as unknown as {
    __TAURI__?: { core?: { invoke?: (c: string, a?: unknown) => Promise<T> } };
    __TAURI_INTERNALS__?: { invoke?: (c: string, a?: unknown) => Promise<T> };
  };
  return w.__TAURI__?.core?.invoke || w.__TAURI_INTERNALS__?.invoke;
}

export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    const invoke = tauriInvoker<T>();
    if (typeof invoke !== "function") return null;
    return await invoke(cmd, args ?? {});
  } catch {
    return null;
  }
}

/**
 * Strict form for user-visible, server-authoritative operations. Unlike the
 * legacy nullable bridge, it preserves the Rust/cloud error message so quota
 * and credit failures cannot be mistaken for a successful operation.
 */
export async function tauriInvokeStrict<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = tauriInvoker<T>();
  if (typeof invoke !== "function") throw new Error("Desktop runtime unavailable.");
  try {
    return await invoke(cmd, args ?? {});
  } catch (error) {
    if (error instanceof Error) throw error;
    if (typeof error === "string") throw new Error(error);
    if (error && typeof error === "object" && "message" in error) {
      throw new Error(String((error as { message?: unknown }).message || "Desktop operation failed."));
    }
    throw new Error("Desktop operation failed.");
  }
}

export async function sidecarStatus(): Promise<SidecarStatus | null> {
  const st = await tauriInvoke<SidecarStatus>("sidecar_status");
  if (st?.port) setSidecarPort(st.port);
  return st;
}

export async function sidecarRestart(): Promise<SidecarStatus | null> {
  const st = await tauriInvoke<SidecarStatus>("sidecar_restart");
  if (st?.port) setSidecarPort(st.port);
  return st;
}

export async function winMinimize() {
  await tauriInvoke("win_minimize");
}

export async function winToggleMaximize() {
  await tauriInvoke("win_toggle_maximize");
}

export async function winClose() {
  await tauriInvoke("win_close");
}

export async function openPath(path: string): Promise<boolean> {
  const r = await tauriInvoke<boolean>("open_path", { path });
  return Boolean(r);
}

export async function openUrl(url: string): Promise<boolean> {
  const target = url.trim();
  if (!target) return false;

  // Never use window.open inside the desktop WebView. Tauri treats it as a
  // request for another WebView window, which can appear as a transient blank
  // white window instead of opening the system browser.
  if (isTauri()) {
    try {
      await tauriInvokeStrict("license_open_url", { url: target });
      return true;
    } catch {
      return false;
    }
  }

  // A production build that is not detected as Tauri must fail closed rather
  // than create a browser/WebView child window. Vite development keeps the
  // normal browser behavior for local testing.
  if (!import.meta.env.DEV) return false;
  try {
    const opened = window.open(target, "_blank", "noopener,noreferrer");
    return Boolean(opened);
  } catch {
    return false;
  }
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  window.setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 2500);
}

/**
 * Desktop downloads go through the Tauri shell instead of WebView anchor
 * downloads. That prevents Chromium's unstyled “allow multiple downloads?”
 * permission bubble while keeping browser/Vite development downloads intact.
 */
async function saveDesktopDownload(blob: Blob, filename: string): Promise<string> {
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
  return tauriInvokeStrict<string>("save_download_file", { filename, bytes });
}

export type TermResult = {
  cwd: string;
  stdout: string;
  stderr: string;
  code: number;
  shell?: string;
};

export type TermCwd = {
  cwd: string;
  shell: string;
};

export function prettyTermPath(p: string) {
  const s = (p || "").trim();
  if (s.startsWith("\\\\?\\UNC\\")) return "\\\\" + s.slice(8);
  if (s.startsWith("\\\\?\\")) return s.slice(4);
  return s;
}

function guessShell() {
  if (typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent)) return "powershell";
  return "bash";
}

export async function termCwd(): Promise<TermCwd> {
  const r = await tauriInvoke<TermCwd | string>("term_cwd");
  if (!r) return { cwd: "", shell: guessShell() };
  if (typeof r === "string") return { cwd: prettyTermPath(r), shell: guessShell() };
  return { cwd: prettyTermPath(r.cwd || ""), shell: r.shell || guessShell() };
}

export async function termExec(command: string, cwd?: string): Promise<TermResult> {
  const r = await tauriInvoke<TermResult>("term_exec", { command, cwd: cwd || "" });
  if (!r) {
    throw new Error("Terminal is available in the desktop app. Run npm run tauri dev.");
  }
  return { ...r, cwd: prettyTermPath(r.cwd || "") };
}

const SIDECAR_HINT =
  "Python engine is not running. The desktop app starts it automatically (npm run tauri dev). Python 3.11–3.13: py -3.12 -m pip install -r requirements.txt";

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function pingSidecar(timeoutMs = 1500): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiBase()}/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function probePorts(): Promise<boolean> {
  const ports = new Set<number>([sidecarPort]);
  for (let p = 17831; p <= 17840; p++) ports.add(p);
  const tauri = isTauri();
  const dev = Boolean(import.meta.env.DEV);
  for (const p of ports) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 500);
    try {
      const url = !tauri && dev && p === 17831 ? "/sidecar/health" : `http://127.0.0.1:${p}/health`;
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.ok) {
        setSidecarPort(p);
        return true;
      }
    } catch {
      /* next port */
    } finally {
      clearTimeout(t);
    }
  }
  return false;
}

function sidecarFail(st: SidecarStatus | null): never {
  const bits: string[] = [];
  if (st?.python) bits.push(`Python: ${st.python}`);
  if (st?.error) bits.push(st.error.trim());
  const log = (st?.log || "").trim();
  if (log) {
    const tail = log
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-10)
      .join("\n");
    if (tail && !bits.includes(tail) && tail !== (st?.error || "").trim()) bits.push(tail);
  }
  if (bits.length) throw new Error(`Python engine failed to start.\n${bits.join("\n")}`);
  throw new Error(SIDECAR_HINT);
}

/** Wait for /health. Discover the bound port, restart the Tauri sidecar if needed. */
export async function ensureSidecar(): Promise<void> {
  if (await pingSidecar()) return;
  if (await probePorts()) return;
  let st = await sidecarStatus();
  if (st?.port) setSidecarPort(st.port);
  if (await pingSidecar()) return;
  if (isTauri() && (!st || !st.running)) {
    st = await sidecarRestart();
    if (st?.port) setSidecarPort(st.port);
  }
  for (let i = 0; i < 24; i++) {
    st = (await sidecarStatus()) || st;
    if (st?.port) setSidecarPort(st.port);
    if (await pingSidecar(1200)) return;
    if (await probePorts()) return;
    if (st && !st.running && st.error && i >= 3) sidecarFail(st);
    await sleep(400);
  }
  sidecarFail(st);
}

async function requirePremiumFeature(feature: string) {
  await nativeRequireFeature(feature);
}

async function importRowLimit(requested: number) {
  const snap = await nativeState();
  return effectiveImportRowLimit(snap, requested);
}

async function parseBody(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) {
    throw new Error(
      res.status === 0 || res.status >= 500
        ? SIDECAR_HINT
        : `Empty response from sidecar (HTTP ${res.status}). ${SIDECAR_HINT}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Sidecar did not return JSON (HTTP ${res.status}). ${SIDECAR_HINT}`);
  }
}

async function req<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const timeoutMs = init?.timeoutMs ?? (path === "/health" ? 2000 : 45000);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    const { timeoutMs: _omit, ...rest } = init || {};
    res = await fetch(`${apiBase()}${path}`, {
      ...rest,
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", ...(rest.headers || {}) },
    });
  } catch {
    throw new Error(SIDECAR_HINT);
  } finally {
    clearTimeout(t);
  }
  const body = await parseBody(res);
  if (!res.ok || body.ok === false) {
    const detail = body.detail;
    const structured = body.error && typeof body.error === "object" ? body.error : null;
    const msg = Array.isArray(detail)
      ? JSON.stringify(detail)
      : structured?.message || detail || body.message || res.statusText;
    const error = new Error(String(msg)) as Error & { pluginError?: PluginCommandError };
    if (structured?.message) error.pluginError = structured as PluginCommandError;
    throw error;
  }
  return (body.data ?? body) as T;
}

export const api = {
  health: () => req<{ ok: boolean; name?: string }>("/health"),
  sessions: () => req<unknown[]>("/sessions"),
  diskSessions: () => req<unknown[]>("/sessions/disk"),
  restoreDiskSession: (sid: string) =>
    req<{ session_id?: string; label?: string; rows?: number }>(`/sessions/disk/${sid}/restore`, { method: "POST" }),
  deleteDiskSession: (sid: string) => req<{ deleted?: string }>(`/sessions/disk/${sid}`, { method: "DELETE" }),
  renameSession: (sid: string, label: string) =>
    req<{ label?: string }>(`/session/${sid}/rename`, { method: "POST", body: JSON.stringify({ label }) }),
  deleteSession: (sid: string) => req<{ deleted?: string }>(`/session/${sid}`, { method: "DELETE" }),
  sessionWorkspace: (sid: string) => req<Record<string, unknown>>(`/session/${sid}/workspace`),
  history: (sid: string) =>
    req<{ checkpoints: { i: number; rows: number; cols: number; ts: string }[]; current: { rows: number; cols: number } }>(
      `/session/${sid}/history`,
    ),
  undoTo: (sid: string, index: number) =>
    req<{ rows?: number }>(`/session/${sid}/undo_to`, { method: "POST", body: JSON.stringify({ index }) }),
  peek: () =>
    req<{
      restorable: boolean;
      session_id?: string;
      source?: string;
      rows?: number;
      exported?: boolean;
      dirty?: number;
      saved_at?: string;
    }>("/session/peek", { timeoutMs: 3000 }),
  resume: () =>
    req<{
      restored: boolean;
      session_id?: string;
      rows?: number;
      columns?: string[];
      source?: string;
      sql?: string;
      javascript?: string;
      python?: string;
      column_rules?: Record<string, string>;
      clean_total?: number;
      highlights?: CellHighlight[];
      exported?: boolean;
    }>("/session/resume"),
  saveWorkspace: (
    sid: string,
    body: { sql?: string; javascript?: string; python?: string; column_rules?: Record<string, string> },
  ) => req<{ saved?: boolean }>(`/session/${sid}/workspace`, { method: "POST", body: JSON.stringify(body) }),
  runtime: () =>
    req<{
      python: string;
      version: string;
      packages: Array<{ name: string; version?: string; import?: string }>;
      node_modules: Array<{ name: string }>;
      libraries?: string;
    }>("/runtime"),
  recents: () => req<Array<{ path: string; opened_at: string }>>("/recents"),
  settings: () => req<Record<string, unknown>>("/settings"),
  saveSettings: (values: Record<string, unknown>) =>
    req("/settings", { method: "POST", body: JSON.stringify({ values }) }),
  open: async (path: str, row_limit = 10000) => {
    await ensureSidecar();
    const limit = await importRowLimit(row_limit);
    return req<{ session_id: string; rows: number; columns: string[]; source: string }>("/session/open", {
      method: "POST",
      body: JSON.stringify({ path, row_limit: limit }),
    });
  },
  upload: async (file: File, row_limit = 10000) => {
    await ensureSidecar();
    const limit = await importRowLimit(row_limit);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("row_limit", String(limit));
    const send = () => fetch(`${apiBase()}/session/upload`, { method: "POST", body: fd });
    let res: Response;
    try {
      res = await send();
    } catch {
      await ensureSidecar();
      try {
        res = await send();
      } catch {
        sidecarFail(await sidecarStatus());
      }
    }
    const body = await parseBody(res);
    if (!res.ok || body.ok === false) throw new Error(body.detail || body.message || "upload failed");
    return body.data as { session_id: string; rows: number; columns: string[]; source: string };
  },
  database: async (kind: string, config: Record<string, unknown>, query: string, row_limit = 10000) => {
    await requirePremiumFeature("connect_db");
    await ensureSidecar();
    const limit = await importRowLimit(row_limit);
    return req<{ session_id: string; rows: number; columns: string[]; source?: string }>("/session/database", {
      method: "POST",
      body: JSON.stringify({ kind, config, query, row_limit: limit }),
    });
  },
  dbTest: async (kind: string, config: Record<string, unknown>) => {
    await requirePremiumFeature("connect_db");
    return req<{ ok: boolean; ms?: number }>("/session/db/test", { method: "POST", body: JSON.stringify({ kind, config }) });
  },
  push: async (sid: string, body: { kind: string; config: Record<string, unknown>; table: string; mode?: string; schema_name?: string }) => {
    await requirePremiumFeature("push");
    return req<{ rows: number; table: string; mode: string }>(`/session/${sid}/push`, { method: "POST", body: JSON.stringify(body) });
  },
  viewport: (sid: string, offset = 0, limit = 80) =>
    req<{
      session_id: string;
      offset: number;
      limit: number;
      total: number;
      columns: string[];
      schema: SchemaCol[];
      rows: unknown[][];
    }>(`/session/${sid}/viewport?offset=${offset}&limit=${limit}`),
  profile: (sid: string) => req<ProfileCol[]>(`/session/${sid}/profile`),
  metrics: (sid: string) => req<Metrics>(`/session/${sid}/metrics`),
  logs: (sid: string) => req<LogItem[]>(`/session/${sid}/logs`),
  lineage: (sid: string) => req<unknown[]>(`/session/${sid}/lineage`),
  versions: (sid: string) => req<unknown[]>(`/session/${sid}/versions`),
  edit: (sid: string, row: number, column: string, value: unknown) =>
    req(`/session/${sid}/edit`, { method: "POST", body: JSON.stringify({ row, column, value }) }),
  schema: (sid: string, column: string, patch: Record<string, unknown>) =>
    req(`/session/${sid}/schema`, { method: "POST", body: JSON.stringify({ column, patch }) }),
  dropColumns: (sid: string, columns: string[]) =>
    req<{ dropped: string[]; columns: string[]; rows: number }>(`/session/${sid}/columns/drop`, {
      method: "POST",
      body: JSON.stringify({ columns }),
    }),
  addColumn: (sid: string, name: string, type = "Text", after?: string) =>
    req<{ added: string; type: string; columns: string[]; rows: number }>(`/session/${sid}/columns/add`, {
      method: "POST",
      body: JSON.stringify({ name, type, after: after || null }),
    }),
  applyTemplate: (sid: string, mapping: unknown[]) =>
    req<{ applied?: Array<{ column: string; type: string }>; count?: number }>(`/session/${sid}/schema/template`, {
      method: "POST",
      body: JSON.stringify({ mapping }),
    }),
  sql: (sid: string, sql: string) =>
    req(`/session/${sid}/sql`, { method: "POST", body: JSON.stringify({ sql }) }),
  javascript: (sid: string, code: string) =>
    req(`/session/${sid}/javascript`, { method: "POST", body: JSON.stringify({ javascript: code }) }),
  python: (sid: string, code: string) =>
    req(`/session/${sid}/python`, { method: "POST", body: JSON.stringify({ python: code }) }),
  rules: (sid: string, rules: unknown[]) =>
    req(`/session/${sid}/rules`, { method: "POST", body: JSON.stringify({ rules }) }),
  pipeline: (sid: string, payload: Record<string, unknown>) =>
    req(`/session/${sid}/pipeline`, { method: "POST", body: JSON.stringify(payload) }),
  undo: (sid: string) => req(`/session/${sid}/undo`, { method: "POST", body: "{}" }),
  redo: (sid: string) => req(`/session/${sid}/redo`, { method: "POST", body: "{}" }),
  restore: (sid: string, version_id: number) =>
    req(`/session/${sid}/restore`, { method: "POST", body: JSON.stringify({ version_id }) }),
  export: async (sid: string, fmt: string, dest: string, options: Record<string, unknown> = {}) => {
    if (String(fmt).toLowerCase() !== "csv") await requirePremiumFeature("export_non_csv");
    const result = await req(`/session/${sid}/export`, { method: "POST", body: JSON.stringify({ fmt, dest, options }) });
    /* Export = saved & done: never promise a restore for it next launch. */
    clearRestoreHint();
    return result;
  },
  report: (sid: string) => req<CleaningReport>(`/session/${sid}/report`),
  downloadReport: async (sid: string, filename = "cleaning-report.pdf") => {
    await requirePremiumFeature("export_non_csv");
    await ensureSidecar();
    const dest = `exports/${filename}`;
    const saved = await req<{ path?: string }>(`/session/${sid}/export`, {
      method: "POST",
      body: JSON.stringify({ fmt: "report-pdf", dest, options: {} }),
    });
    const path = String(saved?.path || dest);
    let downloadedPath = path;
    let reportBlob: Blob | null = null;
    try {
      const res = await fetch(`${apiBase()}/session/${sid}/report?fmt=pdf`);
      if (res.ok) reportBlob = await res.blob();
    } catch {
      /* The report is already saved on disk; opening that copy is still useful. */
    }
    if (reportBlob) {
      const kind = (reportBlob.type || "").toLowerCase();
      if (reportBlob.size > 80 && !kind.includes("json")) {
        downloadedPath = isTauri() ? await saveDesktopDownload(reportBlob, filename) : path;
        if (!isTauri()) triggerDownload(reportBlob, filename);
      }
    }
    await openPath(downloadedPath);
    return { path: downloadedPath };
  },
  download: async (sid: string, fmt: string, filename: string, options: Record<string, unknown> = {}) => {
    if (String(fmt).toLowerCase() !== "csv") await requirePremiumFeature("export_non_csv");
    const q = new URLSearchParams({ fmt, headers: String(options.headers !== false) });
    let res: Response;
    try {
      res = await fetch(`${apiBase()}/session/${sid}/download?${q}`);
    } catch {
      throw new Error(SIDECAR_HINT);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `Export failed (HTTP ${res.status})`);
    }
    const blob = await res.blob();
    const target = filename || `clean.${fmt}`;
    if (isTauri()) {
      await saveDesktopDownload(blob, target);
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = target;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  ai: (sid: string, step: string, settings: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    // Inside Tauri the Rust proxy injects the BYOK key from the OS credential
    // manager; browser dev mode falls back to the direct engine call.
    const w = window as unknown as {
      __TAURI__?: { core?: { invoke?: (c: string, a?: unknown) => Promise<unknown> } };
      __TAURI_INTERNALS__?: { invoke?: (c: string, a?: unknown) => Promise<unknown> };
    };
    const fn = w.__TAURI__?.core?.invoke || w.__TAURI_INTERNALS__?.invoke;
    if (typeof fn === "function") {
      return fn("ai_run", { sid, step, settings, extra }) as Promise<unknown>;
    }
    return req(`/session/${sid}/ai`, { method: "POST", body: JSON.stringify({ step, settings, ...extra }) });
  },
  aiCode: async (sid: string, settings: Record<string, unknown>, prompt: string, language: string) => {
    // Code generation uses the same central Rust AI proxy as normal AI runs.
    // The proxy injects BYOK credentials from the OS credential manager.
    const w = window as unknown as {
      __TAURI__?: { core?: { invoke?: (c: string, a?: unknown) => Promise<unknown> } };
      __TAURI_INTERNALS__?: { invoke?: (c: string, a?: unknown) => Promise<unknown> };
    };
    const fn = w.__TAURI__?.core?.invoke || w.__TAURI_INTERNALS__?.invoke;
    const extra = { prompt, language };
    if (typeof fn === "function") {
      const result = await fn("ai_run", { sid, step: "code", settings, extra });
      if (result && typeof result === "object" && "data" in result) {
        return (result as { data?: unknown }).data;
      }
      return result;
    }
    return req(`/session/${sid}/ai`, {
      method: "POST",
      body: JSON.stringify({ step: "code", settings, prompt, language, extra: prompt }),
      timeoutMs: 120000,
    });
  },
  aiPreview: (sid: string, body: Record<string, unknown> = {}) =>
    req<AiPreviewResult>(`/session/${sid}/ai/preview`, {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs: 90000,
    }),
  aiApply: (sid: string, operations: unknown[], threshold = 0) =>
    req(`/session/${sid}/ai/apply`, { method: "POST", body: JSON.stringify({ operations, threshold }) }),
  search: (
    sid: string,
    body: { find: string; replace?: string; column?: string; regex?: boolean; do_replace?: boolean },
  ) => req<{ matches: number; replaced: boolean }>(`/session/${sid}/search`, { method: "POST", body: JSON.stringify(body) }),
  libraryRules: () => req<unknown[]>("/library/rules"),
  saveRule: (body: Record<string, unknown>) =>
    req<{ id: number }>("/library/rules", { method: "POST", body: JSON.stringify(body) }),
  deleteRule: (id: number) => req(`/library/rules/${id}`, { method: "DELETE" }),
  templates: () => req<unknown[]>("/library/templates"),
  saveTemplate: (name: string, mapping: unknown[], description = "") =>
    req("/library/templates", {
      method: "POST",
      body: JSON.stringify({ name, mapping, description }),
    }),
  githubMe: () => req<GithubAccount>("/auth/github"),
  githubStart: () =>
    req<GithubDeviceStart>("/auth/github/device/start", { method: "POST", body: "{}" }),
  githubPoll: (device_id: string) =>
    req<{ status: string; message?: string; interval?: number; github?: GithubAccount }>("/auth/github/device/poll", {
      method: "POST",
      body: JSON.stringify({ device_id }),
    }),
  githubToken: (token: string) =>
    req<GithubAccount>("/auth/github/token", { method: "POST", body: JSON.stringify({ token }) }),
  githubSignOut: (account_id?: string) =>
    req<GithubAccount>("/auth/github/signout", { method: "POST", body: JSON.stringify({ account_id: account_id || "" }) }),
  githubSwitch: (account_id: string) =>
    req<GithubAccount>("/auth/github/switch", { method: "POST", body: JSON.stringify({ account_id }) }),
  githubClientId: (client_id: string) =>
    req<GithubAccount>("/auth/github/client", { method: "POST", body: JSON.stringify({ client_id }) }),
  plugins: async () => {
    await requirePremiumFeature("installed_plugins");
    return req<PluginRec[]>("/plugins");
  },
  pluginUi: async () => {
    await requirePremiumFeature("installed_plugins");
    return req<PluginUI>("/plugins/ui");
  },
  pluginEnable: async (id: string, enabled: boolean, trust = false) => {
    await requirePremiumFeature("installed_plugins");
    return req<PluginRec>(`/plugins/${encodeURIComponent(id)}/enable`, {
      method: "POST",
      body: JSON.stringify({ enabled, trust }),
    });
  },
  pluginUnload: async (id: string) => {
    await requirePremiumFeature("installed_plugins");
    return req(`/plugins/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  pluginInstallPath: async (path: string) => {
    await requirePremiumFeature("plugin_install");
    await requirePremiumFeature("marketplace");
    return req<PluginRec>("/plugins/install-path", { method: "POST", body: JSON.stringify({ path }) });
  },
  pluginInstallFile: async (file: File) => {
    await requirePremiumFeature("plugin_install");
    await requirePremiumFeature("marketplace");
    const fd = new FormData();
    fd.append("file", file);
    let res: Response;
    try {
      res = await fetch(`${apiBase()}/plugins/install`, { method: "POST", body: fd });
    } catch {
      throw new Error(SIDECAR_HINT);
    }
    const body = await parseBody(res);
    if (!res.ok || body.ok === false) throw new Error(body.detail || body.message || "install failed");
    return body.data as PluginRec;
  },
  pluginCommand: async (sid: string | null, plugin_id: string, command_id: string, extra: Record<string, unknown> = {}) => {
    await requirePremiumFeature("installed_plugins");
    return req<PluginCommandResult>(
      sid ? `/session/${sid}/plugin-command` : "/plugins/command",
      {
        method: "POST",
        body: JSON.stringify({ plugin_id, command_id, extra }),
        timeoutMs: 180000,
      },
    );
  },
};

type str = string;

export type SchemaCol = {
  name: string;
  display_name: string;
  inferred: string;
  active: string;
  manual: boolean;
  nullable: boolean;
  required: boolean;
  unique: boolean;
  default: string;
  validation: string;
  regex: string;
  description: string;
  example: string;
};

export type ProfileCol = {
  name: string;
  inferred: string;
  active: string;
  manual: boolean;
  null_pct: number;
  unique_count: number;
  dtype: string;
};

export type Metrics = {
  rows: number;
  columns: number;
  missing: number;
  duplicates: number;
  invalid: number;
  health: number;
  runtime_ms: number;
  source: string;
  cells_cleaned?: number;
};

export type CleaningReport = {
  cells_cleaned: number;
  pct_cleaned: number;
  total_cells: number;
  source?: string;
  current?: Metrics;
  baseline?: Metrics;
  by_stage?: Array<{ stage: string; cells: number }>;
  by_column?: Array<{ column: string; cells: number; pct: number }>;
};

export type LogItem = { ts: string; channel: string; message: string };

export type CellHighlight = { row: number; column: string; stage: string };

export type AiOp = {
  id: string;
  title: string;
  kind: "rule" | "ai" | string;
  cells: number;
  columns: string[];
  confidence: number;
  bucket: "auto" | "review" | "ignore" | string;
  description?: string;
  enabled?: boolean;
};

export type AiDiff = {
  row: number;
  column: string;
  original?: unknown;
  suggested?: unknown;
  confidence: number;
  op_id: string;
  bucket: string;
  reason?: string;
  status?: "pending" | "accepted" | "rejected";
  kind?: string;
};

export type AiPreviewResult = {
  phase?: string;
  profiles?: ProfileCol[];
  plan?: AiOp[];
  diffs?: AiDiff[];
  buckets?: Record<string, number>;
  highlights?: CellHighlight[];
  scope?: { columns?: string[]; row_count?: number; extra?: string };
  llm?: boolean;
  wrote?: boolean;
  llm_error?: string;
};

export type GithubUser = {
  id?: number;
  login: string;
  name?: string;
  avatar_url?: string;
  html_url?: string;
  account_id?: string;
  active?: boolean;
};

export type GithubAccount = {
  client_id: string;
  signed_in: boolean;
  has_token: boolean;
  user: GithubUser | null;
  scope: string;
  method: string;
  active_id?: string;
  accounts?: GithubUser[];
};

export type GithubDeviceStart = {
  device_id: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval: number;
  expires_in: number;
};

export type PluginCommandError = {
  type: string;
  message: string;
  details?: string;
};

export type PluginCommandResult = {
  ok?: boolean;
  changed?: number;
  highlights?: CellHighlight[];
  ui?: boolean;
  view?: string;
  theme?: string;
  output?: string;
  message?: string;
  error?: PluginCommandError;
};

export type PluginRec = {
  id: string;
  name: string;
  displayName: string;
  publisher?: string;
  version: string;
  description: string;
  enabled: boolean;
  bundled: boolean;
  trusted: boolean;
  needsTrust: boolean;
  permissions: string[];
  levels: string[];
  icon?: string;
  command_count?: number;
  hook_count?: number;
  rule_count?: number;
};

export type PluginViewOption = {
  id?: string;
  label: string;
  hint?: string;
  command?: string;
  theme?: string;
  action?: "saveRule" | "applyRule" | "newRule" | string;
  session?: boolean;
};

export type PluginViewField = {
  id: string;
  label?: string;
  type?: "text" | "textarea" | "select" | string;
  placeholder?: string;
  hint?: string;
  default?: string;
  options?: Array<string | { value: string; label?: string }>;
  when?: { field: string; equals?: string; in?: string[] };
};

export type PluginView = {
  id: string;
  title?: string;
  body?: string;
  icon?: string;
  sidebar?: boolean;
  /** First-party core-rendered view, used by privileged local integrations. */
  component?: string;
  catalog?: string;
  account?: string;
  fields?: PluginViewField[];
  options?: PluginViewOption[];
  extension_id?: string;
  extension?: string;
};

export type PluginUI = {
  commands: Array<
    Record<string, unknown> & {
      id: string;
      title?: string;
      extension_id?: string;
      extension?: string;
      python?: string;
      view?: string;
      theme?: string;
    }
  >;
  themes: Array<
    Record<string, unknown> & {
      id: string;
      label?: string;
      hint?: string;
      monaco?: string;
      colors?: Record<string, string>;
      swatches?: string[];
      grid?: Record<string, string>;
    }
  >;
  statusBar: Array<{ text: string; tooltip?: string; extension?: string }>;
  snippets: Array<{ language?: string; label?: string; insertText: string; detail?: string; extension?: string }>;
  views: PluginView[];
  exporters: Array<{ id?: string; ext?: string; label?: string; hint?: string; extension?: string }>;
  ingest: Array<{ extensions?: string[]; extension?: string }>;
  aiSteps: Array<{ id: string; title?: string; body?: string; extension?: string }>;
  aiPrompts: Record<string, string>;
};
