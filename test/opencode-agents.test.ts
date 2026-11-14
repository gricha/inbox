// With OpenCode chosen (Settings → Local Agent Integration): the tool-less calls, an automation's agent run and your agent run on the
// owner's opencode, fenced by the config the desk passes it, as Codex's are by flags.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OPENCODE_NOT_LOGGED_IN } from "../src/errors.ts";
import { OPENCODE_RULES } from "../src/coordinator.ts";
import {
  agentDown,
  askAgent,
  forgetOpencodeServers,
  loggedIn,
  OPENCODE_AGENT,
  notLoggedIn,
  OPENCODE_PAUSED,
  opencodeKeyed,
  pausedWords,
} from "../src/review.ts";
import { agentDefs, agentName } from "../src/settings.ts";
import { myPr, setup } from "./helpers/desk.ts";
import { makeItem } from "./helpers/items.ts";
import { failure, run, runSync } from "./helpers/run.ts";

const posix = { skip: process.platform === "win32" };
const MCP = "http://localhost:49402/mcp";
const ROLE =
  "You are my Inbox coordinator: the desk keeps you running and wakes you with a message when something changes on a PR in Merging, or when I ask you something in the desk. Follow the Coordinator section of the inbox skill.";
const RUN = ["run", "--format", "json", "--pure", "--agent", OPENCODE_AGENT];

interface Call {
  args: string[];
  cwd: string;
  stdin: string;
  config: string | null;
}

