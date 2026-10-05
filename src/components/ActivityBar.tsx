import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { Files, Search, Library, ListChecks, Sparkles, GitBranch, History, Blocks, Store, Settings, PanelLeft, CircleUser, HardDrive } from "lucide-react";
import { useUI, type BuiltinSidebar, type SidebarId } from "../store/ui";
import { useAuth } from "../store/auth";
import { usePlugins } from "../store/plugins";
import { pluginIcon, pluginSidebarId } from "../lib/pluginIcons";

const ITEMS: { id: BuiltinSidebar; icon: typeof Files; label: string }[] = [
  { id: "explorer", icon: Files, label: "Explorer" },
  { id: "search", icon: Search, label: "Search" },
  { id: "library", icon: Library, label: "Library" },
  { id: "rules", icon: ListChecks, label: "Rules" },
  { id: "ai", icon: Sparkles, label: "AI" },
  { id: "lineage", icon: GitBranch, label: "Lineage" },
  { id: "versions", icon: History, label: "Versions" },
  { id: "sessions", icon: HardDrive, label: "Sessions" },
  { id: "marketplace", icon: Store, label: "Marketplace" },
  { id: "extensions", icon: Blocks, label: "Extensions" },
];

export const ActivityBar = memo(function ActivityBar() {
  const { sidebar, toggleSidebar, setSidebarWidth, sidebarWidth } = useUI(
    useShallow((s) => ({
      sidebar: s.sidebar,
      toggleSidebar: s.toggleSidebar,
      setSidebarWidth: s.setSidebarWidth,
      sidebarWidth: s.sidebarWidth,
    })),
  );
  const { account, setAuthOpen } = useAuth(
    useShallow((s) => ({ account: s.account, setAuthOpen: s.setAuthOpen })),
  );
  const views = usePlugins((s) => s.ui.views) || [];
  const pluginItems = views
    .filter((v) => v?.id && v.sidebar !== false)
    .sort((a, b) =>
      String(a.title || a.extension || a.id).localeCompare(String(b.title || b.extension || b.id), undefined, {
        sensitivity: "base",
        numeric: true,
      }),
    );
  const user = account.user;
  // UI spec: >15 options makes the rail scrollable with a hidden scrollbar.
  const optionCount = ITEMS.length + pluginItems.length;
  const railTopClass = optionCount > 15 ? "activity-rail-top drs-scroll-hidden" : "activity-rail-top";
  return (
    <nav className="activity-rail" aria-label="Workspace">
      <div className={railTopClass}>
        {ITEMS.map((it) => {
          const Icon = it.icon;
          const on = sidebar === it.id;
          return (
            <button
              key={it.id}
              type="button"
              title={it.label}
              aria-label={it.label}
              aria-pressed={on}
              onClick={() => {
                toggleSidebar(it.id);
                if (it.id === "ai") setSidebarWidth(Math.max(320, sidebarWidth));
              }}
              className={on ? "activity-btn is-on" : "activity-btn"}
            >
              <Icon size={20} strokeWidth={1.75} />
            </button>
          );
        })}
        {pluginItems.map((v) => {
          const id = pluginSidebarId(String(v.id));
          const Icon = pluginIcon(v.icon);
          const on = sidebar === id;
          const label = String(v.title || v.extension || v.id);
          return (
            <button
              key={id}
              type="button"
              title={`${label}${v.extension ? ` · ${v.extension}` : ""}`}
              aria-label={label}
              aria-pressed={on}
              onClick={() => toggleSidebar(id as SidebarId)}
              className={on ? "activity-btn is-on" : "activity-btn"}
            >
              <Icon size={20} strokeWidth={1.75} />
            </button>
          );
        })}
      </div>
      <div className="activity-rail-bottom">
        <button
          type="button"
          title={sidebar ? "Collapse sidebar" : "Open sidebar"}
          aria-label={sidebar ? "Collapse sidebar" : "Open sidebar"}
          onClick={() => toggleSidebar(sidebar || "explorer")}
          className="activity-btn"
        >
          <PanelLeft size={18} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          title={user ? `GitHub: ${user.login}` : "Sign in with GitHub"}
          aria-label={user ? `GitHub: ${user.login}` : "Sign in with GitHub"}
          onClick={() => setAuthOpen(true)}
          className="activity-btn"
        >
          {user?.avatar_url ? (
            <img src={user.avatar_url} alt="" width={20} height={20} style={{ borderRadius: 99, display: "block" }} />
          ) : (
            <CircleUser size={20} strokeWidth={1.75} />
          )}
        </button>
        <button
          type="button"
          title="Settings"
          aria-label="Settings"
          aria-pressed={sidebar === "settings"}
          onClick={() => toggleSidebar("settings")}
          className={sidebar === "settings" ? "activity-btn is-on" : "activity-btn"}
        >
          <Settings size={20} strokeWidth={1.75} />
        </button>
      </div>
    </nav>
  );
});
