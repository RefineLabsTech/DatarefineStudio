import "./xterm.css";
// UMD bundle — Vite may take the CJS branch or attach to globalThis.
// @ts-expect-error vendored UMD
import * as umd from "./xterm.js";

const g = globalThis as unknown as { Terminal?: unknown };
const mod = umd as { Terminal?: unknown; default?: { Terminal?: unknown } | (new () => XTerm) };

export const Terminal = (mod.Terminal ||
  (typeof mod.default === "function" ? mod.default : mod.default?.Terminal) ||
  g.Terminal) as new (options?: Record<string, unknown>) => XTerm;

export type XTerm = {
  cols: number;
  rows: number;
  options: {
    theme: Record<string, string | undefined>;
    fontFamily: string;
    fontSize: number;
  };
  element?: HTMLElement;
  open: (el: HTMLElement) => void;
  write: (data: string) => void;
  writeln: (data: string) => void;
  clear: () => void;
  reset: () => void;
  focus: () => void;
  blur: () => void;
  resize: (cols: number, rows: number) => void;
  dispose: () => void;
  onData: (cb: (data: string) => void) => { dispose: () => void };
  attachCustomKeyEventHandler: (cb: (ev: KeyboardEvent) => boolean) => void;
  hasSelection: () => boolean;
  getSelection: () => string;
  clearSelection: () => void;
  scrollToBottom: () => void;
};
