// One geometry for the mark: assets/brand/mark.svg, copied into the window's Mark and written into every icon by npm run icons.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const paths = (f: string) => [...fs.readFileSync(new URL(f, root), "utf8").matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);

test("the window's Mark and every icon draw the paths of assets/brand/mark.svg", () => {
  const mark = paths("assets/brand/mark.svg");
  assert.equal(mark.length, 2);
  for (const f of [
    "web/src/components/Mark.tsx",
    "assets/brand/tile.svg",
    "assets/icon.svg",
    "web/public/icon.svg",
    "web/public/icon-maskable.svg",
  ])
    assert.deepEqual(paths(f), mark, f);
});
