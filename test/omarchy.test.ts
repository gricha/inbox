// Omarchy's theme as the desk reads it, from a scratch HOME laid out as Omarchy lays out its own.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { readOmarchy, watchOmarchy } from "../src/omarchy.ts";
import { run } from "./helpers/run.ts";

let home = "";
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-omarchy-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const TOKYO = `mode = "dark"\naccent = "#7aa2f7"\nbackground = "#1a1b26"\nforeground = "#a9b1d6"\nred = "#f7768e"\n`;
const HACKERMAN = `mode = "dark"\naccent = "#82FB9C"\nbackground = "#0B0C16"\nforeground = "#ddf7ff"\nred = "#50f872"\n`;

// Omarchy 4's: the staged theme under ~/.local/state, its name written beside it last; `at` for 3.x's ~/.config.
function wear(name: string, files: Record<string, string>, at = ".local/state/omarchy/current"): void {
  const dir = path.join(home, at);
  fs.rmSync(path.join(dir, "theme"), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "theme"), { recursive: true });
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, "theme", f), text);
  fs.writeFileSync(path.join(dir, "theme.name"), `${name}\n`);
}

test("off Omarchy there's no theme to follow", async () => {
  assert.equal(await run(readOmarchy(home)), null);
});

test("a theme the desk has is the desk's, by Omarchy's name: catppuccin-latte is Catppuccin Latte, catppuccin isn't", async () => {
  wear("tokyo-night", { "colors.toml": TOKYO });
  assert.deepEqual(await run(readOmarchy(home)), { name: "tokyo-night", scheme: "dark", theme: "tokyo-night", tokens: null });
  wear("catppuccin-latte", { "colors.toml": `mode = "light"\nbackground = "#eff1f5"\nforeground = "#4c4f69"\n` });
  assert.equal((await run(readOmarchy(home)))?.theme, "catppuccin");
  wear("catppuccin", { "colors.toml": `mode = "dark"\nbackground = "#1e1e2e"\nforeground = "#cdd6f4"\n` });
  const mocha = await run(readOmarchy(home));
  assert.equal(mocha?.theme, null, "Omarchy's Catppuccin is Mocha, not the desk's Latte");
  assert.equal(mocha?.tokens?.["--sheet"], "#1e1e2e");
});

test("one the desk hasn't got is made from its colours, in its light or dark", async () => {
  wear("hackerman", { "colors.toml": HACKERMAN });
  const t = await run(readOmarchy(home));
  assert.equal(t?.theme, null);
  assert.equal(t?.scheme, "dark");
  assert.equal(t?.tokens?.["--sheet"], "#0B0C16");
  assert.equal(t?.tokens?.["--accent"], "#82FB9C");
  assert.equal(t?.tokens?.["color-scheme"], "dark");
});

test("Omarchy 3's: under ~/.config, the terminal's colours, light by its light.mode file", async () => {
  wear(
    "paper",
    { "colors.toml": `background = "#f8f8f2"\nforeground = "#383a42"\ncolor1 = "#e45649"\ncolor4 = "#4078f2"\n`, "light.mode": "" },
    ".config/omarchy/current",
  );
  const t = await run(readOmarchy(home));
  assert.equal(t?.name, "paper");
  assert.equal(t?.scheme, "light");
  assert.equal(t?.tokens?.["--sheet"], "#f8f8f2");
  assert.equal(t?.tokens?.["--accent"], "#4078f2", "no accent: its blue");
});

test("no colours to read: Light or Dark, by its mode, or else its background", async () => {
  wear("mine", {});
  assert.deepEqual(await run(readOmarchy(home)), { name: "mine", scheme: "dark", theme: "dark", tokens: null });
  wear("mine", { "light.mode": "" });
  assert.equal((await run(readOmarchy(home)))?.theme, "light");
  wear("bright", { "colors.toml": `background = "#fdf6e3"\nforeground = "#657b83"\n` });
  assert.equal((await run(readOmarchy(home)))?.scheme, "light", "a light background, no mode");
});

test("Omarchy 1 and 2: the current theme a symlink to its folder, named by it", async () => {
  const themes = path.join(home, ".config/omarchy/themes/nord");
  fs.mkdirSync(themes, { recursive: true });
  fs.mkdirSync(path.join(home, ".config/omarchy/current"), { recursive: true });
  // A junction on Windows, which needs no privilege; elsewhere the type is ignored.
  fs.symlinkSync(themes, path.join(home, ".config/omarchy/current/theme"), "junction");
  assert.equal((await run(readOmarchy(home)))?.theme, "nord");
});

test("a switch is heard: Omarchy writes theme.name last", async () => {
  wear("tokyo-night", { "colors.toml": TOKYO });
  let heard = 0;
  const stop = watchOmarchy(
    () => {
      heard++;
    },
    home,
    20,
  );
  await sleep(100);
  wear("hackerman", { "colors.toml": HACKERMAN });
  for (let i = 0; i < 100; i++) {
    if (heard) break;
    await sleep(20);
  }
  stop();
  assert.ok(heard > 0, "no switch heard");
  assert.equal((await run(readOmarchy(home)))?.name, "hackerman");
});
