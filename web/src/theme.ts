// The theme is this device's, kept in its browser storage (not a desk setting); index.html applies it before the first paint.
export const THEMES = [
  { id: "system", label: "System", diff: "system" },
  { id: "light", label: "Light", diff: "light" },
  { id: "dark", label: "Dark", diff: "dark" },
  { id: "sand", label: "Sand", diff: "light" },
  { id: "slate", label: "Slate", diff: "dark" },
] as const;
export type ThemeId = (typeof THEMES)[number]["id"];
const KEY = "desk.theme"; // index.html reads it too

const known = (t: string | null | undefined): t is ThemeId => THEMES.some((x) => x.id === t);

export function savedTheme(): ThemeId {
  try {
    const t = localStorage.getItem(KEY);
    return known(t) ? t : "system";
  } catch {
    return "system";
  }
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
}

// The diff's own light or dark, following the theme on screen.
export function diffTheme(): "system" | "light" | "dark" {
  const t = document.documentElement.dataset.theme;
  return known(t) ? THEMES.find((x) => x.id === t)!.diff : "system";
}
