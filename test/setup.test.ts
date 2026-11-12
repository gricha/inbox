import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Effect } from "effect";
import { Desk } from "../src/desk.ts";
import { GitHubAuthError, Upstream } from "../src/errors.ts";
import { installed } from "../src/review.ts";
import { createApp } from "../src/server.ts";
import { agentView, githubView } from "../src/setup.ts";
import type { DriverId } from "../src/agents.ts";
import { FakeGitHub, makeItem, NOW } from "./helpers/items.ts";
import { failure, run } from "./helpers/run.ts";

const MCP = "http://localhost:47823/mcp";
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH };
let home = "";
let bin = "";

// A scratch HOME and a PATH of fakes: the real ~/.claude and ~/.inbox are never touched, and no real agent runs.
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "desk-setup-"));
  bin = join(home, "bin");
  mkdirSync(bin);
  Object.assign(process.env, { HOME: home, USERPROFILE: home, PATH: bin });
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

function fake(name: string) {
  writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$@" >> "$HOME/${name}-args"\n`);
  chmodSync(join(bin, name), 0o755);
}

const signedOut = () => Effect.fail(new GitHubAuthError({ reason: "no_token", message: "no GitHub token: run `gh auth login`" }));

// A fresh desk (no config.toml, nothing learned from GitHub), with agents that are or aren't ready.
async function fresh(ready: Partial<Record<DriverId, "installed" | "ready">> = {}, offline = false) {
  const dir = mkdtempSync(join(home, "desk-"));
  const gh = new FakeGitHub([makeItem({ number: 7 })], () => []);
  const viewer = gh.viewer.bind(gh);
  if (offline) gh.viewer = signedOut;
  const desk = new Desk({
    home: dir,
    github: gh,
    now: () => NOW,
    notify: () => {},
    log: () => {},
    review: {
      fetchPr: () => Effect.die("no diffs here"),
      generate: () => Effect.die("no AI reviews here"),
      installed: (a) => !!ready[a],
      loggedIn: (a) => Effect.succeed(ready[a] === "ready"),
    },
  });
  await run(desk.init());
  return { desk, gh, dir, signIn: () => (gh.viewer = viewer), app: createApp(desk, 47823) };
}

