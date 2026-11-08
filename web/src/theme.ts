import { Effect } from "effect";
import { THEMES, themeOf, type Theme, type ThemeId as Named } from "../../src/themes.ts";
import type { DesktopBridge } from "../../src/types.ts";
import { runUi } from "./api.ts";
import { getStored, setStored } from "./storage.ts";

// The theme is this device's (not a desk setting): the desktop app keeps it, a browser keeps it in its storage, and
// index.html applies it before the first paint. The themes themselves are src/themes.ts's.
export type ThemeId = "system" | Named;
const KEY = "desk.theme"; // index.html reads it too

// Settings → This device's themes after System: the light themes, then the dark, each in the list's order (Light and Dark first).
export const THEME_GROUPS: { label: string; themes: Theme[] }[] = [
  { label: "Light", themes: THEMES.filter((t) => t.scheme === "light") },
  { label: "Dark", themes: THEMES.filter((t) => t.scheme === "dark") },
];

const known = (t: unknown): t is ThemeId => t === "system" || themeOf(t) !== undefined;
export const desktop = (window as Window & { desktop?: DesktopBridge }).desktop;

function stored(): ThemeId | null {
  const t = getStored(KEY);
  return known(t) ? t : null;
}

export function savedTheme(): ThemeId {
  const app = desktop?.theme;
  return known(app) ? app : (stored() ?? "system");
}

// The desktop app keeps it for the next start; an app that refuses it (one too old to know the theme) leaves this window
// showing it anyway, so there's nothing to say.
function keepInApp(id: ThemeId): void {
  if (desktop?.setTheme)
    runUi(Effect.tryPromise({ try: () => desktop?.setTheme?.(id) ?? Promise.resolve(), catch: (e) => e }).pipe(Effect.ignore));
}

export function applyTheme(id: ThemeId): void {
  if (id === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
  setStored(KEY, id === "system" ? null : id);
  keepInApp(id);
}

// A theme picked before the app kept it lives in this origin's storage only: hand it to the app once.
export function adoptTheme(): void {
  const t = stored();
  if (desktop?.theme === null && t) keepInApp(t);
}

const SYSTEM_DIFF = { light: themeOf("light")!.diff, dark: themeOf("dark")!.diff };

// The diff's syntax colours and its light or dark, following the theme on screen: System pairs Light's and Dark's.
export function diffTheme(): { id: string; type: "system" | "light" | "dark"; theme: { light: string; dark: string } } {
  const t = themeOf(document.documentElement.dataset.theme);
  return t
    ? { id: t.id, type: t.scheme, theme: { ...SYSTEM_DIFF, [t.scheme]: t.diff } }
    : { id: "system", type: "system", theme: SYSTEM_DIFF };
}
