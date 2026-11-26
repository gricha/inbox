import "./helpers/no-agent.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

// Every `claude -p` the desk starts names its model: one that doesn't runs on Claude Code's own default, which can be a
// model you never picked in Inbox (reviews ran on Fable that way, and hit its limit). Agent calls through askAgent can't
// leave it out (AskOpts.model is required); this catches a launch of its own. Resuming your own session keeps its model.
const RESUMES_YOUR_SESSION = new Set(["src/connectors/session-host.ts"]);

const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });

test("every claude -p the desk starts names its model", () => {
  const bare: string[] = [];
  for (const file of files("src")) {
    const rel = file.split(path.sep).join("/");
    if (RESUMES_YOUR_SESSION.has(rel)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/"-p",/g)) {
      // The launch's own argument list: from the "-p" to the line that closes it.
      const rest = text.slice(m.index);
      const args = rest.slice(0, rest.search(/\n\s*\][);,]/));
      if (!/"--model"|modelArgs\(/.test(args)) bare.push(`${rel}:${text.slice(0, m.index).split("\n").length}`);
    }
  }
  assert.deepEqual(bare, [], "a claude -p with no model runs on Claude Code's default: pass modelArgs(desk.agentRuns())");
});
