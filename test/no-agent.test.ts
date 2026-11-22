// No test reaches the owner's real claude, codex or opencode, however it's run (npm test, node --test on one file, an
// editor's runner): every test file's first import is the helper that points them at nothing.
import "./helpers/no-agent.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.join(import.meta.dirname, "..");
const tests = (dir: string): string[] =>
  fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const f = path.posix.join(dir, e.name);
    return e.isDirectory() ? tests(f) : e.name.endsWith(".test.ts") ? [f] : [];
  });

test("every test file imports the no-agent helper first", () => {
  const guard = path.join(root, "test/helpers/no-agent.ts");
  const missing = ["test", "web/test", "integrations"].flatMap(tests).filter((f) => {
    const first = /^import\s+(?:[^"']*?from\s+)?["']([^"']+)["']/m.exec(fs.readFileSync(path.join(root, f), "utf8"))?.[1];
    return !first || path.resolve(root, path.dirname(f), first) !== guard;
  });
  assert.deepEqual(missing, []);
});
