// Settings → This device's themes: src/themes.ts lists them, web/src/styles.css holds their tokens, and the copies that can't
// import the list (index.html's pre-paint script, the window's colours) agree with both.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveTheme } from "@pierre/diffs";
import { themeColors } from "../../electron/lib.ts";
import { colorsOf, tokensFrom } from "../../src/omarchy.ts";
import { THEMES } from "../../src/themes.ts";
import "../src/diffThemes.ts";

const web = path.join(import.meta.dirname, "..");
const css = fs.readFileSync(path.join(web, "src/styles.css"), "utf8").replaceAll(/\/\*[^]*?\*\//g, "");
const html = fs.readFileSync(path.join(web, "index.html"), "utf8");

// The declarations of the first rule with exactly this selector, from `from` on.
function block(selector: string, from = 0): Map<string, string> | null {
  const at = css.indexOf(`${selector} {`, from);
  if (at < 0) return null;
  const body = css.slice(at + selector.length + 2, css.indexOf("}", at));
  return new Map([...body.matchAll(/([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}
const tokensOf = (id: string) => block(id === "light" ? ":root" : `:root[data-theme="${id}"]`);
const BASE = tokensOf("light")!;
const SHARED = new Set(["--sans", "--mono", "--title-size", "--meta-size", "color-scheme"]); // type, the same in every theme
const TOKENS = [...BASE.keys()].filter((k) => !SHARED.has(k));

// WCAG 2.x contrast of two sRGB hex colours.
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.replaceAll(/./g, "$&$&") : h;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

// [text, on, at least, at most]
const TARGETS: [string, string, number, number?][] = [
  ["--ink", "--sheet", 10],
  ["--ink", "--paper", 10],
  ["--ink", "--sel", 8],
  ["--ink", "--side-on", 8],
  ["--ink", "--wash", 8],
  ["--ink-2", "--sheet", 7],
  ["--pencil", "--sheet", 4.5], // 13px meta text
  ["--pencil", "--paper", 4.5],
  ["--pencil", "--side", 4.5],
  ["--pencil", "--sel", 4.2],
  ["--faint", "--sheet", 2.2, 4.5], // deliberately quiet: placeholders, separators in text
  ["--accent-ink", "--sheet", 4.5],
  ["--accent-ink", "--accent-wash", 4.5],
  ["--on-accent", "--accent", 4.5], // the filled call to action
  ["--on-go", "--go", 4.5], // Approve, Hand off for merge
  ["--red", "--sheet", 4.5],
  ["--red", "--red-wash", 4.5],
  ["--amber", "--sheet", 4.5],
  ["--amber", "--amber-wash", 4.5],
  ["--green", "--sheet", 4.5],
  ["--rule", "--sheet", 1.08, 1.6], // a hairline: visible, never loud
  ["--rule-strong", "--sheet", 1.2, 2.3],
  ["--control", "--sheet", 2.4],
  ["--sel", "--sheet", 1.06], // a selected row reads
  ["--side", "--paper", 1.02],
];
// Sand predates these targets and its colours stay as designed: its pencil sits just under them on the sidebar and a selected row.
const EXCEPT: Record<string, Record<string, number>> = { sand: { "--pencil on --side": 4.34, "--pencil on --sel": 4.04 } };

test("every theme has a block in styles.css with every token, in its light or dark", () => {
  for (const t of THEMES) {
    const tokens = tokensOf(t.id);
    assert.ok(tokens, `no block for ${t.id}`);
    assert.deepEqual(
      TOKENS.filter((k) => !tokens.has(k)),
      [],
      `${t.id} misses tokens`,
    );
    if (t.id !== "light")
      assert.deepEqual(
        [...tokens.keys()].filter((k) => !BASE.has(k)),
        [],
        `${t.id} sets tokens :root doesn't`,
      );
    assert.equal(tokens.get("color-scheme"), t.scheme, `${t.id}'s color-scheme`);
  }
});

test("every theme meets the contrast targets", () => {
  const misses: string[] = [];
  for (const t of THEMES) {
    const tokens = tokensOf(t.id)!;
    for (const [fg, bg, min, max] of TARGETS) {
      const pair = `${fg} on ${bg}`;
      const ratio = contrast(tokens.get(fg)!, tokens.get(bg)!);
      const floor = EXCEPT[t.id]?.[pair] ?? min;
      if (ratio < floor || (max !== undefined && ratio > max))
        misses.push(`${t.id}: ${pair} is ${ratio.toFixed(2)}, wants ${floor}${max ? ` to ${max}` : "+"}`);
    }
  }
  assert.deepEqual(misses, []);
});

// Omarchy's own themes the desk hasn't got (their colors.toml as Omarchy 4.5 ships them, cut to what the desk reads), and
// a 3.x one in the terminal's color0–15.
const OMARCHY: Record<string, string> = {
  catppuccin: `mode = "dark"\naccent = "#89b4fa"\nbackground = "#1e1e2e"\nforeground = "#cdd6f4"\nred = "#f38ba8"\nyellow = "#f9e2af"\ngreen = "#a6e3a1"`,
  ethereal: `mode = "dark"\naccent = "#7d82d9"\nbackground = "#060B1E"\nforeground = "#ffcead"\nred = "#ED5B5A"\nyellow = "#E9BB4F"\ngreen = "#92a593"`,
  hackerman: `mode = "dark"\naccent = "#82FB9C"\nbackground = "#0B0C16"\nforeground = "#ddf7ff"\nred = "#50f872"\nyellow = "#50f7d4"\ngreen = "#4fe88f"`,
  "matte-black": `mode = "dark"\naccent = "#e68e0d"\nbackground = "#121212"\nforeground = "#bebebe"\nred = "#D35F5F"\nyellow = "#b91c1c"\ngreen = "#FFC107"`,
  "retro-82": `mode = "dark"\naccent = "#faa968"\nbackground = "#05182e"\nforeground = "#f6dcac"\nred = "#f85525"\nyellow = "#e97b3c"\ngreen = "#028391"`,
  vantablack: `mode = "dark"\naccent = "#8d8d8d"\nbackground = "#000000"\nforeground = "#ffffff"\nred = "#a4a4a4"\nyellow = "#cecece"\ngreen = "#b6b6b6"`,
  lupine: `mode = "light"\naccent = "#3264eb"\nbackground = "#fafafa"\nforeground = "#212121"\nbright_foreground = "#000000"\nred = "#c900c4"\nyellow = "#026fde"\ngreen = "#4a2fd0"`,
  white: `mode = "light"\naccent = "#6e6e6e"\nbackground = "#ffffff"\nforeground = "#000000"\nred = "#2a2a2a"\nyellow = "#4a4a4a"\ngreen = "#3a3a3a"`,
  "nord (3.x)": `accent = "#81a1c1"\nforeground = "#d8dee9"\nbackground = "#2e3440"\ncolor1 = "#bf616a"\ncolor2 = "#a3be8c"\ncolor3 = "#ebcb8b"\ncolor15 = "#eceff4"`,
};

test("an Omarchy theme the desk hasn't got, made into tokens, sets every token and meets the contrast targets", () => {
  const misses: string[] = [];
  for (const [name, text] of Object.entries(OMARCHY)) {
    const colors = colorsOf(text);
    const tokens = tokensFrom(colors, colors.mode === "light" ? "light" : "dark");
    assert.deepEqual(Object.keys(tokens).sort(), [...BASE.keys()].filter((k) => k === "color-scheme" || !SHARED.has(k)).sort(), name);
    for (const [fg, bg, min, max] of TARGETS) {
      const ratio = contrast(tokens[fg]!, tokens[bg]!);
      if (ratio < min || (max !== undefined && ratio > max))
        misses.push(`${name}: ${fg} on ${bg} is ${ratio.toFixed(2)}, wants ${min}${max ? ` to ${max}` : "+"}`);
    }
  }
  assert.deepEqual(misses, []);
});

test("a theme's red, yellow or green that isn't one gives way to the desk's: they carry information", () => {
  const hackerman = tokensFrom(colorsOf(OMARCHY.hackerman!), "dark");
  assert.equal(hackerman["--red"], tokensOf("dark")!.get("--red"), "Hackerman's red is green");
  assert.equal(hackerman["--go"], "#4fe88f", "its green is one");
  assert.equal(tokensFrom(colorsOf(OMARCHY.white!), "light")["--go"], tokensOf("light")!.get("--go"), "White's green is grey");
  assert.equal(tokensFrom(colorsOf(OMARCHY.catppuccin!), "dark")["--accent"], "#89b4fa");
});

test("the system's dark is the Dark theme", () => {
  const media = css.indexOf("@media (prefers-color-scheme: dark) {");
  assert.ok(media >= 0, "no system dark");
  assert.deepEqual(block(":root:not([data-theme])", media), tokensOf("dark"));
});

test("index.html paints the same themes and colours before the UI loads", () => {
  const list = /\[([^\]]*)\]\.includes\(t\)/.exec(html)?.[1];
  assert.ok(list, "no theme list in index.html's pre-paint script");
  // Prettier lays a long list out one id a line, with a trailing comma.
  assert.deepEqual(
    JSON.parse(`[${list.replace(/,\s*$/, "")}]`),
    THEMES.map((t) => t.id),
  );
  const meta = (scheme: string) =>
    new RegExp(`name="theme-color" content="(#[0-9a-f]+)" media="\\(prefers-color-scheme: ${scheme}\\)"`).exec(html)?.[1];
  assert.equal(meta("light"), tokensOf("light")!.get("--paper"));
  assert.equal(meta("dark"), tokensOf("dark")!.get("--paper"));
});

test("the desktop window's colours before the UI paints are each theme's paper and pencil", () => {
  for (const t of THEMES) {
    const tokens = tokensOf(t.id)!;
    assert.deepEqual({ paper: t.paper, pencil: t.pencil }, { paper: tokens.get("--paper"), pencil: tokens.get("--pencil") }, t.id);
    assert.deepEqual(themeColors(t.id, t.scheme !== "dark"), { paper: t.paper, pencil: t.pencil }, t.id);
  }
});

test("every theme's diff colours are a theme Pierre has, in the same light or dark", async () => {
  for (const t of THEMES) assert.equal((await resolveTheme(t.diff)).type, t.scheme, t.id);
});

test("every theme's diff draws its code at 4.5:1 on the sheet and every colour at 3:1", async () => {
  const misses: string[] = [];
  for (const t of THEMES) {
    const sheet = tokensOf(t.id)!.get("--sheet")!;
    const theme = await resolveTheme(t.diff);
    if (contrast(theme.fg, sheet) < 4.5) misses.push(`${t.id}: its text ${theme.fg}`);
    for (const s of theme.textmate?.settings ?? []) {
      const fg = s.settings?.foreground?.slice(0, 7);
      if (fg && /^#[0-9a-f]{6}$/i.test(fg) && contrast(fg, sheet) < 3) misses.push(`${t.id}: ${fg} (${String(s.scope)})`);
    }
  }
  assert.deepEqual(misses, []);
});
