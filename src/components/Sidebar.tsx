import { lazy, memo, Suspense, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronDown, ChevronRight, Eye, EyeOff, PanelLeft, Play, Plus, Trash2 } from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { useUI } from "../store/ui";
import { columnRuleOptions, kindSuffix, ruleValue, type ColumnRuleChoice } from "../lib/builtinRules";
import { SplitSash } from "./SplitSash";
import { MetricsPanel } from "../panels/Metrics";
import { FindBar } from "./FindBar";
import { usePlugins } from "../store/plugins";
import { isPluginSidebar, viewIdFromSidebar } from "../lib/pluginIcons";
import { useLicense } from "../store/license";
import { canUseFeature, PREMIUM_FEATURE } from "../license/features";
import { PremiumFeatureGate } from "./license/PremiumFeatureGate";
import { PluginSidebar } from "./PluginSidebar";

const LibraryPage = lazy(() => import("../pages/LibraryPage").then((m) => ({ default: m.LibraryPage })));
const UniversalRulesPage = lazy(() => import("../pages/UniversalRulesPage").then((m) => ({ default: m.UniversalRulesPage })));
const AIWorkspace = lazy(() => import("../pages/AIWorkspace").then((m) => ({ default: m.AIWorkspace })));
const SessionsPage = lazy(() => import("../pages/SessionsPage").then((m) => ({ default: m.SessionsPage })));
const LineagePage = lazy(() => import("../pages/LineagePage").then((m) => ({ default: m.LineagePage })));
const VersionsPage = lazy(() => import("../pages/VersionsPage").then((m) => ({ default: m.VersionsPage })));
const SettingsPage = lazy(() => import("../pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const PluginsPage = lazy(() => import("../pages/PluginsPage").then((m) => ({ default: m.PluginsPage })));
const MarketplacePage = lazy(() => import("../pages/MarketplacePage").then((m) => ({ default: m.MarketplacePage })));

const TYPES = [
  "Text",
  "Name",
  "Gender",
  "Integer",
  "Decimal",
  "Amount",
  "Currency",
  "Percent",
  "Boolean",
  "Date",
  "DateTime",
  "Year",
  "Email",
  "Phone",
  "URL",
  "Country",
  "City",
  "Postal Code",
  "Address",
  "UUID",
  "Category",
  "JSON",
  "ID",
];

const TITLES: Record<string, string> = {
  explorer: "Explorer",
  search: "Search",
  library: "Library",
  rules: "Universal rules",
  ai: "AI pipeline",
  lineage: "Lineage",
  versions: "Versions",
  sessions: "Sessions",
  marketplace: "Marketplace",
  extensions: "Extensions",
  settings: "Settings",
};

export const Sidebar = memo(function Sidebar() {
  const sidebar = useUI((s) => s.sidebar);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const views = usePlugins((s) => s.ui.views);
  const license = useLicense((s) => s.snap);
  if (!sidebar) return null;
  const plug = isPluginSidebar(sidebar) ? views.find((v) => v.id === viewIdFromSidebar(String(sidebar))) : null;
  const heading = plug?.title || TITLES[sidebar] || sidebar;
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", color: "var(--text)" }}>
      <div
        style={{
          height: 48,
          padding: "0 10px 0 16px",
          display: "flex",
          alignItems: "center",
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--text-dim)",
          borderBottom: "1px solid var(--border)",
          gap: 8,
        }}
      >
        <span style={{ flex: 1 }}>{heading}</span>
        <button
          type="button"
          title="Collapse sidebar"
          onClick={() => toggleSidebar(sidebar)}
          style={{
            width: 28,
            height: 28,
            border: "none",
            borderRadius: 8,
            background: "transparent",
            color: "var(--text-dim)",
            display: "grid",
            placeItems: "center",
            padding: 0,
          }}
        >
          <PanelLeft size={14} />
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: sidebar === "explorer" ? "hidden" : "auto" }}>
        {sidebar === "explorer" && <Explorer />}
        {sidebar === "search" && <FindBar />}
        <Suspense fallback={null}>
          {sidebar === "library" && <LibraryPage />}
          {sidebar === "rules" && <UniversalRulesPage />}
          {sidebar === "ai" && <AIWorkspace />}
          {sidebar === "lineage" && <LineagePage />}
          {sidebar === "versions" && <VersionsPage />}
          {sidebar === "sessions" && <SessionsPage />}
          {sidebar === "marketplace" && <MarketplacePage />}
          {sidebar === "extensions" && <PluginsPage />}
          {sidebar === "settings" && <SettingsPage />}
        </Suspense>
        {isPluginSidebar(sidebar) &&
          (canUseFeature(license, PREMIUM_FEATURE.installedPlugins) ? (
            <PluginSidebar viewId={viewIdFromSidebar(String(sidebar))} />
          ) : (
            <PremiumFeatureGate feature={PREMIUM_FEATURE.installedPlugins} title="Extensions are disabled in Basic mode" />
          ))}
      </div>
    </div>
  );
});

