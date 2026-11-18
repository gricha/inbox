// Every size comes from the type scale on :root (docs/visual.md → Type); the few that keep their own are listed here,
// so a new raw size fails and the list only shrinks.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const css = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "styles.css"), "utf8").replaceAll(/\/\*[\s\S]*?\*\//g, "");

// Each font-size or font declaration with the selector of the block it's in.
function sizes(): { selector: string; value: string }[] {
  const out: { selector: string; value: string }[] = [];
  let selector = "";
  for (const line of css.split("\n")) {
    if (line.includes("{")) selector = line.slice(0, line.indexOf("{")).trim();
    const m = /^\s*font(?:-size)?:\s*([^;]+);/.exec(line);
    if (m?.[1]) out.push({ selector, value: m[1].trim() });
  }
  return out;
}

// Code and diagrams keep their own sizes, so do sizes relative to their parent.
const own = (v: string) => /var\(--text-|^inherit$|^[\d.]+em\b|var\(--mono\)|var\(--diagram\)/.test(v);

// The page's default, the drop glyph, and the diagrams' and rules' code labels drawn in the sans.
const KNOWN = [
  "body: 15px/1.5 var(--sans)",
  ".chat-drop: 15px",
  ".dg-head: 12.5px",
  ".dg-label: 11.5px",
  ".dg-group text: 11px",
  ".dg-note text: 11.5px",
  ".dg-text: 13px",
  ".hard-rules code: 12px",
  ".builtin-rules code: 12px",
];

test("a size is a step of the type scale, or one of the few known to keep their own", () => {
  const raw = sizes()
    .filter((s) => s.selector !== ":root" && !own(s.value))
    .map((s) => `${s.selector}: ${s.value}`);
  assert.deepEqual(raw, KNOWN);
});

test("every step used is defined on :root", () => {
  const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const defined = new Set([...root.matchAll(/(--text-[\w-]+):/g)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--text-[\w-]+)\)/g)].map((m) => m[1]));
  assert.deepEqual(
    [...used].filter((t) => !defined.has(t)),
    [],
  );
});
