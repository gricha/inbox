// With Codex chosen (Settings → Local Agent Integration): an automation's agent run and your agent run on the owner's codex, as Claude Code's do.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEX_NOT_LOGGED_IN } from "../src/errors.ts";
import { loggedIn } from "../src/review.ts";
import { myPr, setup } from "./helpers/desk.ts";
import { makeItem } from "./helpers/items.ts";
import { run, runSync } from "./helpers/run.ts";

const posix = { skip: process.platform === "win32" };
const MCP = "http://localhost:49401/mcp";
const ROLE =
  "You are my Inbox coordinator: the desk keeps you running and wakes you with a message when something changes on a PR in Merging, or when I ask you something in the desk. Follow the Coordinator section of the inbox skill.";
const TOOL_LESS_OFF = ["shell_tool", "unified_exec", "apps", "plugins", "browser_use", "browser_use_external", "in_app_browser"]
  .concat(["computer_use", "image_generation", "view_image", "multi_agent", "hooks", "memories"])
  .flatMap((x) => ["--disable", x]);
const COORDINATOR_OFF = ["apps", "plugins", "browser_use", "browser_use_external", "in_app_browser", "computer_use"].flatMap((x) => [
  "--disable",
  x,
]);
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

// A claude whose one background session, stopped, is resumed by --resume <its session> --bg.
function fakeClaude(c: TestContext, folder: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-fake-claude-"));
  const bin = path.join(dir, "claude");
  const row = JSON.stringify([{ id: "c0ffee01", sessionId: "c0ffee01-s", cwd: folder, kind: "background", name: "Inbox coordinator" }]);
  fs.writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$(dirname "$0")/calls"
case "$1" in agents) echo '${row}';; --resume) echo "backgrounded · c0ffee01";; esac
`,
  );
  fs.chmodSync(bin, 0o755);
  const was = process.env.DESK_CLAUDE;
  process.env.DESK_CLAUDE = bin;
  c.after(() => {
    process.env.DESK_CLAUDE = was;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    calls: () => (fs.existsSync(path.join(dir, "calls")) ? fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n") : []),
  };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++)
    await new Promise((r) => {
      setTimeout(r, 10);
    });
  assert.ok(cond(), "timed out waiting");
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

test("Codex counts as logged in on a provider of yours whose key is set, which `codex login status` doesn't count", posix, async (c) => {
  const fake = fakeCodex(c);
  fake.file("fail", "Not logged in\n");
  assert.equal(await run(loggedIn("codex")), false);
  // As for OpenRouter: a provider of your own in config.toml, signing in with the key its env_key names.
  fake.file(
    "codex-home/config.toml",
    'model = "openai/gpt-5-mini"\nmodel_provider = "openrouter"\n\n[model_providers.openrouter]\nbase_url = "https://openrouter.ai/api/v1"\nenv_key = "DESK_TEST_PROVIDER_KEY"\nwire_api = "responses"\n',
  );
  assert.equal(await run(loggedIn("codex")), false, "its key isn't set");
  process.env.DESK_TEST_PROVIDER_KEY = "k";
  c.after(() => {
    delete process.env.DESK_TEST_PROVIDER_KEY;
  });
  assert.equal(await run(loggedIn("codex")), true);
  fake.file("codex-home/config.toml", 'model = "o3"\n');
  assert.equal(await run(loggedIn("codex")), false, "OpenAI's own login is codex login status's to say");
  fake.file("fail", null);
  assert.equal(await run(loggedIn("codex")), true, "codex login status says so");
});

// ---------------------------------------------------------------- your agent

async function coordinating(c: TestContext, settings: Record<string, unknown> = {}, trust = true) {
  const fake = fakeCodex(c);
  fake.servers([
    { name: "linear", enabled: true, transport: { type: "streamable_http", url: "https://mcp.linear.app/mcp" } },
    { name: "inbox", enabled: true, transport: { type: "streamable_http", url: MCP } },
  ]);
  const t = await setup([myPr(3, { ci: "pending" }), myPr(4, { ci: "pending" }), myPr(5, { ci: "pending" })], {
    settings: { "agent.harness": "codex", "policy.judge": false, "review.auto_ai": false, "agent.coordinator_bypass": false, ...settings },
    desk: { mcpUrl: MCP },
  });
  c.after(() => {
    t.desk.stop();
    t.cleanup();
  });
  t.desk.coordinator.batch = 30;
  await run(t.desk.sync());
  const dir = path.join(t.home, "coordinator");
  fs.mkdirSync(dir, { recursive: true });
  if (trust) fake.trust(dir);
  // Only the coordinator's calls: a tool-less call reads its prompt from stdin.
  const turns = () => fake.calls().filter((x) => x.args.at(-1) !== "-");
  const view = () => runSync(t.desk.inflight()).coordinator;
  return { ...t, fake, dir, turns, view };
}

const MCP_ARGS = ["-c", "mcp_servers.linear.enabled=false", "-c", `mcp_servers.inbox.url="${MCP}"`, "-c", "mcp_servers.inbox.enabled=true"];
const merging = (n: number) => `In Merging: acme/web#${n} (https://github.com/acme/web/pull/${n}): handed off.`;

