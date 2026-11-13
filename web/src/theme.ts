import { Effect, Schema } from "effect";
import { THEMES, themeOf, type Theme, type ThemeId as Named } from "../../src/themes.ts";
import type { DesktopBridge, OmarchyTheme } from "../../src/types.ts";
import { api, runUi } from "./api.ts";
import { getStored, setStored } from "./storage.ts";

// The theme is this device's (not a desk setting): the desktop app keeps it, a browser keeps it in its storage, and
// index.html applies it before the first paint. The themes themselves are src/themes.ts's; Omarchy follows the theme
// Omarchy has on, as the desk reads it (src/omarchy.ts).
export type ThemeId = "system" | "omarchy" | Named;
const KEY = "desk.theme"; // index.html reads it too
const OMARCHY = "desk.omarchy"; // Omarchy's theme as last shown: index.html paints it before the desk answers

// Settings → This device's themes after System: the light themes, then the dark, each in the list's order (Light and Dark first).
export const THEME_GROUPS: { label: string; themes: Theme[] }[] = [
  { label: "Light", themes: THEMES.filter((t) => t.scheme === "light") },
  { label: "Dark", themes: THEMES.filter((t) => t.scheme === "dark") },
];

export const isThemeId = (t: unknown): t is ThemeId => t === "system" || t === "omarchy" || themeOf(t) !== undefined;
export const desktop = (window as Window & { desktop?: DesktopBridge }).desktop;

function stored(): ThemeId | null {
  const t = getStored(KEY);
  return isThemeId(t) ? t : null;
}

function saved(): ThemeId {
  const app = desktop?.theme;
  return isThemeId(app) ? app : (stored() ?? "system");
}
let picked = saved(); // the app's or this browser's at the start, then what Settings picks
export const savedTheme = () => picked;

// The desktop app keeps it for the next start; an app that refuses it (one too old to know the theme) leaves this window
// showing it anyway, so there's nothing to say.
function keepInApp(id: ThemeId): void {
  if (desktop?.setTheme)
    runUi(Effect.tryPromise({ try: () => desktop?.setTheme?.(id) ?? Promise.resolve(), catch: (e) => e }).pipe(Effect.ignore));
}

let omarchy: OmarchyTheme | null = null; // the desk's reading; null off Omarchy or until it answers
const listeners = new Set<() => void>();

// Omarchy shows the desk's theme of its name, or the tokens made from its colours inline; off Omarchy, System's.
function paint(id: ThemeId): void {
  const root = document.documentElement;
  root.removeAttribute("style"); // only a theme made from Omarchy's colours sets it
  const o = id === "omarchy" ? omarchy : null;
  for (const [k, v] of Object.entries(o?.tokens ?? {})) root.style.setProperty(k, v);
  const t = id === "omarchy" ? (o ? (o.theme ?? "omarchy") : "system") : id;
  if (t === "system") delete root.dataset.theme;
  else root.dataset.theme = t;
  if (id === "omarchy") setStored(OMARCHY, o && JSON.stringify(o));
}

export function applyTheme(id: ThemeId): void {
  picked = id;
  paint(id);
  setStored(KEY, id === "system" ? null : id);
  keepInApp(id);
}

// A theme picked before the app kept it lives in this origin's storage only: hand it to the app once.
export function adoptTheme(): void {
  const t = stored();
  if (desktop?.theme === null && t) keepInApp(t);
}

// The event stream's `omarchy` payload.
export const OmarchyAnswer = Schema.NullOr(
  Schema.Struct({
    name: Schema.String,
    scheme: Schema.Literals(["light", "dark"]),
    theme: Schema.NullOr(Schema.String),
    tokens: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
  }),
);

// The desk's reading of Omarchy's theme, at the start and on each switch: shown at once when Omarchy is this device's.
export function omarchyIs(o: OmarchyTheme | null): void {
  omarchy = o;
  if (picked === "omarchy") paint("omarchy");
  for (const fn of listeners) fn();
}

// A desk too old to know Omarchy, or one not answering, leaves the theme as it is.
export const loadOmarchy = () => api.omarchy().pipe(Effect.map(omarchyIs), Effect.ignore);

// For Settings: Omarchy's theme while the desk reads one, and its name as Omarchy says it (tokyo-night is Tokyo Night).
export const omarchyTheme = () => omarchy;
export const omarchyName = (name: string) =>
  name.replaceAll(/(^|-)(\w)/g, (_, dash: string, c: string) => `${dash && " "}${c.toUpperCase()}`);
export function onOmarchy(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const SYSTEM_DIFF = { light: themeOf("light")!.diff, dark: themeOf("dark")!.diff };

// The diff's syntax colours and its light or dark, following the theme on screen: System pairs Light's and Dark's, and
// one made from Omarchy's colours takes Light's or Dark's.
export function diffTheme(): { id: string; type: "system" | "light" | "dark"; theme: { light: string; dark: string } } {
  const on = document.documentElement.dataset.theme;
  const t = themeOf(on);
  if (t) return { id: t.id, type: t.scheme, theme: { ...SYSTEM_DIFF, [t.scheme]: t.diff } };
  if (on === "omarchy" && omarchy) return { id: `omarchy-${omarchy.scheme}`, type: omarchy.scheme, theme: SYSTEM_DIFF };
  return { id: "system", type: "system", theme: SYSTEM_DIFF };
}
