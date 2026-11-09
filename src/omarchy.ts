// The theme Omarchy (basecamp/omarchy) has on, on the machine the desk runs on, for Settings → This device's Omarchy: the
// desk's theme of the same name when it has one, else the desk's tokens made from the theme's colors.toml. The window, in
// the app or a browser here, asks GET /api/omarchy and hears a switch on the event stream.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { fsError, type FsError } from "./errors.ts";
import { themeOf, type ThemeId } from "./themes.ts";
import type { OmarchyTheme } from "./types.ts";

// The desk's themes that are Omarchy's, by Omarchy's names (its themes/<name>): its catppuccin is Mocha, not our Latte.
const SAME: Record<string, ThemeId> = {
  "catppuccin-latte": "catppuccin",
  gruvbox: "gruvbox",
  "tokyo-night": "tokyo-night",
  everforest: "everforest",
  kanagawa: "kanagawa",
  nord: "nord",
  "rose-pine": "rose-pine",
  "flexoki-light": "flexoki-light",
};

// Where Omarchy stages the theme it has on, with its name beside it in theme.name: 4.x's, then 3.x's (whose 1.x and 2.x
// predecessors made `theme` a symlink to the theme's folder, and kept no theme.name).
const CURRENT = [".local/state/omarchy/current", ".config/omarchy/current"];

const currentDir = (home: string) => CURRENT.map((d) => path.join(home, d)).find((d) => fs.existsSync(path.join(d, "theme")));

// colors.toml's `key = "value"` lines, read as Omarchy's own omarchy-theme-color reads them; anything else is skipped.
export function colorsOf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/^\s*([\w-]+)\s*=\s*["']([^"'\n]*)["']/gm)) out[m[1]!] = m[2]!.trim();
  return out;
}

const HEX = /^#[0-9a-f]{6}$/i;

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
const mix = (a: string, b: string, t: number) => {
  const [x, y] = [rgb(a), rgb(b)];
  return toHex(x.map((v, i) => v + (y[i]! - v) * t));
};
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
// Its hue (0–360) and HSL saturation (0–1).
function hueOf(hex: string): { hue: number; sat: number } {
  const [r, g, b] = rgb(hex).map((v) => v / 255) as [number, number, number];
  const [hi, lo] = [Math.max(r, g, b), Math.min(r, g, b)];
  const d = hi - lo;
  if (d === 0) return { hue: 0, sat: 0 };
  const h = hi === r ? ((g - b) / d + 6) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { hue: h * 60, sat: d / (1 - Math.abs(hi + lo - 1)) };
}
// The first colour from `from` toward `to`, in 2% steps, that `ok` takes; `to` if none does.
function first(from: string, to: string, ok: (c: string) => boolean): string {
  for (let t = 0; t <= 1; t += 0.02) {
    const c = mix(from, to, t);
    if (ok(c)) return c;
  }
  return to;
}