test(
  "on Codex your agent starts as codex exec in its folder, keeps the thread it names, and each wake resumes it after the last ends",
  posix,
  async (c) => {
    const t = await coordinating(c);
    t.fake.file("hold", "");
    runSync(t.desk.act("web#3", "inflight"));
    await until(() => t.view().id === "th-1");
    assert.deepEqual(t.view(), { on: true, id: "th-1", url: null, error: null, status: "busy", queued: [], activity: [] });
    const [start] = t.turns();
    assert.equal(fs.realpathSync(start!.cwd), fs.realpathSync(t.dir));
    assert.deepEqual(start!.args, [
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-c",
      'approval_policy="never"',
      "-C",
      t.dir,
      "--skip-git-repo-check",
      ...COORDINATOR_OFF,
      ...MCP_ARGS,
      `${ROLE} ${merging(3)}`,
    ]);
    const rules = fs.readFileSync(path.join(t.dir, ".codex", "rules", "inbox.rules"), "utf8");
    for (const r of ['["gh","pr","close"]', '["gh","api"]', '["git","push","--force"]', '["gh","pr","comment"]'])
      assert.ok(rules.includes(`prefix_rule(pattern = ${r}, decision = "forbidden")`), r);

    runSync(t.desk.act("web#4", "inflight"));
    await new Promise((r) => {
      setTimeout(r, 200);
    });
    assert.equal(t.turns().length, 1, "one turn at a time: the next waits for this one to end");
    t.fake.file("hold", null);
    await until(() => t.turns().length === 2 && t.view().status === "idle");
    assert.deepEqual(t.turns()[1]!.args, [
      "exec",
      "resume",
      "--json",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-c",
      'approval_policy="never"',
      "--skip-git-repo-check",
      ...COORDINATOR_OFF,
      ...MCP_ARGS,
      "th-1",
      merging(4),
    ]);
    assert.equal(fs.realpathSync(t.turns()[1]!.cwd), fs.realpathSync(t.dir));
    assert.deepEqual(t.view(), { on: true, id: "th-1", url: null, error: null, status: "idle", queued: [], activity: [] });
  },
);

test("with Let your agent run without asking on, Codex runs with no sandbox and no approvals", posix, async (c) => {
  const t = await coordinating(c, { "agent.coordinator_bypass": true });
  runSync(t.desk.act("web#3", "inflight"));
  await until(() => t.view().status === "idle");
  runSync(t.desk.act("web#4", "inflight"));
  await until(() => t.turns().length === 2 && t.view().status === "idle");
  const [start, wake] = t.turns();
  assert.deepEqual(start!.args.slice(0, 6), [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    t.dir,
    "--skip-git-repo-check",
  ]);
  assert.deepEqual(wake!.args.slice(0, 5), [
    "exec",
    "resume",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
  ]);
  assert.ok(!t.turns().some((x) => x.args.some((a) => a.includes("sandbox_mode") || a.includes("approval_policy"))));
});

test("Codex logged out is your agent's error in Codex's words, and what it was told waits for the next try", posix, async (c) => {
  const t = await coordinating(c);
  t.fake.file("fail", "Error: Not logged in. Run `codex login`.\n");
  runSync(t.desk.act("web#3", "inflight"));
  await until(() => t.view().error !== null);
  assert.deepEqual(t.view(), { on: true, id: null, url: null, error: CODEX_NOT_LOGGED_IN, status: null, queued: [], activity: [] });
  assert.deepEqual(t.desk.coordinator.news(), [["acme/web#3", "handed off"]]);
  t.fake.file("fail", null);
  t.fake.file("turnfail", "You've hit your usage limit.");
  runSync(t.desk.act("web#4", "inflight"));
  await until(() => t.view().id === "th-2" && t.view().status === "idle" && t.view().error !== null);
  assert.equal(t.view().error, "You've hit your usage limit.");
  assert.equal(
    t.turns()[1]!.args.at(-1),
    `${ROLE} In Merging: acme/web#3 (https://github.com/acme/web/pull/3): handed off; acme/web#4 (https://github.com/acme/web/pull/4): handed off.`,
  );
  assert.deepEqual(t.desk.coordinator.news(), []);
});

test("your agent's folder untrusted in Codex: it doesn't start, and says how to trust it", posix, async (c) => {
  const t = await coordinating(c, {}, false);
  runSync(t.desk.act("web#3", "inflight"));
  await until(() => t.view().error !== null);
  assert.match(
    t.view().error!,
    /^Codex reads your agent's deny rules only in a folder you trust, so it didn't start: add `\[projects\.".*coordinator"\]` with `trust_level = "trusted"` to .*config\.toml$/,
  );
  assert.deepEqual(t.turns(), []);
});

test("switching agents keeps each one's session: a wake goes to the chosen agent's", posix, async (c) => {
  const t = await coordinating(c);
  const claude = fakeClaude(c, t.dir);
  t.desk.store.set("coordinator_bg", { id: "c0ffee01", mode: "default" });
  runSync(t.desk.act("web#3", "inflight"));
  await until(() => t.view().id === "th-1" && t.view().status === "idle");
  assert.deepEqual(claude.calls(), [], "Codex chosen: Claude Code isn't asked");

  await run(t.desk.putSettings({ set: { "agent.harness": "claude-code" } }));
  assert.equal(t.view().id, "c0ffee01");
  runSync(t.desk.act("web#4", "inflight"));
  await until(() => claude.calls().some((l) => l.startsWith("--resume")));
  assert.ok(claude.calls().includes(`--resume c0ffee01-s --bg ${merging(4)}`), claude.calls().join("\n"));

  await run(t.desk.putSettings({ set: { "agent.harness": "codex" } }));
  assert.equal(t.view().id, "th-1");
  runSync(t.desk.act("web#5", "inflight"));
  await until(() => t.turns().length === 2 && t.view().status === "idle");
  assert.deepEqual(t.turns()[1]!.args.slice(-2), ["th-1", merging(5)]);
  assert.deepEqual(t.desk.store.get("coordinator_bg"), { id: "c0ffee01", mode: "default" });
});
