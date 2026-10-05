import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Eraser, Plus, SquareTerminal, Trash2, X } from "lucide-react";
import { openUrl, prettyTermPath, termCwd, termExec } from "../ipc/client";
import { useUI } from "../store/ui";
import { Terminal as XTermCtor, type XTerm } from "../vendor/xterm";

type Tab = { id: string; title: string; cwd: string; shell: string };

type Rt = {
  id: string;
  term: XTerm;
  cwd: string;
  shell: string;
  busy: boolean;
  line: string;
  cursor: number;
  hist: string[];
  histAt: number;
  stash: string;
  onData?: { dispose: () => void };
  resizeObserver?: ResizeObserver;
};

let seq = 0;

function shellName(shell: string) {
  return shell === "powershell" ? "powershell" : "bash";
}

function promptText(cwd: string, shell: string) {
  const p = prettyTermPath(cwd) || "~";
  return shell === "powershell" ? `PS ${p}> ` : `${p} $ `;
}

function cssVar(name: string, fallback: string) {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function xtermTheme() {
  const bg = cssVar("--bg", "#1e1e1e");
  const fg = cssVar("--text", "#cccccc");
  const dim = cssVar("--text-dim", "#6a6a6a");
  const acc = cssVar("--accent", "#3b8eea");
  const danger = cssVar("--danger", "#f14c4c");
  const sel = cssVar("--bg-input", "#264f78");
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: sel,
    selectionForeground: fg,
    black: "#000000",
    red: danger,
    green: "#13a10e",
    yellow: "#c19c00",
    blue: acc,
    magenta: "#bc3fbc",
    cyan: "#3b8eea",
    white: fg,
    brightBlack: dim,
    brightRed: danger,
    brightGreen: "#16c60c",
    brightYellow: "#f9f1a5",
    brightBlue: acc,
    brightMagenta: "#b4009e",
    brightCyan: "#61d6d6",
    brightWhite: "#ffffff",
  };
}

function fit(term: XTerm, host: HTMLElement) {
  // Do not lock xterm to its defensive 20-column minimum while the bottom
  // panel is still laying out. A zero-width first measurement was causing
  // long PowerShell paths to wrap every ~20 characters permanently.
  if (host.clientWidth <= 8 || host.clientHeight <= 8) return;
  const core = term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } };
  const cell = core._core?._renderService?.dimensions?.css?.cell;
  let cw = cell?.width || 0;
  let ch = cell?.height || 0;
  if (cw < 4 || ch < 8) {
    cw = Math.max(7, (term.options.fontSize || 13) * 0.62);
    ch = Math.max(12, (term.options.fontSize || 13) * 1.25);
  }
  const cols = Math.max(20, Math.floor(host.clientWidth / cw));
  const rows = Math.max(4, Math.floor(host.clientHeight / ch));
  if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
}

