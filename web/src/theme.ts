import type { DesktopBridge } from "../../src/types.ts";

// The theme is this device's (not a desk setting): the desktop app keeps it, a browser keeps it in its storage, and
// index.html applies it before the first paint.
export const THEMES = [
  { id: "system", label: "System", diff: "system" },
  { id: "light", label: "Light", diff: "light" },
  { id: "dark", label: "Dark", diff: "dark" },
  { id: "sand", label: "Sand", diff: "light" },
  { id: "slate", label: "Slate", diff: "dark" },
] as const;
export type ThemeId = (typeof THEMES)[number]["id"];
const KEY = "desk.theme"; // index.html reads it too

const known = (t: unknown): t is ThemeId => THEMES.some((x) => x.id === t);
const desktop = () => (window as Window & { desktop?: DesktopBridge }).desktop;

function stored(): ThemeId | null {
  try {
    const t = localStorage.getItem(KEY);
    return known(t) ? t : null;
  } catch {
    return null;
  }
}

export function savedTheme(): ThemeId {
  const app = desktop()?.theme;
  return known(app) ? app : (stored() ?? "system");
}

export function applyTheme(id: ThemeId): void {
  if (id === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
  try {
    if (id === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, id);
  } catch {
    // storage off (a private window): the theme holds until the window closes
  }
  desktop()
    ?.setTheme?.(id)
    .catch(() => {});
}

// A theme picked before the app kept it lives in this origin's storage only: hand it to the app once.
export function adoptTheme(): void {
  const d = desktop();
  const t = stored();
  if (d?.setTheme && d.theme === null && t) d.setTheme(t).catch(() => {});
}

// The diff's own light or dark, following the theme on screen.
export function diffTheme(): "system" | "light" | "dark" {
  const t = document.documentElement.dataset.theme;
  return known(t) ? THEMES.find((x) => x.id === t)!.diff : "system";
}
