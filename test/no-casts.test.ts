// What the linters ban stays banned: an unchecked cast (typescript/no-unsafe-type-assertion) is allowed in src/narrow.ts,
// whose helpers check first, and in the few reads of what the desk itself wrote, counted here so the list only shrinks; and
// no effect may skip its dependencies (react/exhaustive-effect-dependencies).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.join(import.meta.dirname, "..");
function files(dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const f = path.join(dir, e.name);
    return e.isDirectory() ? files(f) : /\.(ts|tsx)$/.test(e.name) ? [f] : [];
  });
}
const code = ["src", "web/src", "web/mock", "electron", "scripts"].flatMap(files);
const disabling = (rule: RegExp) =>
  code.flatMap((f) =>
    fs
      .readFileSync(path.join(root, f), "utf8")
      .split("\n")
      .flatMap((l, i) => (l.includes("oxlint-disable") && rule.test(l) ? [`${f}:${i + 1}`] : [])),
  );

// The stored items table and the desk's own API answers, typed by src/types.ts: a schema for each would be the next step.
const KNOWN: Record<string, number> = { "src/store.ts": 4, "src/client.ts": 1, "web/src/api.ts": 1 };

test("unchecked casts live only in src/narrow.ts and the known reads of the desk's own data", () => {
  const per: Record<string, number> = {};
  for (const at of disabling(/no-unsafe-type-assertion/)) {
    const f = at.slice(0, at.indexOf(":"));
    if (f !== "src/narrow.ts") per[f] = (per[f] ?? 0) + 1;
  }
  assert.deepEqual(per, KNOWN);
});

test("no effect skips its dependencies", () => {
  assert.deepEqual(disabling(/exhaustive-effect-dependencies|exhaustive-deps/), []);
});
