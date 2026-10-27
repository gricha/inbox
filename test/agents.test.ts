import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { connect, status } from "../src/agents.ts";

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
  const s = status("claude-code", MCP);
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
  assert.equal(status("claude-code", MCP).mcp?.connected, false);
  write(".claude.json", JSON.stringify({ mcpServers: { "review-desk": { type: "http", url: MCP } } }));
  assert.equal(status("claude-code", MCP).mcp?.connected, true);
  write(".claude.json", "{ not json");
  assert.equal(status("claude-code", MCP).mcp?.connected, false);
});

test("Codex: ~/.codex/config.toml and ~/.agents/skills", () => {
  const s = status("codex", MCP);
  assert.deepEqual(s.mcp, { connected: false, command: "codex mcp add review-desk --url http://localhost:47961/mcp" });
  assert.equal(s.skill?.path, join(home, ".agents", "skills", "review-desk", "SKILL.md"));
  write(join(".codex", "config.toml"), `model = "o3"\n\n[mcp_servers.review-desk]\nurl = "${MCP}"\n`);
  assert.equal(status("codex", MCP).mcp?.connected, true);
});

test("none: nothing to connect", async () => {
  assert.deepEqual(status("none", MCP), { driver: "none", mcp: null, skill: null });
  assert.deepEqual(await connect("none", MCP), { driver: "none", mcp: null, skill: null });
});

// Already registered, so no agent CLI runs: this part works on every OS.
test("connect copies the skill, and refreshes it when it's out of date", async () => {
  write(".claude.json", JSON.stringify({ mcpServers: { "review-desk": { type: "http", url: MCP } } }));
  const s = await connect("claude-code", MCP);
  assert.equal(s.skill?.state, "installed");
  assert.equal(readFileSync(claudeSkill(), "utf8"), SKILL);
  writeFileSync(claudeSkill(), SKILL.replace("Review Desk", "Old Desk"));
  assert.equal(status("claude-code", MCP).skill?.state, "outdated");
  assert.equal((await connect("claude-code", MCP)).skill?.state, "installed");
  assert.equal(readFileSync(claudeSkill(), "utf8"), SKILL);
});

test("connect registers through the agent's own CLI", { skip: process.platform === "win32" }, async () => {
  fake("claude", `printf '{"mcpServers":{"review-desk":{"type":"http","url":"%s"}}}' "$8" > "$HOME/.claude.json"`);
  const c = await connect("claude-code", MCP);
  assert.equal(readFileSync(join(home, "claude-args"), "utf8"), `mcp\nadd\n--transport\nhttp\n--scope\nuser\nreview-desk\n${MCP}\n`);
  assert.equal(c.mcp?.connected, true);
  assert.equal(c.skill?.state, "installed");

  fake("codex", `/bin/mkdir -p "$HOME/.codex" && printf '[mcp_servers.review-desk]\\nurl = "%s"\\n' "$5" >> "$HOME/.codex/config.toml"`);
  const x = await connect("codex", MCP);
  assert.equal(readFileSync(join(home, "codex-args"), "utf8"), `mcp\nadd\nreview-desk\n--url\n${MCP}\n`);
  assert.equal(x.mcp?.connected, true);
  assert.equal(readFileSync(join(home, ".agents", "skills", "review-desk", "SKILL.md"), "utf8"), SKILL);

  // Both in place: nothing runs again.
  fake("claude", "exit 1");
  assert.equal((await connect("claude-code", MCP)).mcp?.connected, true);
});

test("connect says what to run when the CLI is missing or fails", { skip: process.platform === "win32" }, async () => {
  await assert.rejects(connect("claude-code", MCP), {
    message: `claude isn't on PATH. Run it yourself: claude mcp add --transport http --scope user review-desk ${MCP}`,
  });
  assert.ok(existsSync(claudeSkill()), "the skill is installed even when registering fails");
  fake("codex", `echo "config.toml: bad TOML" >&2; exit 1`);
  await assert.rejects(connect("codex", MCP), {
    message: `codex failed: config.toml: bad TOML. Run it yourself: codex mcp add review-desk --url ${MCP}`,
  });
});
