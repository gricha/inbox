// Every theme Settings → This device offers, in one plain list the window, the desktop app, the shots and the tests read.
// Each one's tokens are in web/src/styles.css: Light's in :root, the others' in :root[data-theme="<id>"]. A new theme is a
// row here, its block there and its id in web/index.html's pre-paint list (web/test/themes.test.ts holds them together).
export interface Theme {
  id: string;
  label: string;
  scheme: "light" | "dark";
  paper: string; // its --paper: the desktop window's background before the UI paints
  pencil: string; // its --pencil: the window's text before the UI paints
  diff: string; // the diff's syntax colours: a theme in Pierre's catalog (its own, or one Shiki bundles), or the desk's copy of one (web/src/diffThemes.ts)
}

export const THEMES = [
  { id: "light", label: "Light", scheme: "light", paper: "#f5f6f8", pencil: "#5c6573", diff: "pierre-light-desk" },
  { id: "dark", label: "Dark", scheme: "dark", paper: "#14171c", pencil: "#a7b0be", diff: "pierre-dark-desk" },
  { id: "sand", label: "Sand", scheme: "light", paper: "#f3eee5", pencil: "#73685a", diff: "pierre-light-desk" },
  { id: "slate", label: "Slate", scheme: "dark", paper: "#1b2028", pencil: "#8e98a5", diff: "pierre-dark-desk" },
  { id: "solarized", label: "Solarized", scheme: "light", paper: "#f6efdc", pencil: "#4f646b", diff: "solarized-light-desk" },
  { id: "catppuccin", label: "Catppuccin Latte", scheme: "light", paper: "#e6e9ef", pencil: "#5c5f77", diff: "catppuccin-latte-desk" },
  { id: "sentry", label: "Sentry Dusk", scheme: "dark", paper: "#1c1925", pencil: "#abaab2", diff: "sentry-dusk-desk" },
  { id: "sentry-dawn", label: "Sentry Dawn", scheme: "light", paper: "#f6f5f8", pencil: "#6a6383", diff: "github-light-default-desk" },
  { id: "gruvbox", label: "Gruvbox", scheme: "dark", paper: "#1f1d1c", pencil: "#a89984", diff: "gruvbox-dark-medium-desk" },
  { id: "tokyo-night", label: "Tokyo Night", scheme: "dark", paper: "#15161f", pencil: "#838cb4", diff: "tokyo-night-desk" },
  // Omarchy's own, by its names: its themes/<id>, mapped from each one's published palette.
  { id: "everforest", label: "Everforest", scheme: "dark", paper: "#272e33", pencil: "#9da9a0", diff: "everforest-dark" },
  { id: "kanagawa", label: "Kanagawa", scheme: "dark", paper: "#1a1a22", pencil: "#a09c87", diff: "kanagawa-wave" },
  { id: "nord", label: "Nord", scheme: "dark", paper: "#292e39", pencil: "#adb5c4", diff: "nord-desk" },
  { id: "rose-pine", label: "Rose Pine", scheme: "light", paper: "#faf4ed", pencil: "#65617f", diff: "rose-pine-dawn-desk" },
  { id: "flexoki-light", label: "Flexoki Light", scheme: "light", paper: "#f2f0e5", pencil: "#64635e", diff: "flexoki-light-desk" },
] as const satisfies readonly Theme[];

export type ThemeId = (typeof THEMES)[number]["id"];

export const themeOf = (id: unknown): Theme | undefined => THEMES.find((t) => t.id === id);
