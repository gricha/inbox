// With Codex chosen (Settings → Agent): an automation's agent run and your agent run on the owner's codex, as Claude Code's do.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEX_NOT_LOGGED_IN } from "../src/errors.ts";
import { setup } from "./helpers/desk.ts";
import { makeItem } from "./helpers/items.ts";
import { runSync } from "./helpers/run.ts";

const posix = { skip: process.platform === "win32" };
const MCP = "http://localhost:49401/mcp";
const TOOL_LESS_OFF = ["shell_tool", "unified_exec", "apps", "plugins", "browser_use", "browser_use_external", "in_app_browser"]
  .concat(["computer_use", "image_generation", "view_image", "multi_agent", "hooks", "memories"])
  .flatMap((x) => ["--disable", x]);
const READ = '["desk_list","desk_item","desk_overview","desk_events","desk_brief","desk_merging"]';

// A codex that lists `servers` for `mcp list --json`, and for exec records its args, folder and stdin, says its thread
// first (a resume's is its id), writes `answer` to -o, waits while `hold` exists, and fails as `fail` or `turnfail` say.
function fakeCodex(c: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-fake-codex-"));
  const bin = path.join(dir, "codex");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const d = __dirname;
const at = (f) => require("node:path").join(d, f);
const args = process.argv.slice(2);
const say = (o) => fs.writeSync(1, JSON.stringify(o) + "\\n");
if (args.includes("mcp")) {
  process.stdout.write(fs.existsSync(at("servers")) ? fs.readFileSync(at("servers"), "utf8") : "[]");
  process.exit(0);
}
const n = (fs.existsSync(at("count")) ? Number(fs.readFileSync(at("count"), "utf8")) : 0) + 1;
fs.writeFileSync(at("count"), String(n));
fs.appendFileSync(at("calls"), JSON.stringify({ args, cwd: process.cwd(), stdin: args.at(-1) === "-" ? fs.readFileSync(0, "utf8") : "" }) + "\\n");
if (fs.existsSync(at("fail"))) {
  process.stderr.write(fs.readFileSync(at("fail"), "utf8"));
  process.exit(1);
}
say({ type: "thread.started", thread_id: args[1] === "resume" ? args.at(-2) : "th-" + n });
const o = args.indexOf("-o");
if (o >= 0 && fs.existsSync(at("answer"))) fs.copyFileSync(at("answer"), args[o + 1]);
while (fs.existsSync(at("hold"))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
if (fs.existsSync(at("turnfail"))) {
  say({ type: "turn.failed", error: { message: fs.readFileSync(at("turnfail"), "utf8") } });
  process.exit(1);
}
say({ type: "turn.completed" });
`,
  );
  fs.chmodSync(bin, 0o755);
  const was = { codex: process.env.DESK_CODEX, home: process.env.CODEX_HOME };
  process.env.DESK_CODEX = bin;
  process.env.CODEX_HOME = path.join(dir, "codex-home");
  fs.mkdirSync(process.env.CODEX_HOME);
  c.after(() => {
    process.env.DESK_CODEX = was.codex;
    if (was.home === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = was.home;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const file = (f: string, text: string | null) => {
    if (text === null) fs.rmSync(path.join(dir, f), { force: true });
    else fs.writeFileSync(path.join(dir, f), text);
  };
  return {
    file,
    servers: (list: unknown[]) => {
      file("servers", JSON.stringify(list));
    },
    trust: (folder: string) => {
      file("codex-home/config.toml", `[projects."${fs.realpathSync(folder)}"]\ntrust_level = "trusted"\n`);
    },
    calls: (): { args: string[]; cwd: string; stdin: string }[] =>
      fs.existsSync(path.join(dir, "calls"))
        ? fs
            .readFileSync(path.join(dir, "calls"), "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as { args: string[]; cwd: string; stdin: string })
        : [],
  };
}

// ---------------------------------------------------------------- an automation's agent run

async function automating(c: TestContext) {
  const fake = fakeCodex(c);
  const t = await setup([], { settings: { "agent.harness": "codex", "policy.judge": false }, desk: { mcpUrl: MCP } });
  c.after(t.cleanup);
  t.gh.items.set("acme/other#9", makeItem({ repo: "acme/other", number: 9, kind: "issue", author: "dave", title: "Crash on start" }));
  const a = runSync(
    t.desk.automations.set(
      "warden",
      { name: "Warden issues", schedule: "weekdays 09:00", prompt: "Put the new crashes on my desk." },
      true,
    ),
  );
  return { ...t, fake, go: () => t.desk.automations.run(a, "now").p };
}

test("on Codex an agent run is codex exec, read only, with no shell and only the desk's read tools, and resumable", posix, async (c) => {
  const t = await automating(c);
  t.fake.servers([
    { name: "linear", enabled: true, transport: { type: "streamable_http", url: "https://mcp.linear.app/mcp" } },
    { name: "inbox", enabled: true, transport: { type: "streamable_http", url: MCP } },
    { name: "sentry", enabled: false },
  ]);
  t.fake.file("answer", JSON.stringify({ summary: "One crash needs you.", items: [{ ref: "acme/other#9", why: "a crash on start" }] }));
  const r = await t.go();
  assert.equal(r.error, null);
  assert.equal(r.summary, "One crash needs you.");
  assert.deepEqual([r.session, r.agent], ["th-1", "codex"]);
  assert.deepEqual(
    r.items.map((x) => [x.item_id, x.outcome]),
    [["acme/other#9", "added"]],
  );
  const [call] = t.fake.calls();
  const dir = path.join(t.home, "automations");
  assert.equal(fs.realpathSync(call!.cwd), fs.realpathSync(dir));
  const files = call!.args.slice(-5);
  assert.deepEqual(call!.args, [
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "-C",
    dir,
    ...TOOL_LESS_OFF,
    "-c",
    'web_search="disabled"',
    "-c",
    "mcp_servers.linear.enabled=false",
    "-c",
    `mcp_servers.inbox.url="${MCP}"`,
    "-c",
    "mcp_servers.inbox.enabled=true",
    "-c",
    `mcp_servers.inbox.enabled_tools=${READ}`,
    "-c",
    'approval_policy="never"',
    "--output-schema",
    files[1],
    "-o",
    files[3],
    "-",
  ]);
  assert.match(call!.stdin, /Put the new crashes on my desk\./);
  assert.match(call!.stdin, /the desk's read tools .* and nothing else: no shell, no gh, no web\.$/);
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.startsWith(".codex-")),
    [],
    "its schema and answer files are gone",
  );
});

test("an inbox server of yours that isn't the desk's is turned off, and the desk's comes in as inbox_desk", posix, async (c) => {
  const t = await automating(c);
  t.fake.servers([{ name: "inbox", enabled: true, transport: { type: "stdio", command: "helpdesk" } }]);
  t.fake.file("answer", JSON.stringify({ summary: "Nothing new.", items: [] }));
  assert.equal((await t.go()).error, null);
  const args = t.fake.calls()[0]!.args;
  const at = args.indexOf("mcp_servers.inbox.enabled=false");
  assert.ok(at > 0, "yours is off");
  assert.deepEqual(args.slice(at + 1, at + 8), [
    "-c",
    `mcp_servers.inbox_desk.url="${MCP}"`,
    "-c",
    "mcp_servers.inbox_desk.enabled=true",
    "-c",
    `mcp_servers.inbox_desk.enabled_tools=${READ}`,
    "-c",
  ]);
});

test("a Codex agent run that needs a login says Codex's words; one at its limit keeps codex's", posix, async (c) => {
  const t = await automating(c);
  t.fake.file("fail", "Error: Not logged in. Run `codex login`.\n");
  assert.equal((await t.go()).error, CODEX_NOT_LOGGED_IN);
  t.fake.file("fail", null);
  t.fake.file("turnfail", "You've hit your usage limit. Try again at 4:12 PM.");
  assert.equal((await t.go()).error, "You've hit your usage limit. Try again at 4:12 PM.");
});