// The desk's tokens from an Omarchy palette (its 4.x names, or 3.x's ANSI color0–15), each held to the floors
// web/test/themes.test.ts holds the desk's own themes to: a text colour moves toward white or black until it reads.
export function tokensFrom(colors: Record<string, string>, scheme: "light" | "dark"): Record<string, string> {
  const pick = (...keys: string[]) => keys.map((k) => colors[k]).find((v) => v !== undefined && HEX.test(v));
  const dark = scheme === "dark";
  const sheet = pick("background", "bg", "color0") ?? (dark ? "#1b1f26" : "#ffffff");
  const fg = pick("foreground", "fg", "color7") ?? (dark ? "#eceff4" : "#20242c");
  const bright = pick("bright_foreground", "bright_fg", "color15") ?? fg;
  const edge = dark ? "#ffffff" : "#000000";
  const reach = (c: string, on: string[], min: number) => first(c, edge, (x) => on.every((b) => contrast(x, b) >= min));
  const away = (c: string, min: number) => first(sheet, c, (x) => contrast(x, sheet) >= min);
  const fill = (c: string) =>
    contrast(sheet, c) >= 4.5 ? sheet : contrast(c, "#ffffff") >= contrast(c, "#000000") ? "#ffffff" : "#000000";

  const paper = dark ? mix(sheet, "#000000", 0.15) : mix(sheet, fg, 0.035);
  // The sidebar a step off the paper: darker, or on a sheet already black (Vantablack's), lighter.
  const apart = (x: string) => contrast(x, paper) >= 1.04;
  const darker = dark ? first(paper, "#000000", apart) : mix(sheet, fg, 0.06);
  const side = apart(darker) ? darker : first(paper, fg, apart);
  const wash = away(fg, 1.1);
  const sel = away(fg, 1.08);
  const sideOn = first(side, fg, (x) => contrast(x, side) >= 1.12);
  const ink = reach(bright, [sheet, paper, sel, sideOn, wash], 10.5);
  // The terminal's red, yellow and green, where they are one: here they say CI failed or a review waits, so a theme's red
  // that isn't (Hackerman's is green, Vantablack's grey) gives way to Light's or Dark's.
  const meant = (c: string | undefined, from: number, to: number, fallback: string) => {
    const h = c ? hueOf(c) : null;
    return h && h.sat >= 0.25 && (from < to ? h.hue >= from && h.hue < to : h.hue >= from || h.hue < to) ? c! : fallback;
  };
  const tone = (base: string) => {
    const w = mix(sheet, base, 0.12);
    return { text: reach(base, [sheet, w], 4.6), wash: w };
  };
  const red = tone(meant(pick("red", "color1"), 330, 20, dark ? "#ffb4ab" : "#b42318"));
  const amber = tone(meant(pick("yellow", "color3"), 20, 65, dark ? "#ebc076" : "#8a4b08"));
  const green = meant(pick("green", "color2"), 75, 170, dark ? "#8dceaf" : "#176847");
  const accent = pick("accent", "blue", "color4") ?? (dark ? "#a8cacb" : "#365d60");
  const accentWash = mix(sheet, accent, 0.14);
  return {
    "--paper": paper,
    "--sheet": sheet,
    "--wash": wash,
    "--ink": ink,
    "--ink-2": reach(fg, [sheet], 7.2),
    "--pencil": reach(mix(fg, sheet, 0.3), [sheet, paper, side, sel], 4.7),
    "--faint": away(fg, 2.6),
    "--rule": first(sheet, fg, (x) => contrast(x, sheet) >= 1.15 && contrast(x, side) >= 1.1), // it parts the sidebar too
    "--rule-strong": away(fg, 1.35),
    "--control": away(fg, 2.6),
    "--sel": sel,
    "--side": side,
    "--side-on": sideOn,
    "--side-hover": mix(side, sideOn, 0.5),
    "--red": red.text,
    "--red-wash": red.wash,
    "--amber": amber.text,
    "--amber-wash": amber.wash,
    "--green": reach(green, [sheet], 4.6),
    "--go": green,
    "--on-go": fill(green),
    "--accent": accent,
    "--accent-ink": reach(accent, [sheet, accentWash], 4.6),
    "--accent-wash": accentWash,
    "--on-accent": fill(accent),
    "--shadow": dark
      ? "0 1px 2px rgb(0 0 0 / 35%), 0 12px 32px rgb(0 0 0 / 50%)"
      : "0 1px 2px rgb(0 0 0 / 6%), 0 10px 30px rgb(0 0 0 / 12%)",
    "color-scheme": scheme,
  };
}

const readText = (file: string) =>
  Effect.try({ try: () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null), catch: fsError("read", file) });

// null off Omarchy. Its light or dark as Omarchy decides it: `mode`, the older `theme_type`, a light.mode file beside the
// colours, then the background's brightness.
export function readOmarchy(home = os.homedir()): Effect.Effect<OmarchyTheme | null, FsError> {
  return Effect.gen(function* () {
    const dir = currentDir(home);
    if (!dir) return null;
    const theme = path.join(dir, "theme");
    const named = /\S+/.exec((yield* readText(path.join(dir, "theme.name"))) ?? "")?.[0];
    const name = named ?? path.basename(yield* Effect.try({ try: () => fs.realpathSync(theme), catch: fsError("realpath", theme) }));
    const colors = colorsOf((yield* readText(path.join(theme, "colors.toml"))) ?? "");
    const bg = colors.background ?? colors.bg ?? colors.color0;
    const mode = colors.mode ?? colors.theme_type;
    const light =
      mode === "light" ||
      (mode !== "dark" &&
        (fs.existsSync(path.join(theme, "light.mode")) || (!!bg && HEX.test(bg) && rgb(bg).reduce((a, b) => a + b) > 382)));
    const scheme = light ? "light" : "dark";
    const same = Object.hasOwn(SAME, name) ? themeOf(SAME[name]) : undefined;
    if (same) return { name, scheme: same.scheme, theme: same.id, tokens: null };
    if (!bg) return { name, scheme, theme: scheme, tokens: null }; // nothing to read its colours from: Light or Dark
    return { name, scheme, theme: null, tokens: tokensFrom(colors, scheme) };
  });
}

// Calls back when Omarchy switches theme: it writes theme.name last. Polled, so a folder replaced under it is still seen;
// nothing to watch off Omarchy. Returns the stop.
export function watchOmarchy(onSwitch: () => void, home = os.homedir(), interval = 1000): () => void {
  const files = CURRENT.map((d) => path.join(home, d))
    .filter((d) => fs.existsSync(d))
    .map((d) => path.join(d, "theme.name"));
  const listener = () => {
    onSwitch();
  };
  for (const f of files) fs.watchFile(f, { interval, persistent: false }, listener);
  return () => {
    for (const f of files) fs.unwatchFile(f, listener);
  };
}
