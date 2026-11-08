import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Cause, Effect, Exit, Fiber } from "effect";
import { connect, refreshSkills, status } from "../src/agents.ts";
import { failure, failureSync, run, runSync } from "./helpers/run.ts";

const SKILL = readFileSync(join(import.meta.dirname, "..", "skills", "review-desk", "SKILL.md"), "utf8");
const MCP = "http://localhost:47961/mcp";
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH };
let home = "";
let bin = "";

// A scratch HOME (USERPROFILE on Windows) and a PATH holding only fake agents, so the real ~/.claude, ~/.claude.json and ~/.codex are never touched.
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "desk-agents-"));
  bin = join(home, "bin");
  mkdirSync(bin);
  Object.assign(process.env, { HOME: home, USERPROFILE: home, PATH: bin });
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function fake(name: string, script: string) {
  writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$@" > "$HOME/${name}-args"\n${script}\n`);
  chmodSync(join(bin, name), 0o755);
}
const write = (rel: string, text: string) => {
  mkdirSync(join(home, rel, ".."), { recursive: true });
  writeFileSync(join(home, rel), text);
};
const claudeSkill = () => join(home, ".claude", "skills", "review-desk", "SKILL.md");

test("Claude Code: nothing connected yet, with the exact commands", () => {
  const s = runSync(status("claude-code", MCP));
  assert.equal(s.driver, "claude-code");
  assert.deepEqual(s.mcp, {
    connected: false,
    command: "claude mcp add --transport http --scope user review-desk http://localhost:47961/mcp",
  });
  assert.ok(s.skill);
  assert.equal(s.skill.state, "missing");
  assert.equal(s.skill.path, claudeSkill());
  assert.match(s.skill.command, /^mkdir -p \S*\.claude.skills'? && cp -R \S*skills.review-desk'? \S*\.claude.skills'?\/$/);
});

test("Claude Code: registered means user scope in ~/.claude.json", () => {
  write(".claude.json", JSON.stringify({ projects: { "/x": { mcpServers: { "review-desk": { type: "http", url: MCP } } } } }));
  assert.equal(runSync(status("claude-code", MCP)).mcp?.connected, false);
  write(".claude.json", JSON.stringify({ mcpServers: { "review-desk": { type: "http", url: MCP } } }));
  assert.equal(runSync(status("claude-code", MCP)).mcp?.connected, true);
  write(".claude.json", "{ not json");
  assert.equal(runSync(status("claude-code", MCP)).mcp?.connected, false);
});

test("Codex: ~/.codex/config.toml and ~/.agents/skills", () => {
  const s = runSync(status("codex", MCP));
  assert.deepEqual(s.mcp, { connected: false, command: "codex mcp add review-desk --url http://localhost:47961/mcp" });
  assert.equal(s.skill?.path, join(home, ".agents", "skills", "review-desk", "SKILL.md"));
  write(join(".codex", "config.toml"), `model = "o3"\n\n[mcp_servers.review-desk]\nurl = "${MCP}"\n`);
  assert.equal(runSync(status("codex", MCP)).mcp?.connected, true);
});

// Already registered, so no agent CLI runs: this part works on every OS.
test("connect copies the skill, and refreshes it when it's out of date", async () => {
  write(".claude.json", JSON.stringify({ mcpServers: { "review-desk": { type: "http", url: MCP } } }));
  const s = await run(connect("claude-code", MCP));
  assert.equal(s.skill?.state, "installed");
  assert.equal(readFileSync(claudeSkill(), "utf8"), SKILL);
  writeFileSync(claudeSkill(), SKILL.replace("Review Desk", "Old Desk"));
  assert.equal(runSync(status("claude-code", MCP)).skill?.state, "outdated");
  assert.equal((await run(connect("claude-code", MCP))).skill?.state, "installed");
  assert.equal(readFileSync(claudeSkill(), "utf8"), SKILL);
});

test("connect registers through the agent's own CLI", { skip: process.platform === "win32" }, async () => {
  fake("claude", `printf '{"mcpServers":{"review-desk":{"type":"http","url":"%s"}}}' "$8" > "$HOME/.claude.json"`);
  const c = await run(connect("claude-code", MCP));
  assert.equal(readFileSync(join(home, "claude-args"), "utf8"), `mcp\nadd\n--transport\nhttp\n--scope\nuser\nreview-desk\n${MCP}\n`);
  assert.equal(c.mcp?.connected, true);
  assert.equal(c.skill?.state, "installed");

  fake("codex", `/bin/mkdir -p "$HOME/.codex" && printf '[mcp_servers.review-desk]\\nurl = "%s"\\n' "$5" >> "$HOME/.codex/config.toml"`);
  const x = await run(connect("codex", MCP));
  assert.equal(readFileSync(join(home, "codex-args"), "utf8"), `mcp\nadd\nreview-desk\n--url\n${MCP}\n`);
  assert.equal(x.mcp?.connected, true);
  assert.equal(readFileSync(join(home, ".agents", "skills", "review-desk", "SKILL.md"), "utf8"), SKILL);

  // Both in place: nothing runs again.
  fake("claude", "exit 1");
  assert.equal((await run(connect("claude-code", MCP))).mcp?.connected, true);
});

test("connect says what to run when the CLI is missing or fails", { skip: process.platform === "win32" }, async () => {
  const missing = await failure(connect("claude-code", MCP));
  assert.equal(missing._tag, "CommandNotFound");
  assert.equal(missing.message, `claude isn't on PATH. Run it yourself: claude mcp add --transport http --scope user review-desk ${MCP}`);
  assert.ok(existsSync(claudeSkill()), "the skill is installed even when registering fails");
  fake("codex", `echo "config.toml: bad TOML" >&2; exit 1`);
  const failed = await failure(connect("codex", MCP));
  assert.equal(failed._tag, "CommandFailed");
  assert.equal(failed.message, `codex failed: config.toml: bad TOML. Run it yourself: codex mcp add review-desk --url ${MCP}`);
  assert.deepEqual(failed._tag === "CommandFailed" && [failed.code, failed.stderr], [1, "config.toml: bad TOML\n"]);
  fake("claude", "exec /bin/sleep 30");
  const slow = await failure(connect("claude-code", MCP, 200));
  const add = `claude mcp add --transport http --scope user review-desk ${MCP}`;
  assert.deepEqual([slow._tag, slow.message], ["CommandTimeout", `claude failed: Command failed: ${add}. Run it yourself: ${add}`]);
});

test("an installed skill that can't be read fails with FsError", () => {
  mkdirSync(claudeSkill(), { recursive: true });
  const e = failureSync(status("claude-code", MCP));
  assert.deepEqual([e._tag, e.op, e.path, e.code], ["FsError", "read", claudeSkill(), "EISDIR"]);
});

test(
  "interrupting connect stops the agent's CLI and what it started, and waits for it to exit",
  { skip: process.platform === "win32", timeout: 10_000 },
  async () => {
    fake("claude", `echo $$ > "$HOME/claude-pid"; /bin/sleep 30 & echo $! > "$HOME/child-pid"; wait`);
    const fiber = Effect.runFork(connect("claude-code", MCP));
    const pidOf = (name: string) => (existsSync(join(home, name)) ? Number(readFileSync(join(home, name), "utf8")) : 0);
    while (!pidOf("claude-pid") || !pidOf("child-pid")) await sleep(10);
    await Effect.runPromise(Fiber.interrupt(fiber));
    const exit = await Effect.runPromise(Fiber.await(fiber));
    assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
    assert.throws(() => process.kill(pidOf("claude-pid"), 0), { code: "ESRCH" });
    // Its whole group goes: the sleep it left behind may be a zombie for a moment, until it's reaped.
    const gone = () => {
      try {
        process.kill(pidOf("child-pid"), 0);
        return false;
      } catch {
        return true;
      }
    };
    for (let i = 0; i < 100 && !gone(); i++) await sleep(20);
    assert.ok(gone(), "what the CLI started is stopped too");
  },
);

test("the owner's desk refreshes an installed skill that's out of date, never installs one, and a scratch desk touches neither", () => {
  const old = SKILL.replace("Review Desk", "Old Desk");
  write(join(".claude", "skills", "review-desk", "SKILL.md"), old);
  const codexSkill = join(home, ".agents", "skills", "review-desk", "SKILL.md");

  assert.deepEqual(runSync(refreshSkills(join(home, "scratch-desk"))), []);
  assert.deepEqual(runSync(refreshSkills(join(tmpdir(), ".review-desk"))), [], "a .review-desk outside HOME isn't the owner's");
  assert.equal(readFileSync(claudeSkill(), "utf8"), old, "a scratch or test desk leaves it alone");

  assert.deepEqual(runSync(refreshSkills(join(home, ".review-desk"))), [claudeSkill()]);
  assert.equal(readFileSync(claudeSkill(), "utf8"), SKILL);
  assert.equal(existsSync(codexSkill), false, "a missing one is Connect's to install");
  assert.deepEqual(runSync(refreshSkills(join(home, ".review-desk") + "/")), [], "current: nothing to do");
});