function toCrlf(s: string) {
  return s.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

export function Terminal() {
  const theme = useUI((s) => s.theme);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState("");
  const [menu, setMenu] = useState(false);
  const seed = useRef({ cwd: "", shell: "powershell" });
  const bodyRef = useRef<HTMLDivElement>(null);
  const hosts = useRef(new Map<string, HTMLDivElement>());
  const runtimes = useRef(new Map<string, Rt>());
  const tabsRef = useRef(tabs);
  const activeRef = useRef(activeId);
  const addTabRef = useRef<() => void>(() => {});
  const closeTabRef = useRef<(id: string) => void>(() => {});
  tabsRef.current = tabs;
  activeRef.current = activeId;

  const patchTab = useCallback((id: string, cwd: string, shell: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, cwd, shell } : t)));
  }, []);

  const writePrompt = useCallback((rt: Rt) => {
    rt.line = "";
    rt.cursor = 0;
    rt.term.write(promptText(rt.cwd, rt.shell));
    rt.term.scrollToBottom();
  }, []);

  const setLine = useCallback((rt: Rt, next: string) => {
    if (rt.cursor > 0) rt.term.write(`\x1b[${rt.cursor}D`);
    rt.term.write("\x1b[K");
    rt.line = next;
    rt.cursor = next.length;
    if (next) rt.term.write(next);
  }, []);

  const runLine = useCallback(
    async (rt: Rt, raw: string) => {
      const command = raw.trim();
      if (!command) {
        writePrompt(rt);
        return;
      }
      if (rt.hist[rt.hist.length - 1] !== command) rt.hist.push(command);
      rt.histAt = -1;
      if (command === "clear" || command === "cls") {
        rt.term.clear();
        writePrompt(rt);
        return;
      }
      if (command === "exit") {
        closeTabRef.current(rt.id);
        return;
      }
      rt.busy = true;
      try {
        const r = await termExec(command, rt.cwd);
        rt.cwd = prettyTermPath(r.cwd || rt.cwd);
        rt.shell = r.shell || rt.shell;
        patchTab(rt.id, rt.cwd, rt.shell);
        if (r.stdout) {
          const t = r.stdout.replace(/\s+$/, "");
          rt.term.write(toCrlf(t) + "\r\n");
        }
        if (r.stderr) {
          const t = r.stderr.replace(/\s+$/, "");
          rt.term.write("\x1b[31m" + toCrlf(t) + "\x1b[0m\r\n");
        }
        if (!r.stdout && !r.stderr && r.code !== 0) {
          rt.term.write(`\x1b[31mExit code ${r.code}\x1b[0m\r\n`);
        }
      } catch (e) {
        rt.term.write(`\x1b[31m${String(e)}\x1b[0m\r\n`);
      } finally {
        rt.busy = false;
        writePrompt(rt);
        if (activeRef.current === rt.id) rt.term.focus();
      }
    },
    [patchTab, writePrompt],
  );

  const onData = useCallback(
    (rt: Rt, data: string) => {
      if (rt.busy) return;
      if (data === "\r") {
        rt.term.write("\r\n");
        const cmd = rt.line;
        rt.line = "";
        rt.cursor = 0;
        void runLine(rt, cmd);
        return;
      }
      if (data === "\x7f" || data === "\b") {
        if (rt.cursor === 0) return;
        const rest = rt.line.slice(rt.cursor);
        rt.line = rt.line.slice(0, rt.cursor - 1) + rest;
        rt.cursor -= 1;
        if (!rest) {
          rt.term.write("\b \b");
        } else {
          rt.term.write("\b" + rest + " \x1b[" + (rest.length + 1) + "D");
        }
        return;
      }
      if (data === "\x03") {
        rt.term.write("^C\r\n");
        rt.line = "";
        rt.cursor = 0;
        writePrompt(rt);
        return;
      }
      if (data === "\x0c") {
        rt.term.clear();
        writePrompt(rt);
        return;
      }
      if (data === "\x1b[A") {
        if (!rt.hist.length) return;
        if (rt.histAt < 0) {
          rt.stash = rt.line;
          rt.histAt = rt.hist.length;
        }
        if (rt.histAt === 0) return;
        rt.histAt -= 1;
        setLine(rt, rt.hist[rt.histAt]);
        return;
      }
      if (data === "\x1b[B") {
        if (rt.histAt < 0) return;
        rt.histAt += 1;
        if (rt.histAt >= rt.hist.length) {
          rt.histAt = -1;
          setLine(rt, rt.stash);
        } else setLine(rt, rt.hist[rt.histAt]);
        return;
      }
      if (data === "\x1b[C") {
        if (rt.cursor < rt.line.length) {
          rt.cursor += 1;
          rt.term.write("\x1b[C");
        }
        return;
      }
      if (data === "\x1b[D") {
        if (rt.cursor > 0) {
          rt.cursor -= 1;
          rt.term.write("\x1b[D");
        }
        return;
      }
      if (data === "\x01" || data === "\x1b[H") {
        if (rt.cursor > 0) rt.term.write(`\x1b[${rt.cursor}D`);
        rt.cursor = 0;
        return;
      }
      if (data === "\x05" || data === "\x1b[F") {
        const n = rt.line.length - rt.cursor;
        if (n > 0) rt.term.write(`\x1b[${n}C`);
        rt.cursor = rt.line.length;
        return;
      }
      if (data.startsWith("\x1b")) return;

      const chunks = data.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      const runPaste = async () => {
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (chunk) {
            const rest = rt.line.slice(rt.cursor);
            rt.line = rt.line.slice(0, rt.cursor) + chunk + rest;
            rt.cursor += chunk.length;
            if (!rest) rt.term.write(chunk);
            else rt.term.write(chunk + rest + `\x1b[${rest.length}D`);
          }
          if (i < chunks.length - 1) {
            rt.term.write("\r\n");
            const cmd = rt.line;
            rt.line = "";
            rt.cursor = 0;
            await runLine(rt, cmd);
          }
        }
      };
      void runPaste();
    },
    [runLine, setLine, writePrompt],
  );

  const boot = useCallback(
    (tab: Tab, host: HTMLDivElement) => {
      if (runtimes.current.has(tab.id)) return;
      if (typeof XTermCtor !== "function") {
        host.textContent = "Terminal renderer failed to load.";
        return;
      }
      const term = new XTermCtor({
        convertEol: true,
        cursorBlink: true,
        cursorStyle: "block",
        fontFamily: "JetBrains Mono, Cascadia Code, Consolas, ui-monospace, monospace",
        fontSize: 13,
        lineHeight: 1.2,
        scrollback: 5000,
        theme: xtermTheme(),
        // Never use xterm's default window.open() link handler in Tauri.
        // Route terminal URLs through the shared system-browser command.
        linkHandler: {
          activate: (_event: unknown, text: string) => {
            void openUrl(text);
          },
        },
        windowsMode: true,
        allowProposedApi: false,
        disableStdin: false,
      });
      term.open(host);
      fit(term, host);
      const resizeObserver = new ResizeObserver(() => fit(term, host));
      resizeObserver.observe(host);
      const rt: Rt = {
        id: tab.id,
        term,
        cwd: tab.cwd,
        shell: tab.shell,
        busy: false,
        line: "",
        cursor: 0,
        hist: [],
        histAt: -1,
        stash: "",
        resizeObserver,
      };
      rt.onData = term.onData((d) => onData(rt, d));
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== "keydown") return true;
        const ctrl = ev.ctrlKey || ev.metaKey;
        if (ctrl && !ev.altKey && (ev.key === "c" || ev.key === "C") && term.hasSelection()) {
          void navigator.clipboard.writeText(term.getSelection());
          return false;
        }
        if (ctrl && ev.shiftKey && (ev.key === "c" || ev.key === "C")) {
          void navigator.clipboard.writeText(term.getSelection());
          return false;
        }
        if (ctrl && (ev.key === "v" || ev.key === "V")) {
          void navigator.clipboard.readText().then((t) => {
            if (t) onData(rt, t);
          });
          return false;
        }
        if (ctrl && ev.shiftKey && ev.key === "`") {
          addTabRef.current();
          return false;
        }
        return true;
      });
      host.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (term.hasSelection()) {
          void navigator.clipboard.writeText(term.getSelection());
          term.clearSelection();
        } else {
          void navigator.clipboard.readText().then((t) => {
            if (t) onData(rt, t);
          });
        }
      });
      runtimes.current.set(tab.id, rt);
      if (!tab.cwd) {
        term.write("\x1b[31mOpen the desktop app (npm run tauri dev) to run a real shell.\x1b[0m\r\n");
      }
      writePrompt(rt);
      requestAnimationFrame(() => {
        fit(term, host);
        term.focus();
      });
    },
    [onData, writePrompt],
  );

  const bindHost = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (!el) return;
      hosts.current.set(id, el);
      const tab = tabsRef.current.find((t) => t.id === id);
      if (tab) boot(tab, el);
    },
    [boot],
  );

  const addTab = useCallback(() => {
    const active = tabsRef.current.find((t) => t.id === activeRef.current);
    const cwd = active?.cwd || seed.current.cwd;
    const shell = active?.shell || seed.current.shell;
    seq += 1;
    const n = seq;
    const tab: Tab = {
      id: `t${Date.now().toString(36)}${n}`,
      title: n <= 1 ? shellName(shell) : `${shellName(shell)} ${n}`,
      cwd: prettyTermPath(cwd),
      shell,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
    setMenu(false);
  }, []);

  addTabRef.current = addTab;

  const closeTab = useCallback((id: string) => {
    const rt = runtimes.current.get(id);
    rt?.onData?.dispose();
    rt?.resizeObserver?.disconnect();
    try {
      rt?.term.dispose();
    } catch {
      /* ignore */
    }
    runtimes.current.delete(id);
    hosts.current.delete(id);
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      setActiveId((cur) => {
        if (cur !== id) return cur;
        return next[next.length - 1]?.id || "";
      });
      return next;
    });
    setMenu(false);
  }, []);
  closeTabRef.current = closeTab;

  useEffect(() => {
    void termCwd().then((info) => {
      seed.current = { cwd: prettyTermPath(info.cwd), shell: info.shell || "powershell" };
      seq = 0;
      addTab();
    });
    return () => {
      for (const rt of runtimes.current.values()) {
        rt.onData?.dispose();
        rt.resizeObserver?.disconnect();
        try {
          rt.term.dispose();
        } catch {
          /* ignore */
        }
      }
      runtimes.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const themeObj = xtermTheme();
    for (const rt of runtimes.current.values()) {
      rt.term.options.theme = themeObj;
    }
  }, [theme]);

  useEffect(() => {
    const rt = runtimes.current.get(activeId);
    const host = hosts.current.get(activeId);
    if (rt && host) {
      fit(rt.term, host);
      rt.term.focus();
    }
  }, [activeId]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const ro = new ResizeObserver(() => {
      for (const [id, rt] of runtimes.current) {
        const host = hosts.current.get(id);
        if (host && host.clientWidth > 8) fit(rt.term, host);
      }
    });
    ro.observe(body);
    return () => ro.disconnect();
  }, [tabs.length]);

  const active = tabs.find((t) => t.id === activeId);
  const clearActiveTerminal = useCallback(() => {
    const rt = runtimes.current.get(activeId);
    if (!rt || rt.busy) return;
    rt.term.clear();
    writePrompt(rt);
    rt.term.focus();
  }, [activeId, writePrompt]);
  const iconBtn: React.CSSProperties = {
    width: 28,
    height: 28,
    border: "none",
    borderRadius: 4,
    background: "transparent",
    color: "var(--text-dim)",
    display: "grid",
    placeItems: "center",
    padding: 0,
    flexShrink: 0,
  };

  return (
    <div className="drs-term">
      <div className="drs-term-bar">
        <div className="drs-term-menu-wrap">
          <button type="button" title="Switch terminal" style={iconBtn} onClick={() => setMenu((v) => !v)}>
            <ChevronDown size={14} />
          </button>
          {menu && (
            <div className="drs-term-menu" onMouseLeave={() => setMenu(false)}>
              {tabs.map((t, i) => (
                <button
                  key={t.id}
                  type="button"
                  className={t.id === activeId ? "is-on" : ""}
                  onClick={() => {
                    setActiveId(t.id);
                    setMenu(false);
                  }}
                >
                  <span>
                    {i + 1}: {t.title}
                  </span>
                  <span className="dim">{t.cwd}</span>
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  addTab();
                }}
              >
                New terminal
              </button>
            </div>
          )}
        </div>
        <div className="drs-term-tabs">
          {tabs.map((t) => {
            const on = t.id === activeId;
            return (
              <button
                key={t.id}
                type="button"
                className={`drs-term-tab${on ? " is-on" : ""}`}
                title={t.cwd}
                onClick={() => setActiveId(t.id)}
              >
                <SquareTerminal size={13} strokeWidth={1.8} />
                <span className="drs-term-tab-name">{t.title}</span>
                <span
                  className="drs-term-tab-x"
                  title="Kill terminal"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                >
                  <X size={11} />
                </span>
              </button>
            );
          })}
        </div>
        <button type="button" title="New terminal" onClick={addTab} style={iconBtn}>
          <Plus size={14} />
        </button>
        <button
          type="button"
          title="Clear terminal output"
          aria-label="Clear terminal output"
          disabled={!active}
          onClick={clearActiveTerminal}
          style={{ ...iconBtn, opacity: !active ? 0.45 : 1, cursor: !active ? "default" : "pointer" }}
        >
          <Eraser size={13} />
        </button>
        <button
          type="button"
          title="Kill terminal"
          onClick={() => active && closeTab(active.id)}
          style={iconBtn}
        >
          <Trash2 size={13} />
        </button>
      </div>

      {!tabs.length ? (
        <div className="drs-term-empty">
          <div>No terminals are open.</div>
          <button type="button" className="drs-term-new" onClick={addTab}>
            <Plus size={14} /> New terminal
          </button>
        </div>
      ) : (
        <div
          ref={bodyRef}
          className="drs-term-body"
          onClick={() => runtimes.current.get(activeId)?.term.focus()}
        >
          {tabs.map((t) => (
            <div
              key={t.id}
              ref={bindHost(t.id)}
              className={`drs-term-host${t.id === activeId ? "" : " is-off"}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
