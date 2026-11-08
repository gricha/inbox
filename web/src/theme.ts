import { THEMES, themeOf, type Theme, type ThemeId as Named } from "../../src/themes.ts";
import type { DesktopBridge } from "../../src/types.ts";

// The theme is this device's (not a desk setting): the desktop app keeps it, a browser keeps it in its storage, and
// index.html applies it before the first paint. The themes themselves are src/themes.ts's.
export type ThemeId = "system" | Named;
const KEY = "desk.theme"; // index.html reads it too

// Settings → Appearance's choices after System: the light themes, then the dark, each in the list's order (Light and Dark first).
export const THEME_GROUPS: { label: string; themes: Theme[] }[] = [
  { label: "Light", themes: THEMES.filter((t) => t.scheme === "light") },
  { label: "Dark", themes: THEMES.filter((t) => t.scheme === "dark") },
];

const known = (t: unknown): t is ThemeId => t === "system" || themeOf(t) !== undefined;
export const desktop = (window as Window & { desktop?: DesktopBridge }).desktop;

function stored(): ThemeId | null {
  try {
    const t = localStorage.getItem(KEY);
    return known(t) ? t : null;
  } catch {
    return null;
  }
}

export function savedTheme(): ThemeId {
  const app = desktop?.theme;
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
  desktop?.setTheme?.(id).catch(() => {});
}

// A theme picked before the app kept it lives in this origin's storage only: hand it to the app once.
export function adoptTheme(): void {
  const t = stored();
  if (desktop?.setTheme && desktop.theme === null && t) desktop.setTheme(t).catch(() => {});
}

const SYSTEM_DIFF = { light: themeOf("light")!.diff, dark: themeOf("dark")!.diff };

// The diff's syntax colours and its light or dark, following the theme on screen: System pairs Light's and Dark's.
export function diffTheme(): { id: string; type: "system" | "light" | "dark"; theme: { light: string; dark: string } } {
  const t = themeOf(document.documentElement.dataset.theme);
  return t
    ? { id: t.id, type: t.scheme, theme: { ...SYSTEM_DIFF, [t.scheme]: t.diff } }
    : { id: "system", type: "system", theme: SYSTEM_DIFF };
}
