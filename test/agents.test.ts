import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Cause, Effect, Exit, Fiber } from "effect";
import { connect, plan, refreshSkills, status } from "../src/agents.ts";
import { failure, failureSync, run, runSync } from "./helpers/run.ts";

const SKILL = readFileSync(join(import.meta.dirname, "..", "skills", "inbox", "SKILL.md"), "utf8");
const MCP = "http://localhost:47961/mcp";
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH, DESK_PORT: process.env.DESK_PORT };
let home = "";
let bin = "";

// A scratch HOME (USERPROFILE on Windows) and a PATH holding only fake agents, so the real ~/.claude, ~/.claude.json and ~/.codex are never touched.
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "desk-agents-"));
  bin = join(home, "bin");
  mkdirSync(bin);
  Object.assign(process.env, { HOME: home, USERPROFILE: home, PATH: bin });
  delete process.env.DESK_PORT;
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
const claudeSkill = () => join(home, ".claude", "skills", "inbox", "SKILL.md");

test("Claude Code: nothing connected yet, with the exact commands", () => {
  const s = runSync(status("claude-code", MCP));
  assert.equal(s.driver, "claude-code");
  assert.deepEqual(s.mcp, {
    connected: false,
    command: "claude mcp add --transport http --scope user inbox http://localhost:47961/mcp",
  });
  assert.ok(s.skill);
  assert.equal(s.skill.state, "missing");
  assert.equal(s.skill.path, claudeSkill());
  assert.match(s.skill.command, /^mkdir -p \S*\.claude.skills'? && cp -R \S*skills.inbox'? \S*\.claude.skills'?\/$/);
  assert.equal(s.needs, "connect");
  assert.deepEqual(s.connect, [s.mcp.command, s.skill.command]);
});

test("Settings asks you to connect or update only while it's needed, and Connect runs only what's missing", () => {
  const mcp = (connected: boolean) => ({ connected, command: "claude mcp add inbox" });
  const skill = (state: "installed" | "outdated" | "missing") => ({ state, path: "SKILL.md", command: "cp -R skills.inbox" });
  assert.deepEqual(plan(mcp(true), skill("installed")), { needs: null, connect: [] });
  assert.deepEqual(plan(mcp(true), skill("missing")), { needs: "connect", connect: ["cp -R skills.inbox"] });
  assert.deepEqual(plan(mcp(false), skill("installed")), { needs: "connect", connect: ["claude mcp add inbox"] });
  assert.deepEqual(plan(mcp(false), skill("outdated")), {
    needs: "connect",
    connect: ["claude mcp add inbox", "cp -R skills.inbox"],
  });
  assert.deepEqual(plan(mcp(true), skill("outdated")), { needs: "update", connect: ["cp -R skills.inbox"] });
});

test("Claude Code: registered means user scope in ~/.claude.json", () => {
  write(".claude.json", JSON.stringify({ projects: { "/x": { mcpServers: { inbox: { type: "http", url: MCP } } } } }));
  assert.equal(runSync(status("claude-code", MCP)).mcp?.connected, false);
  write(".claude.json", JSON.stringify({ mcpServers: { inbox: { type: "http", url: MCP } } }));
  assert.equal(runSync(status("claude-code", MCP)).mcp?.connected, true);
  write(".claude.json", "{ not json");
  assert.equal(runSync(status("claude-code", MCP)).mcp?.connected, false);
});

test("Codex: ~/.codex/config.toml and ~/.agents/skills", () => {
  const s = runSync(status("codex", MCP));
  assert.deepEqual(s.mcp, { connected: false, command: "codex mcp add inbox --url http://localhost:47961/mcp" });
  assert.equal(s.skill?.path, join(home, ".agents", "skills", "inbox", "SKILL.md"));
  write(join(".codex", "config.toml"), `model = "o3"\n\n[mcp_servers.inbox]\nurl = "${MCP}"\n`);
  assert.equal(runSync(status("codex", MCP)).mcp?.connected, true);
  const cmd = String.raw`C:\Users\me\code\review-desk\bin\desk.cmd`;
  write(join(".codex", "config.toml"), `[mcp_servers.inbox]\ncommand = '${cmd}'\nargs = ["mcp"]\nenv = { DESK_PORT = "47961" }\n`);
  assert.equal(runSync(status("codex", MCP)).mcp?.connected, true, "desk.cmd mcp, on Windows");
});

// Already registered, so no agent CLI runs: this part works on every OS.
test("connect copies the skill, and refreshes it when it's out of date", async () => {
  write(".claude.json", JSON.stringify({ mcpServers: { inbox: { type: "http", url: MCP } } }));
  const s = await run(connect("claude-code", MCP));
  assert.equal(s.skill?.state, "installed");
  assert.equal(readFileSync(claudeSkill(), "utf8"), SKILL);
  writeFileSync(claudeSkill(), SKILL.replace("Inbox", "Old Desk"));
  assert.equal(runSync(status("claude-code", MCP)).skill?.state, "outdated");
  assert.equal((await run(connect("claude-code", MCP))).skill?.state, "installed");
  assert.equal(readFileSync(claudeSkill(), "utf8"), SKILL);
});

test("connect registers through the agent's own CLI", { skip: process.platform === "win32" }, async () => {
  fake("claude", `printf '{"mcpServers":{"inbox":{"type":"http","url":"%s"}}}' "$8" > "$HOME/.claude.json"`);
  const c = await run(connect("claude-code", MCP));
  assert.equal(readFileSync(join(home, "claude-args"), "utf8"), `mcp\nadd\n--transport\nhttp\n--scope\nuser\ninbox\n${MCP}\n`);
  assert.equal(c.mcp?.connected, true);
  assert.equal(c.skill?.state, "installed");

  fake("codex", `/bin/mkdir -p "$HOME/.codex" && printf '[mcp_servers.inbox]\\nurl = "%s"\\n' "$5" >> "$HOME/.codex/config.toml"`);
  const x = await run(connect("codex", MCP));
  assert.equal(readFileSync(join(home, "codex-args"), "utf8"), `mcp\nadd\ninbox\n--url\n${MCP}\n`);
  assert.equal(x.mcp?.connected, true);
  assert.equal(readFileSync(join(home, ".agents", "skills", "inbox", "SKILL.md"), "utf8"), SKILL);

  // Both in place: nothing runs again.
  fake("claude", "exit 1");
  assert.equal((await run(connect("claude-code", MCP))).mcp?.connected, true);
});

test("connect says what to run when the CLI is missing or fails", { skip: process.platform === "win32" }, async () => {
  const missing = await failure(connect("claude-code", MCP));
  assert.equal(missing._tag, "CommandNotFound");
  assert.equal(missing.message, `claude isn't on PATH. Run it yourself: claude mcp add --transport http --scope user inbox ${MCP}`);
  assert.ok(existsSync(claudeSkill()), "the skill is installed even when registering fails");
  fake("codex", `echo "config.toml: bad TOML" >&2; exit 1`);
  const failed = await failure(connect("codex", MCP));
  assert.equal(failed._tag, "CommandFailed");
  assert.equal(failed.message, `codex failed: config.toml: bad TOML. Run it yourself: codex mcp add inbox --url ${MCP}`);
  assert.deepEqual(failed._tag === "CommandFailed" && [failed.code, failed.stderr], [1, "config.toml: bad TOML\n"]);
  fake("claude", "exec /bin/sleep 30");
  const slow = await failure(connect("claude-code", MCP, { timeout: 200 }));
  const add = `claude mcp add --transport http --scope user inbox ${MCP}`;
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
  const old = SKILL.replace("Inbox", "Old Desk");
  write(join(".claude", "skills", "inbox", "SKILL.md"), old);
  const codexSkill = join(home, ".agents", "skills", "inbox", "SKILL.md");

  assert.deepEqual(runSync(refreshSkills(join(home, "scratch-desk"), MCP)), []);
  assert.deepEqual(runSync(refreshSkills(join(tmpdir(), ".inbox"), MCP)), [], "a .inbox outside HOME isn't the owner's");
  assert.deepEqual(runSync(refreshSkills(join(home, ".review-desk"), MCP)), [], "nor is a folder that isn't the home");
  assert.equal(readFileSync(claudeSkill(), "utf8"), old, "a scratch or test desk leaves it alone");

  assert.deepEqual(runSync(refreshSkills(join(home, ".inbox"), MCP)), [`refreshed the Inbox skill at ${claudeSkill()}`]);
  assert.equal(readFileSync(claudeSkill(), "utf8"), SKILL);
  assert.equal(existsSync(codexSkill), false, "a missing one is Connect's to install");
  assert.deepEqual(runSync(refreshSkills(join(home, ".inbox") + "/", MCP)), [], "current: nothing to do");
});

test("the owner's desk is its home as it is now: ~/.review-desk until it moves, and a link to it", () => {
  const old = SKILL.replace("Inbox", "Old Desk");
  write(join(".claude", "skills", "inbox", "SKILL.md"), old);
  const before = join(home, ".review-desk");
  mkdirSync(before);
  assert.deepEqual(runSync(refreshSkills(join(home, ".inbox"), MCP)), [], "not yet the home");
  assert.deepEqual(runSync(refreshSkills(before, MCP)), [`refreshed the Inbox skill at ${claudeSkill()}`]);
  mkdirSync(join(home, ".inbox"));
  writeFileSync(claudeSkill(), old);
  assert.deepEqual(runSync(refreshSkills(before, MCP)), [], "moved, a folder left beside it isn't the home");
  rmSync(before, { recursive: true });
  symlinkSync(join(home, ".inbox"), before, "junction");
  assert.deepEqual(runSync(refreshSkills(before, MCP)), [`refreshed the Inbox skill at ${claudeSkill()}`], "a desk through the link is");
});

// What Connect installed before the rename to Inbox: the skill as review-desk, and the MCP server named review-desk.
const OLD_SKILL = SKILL.replace(/^---\nname: inbox\n/, "---\nname: review-desk\n").replaceAll("Inbox", "Review Desk");
const before = () => {
  write(join(".claude", "skills", "review-desk", "SKILL.md"), OLD_SKILL);
  write(".claude.json", JSON.stringify({ mcpServers: { "review-desk": { type: "http", url: MCP }, other: {} } }));
  // A Claude Code whose ~/.claude.json gains inbox on `mcp add` and loses review-desk on `mcp remove`; it says what it was asked.
  const after = (add: boolean) =>
    JSON.stringify({ mcpServers: { ...(add && { "review-desk": {} }), other: {}, inbox: { type: "http", url: MCP } } });
  fake(
    "claude",
    `printf '%s\\n' "$*" >> "$HOME/claude-calls"
case "$2" in add) printf '%s' '${after(true)}' > "$HOME/.claude.json" ;; remove) printf '%s' '${after(false)}' > "$HOME/.claude.json" ;; esac`,
  );
};
const calls = () => readFileSync(join(home, "claude-calls"), "utf8").trim().split("\n");
const servers = () => Object.keys((JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as { mcpServers: object }).mcpServers);

test(
  "the owner's desk moves what Connect installed before the rename: the skill's copy to inbox, the review-desk server to inbox",
  { skip: process.platform === "win32" },
  async () => {
    before();
    // A review-desk skill folder with a file the desk never ships is the owner's own: it stays.
    write(join(".agents", "skills", "review-desk", "SKILL.md"), OLD_SKILL);
    write(join(".agents", "skills", "review-desk", "notes.md"), "mine");
    const old = join(home, ".claude", "skills", "review-desk");
    assert.deepEqual(await run(refreshSkills(join(home, "scratch-desk"), MCP)), [], "a scratch desk leaves them alone");
    assert.ok(existsSync(old));
    assert.deepEqual(await run(refreshSkills(join(home, ".inbox"), MCP)), [
      `moved the Inbox skill from ${old} to ${join(home, ".claude", "skills", "inbox")}`,
      "renamed claude's MCP server review-desk to inbox",
    ]);
    assert.equal(existsSync(old), false);
    assert.equal(readFileSync(claudeSkill(), "utf8"), SKILL);
    assert.deepEqual(calls(), [`mcp add --transport http --scope user inbox ${MCP}`, "mcp remove --scope user review-desk"]);
    assert.deepEqual(servers(), ["other", "inbox"]);
    assert.equal(readFileSync(join(home, ".agents", "skills", "review-desk", "notes.md"), "utf8"), "mine");
    assert.equal(existsSync(join(home, ".agents", "skills", "inbox")), false, "Codex was never connected here");
    assert.deepEqual(await run(refreshSkills(join(home, ".inbox"), MCP)), [], "done once");
    assert.equal(calls().length, 2);
  },
);

test("Connect does the same: it installs the new names, then removes the old", { skip: process.platform === "win32" }, async () => {
  before();
  const was = runSync(status("claude-code", MCP));
  assert.deepEqual([was.mcp.connected, was.skill.state], [true, "missing"], "its tools work under the old name until it's renamed");
  const said: string[] = [];
  const s = await run(
    connect("claude-code", MCP, {
      log: (line) => {
        said.push(line);
      },
    }),
  );
  assert.deepEqual([s.mcp.connected, s.skill.state, s.needs], [true, "installed", null]);
  assert.deepEqual(said, [
    `moved the Inbox skill from ${join(home, ".claude", "skills", "review-desk")} to ${join(home, ".claude", "skills", "inbox")}`,
    "renamed claude's MCP server review-desk to inbox",
  ]);
  assert.deepEqual(calls(), [`mcp add --transport http --scope user inbox ${MCP}`, "mcp remove --scope user review-desk"]);
  assert.deepEqual(servers(), ["other", "inbox"]);
  assert.equal(existsSync(join(home, ".claude", "skills", "review-desk")), false);
  fake("claude", "exit 1");
  assert.equal((await run(connect("claude-code", MCP))).mcp.connected, true, "nothing left to do: nothing runs");
});

// An email skill of the owner's, say: inbox is a common name, and the desk never writes over a skill that isn't its own.
const MAIL = "---\nname: inbox\ndescription: Triage my email inbox with the gmail MCP\n---\nArchive newsletters.\n";
// A support inbox whose tools end in desk_ (zendesk_search) isn't the desk's either.
const SUPPORT =
  "---\nname: inbox\ndescription: Work my support inbox\n---\nFind the ticket with zendesk_search, then helpdesk_escalate it.\n";

test("another skill named inbox is the owner's: the refresh, Connect and the rename leave it as it is", async () => {
  write(".claude.json", JSON.stringify({ mcpServers: { inbox: { type: "http", url: MCP } } }));
  write(join(".claude", "skills", "inbox", "SKILL.md"), SUPPORT);
  assert.equal(runSync(status("claude-code", MCP)).skill.state, "taken");
  assert.deepEqual(await run(refreshSkills(join(home, ".inbox"), MCP)), []);
  assert.equal(readFileSync(claudeSkill(), "utf8"), SUPPORT);
  write(join(".claude", "skills", "inbox", "SKILL.md"), MAIL);
  const s = runSync(status("claude-code", MCP));
  assert.deepEqual([s.skill.state, s.needs, s.connect], ["taken", "connect", []]);
  assert.deepEqual(await run(refreshSkills(join(home, ".inbox"), MCP)), []);
  const taken = await failure(connect("claude-code", MCP));
  assert.deepEqual(
    [taken._tag, taken.message],
    ["Conflict", `${claudeSkill()} is another skill named inbox, not the desk's: move it, then connect again`],
  );
  // The copy from before the rename stays where it is, so the agent keeps the desk's skill.
  write(join(".claude", "skills", "review-desk", "SKILL.md"), OLD_SKILL);
  const old = join(home, ".claude", "skills", "review-desk");
  assert.deepEqual(await run(refreshSkills(join(home, ".inbox"), MCP)), [
    `kept the Inbox skill in ${old}: ${join(home, ".claude", "skills", "inbox")} is another skill named inbox`,
  ]);
  assert.equal(readFileSync(claudeSkill(), "utf8"), MAIL);
  assert.equal(readFileSync(join(old, "SKILL.md"), "utf8"), OLD_SKILL);
});

test(
  "another MCP server named inbox: the desk's stays review-desk, and Connect says the name is taken",
  { skip: process.platform === "win32" },
  async () => {
    before();
    const mail = { type: "stdio", command: "npx", args: ["-y", "gmail-mcp"] };
    write(".claude.json", JSON.stringify({ mcpServers: { "review-desk": { type: "http", url: MCP }, inbox: mail } }));
    assert.equal(runSync(status("claude-code", MCP)).mcp.connected, true, "its tools are there as review-desk");
    assert.deepEqual(await run(refreshSkills(join(home, ".inbox"), MCP)), [
      `moved the Inbox skill from ${join(home, ".claude", "skills", "review-desk")} to ${join(home, ".claude", "skills", "inbox")}`,
      "kept claude's MCP server review-desk: inbox is another server's name there",
    ]);
    assert.equal(existsSync(join(home, "claude-calls")), false, "nothing was added or removed");
    assert.deepEqual(servers(), ["review-desk", "inbox"]);
    // A command that only ends in desk mcp isn't the desk's: the desk's review-desk isn't removed for it.
    const helpdesk = { type: "stdio", command: "npx", args: ["-y", "@acme/helpdesk", "mcp"] };
    write(".claude.json", JSON.stringify({ mcpServers: { "review-desk": { type: "http", url: MCP }, inbox: helpdesk } }));
    assert.deepEqual(await run(refreshSkills(join(home, ".inbox"), MCP)), [
      "kept claude's MCP server review-desk: inbox is another server's name there",
    ]);
    assert.equal(existsSync(join(home, "claude-calls")), false);
    assert.deepEqual(servers(), ["review-desk", "inbox"]);

    write(".claude.json", JSON.stringify({ mcpServers: { inbox: mail } }));
    assert.equal(runSync(status("claude-code", MCP)).mcp.connected, false, "a server named inbox isn't the desk's by its name");
    const taken = await failure(connect("claude-code", MCP));
    assert.deepEqual(
      [taken._tag, taken.message],
      ["Conflict", "claude has another MCP server named inbox, not the desk's: rename or remove it, then connect again"],
    );
    assert.equal(existsSync(join(home, "claude-calls")), false);
    // The desk's own, by its URL on any loopback name, or as `desk mcp` over stdio (bin/desk, bin/desk.cmd, or node on this
    // desk's src/cli.ts) aimed at its port; another port, or another program's mcp, isn't this desk.
    const cli = join(import.meta.dirname, "..", "src", "cli.ts");
    const at = { DESK_PORT: "47961" };
    const connected = (inbox: object) => {
      write(".claude.json", JSON.stringify({ mcpServers: { inbox } }));
      return runSync(status("claude-code", MCP)).mcp.connected;
    };
    for (const inbox of [
      { type: "http", url: "http://127.0.0.1:47961/mcp" },
      { type: "stdio", command: "/usr/local/bin/desk", args: ["mcp"], env: at },
      { type: "stdio", command: String.raw`C:\Users\me\code\review-desk\bin\desk.cmd`, args: ["mcp"], env: at },
      { type: "stdio", command: "/opt/homebrew/bin/node", args: ["--disable-warning=ExperimentalWarning", cli, "mcp"], env: at },
    ])
      assert.equal(connected(inbox), true, JSON.stringify(inbox));
    for (const inbox of [
      { type: "http", url: "http://localhost:47962/mcp" },
      { type: "stdio", command: "/usr/local/bin/desk", args: ["mcp"], env: { DESK_PORT: "47823" } },
      { type: "stdio", command: "/usr/local/bin/desk", args: ["mcp"] },
      { type: "stdio", command: "npx", args: ["-y", "@acme/helpdesk", "mcp"], env: at },
      { type: "stdio", command: "node", args: ["/elsewhere/src/cli.ts", "mcp"], env: at },
    ])
      assert.equal(connected(inbox), false, JSON.stringify(inbox));
    process.env.DESK_PORT = "47961";
    assert.equal(connected({ type: "stdio", command: "desk", args: ["mcp"] }), true, "no DESK_PORT of its own: the desk's");
  },
);

test("one agent's CLI failing doesn't hold up the other's renaming", { skip: process.platform === "win32" }, async () => {
  before();
  rmSync(join(bin, "claude"));
  write(join(".agents", "skills", "review-desk", "SKILL.md"), OLD_SKILL);
  write(join(".codex", "config.toml"), `[mcp_servers.review-desk]\nurl = "${MCP}"\n`);
  // A Codex whose config gains inbox on `mcp add` and loses review-desk on `mcp remove`.
  const toml = (...names: string[]) => names.map((n) => `[mcp_servers.${n}]\nurl = "${MCP}"\n`).join("");
  write("codex-add.toml", toml("review-desk", "inbox"));
  write("codex-remove.toml", toml("inbox"));
  fake("codex", `/bin/cp "$HOME/codex-$2.toml" "$HOME/.codex/config.toml"`);
  const skills = (agent: string) => join(home, agent, "skills");
  assert.deepEqual(await run(refreshSkills(join(home, ".inbox"), MCP)), [
    `moved the Inbox skill from ${join(skills(".claude"), "review-desk")} to ${join(skills(".claude"), "inbox")}`,
    `couldn't bring claude's Inbox skill and MCP server up to date: claude isn't on PATH. Run it yourself: claude mcp add --transport http --scope user inbox ${MCP}`,
    `moved the Inbox skill from ${join(skills(".agents"), "review-desk")} to ${join(skills(".agents"), "inbox")}`,
    "renamed codex's MCP server review-desk to inbox",
  ]);
  const codex = runSync(status("codex", MCP));
  assert.deepEqual([codex.mcp.connected, codex.skill.state], [true, "installed"]);
  assert.equal(readFileSync(join(home, ".codex", "config.toml"), "utf8"), toml("inbox"));
  assert.equal(runSync(status("claude-code", MCP)).mcp.connected, true, "claude keeps the old name's tools until the next try");
});