function Explorer() {
  const { sessionId, schema, metrics, columnRules, setColumnRule, setColumnType, assignColumnRule, libraryRules, run, running, autoCleanAll, deleteColumns } =
    useWorkspace(
      useShallow((s) => ({
        sessionId: s.sessionId,
        schema: s.schema,
        metrics: s.metrics,
        columnRules: s.columnRules,
        setColumnRule: s.setColumnRule,
        setColumnType: s.setColumnType,
        assignColumnRule: s.assignColumnRule,
        libraryRules: s.libraryRules,
        run: s.run,
        running: s.running,
        autoCleanAll: s.autoCleanAll,
        deleteColumns: s.deleteColumns,
      })),
    );
  const openColumnDialog = useUI((s) => s.openColumnDialog);
  const { hiddenCols, toggleHidden, showAllCols, expandedFields, toggleField, colWidths, setColWidth, metricsOpen, setMetricsOpen, metricsHeight, setMetricsHeight } =
    useUI(
      useShallow((s) => ({
        hiddenCols: s.hiddenCols,
        toggleHidden: s.toggleHidden,
        showAllCols: s.showAllCols,
        expandedFields: s.expandedFields,
        toggleField: s.toggleField,
        colWidths: s.colWidths,
        setColWidth: s.setColWidth,
        metricsOpen: s.metricsOpen,
        setMetricsOpen: s.setMetricsOpen,
        metricsHeight: s.metricsHeight,
        setMetricsHeight: s.setMetricsHeight,
      })),
    );
  const ruleChoices = columnRuleOptions(libraryRules);
  const assignedCount = Object.values(columnRules).filter((n) => n && n !== "none").length;
  return (
    <div style={{ fontSize: 12, height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
      <div style={{ padding: "14px 16px 10px", display: "flex", justifyContent: "space-between", alignItems: "center", color: "var(--text-dim)", gap: 8 }}>
        <span style={{ fontWeight: 600 }}>Fields · {schema.length}</span>
        <button onClick={showAllCols} style={{ border: "none", background: "none", color: "var(--accent)", fontSize: 11 }}>
          Show all
        </button>
      </div>
      <div style={{ padding: "0 16px 12px" }}>
        <button
          type="button"
          disabled={running || !sessionId}
          onClick={() => openColumnDialog()}
          style={{
            width: "100%",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            padding: "8px 10px",
            border: "1px dashed var(--border)",
            borderRadius: 10,
            background: "transparent",
            color: "var(--text)",
            fontSize: 12,
            fontWeight: 600,
            opacity: running || !sessionId ? 0.4 : 1,
          }}
        >
          <Plus size={14} /> Add column
        </button>
      </div>
      {schema.length > 0 && (
        <div style={{ padding: "0 16px 12px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <button
            disabled={running || !sessionId}
            onClick={() => void autoCleanAll()}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 10px",
              border: "none",
              borderRadius: 8,
              background: "var(--accent)",
              color: "#fff",
              fontSize: 11,
              opacity: running || !sessionId ? 0.4 : 1,
            }}
          >
            <Play size={11} /> Auto-clean all
          </button>
          <button
            disabled={running || !sessionId}
            onClick={() => void run("rules")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 10px",
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "transparent",
              color: "var(--text)",
              fontSize: 11,
              opacity: running || !sessionId ? 0.4 : 1,
            }}
          >
            Apply extras
          </button>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{assignedCount} extra</span>
        </div>
      )}
      {!schema.length && (
        <div style={{ margin: "0 16px 12px", padding: 14, borderRadius: 12, background: "var(--bg)", color: "var(--text-dim)", fontSize: 12, lineHeight: 1.5 }}>
          Import a file to map columns. Expand a field to set type, width, and a cleaning rule.
        </div>
      )}
      {schema.map((s) => {
        const open = expandedFields.includes(s.name);
        const hidden = hiddenCols.includes(s.name);
        const assigned = columnRules[s.name] || "none";
        return (
          <div key={s.name} style={{ margin: "0 12px 10px", borderRadius: 12, border: "1px solid var(--border)", background: "var(--bg)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px" }}>
              <button onClick={() => toggleField(s.name)} style={{ border: "none", background: "none", color: "var(--text-dim)" }}>
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              <span style={{ flex: 1, fontFamily: "JetBrains Mono, ui-monospace, monospace", overflow: "hidden", textOverflow: "ellipsis" }} title={s.name}>
                {s.name}
              </span>
              <span
                style={{
                  fontSize: 10,
                  padding: "2px 7px",
                  borderRadius: 99,
                  background: "var(--bg-input)",
                  color: "var(--text-dim)",
                }}
              >
                {s.active}
              </span>
              <button title={hidden ? "Show column" : "Hide column"} onClick={() => toggleHidden(s.name)} style={{ border: "none", background: "none", color: "var(--text-dim)" }}>
                {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
              <button
                type="button"
                title={schema.length < 2 ? "Keep at least one column" : `Delete ${s.name}`}
                disabled={running || schema.length < 2}
                onClick={(e) => {
                  e.stopPropagation();
                  void deleteColumns([s.name]);
                }}
                style={{
                  border: "none",
                  background: "none",
                  color: schema.length < 2 ? "var(--text-dim)" : "var(--danger, #e05d6f)",
                  opacity: running || schema.length < 2 ? 0.4 : 1,
                  padding: 0,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
            {open && (
              <div style={{ padding: "4px 14px 14px", color: "var(--text-dim)", display: "grid", gap: 10 }}>
                <div>Inferred: {s.inferred}</div>
                <label style={{ display: "grid", gap: 4, fontSize: 11 }}>
                  Type
                  <select
                    className="field field-sm"
                    value={s.active}
                    onChange={(e) => void setColumnType(s.name, e.target.value)}
                  >
                    {TYPES.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "grid", gap: 4, fontSize: 11 }}>
                  Cleaning rule
                  <RuleSelect
                    value={assigned}
                    options={ruleChoices}
                    disabled={running}
                    onChange={(v) => {
                      if (v === "none") setColumnRule(s.name, "none");
                      else void assignColumnRule(s.name, v, true);
                    }}
                  />
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  Width
                  <input
                    type="range"
                    min={80}
                    max={420}
                    value={colWidths[s.name] || 168}
                    onChange={(e) => setColWidth(s.name, Number(e.target.value))}
                    style={{ flex: 1 }}
                  />
                  <span style={{ fontFamily: "ui-monospace, monospace", width: 32 }}>{colWidths[s.name] || 168}</span>
                </label>
                <div>{s.manual ? "Manual · locked" : "Auto inferred"}</div>
                <button
                  type="button"
                  disabled={running || schema.length < 2}
                  onClick={() => void deleteColumns([s.name])}
                  style={{
                    justifySelf: "start",
                    padding: "6px 10px",
                    border: "1px solid color-mix(in srgb, var(--danger, #e05d6f) 45%, var(--border))",
                    borderRadius: 8,
                    background: "transparent",
                    color: "var(--danger, #e05d6f)",
                    fontSize: 11,
                    opacity: running || schema.length < 2 ? 0.4 : 1,
                  }}
                >
                  Delete column
                </button>
              </div>
            )}
          </div>
        );
      })}
      </div>
      <SplitSash
        axis="y"
        onDrag={(d) => {
          const next = (metricsOpen ? metricsHeight : 36) - d;
          if (next < 64) setMetricsOpen(false);
          else setMetricsHeight(next);
        }}
        onToggle={() => setMetricsOpen(!metricsOpen)}
      />
      <div style={{ flexShrink: 0, borderTop: "1px solid var(--border)" }}>
        <button
          type="button"
          onClick={() => setMetricsOpen(!metricsOpen)}
          style={{
            width: "100%",
            padding: "10px 16px",
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-dim)",
            border: "none",
            background: "transparent",
            display: "flex",
            alignItems: "center",
            gap: 8,
            textAlign: "left",
          }}
        >
          {metricsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Metrics {metrics ? `· ${metrics.health.toFixed(0)}` : ""}
        </button>
        {metricsOpen && (
          <div style={{ height: metricsHeight, padding: "0 8px 12px" }}>
            <MetricsPanel />
          </div>
        )}
      </div>
    </div>
  );
}

function RuleSelect({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string;
  options: ColumnRuleChoice[];
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null);

  const current =
    value === "none" ? null : options.find((r) => ruleValue(r) === value);
  const label = current ? `${current.name}${kindSuffix(current.kind)}` : "None";

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const space = window.innerHeight - r.bottom;
    setPos({ top: r.bottom, left: r.left, width: Math.max(r.width, 200), up: space < 200 });
    setOpen(true);
  };

  const pick = (v: string) => {
    setOpen(false);
    onChange(v);
  };

  const builtins = options.filter((r) => r.source === "builtin");
  const library = options.filter((r) => r.source === "library");

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="drs-pick-btn"
        disabled={disabled}
        title={current?.description || label}
        onClick={toggle}
      >
        <span>{label}</span>
        <ChevronDown size={12} />
      </button>
      {open && pos && (
        <div
          ref={menuRef}
          className="drs-pick-menu"
          style={{
            top: pos.up ? undefined : pos.top + 4,
            bottom: pos.up ? window.innerHeight - (btnRef.current?.getBoundingClientRect().top || 0) + 4 : undefined,
            left: pos.left,
            width: pos.width,
          }}
        >
          <button type="button" className={`drs-pick-item${value === "none" ? " is-on" : ""}`} onClick={() => pick("none")}>
            None
          </button>
          {builtins.length > 0 && <div className="drs-pick-group">Cleaning</div>}
          {builtins.map((r) => {
            const v = ruleValue(r);
            return (
              <button
                key={`b:${r.body}`}
                type="button"
                title={r.description || r.name}
                className={`drs-pick-item${value === v ? " is-on" : ""}`}
                onClick={() => pick(v)}
              >
                {r.name}
              </button>
            );
          })}
          {library.length > 0 && <div className="drs-pick-group">Library</div>}
          {library.map((r, i) => {
            const v = ruleValue(r);
            return (
              <button
                key={typeof r.id === "number" ? `id:${r.id}` : `lib:${r.name}:${i}`}
                type="button"
                title={r.description || r.name}
                className={`drs-pick-item${value === v ? " is-on" : ""}`}
                onClick={() => pick(v)}
              >
                {r.name}
                {kindSuffix(r.kind)}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
