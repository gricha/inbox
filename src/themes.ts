// Every theme Settings → Appearance offers, in one plain list the window, the desktop app, the shots and the tests read.
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
  { id: "light", label: "Light", scheme: "light", paper: "#f7f7f5", pencil: "#62676f", diff: "pierre-light" },
  { id: "dark", label: "Dark", scheme: "dark", paper: "#151618", pencil: "#9599a1", diff: "pierre-dark" },
  { id: "sand", label: "Sand", scheme: "light", paper: "#f3eee5", pencil: "#73685a", diff: "pierre-light" },
  { id: "slate", label: "Slate", scheme: "dark", paper: "#1b2028", pencil: "#8e98a5", diff: "pierre-dark" },
  { id: "solarized", label: "Solarized", scheme: "light", paper: "#f6efdc", pencil: "#4f646b", diff: "solarized-light-desk" },
  { id: "catppuccin", label: "Catppuccin Latte", scheme: "light", paper: "#e6e9ef", pencil: "#5c5f77", diff: "catppuccin-latte-desk" },
  { id: "sentry", label: "Sentry", scheme: "dark", paper: "#181225", pencil: "#9d95b0", diff: "pierre-dark-soft-desk" },
  { id: "gruvbox", label: "Gruvbox", scheme: "dark", paper: "#1f1d1c", pencil: "#a89984", diff: "gruvbox-dark-medium" },
  { id: "tokyo-night", label: "Tokyo Night", scheme: "dark", paper: "#15161f", pencil: "#838cb4", diff: "tokyo-night-desk" },
] as const satisfies readonly Theme[];

export type ThemeId = (typeof THEMES)[number]["id"];

export const themeOf = (id: unknown): Theme | undefined => THEMES.find((t) => t.id === id);