// An opencode that prints `config` for `debug config` (fails while `configfail` exists), `auth` for `auth list`, records
// every call with its stdin and OPENCODE_CONFIG_CONTENT, and for run names its session (--session's, else ses-<n>), says
// `answer` as its last text, waits while `hold` exists, and fails with `fail` as an error event.
function fakeOpencode(c: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-fake-opencode-"));
  const bin = path.join(dir, "opencode");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const at = (f) => require("node:path").join(__dirname, f);
const args = process.argv.slice(2);
const say = (o) => fs.writeSync(1, JSON.stringify(o) + "\\n");
const stdin = args[0] === "run" ? fs.readFileSync(0, "utf8") : "";
fs.appendFileSync(at("calls"), JSON.stringify({ args, cwd: process.cwd(), stdin, config: process.env.OPENCODE_CONFIG_CONTENT ?? null }) + "\\n");
if (args[0] === "debug") {
  if (fs.existsSync(at("configfail"))) { process.stderr.write("Error: bad config"); process.exit(1); }
  process.stdout.write(fs.existsSync(at("config")) ? fs.readFileSync(at("config"), "utf8") : "{}");
  process.exit(0);
}
if (args[0] === "auth") { process.stdout.write(fs.existsSync(at("auth")) ? fs.readFileSync(at("auth"), "utf8") : ""); process.exit(0); }
if (args[0] === "session") process.exit(0);
const n = (fs.existsSync(at("count")) ? Number(fs.readFileSync(at("count"), "utf8")) : 0) + 1;
fs.writeFileSync(at("count"), String(n));
const s = args.includes("--session") ? args[args.indexOf("--session") + 1] : "ses-" + n;
say({ type: "step_start", sessionID: s, part: { type: "step-start" } });
while (fs.existsSync(at("hold"))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
if (fs.existsSync(at("fail"))) { say({ type: "error", sessionID: s, error: JSON.parse(fs.readFileSync(at("fail"), "utf8")) }); process.exit(1); }
say({ type: "text", sessionID: s, part: { type: "text", text: "Looking at it." } });
if (fs.existsSync(at("answer"))) say({ type: "text", sessionID: s, part: { type: "text", text: fs.readFileSync(at("answer"), "utf8") } });
say({ type: "step_finish", sessionID: s, part: { type: "step-finish", reason: "stop" } });
`,
  );
  fs.chmodSync(bin, 0o755);
  const was = process.env.DESK_OPENCODE;
  process.env.DESK_OPENCODE = bin;
  forgetOpencodeServers();
  c.after(() => {
    process.env.DESK_OPENCODE = was;
    forgetOpencodeServers();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const file = (f: string, text: string | null) => {
    if (text === null) fs.rmSync(path.join(dir, f), { force: true });
    else fs.writeFileSync(path.join(dir, f), text);
  };
  const calls = (): Call[] =>
    fs.existsSync(path.join(dir, "calls"))
      ? fs
          .readFileSync(path.join(dir, "calls"), "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as Call)
      : [];
  return { bin, dir, file, calls, runs: () => calls().filter((x) => x.args[0] === "run") };
}

const config = (c: Call) =>
  JSON.parse(c.config!) as { share: string; mcp: Record<string, unknown>; agent: Record<string, { permission: unknown }> };
const DENY_ALL = Object.fromEntries(
  ["*", "read", "edit", "glob", "grep", "list", "bash", "task", "external_directory", "todowrite", "todoread"]
    .concat(["question", "webfetch", "websearch", "codesearch", "lsp", "skill", "doom_loop"])
    .map((k) => [k, "deny"]),
);

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++)
    await new Promise((r) => {
      setTimeout(r, 10);
    });
  assert.ok(cond(), "timed out waiting");
}

// ---------------------------------------------------------------- the tool-less call

test(
  "on OpenCode the tool-less call is opencode run as the desk's agent: every permission denied, your MCP servers off, the session deleted",
  posix,
  async (c) => {
    const f = fakeOpencode(c);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-agent-"));
    c.after(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    f.file(
      "config",
      JSON.stringify({
        model: "openrouter/openai/gpt-5-mini",
        mcp: { linear: { type: "remote", url: "https://mcp.linear.app/mcp" }, off: { type: "local", command: ["x"], enabled: false } },
      }),
    );
    f.file("answer", 'Here it is:\n{"summary":"ok"}');
    const schema = { type: "object", properties: { summary: { type: "string" } } };
    assert.deepEqual(await run(askAgent("PROMPT", { agent: "opencode", dir, schema })), { answer: { summary: "ok" }, model: "opencode" });
    const [debug, call, drop] = f.calls();
    assert.deepEqual(debug!.args, ["debug", "config", "--pure"], "the servers it would load, plugins left out as the run leaves them");
    assert.deepEqual(call!.args, [...RUN, "--title", "Inbox"], "no --model, no --auto: your model, and nothing approved");
    assert.equal(fs.realpathSync(call!.cwd), fs.realpathSync(dir));
    assert.equal(
      call!.stdin,
      `PROMPT\n\nAnswer with one JSON object and nothing else (no code fence) that matches this JSON Schema:\n${JSON.stringify(schema)}`,
    );
    assert.deepEqual(config(call!), {
      share: "disabled",
      mcp: { linear: { enabled: false } },
      agent: { [OPENCODE_AGENT]: { mode: "primary", description: "Inbox runs this agent for you.", permission: DENY_ALL } },
    });
    assert.deepEqual(drop!.args, ["session", "delete", "ses-1"], "it keeps no session, as Claude Code's --no-session-persistence");
  },
);

test(
  "OpenCode's errors: a 401 pauses as a logged-out agent in OpenCode's words, a 429 or no credits is held, others keep their words",
  posix,
  async (c) => {
    const f = fakeOpencode(c);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-agent-"));
    c.after(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const ask = (error: object) => {
      f.file("fail", JSON.stringify(error));
      return failure(askAgent("hi", { agent: "opencode", dir }));
    };
    const login = await ask({ name: "APIError", data: { message: "User not found.", statusCode: 401 } });
    assert.deepEqual([login._tag, login.message, agentDown(login)], ["ClaudeNotLoggedIn", OPENCODE_NOT_LOGGED_IN, true]);
    assert.equal(login._tag === "ClaudeNotLoggedIn" && login.detail, "401 User not found.");
    const limit = await ask({ name: "APIError", data: { message: "Rate limit exceeded", statusCode: 429 } });
    assert.deepEqual([limit._tag, agentDown(limit)], ["ClaudeApiError", true]);
    const credits = await ask({ name: "APIError", data: { message: "Insufficient credits", statusCode: 402 } });
    assert.equal(agentDown(credits), true, "out of credits is the agent's, not the PR's");
    const other = await ask({ name: "UnknownError", data: { message: "Unexpected server error. Check server logs for details." } });
    assert.deepEqual(
      [other._tag, other.message, agentDown(other)],
      ["ClaudeApiError", "Unexpected server error. Check server logs for details.", false],
    );
  },
);

test("an OpenCode call never runs unless its config is read: one that can't be holds it as a down agent", posix, async (c) => {
  const f = fakeOpencode(c);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-agent-"));
  c.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  f.file("configfail", "");
  const e = await failure(askAgent("hi", { agent: "opencode", dir }));
  assert.equal(e._tag, "CodexServersUnknown");
  assert.match(e.message, /^Couldn't confirm OpenCode's MCP servers are off, so it didn't run: /);
  assert.equal(agentDown(e), true);
  assert.equal(f.runs().length, 0);
});

test("your own OPENCODE_CONFIG_CONTENT stays, under the desk's servers and agent", posix, async (c) => {
  const f = fakeOpencode(c);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-agent-"));
  const was = process.env.OPENCODE_CONFIG_CONTENT;
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    theme: "x",
    mcp: { mine: { type: "local", command: ["y"] } },
    agent: { [OPENCODE_AGENT]: { permission: { bash: "allow" } } },
  });
  c.after(() => {
    if (was === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
    else process.env.OPENCODE_CONFIG_CONTENT = was;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  f.file("answer", '{"summary":"ok"}');
  await run(askAgent("hi", { agent: "opencode", dir }));
  const got = config(f.runs()[0]!) as unknown as {
    theme: string;
    mcp: Record<string, unknown>;
    agent: Record<string, { permission: unknown }>;
  };
  assert.equal(got.theme, "x");
  assert.deepEqual(got.mcp.mine, { type: "local", command: ["y"] });
  assert.deepEqual(got.agent[OPENCODE_AGENT]!.permission, DENY_ALL, "the desk's agent is the desk's");
});

// ---------------------------------------------------------------- the login check and the words

test("logged in, on OpenCode: what `opencode auth list` counts, a stored login or a provider's key it finds set", posix, async (c) => {
  const f = fakeOpencode(c);
  f.file(
    "auth",
    "\u001b[0m\n┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n\n┌  Environment\n│\n●  OpenRouter OPENROUTER_API_KEY\n│\n└  1 environment variable\n",
  );
  assert.equal(await run(loggedIn("opencode")), true);
  f.file("auth", "┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n");
  assert.equal(await run(loggedIn("opencode")), false);
  assert.equal(opencodeKeyed("└  2 credentials"), true);
});

test("Settings and the desk's words name OpenCode when it's chosen", () => {
  assert.equal(agentName("opencode"), "OpenCode");
  const defs = new Map(agentDefs("opencode").map((d) => [d.key, d]));
  assert.equal(defs.get("policy.judge")!.label, "Sort my desk with OpenCode");
  assert.match(defs.get("agent.coordinator_bypass")!.help!, /OpenCode has no sandbox either way/);
  assert.deepEqual([pausedWords("opencode"), notLoggedIn("opencode")], [OPENCODE_PAUSED, OPENCODE_NOT_LOGGED_IN]);
});

// ---------------------------------------------------------------- an automation's agent run

test(
  "on OpenCode an automation's agent run has only the desk's read tools, every other permission denied, and is resumable",
  posix,
  async (c) => {
    const f = fakeOpencode(c);
    f.file(
      "config",
      JSON.stringify({
        mcp: { inbox: { type: "local", command: ["helpdesk"] }, sentry: { type: "remote", url: "https://mcp.sentry.dev/mcp" } },
      }),
    );
    const t = await setup([], { settings: { "agent.harness": "opencode", "policy.judge": false }, desk: { mcpUrl: MCP } });
    c.after(t.cleanup);
    t.gh.items.set("acme/other#9", makeItem({ repo: "acme/other", number: 9, kind: "issue", author: "dave", title: "Crash on start" }));
    const a = runSync(
      t.desk.automations.set(
        "warden",
        { name: "Warden issues", schedule: "weekdays 09:00", prompt: "Put the new crashes on my desk." },
        true,
      ),
    );
    f.file("answer", JSON.stringify({ summary: "One crash needs you.", items: [{ ref: "acme/other#9", why: "a crash on start" }] }));
    const r = await t.desk.automations.run(a, "now").p;
    assert.equal(r.error, null);
    assert.deepEqual([r.summary, r.session, r.agent], ["One crash needs you.", "ses-1", "opencode"]);
    assert.deepEqual(
      r.items.map((x) => [x.item_id, x.outcome]),
      [["acme/other#9", "added"]],
    );
    const [call] = f.runs();
    assert.deepEqual(call!.args, [...RUN, "--title", "Inbox automation"]);
    assert.equal(fs.realpathSync(call!.cwd), fs.realpathSync(path.join(t.home, "automations")));
    assert.match(call!.stdin, /the desk's read tools .* and nothing else: no shell, no gh, no web\.\n/);
    const read = ["list", "item", "overview", "events", "brief", "merging"].map((x) => [`inbox_desk_desk_${x}`, "allow"]);
    assert.deepEqual(config(call!), {
      share: "disabled",
      // Your inbox isn't the desk's: it's off, and the desk's comes in as inbox_desk.
      mcp: { inbox: { enabled: false }, sentry: { enabled: false }, inbox_desk: { type: "remote", url: MCP, enabled: true } },
      agent: {
        [OPENCODE_AGENT]: {
          mode: "primary",
          description: "Inbox runs this agent for you.",
          permission: { ...DENY_ALL, ...Object.fromEntries(read) },
        },
      },
    });
    assert.ok(!f.calls().some((x) => x.args[0] === "session"), "kept, so opencode --session shows what it did");
  },
);

// ---------------------------------------------------------------- your agent

test(
  "on OpenCode your agent starts as opencode run in its folder, keeps its session, and each wake resumes it; its deny list is bash rules",
  posix,
  async (c) => {
    const f = fakeOpencode(c);
    f.file("config", JSON.stringify({ mcp: { inbox: { type: "remote", url: MCP } } }));
    const t = await setup(
      [3, 4, 5, 6].map((n) => myPr(n, { ci: "pending" })),
      {
        settings: { "agent.harness": "opencode", "policy.judge": false, "review.auto_ai": false, "agent.coordinator_bypass": false },
        desk: { mcpUrl: MCP },
      },
    );
    c.after(() => {
      t.desk.stop();
      t.cleanup();
    });
    t.desk.coordinator.batch = 30;
    await run(t.desk.sync());
    const view = () => runSync(t.desk.inflight()).coordinator;
    f.file("hold", "");
    runSync(t.desk.act("web#3", "inflight"));
    await until(() => view().id === "ses-1");
    assert.deepEqual(view(), { on: true, id: "ses-1", url: null, error: null, status: "busy", queued: [], activity: [] });
    const [start] = f.runs();
    const dir = path.join(t.home, "coordinator");
    assert.equal(fs.realpathSync(start!.cwd), fs.realpathSync(dir));
    const merging = (n: number) => `In Merging: acme/web#${n} (https://github.com/acme/web/pull/${n}): handed off.`;
    assert.deepEqual(start!.args, [...RUN, "--title", "Inbox coordinator", `${ROLE} ${merging(3)}`]);
    const conf = config(start!);
    assert.deepEqual(conf.mcp, { inbox: { type: "remote", url: MCP, enabled: true } });
    assert.deepEqual(conf.agent[OPENCODE_AGENT]!.permission, { bash: OPENCODE_RULES });
    for (const rule of ["gh pr comment *", "gh api *", "git push --force *", "git push * -f*", "git push * +*", "gh issue edit *"])
      assert.equal(OPENCODE_RULES[rule], "deny", rule);

    runSync(t.desk.act("web#4", "inflight"));
    await new Promise((r) => {
      setTimeout(r, 200);
    });
    assert.equal(f.runs().length, 1, "one turn at a time");
    f.file("hold", null);
    await until(() => f.runs().length === 2 && view().status === "idle");
    assert.deepEqual(f.runs()[1]!.args, [...RUN, "--session", "ses-1", merging(4)]);
    assert.deepEqual(view(), { on: true, id: "ses-1", url: null, error: null, status: "idle", queued: [], activity: [] });

    // Let your agent run without asking: what your config asks about is approved.
    runSync(t.desk.putSettings({ set: { "agent.coordinator_bypass": true } }));
    runSync(t.desk.act("web#5", "inflight"));
    await until(() => f.runs().length === 3 && view().status === "idle");
    assert.ok(f.runs()[2]!.args.includes("--auto"));

    // Logged out: your agent's error in OpenCode's words.
    f.file("fail", JSON.stringify({ name: "APIError", data: { message: "User not found.", statusCode: 401 } }));
    runSync(t.desk.act("web#6", "inflight"));
    await until(() => view().error !== null);
    assert.equal(view().error, OPENCODE_NOT_LOGGED_IN);
  },
);
