export const THEME_IDS = ["midnight", "ocean", "dawn", "forest", "dusk", "ember", "nord", "sand"] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export type ThemeKey = ThemeId | string;

type ThemeDef = {
  label: string;
  hint: string;
  monaco: "vs-dark" | "vs";
  swatches: [string, string, string];
  grid: {
    bgCell: string;
    bgHeader: string;
    textDark: string;
    textHeader: string;
    accentColor: string;
    borderColor: string;
    bgHeaderHovered: string;
  };
};

export const THEMES: Record<ThemeId, ThemeDef> = {
  midnight: {
    label: "Midnight",
    hint: "Graphite workspace",
    monaco: "vs-dark",
    swatches: ["#0f1115", "#5b8def", "#e8eaed"],
    grid: {
      bgCell: "#171a21",
      bgHeader: "#12151b",
      textDark: "#e8eaed",
      textHeader: "#c5c9d1",
      accentColor: "#5b8def",
      borderColor: "#2a2f3a",
      bgHeaderHovered: "#1e232c",
    },
  },
  ocean: {
    label: "Ocean",
    hint: "Deep blue night",
    monaco: "vs-dark",
    swatches: ["#071018", "#3ec8f0", "#dff6ff"],
    grid: {
      bgCell: "#0c1a28",
      bgHeader: "#0a1622",
      textDark: "#dff6ff",
      textHeader: "#bae6fd",
      accentColor: "#3ec8f0",
      borderColor: "#1a3a52",
      bgHeaderHovered: "#12263a",
    },
  },
  dawn: {
    label: "Dawn",
    hint: "Light studio",
    monaco: "vs",
    swatches: ["#eceff3", "#2563eb", "#1a1d23"],
    grid: {
      bgCell: "#ffffff",
      bgHeader: "#f4f6f9",
      textDark: "#1a1d23",
      textHeader: "#3b4150",
      accentColor: "#2563eb",
      borderColor: "#dde2ea",
      bgHeaderHovered: "#e8ecf2",
    },
  },
  forest: {
    label: "Forest",
    hint: "Evergreen dark",
    monaco: "vs-dark",
    swatches: ["#0e1410", "#3dd68c", "#e6f6ec"],
    grid: {
      bgCell: "#151e18",
      bgHeader: "#101710",
      textDark: "#e6f6ec",
      textHeader: "#bbf7d0",
      accentColor: "#3dd68c",
      borderColor: "#24332a",
      bgHeaderHovered: "#1c2820",
    },
  },
  dusk: {
    label: "Dusk",
    hint: "Violet night",
    monaco: "vs-dark",
    swatches: ["#120818", "#c084fc", "#f3e8ff"],
    grid: {
      bgCell: "#1a0f24",
      bgHeader: "#140a1c",
      textDark: "#f3e8ff",
      textHeader: "#e9d5ff",
      accentColor: "#c084fc",
      borderColor: "#3b2452",
      bgHeaderHovered: "#241433",
    },
  },
  ember: {
    label: "Ember",
    hint: "Warm copper dark",
    monaco: "vs-dark",
    swatches: ["#140b08", "#fb923c", "#ffedd5"],
    grid: {
      bgCell: "#1c110c",
      bgHeader: "#160e0a",
      textDark: "#ffedd5",
      textHeader: "#fed7aa",
      accentColor: "#fb923c",
      borderColor: "#3f2418",
      bgHeaderHovered: "#27170f",
    },
  },
  nord: {
    label: "Nord",
    hint: "Arctic frost",
    monaco: "vs-dark",
    swatches: ["#1b1f2a", "#88c0d0", "#eceff4"],
    grid: {
      bgCell: "#222733",
      bgHeader: "#1b1f2a",
      textDark: "#eceff4",
      textHeader: "#d8dee9",
      accentColor: "#88c0d0",
      borderColor: "#3b4252",
      bgHeaderHovered: "#2e3440",
    },
  },
  sand: {
    label: "Sand",
    hint: "Warm paper light",
    monaco: "vs",
    swatches: ["#f4efe6", "#b45309", "#1c1917"],
    grid: {
      bgCell: "#fffdf8",
      bgHeader: "#f4efe6",
      textDark: "#1c1917",
      textHeader: "#44403c",
      accentColor: "#b45309",
      borderColor: "#e7dccb",
      bgHeaderHovered: "#ebe4d6",
    },
  },
};

export type ExtraTheme = {
  id: string;
  label: string;
  hint: string;
  monaco: "vs-dark" | "vs";
  swatches?: [string, string, string];
  colors?: Record<string, string>;
  grid?: ThemeDef["grid"];
};

const extras: Record<string, ExtraTheme> = {};

export function registerExtraThemes(list: ExtraTheme[]) {
  for (const k of Object.keys(extras)) delete extras[k];
  for (const t of list) {
    if (t?.id) extras[t.id] = t;
  }
}

export function extraThemes(): ExtraTheme[] {
  return Object.values(extras);
}

export function themeDef(id: string): ThemeDef {
  if (THEMES[id as ThemeId]) return THEMES[id as ThemeId];
  const ex = extras[id];
  if (ex) {
    return {
      label: ex.label || id,
      hint: ex.hint || "Plugin theme",
      monaco: ex.monaco === "vs" ? "vs" : "vs-dark",
      swatches: ex.swatches || ["#12141a", "#7aa2f7", "#e8eaed"],
      grid: ex.grid || THEMES.midnight.grid,
    };
  }
  return THEMES.midnight;
}

export function isLightTheme(id: string) {
  if (THEMES[id as ThemeId]) return THEMES[id as ThemeId].monaco === "vs";
  return extras[id]?.monaco === "vs";
}

export function applyTheme(id: ThemeKey) {
  document.documentElement.setAttribute("data-theme", id);
  document.documentElement.classList.toggle("dark", !isLightTheme(id));
  try {
    localStorage.setItem("datarefine.theme", id);
  } catch {
    /* ignore */
  }
}

export function loadTheme(): ThemeKey {
  try {
    const v = localStorage.getItem("datarefine.theme");
    if (v && (THEME_IDS as readonly string[]).includes(v)) return v as ThemeId;
    if (v) return v;
  } catch {
    /* ignore */
  }
  return "midnight";
}
