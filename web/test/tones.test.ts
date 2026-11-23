// The tones (.t-bad, .t-warn, .t-good) come last in styles.css so they beat any one class's colour; an error drawn
// grey was the bug this keeps out.
import "../../test/helpers/no-agent.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const css = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "styles.css"), "utf8").replaceAll(/\/\*[\s\S]*?\*\//g, "");

const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) => (m[1] ?? "").trim());

test("the three tone rules are the last rules in the file", () => {
  assert.deepEqual(selectors.slice(-3), [".t-bad", ".t-warn", ".t-good"]);
  assert.equal(selectors.filter((s) => /^\.t-(bad|warn|good)$/.test(s)).length, 3);
});

test("no rule steps around a tone with :not(.t-…)", () => {
  assert.deepEqual(
    selectors.filter((s) => s.includes(":not(.t-")),
    [],
  );
});
