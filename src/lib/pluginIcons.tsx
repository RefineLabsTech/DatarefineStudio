import {
  Blocks,
  Brush,
  CircleHelp,
  Database,
  GitBranch,
  LayoutTemplate,
  List,
  ScrollText,
  SlidersHorizontal,
  Sparkles,
  Type,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import type { SVGProps } from "react";

/** Official Git mark (simple-icons path). Used for the Git plugin rail icon. */
export function GitLogo({
  size = 20,
  className,
  color = "#F05032",
  ...rest
}: SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number }) {
  const { strokeWidth: _sw, ...svgProps } = rest;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden
      {...svgProps}
    >
      <path
        fill={color}
        d="M23.546 10.93 13.067.452c-.604-.603-1.582-.603-2.188 0L8.708 2.627l2.76 2.76c.645-.215 1.379-.07 1.889.441.516.515.658 1.258.438 1.9l2.658 2.66c.645-.223 1.387-.078 1.9.435.721.721.721 1.884 0 2.604-.719.719-1.881.719-2.6 0-.539-.541-.674-1.337-.404-1.996L12.886 8.66v6.979c.176.086.342.203.488.348.713.721.713 1.883 0 2.6-.719.721-1.889.721-2.609 0-.719-.719-.719-1.879 0-2.598.182-.18.387-.316.605-.406V8.542c-.217-.09-.424-.222-.6-.401-.545-.545-.676-1.342-.396-2.009L7.636 3.7.45 10.881c-.6.605-.6 1.584 0 2.189l10.48 10.477c.604.604 1.582.604 2.186 0l10.43-10.43c.605-.603.605-1.582 0-2.187"
      />
    </svg>
  );
}

export type PluginIcon = LucideIcon | typeof GitLogo;

const MAP: Record<string, PluginIcon> = {
  blocks: Blocks,
  brush: Brush,
  broom: Brush,
  database: Database,
  db: Database,
  git: GitLogo,
  github: GitLogo,
  branch: GitBranch,
  help: CircleHelp,
  layout: LayoutTemplate,
  list: List,
  rules: ScrollText,
  scroll: ScrollText,
  sliders: SlidersHorizontal,
  sparkles: Sparkles,
  type: Type,
  wand: Wand2,
  clean: Type,
};

export function pluginIcon(name?: string): PluginIcon {
  const key = String(name || "blocks").toLowerCase().trim();
  return MAP[key] || Blocks;
}

export function pluginSidebarId(viewId: string) {
  return viewId.startsWith("plugin:") ? viewId : `plugin:${viewId}`;
}

export function viewIdFromSidebar(sidebar: string) {
  return sidebar.startsWith("plugin:") ? sidebar.slice("plugin:".length) : sidebar;
}

export function isPluginSidebar(id: string | null | undefined) {
  return Boolean(id && String(id).startsWith("plugin:"));
}