test("a first run without GitHub starts anyway: no config, the page says what to run, and Retry writes the config", async () => {
  const t = await fresh({}, true);
  try {
    assert.equal(existsSync(join(t.dir, "config.toml")), false);
    const s = await run(t.desk.setupView());
    assert.equal(s.needed, true);
    assert.deepEqual(s.github, { login: null, error: "You're not signed in to GitHub.", fix: "gh auth login" });
    const queue = await t.app.request("http://127.0.0.1:47823/api/queue");
    assert.equal(queue.status, 503);
    assert.match(((await queue.json()) as { error: string }).error, /^GitHub isn't connected yet .*: run desk setup$/);
    t.signIn();
    const after = (await (await t.app.request("http://127.0.0.1:47823/api/setup/check", { method: "POST" })).json()) as {
      github: unknown;
      needed: boolean;
    };
    assert.deepEqual(after.github, { login: "me", error: null, fix: null });
    assert.equal(after.needed, true, "still waits on your agent");
    assert.ok(existsSync(join(t.dir, "config.toml")));
    assert.ok(t.desk.loaded);
  } finally {
    t.desk.stop();
  }
});

test("picking an agent that isn't ready says what to run, and changes nothing", async () => {
  const t = await fresh({ codex: "installed" });
  try {
    const none = await failure(t.desk.chooseAgent("opencode", MCP));
    assert.equal(none.message, "OpenCode isn't installed. Run curl -fsSL https://opencode.ai/install | bash && opencode auth login");
    const out = await failure(t.desk.chooseAgent("codex", MCP));
    assert.equal(out.message, "Codex isn't logged in. Run codex login");
    assert.equal((await failure(t.desk.chooseAgent("gpt", MCP)))._tag, "BadRequest");
    assert.equal(t.desk.settings["agent.harness"], "claude-code");
    assert.equal((await run(t.desk.setupView())).needed, true);
  } finally {
    t.desk.stop();
  }
});

test("picking a ready agent sets it, connects it like Settings' Connect, and the page is done for good", async () => {
  fake("codex");
  const t = await fresh({ codex: "ready" });
  try {
    const res = await t.app.request("http://127.0.0.1:47823/api/setup", { method: "POST", body: JSON.stringify({ agent: "codex" }) });
    assert.equal(res.status, 200);
    const s = (await res.json()) as { needed: boolean; agent: string };
    assert.deepEqual([s.needed, s.agent], [false, "codex"]);
    assert.equal(t.desk.settings["agent.harness"], "codex");
    assert.match(readFileSync(join(home, "codex-args"), "utf8"), /^mcp\nadd\ninbox\n--url\nhttp:\/\/localhost:47823\/mcp\n$/);
    assert.ok(existsSync(join(home, ".agents", "skills", "inbox", "SKILL.md")));
  } finally {
    t.desk.stop();
  }
  // The same home started again doesn't ask.
  const again = new Desk({ home: t.dir, github: t.gh, now: () => NOW, notify: () => {}, log: () => {} });
  await run(again.init());
  assert.equal((await run(again.setupView())).needed, false);
  again.stop();
});

test("GitHub not connected: the agent is picked and connected, and the page finishes when GitHub is", async () => {
  fake("claude");
  const t = await fresh({ "claude-code": "ready" }, true);
  try {
    const s = await run(t.desk.chooseAgent("claude-code", MCP));
    assert.deepEqual([s.needed, s.picked], [true, "claude-code"]);
    assert.match(readFileSync(join(home, "claude-args"), "utf8"), /^mcp\nadd\n--transport\nhttp\n--scope\nuser\ninbox\n/);
    assert.ok(existsSync(join(home, ".claude", "skills", "inbox", "SKILL.md")));
    t.signIn();
    const after = await run(t.desk.checkSetup());
    assert.deepEqual([after.needed, after.github.login], [false, "me"]);
  } finally {
    t.desk.stop();
  }
});

test("a desk restarted between the pick and the GitHub login finishes the page once GitHub answers", async () => {
  fake("claude");
  const t = await fresh({ "claude-code": "ready" }, true);
  await run(t.desk.chooseAgent("claude-code", MCP));
  t.desk.stop();
  t.signIn();
  const again = new Desk({ home: t.dir, github: t.gh, now: () => NOW, notify: () => {}, log: () => {} });
  await run(again.init());
  try {
    assert.equal((await run(again.setupView())).needed, false);
  } finally {
    again.stop();
  }
});

test("a desk from before the first-run page never shows it", async () => {
  const dir = mkdtempSync(join(home, "desk-"));
  writeFileSync(join(dir, "config.toml"), "");
  const desk = new Desk({ home: dir, github: new FakeGitHub([], () => []), now: () => NOW, notify: () => {}, log: () => {} });
  await run(desk.init());
  try {
    assert.equal((await run(desk.setupView())).needed, false);
  } finally {
    desk.stop();
  }
});

test("the page's words for GitHub and each agent", () => {
  const auth = (reason: "gh_missing" | "no_token" | "rejected") => new GitHubAuthError({ reason, message: "x" });
  assert.deepEqual(githubView("dana", null), { login: "dana", error: null, fix: null });
  assert.deepEqual(githubView("", auth("gh_missing"), "darwin"), {
    login: null,
    error: "The GitHub CLI isn't installed.",
    fix: "brew install gh && gh auth login",
  });
  assert.equal(githubView("", auth("gh_missing"), "linux").fix, "gh auth login");
  assert.equal(githubView("", auth("rejected")).error, "GitHub refused your login.");
  assert.deepEqual(githubView("", new Upstream({ message: "ENOTFOUND api.github.com" })), {
    login: null,
    error: "Couldn't reach GitHub: ENOTFOUND api.github.com",
    fix: null,
  });
  assert.equal(
    agentView("claude-code", "Claude Code", false, false).fix,
    "curl -fsSL https://claude.ai/install.sh | bash && claude auth login",
  );
  assert.equal(
    agentView("claude-code", "Claude Code", false, false, "win32").fix,
    "npm install -g @anthropic-ai/claude-code && claude auth login",
  );
  assert.deepEqual(agentView("codex", "Codex", true, true), { id: "codex", name: "Codex", installed: true, logged_in: true, fix: null });
});

test("an agent's CLI counts as installed when it's an executable on PATH", { skip: process.platform === "win32" }, () => {
  const was = process.env.DESK_OPENCODE;
  delete process.env.DESK_OPENCODE;
  try {
    assert.equal(installed("opencode"), false);
    writeFileSync(join(bin, "opencode"), "not executable");
    assert.equal(installed("opencode"), false);
    fake("opencode");
    assert.equal(installed("opencode"), true);
    assert.equal(installed("claude-code"), false, "DESK_CLAUDE points at a fake that isn't there");
  } finally {
    process.env.DESK_OPENCODE = was;
  }
});
