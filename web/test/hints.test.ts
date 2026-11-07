// The window names no key: no <kbd> chip, and no key written in the words it shows.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const tsx = fs
  .readdirSync(new URL("web/src/", root), { encoding: "utf8", recursive: true })
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => `web/src/${f}`);
// What the desk puts in the window: Settings' help, the 409s and 403s a toast shows, the first-run config.
const desk = ["src/settings.ts", "src/desk.ts", "src/server.ts", "src/config.ts"];
const lines = (f: string) => fs.readFileSync(new URL(f, root), "utf8").split("\n");

test("no key chip anywhere in the window: every action is named in words", () => {
  const found = tsx.flatMap((f) => lines(f).flatMap((l, i) => (l.includes("<kbd") ? [`${f}:${i + 1}`] : [])));
  assert.deepEqual(found, []);
});

// "(a)", "(g b)", "(a in ...)", "press i", "w starts it", "d on it": a key named in a string, not a button.
const HINT =
  / \((?:[a-z.,@/?]|g [a-z]|esc|enter)\)| \([a-z.,@/?] in |\b[Pp]ress(?:es|ing)? [a-z.,@/?](?![a-z])|\b[a-z] (?:starts|tries|wakes|brings|hands|asks|opens|closes|undoes|says|on it)\b/;
const STRING = /(["'`])(?:\\.|(?!\1).)*\1/g;

test("no key written in words: titles, placeholders, flashes, help and the desk's errors name buttons", () => {
  const found = [...tsx, ...desk].flatMap((f) =>
    lines(f).flatMap((l, i) =>
      !/^\s*(\/\/|\/\*|\{\/\*|\*)/.test(l) && [...l.matchAll(STRING)].some((m) => HINT.test(m[0])) ? [`${f}:${i + 1}`] : [],
    ),
  );
  assert.deepEqual(found, []);
});
