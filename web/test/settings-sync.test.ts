// Settings is one thing everywhere: every setting sits in a part the sidebar lists, the desk (`desk settings`, More's
// button) names each part as the sidebar does, and the docs and every "Settings → …" path name parts that exist. A
// rename, a moved setting or a new part fails here until all of them agree.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { SECTIONS, SETTINGS } from "../../src/settings.ts";
import { SETTINGS_PARTS } from "../src/settings-parts.ts";
import { SETTINGS_VIEWS } from "../src/view.ts";

const root = path.join(import.meta.dirname, "../..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const core = SETTINGS_PARTS.filter((p) => !p.plugin);
const names = [...SETTINGS_PARTS.map((p) => p.name), ...Object.values(SETTINGS_VIEWS).flatMap((v) => (v ? [v.name] : []))];

// Every file people or agents read a Settings path in: the docs, the skill, and what the desk and window say. Not ios/:
// the iPhone app has a Settings of its own.
function sources(): string[] {
  const out = ["README.md", "AGENTS.md", "skills/inbox/SKILL.md"];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(md|ts|tsx)$/.test(e.name)) out.push(f);
    }
  };
  for (const d of ["docs", "src", "web/src", "electron"]) walk(d);
  return out;
}

test("every setting is in a part the sidebar lists", () => {
  const parts = new Set(SETTINGS_PARTS.map((p) => p.id));
  for (const d of SETTINGS) assert.ok(parts.has(d.section), `${d.key} is in "${d.section}", which no Settings part shows`);
});

test("the desk names each part as the sidebar does", () => {
  for (const s of SECTIONS) assert.equal(SETTINGS_PARTS.find((p) => p.id === s.id)?.name, s.title, `section "${s.id}"`);
});

test("the docs list Settings' parts as the sidebar does, each with its own heading", () => {
  const ui = read("docs/ui.md");
  assert.ok(ui.includes(`- The core's: ${core.map((p) => p.name).join(", ")}.`), "docs/ui.md's line listing the core's parts");
  for (const p of core) assert.ok(new RegExp(`^#{3,4} ${p.name}$`, "m").test(ui), `docs/ui.md has no heading for ${p.name}`);
  const line = read("README.md")
    .split("\n")
    .find((l) => l.startsWith("- **Settings**"));
  let at = 0;
  for (const p of core) {
    const i = line?.indexOf(p.name, at) ?? -1;
    assert.ok(i >= 0, `README's Settings line doesn't name ${p.name} (in the sidebar's order)`);
    at = i + p.name.length;
  }
});

test("every Settings → path names a part or a view that exists", () => {
  const stale: string[] = [];
  for (const f of sources())
    for (const m of read(f).matchAll(/Settings → (\*{0,2})([A-Z][^\n]*)/g)) {
      const said = m[2]!;
      if (!names.some((n) => said.startsWith(n))) stale.push(`${f}: Settings → ${said.slice(0, 40)}`);
    }
  assert.deepEqual(stale, []);
});
