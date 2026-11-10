import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import {
  checkSetting,
  DEFAULTS,
  effective,
  loadSettings,
  migrateLegacy,
  readSettings,
  SECTIONS,
  SETTINGS,
  writeSettings,
} from "../src/settings.ts";
import { defaultConfigText, parseConfig } from "../src/config.ts";
import type { SettingDef } from "../src/types.ts";
import { failureSync, runSync } from "./helpers/run.ts";

test("every setting's default is valid", () => {
  for (const d of SETTINGS) assert.equal(checkSetting(d.key, d.default), null, d.key);
});

test("a number names its unit after its field, never in its label", () => {
  for (const d of SETTINGS as readonly SettingDef[]) {
    assert.doesNotMatch(d.label, /\(\w+\)$/, d.key);
    if (d.type === "number") assert.ok(d.unit, `${d.key} has a unit`);
    else assert.equal(d.unit, undefined, `${d.key}: only a number has a unit`);
  }
});

test("a setting's help is one short line", () => {
  for (const d of SETTINGS as readonly SettingDef[])
    if (d.help) assert.ok(d.help.length <= 120, `${d.key}'s help is ${d.help.length} characters`);
});

test("every setting is in one of the page's parts, and no part folds all of its own behind More", () => {
  const defs = SETTINGS as readonly SettingDef[];
  for (const d of defs)
    assert.ok(
      SECTIONS.some((s) => s.id === d.section),
      `${d.key} is in ${d.section}`,
    );
  for (const s of SECTIONS) {
    const own = defs.filter((d) => d.section === s.id);
    if (own.length)
      assert.ok(
        own.some((d) => !d.more),
        `${s.id} shows something before its More`,
      );
  }
  // The array reads in the page's order, part by part.
  const order = defs.map((d) => d.section).filter((s, i, all) => s !== all[i - 1]);
  assert.deepEqual(
    order,
    SECTIONS.map((s) => s.id).filter((id) => defs.some((d) => d.section === id)),
  );
});

test("checkSetting", () => {
  assert.match(checkSetting("github.poll_seconds", 10)!, /at least 30/);
  assert.match(checkSetting("github.poll_seconds", 60.5)!, /whole number/);
  assert.equal(checkSetting("github.poll_seconds", 60), null);
  assert.match(checkSetting("github.my_repos", ["getsentry"])!, /owner\/name/);
  assert.equal(checkSetting("github.my_repos", ["getsentry/sentry"]), null);
  assert.equal(checkSetting("agent.harness", "claude-code"), null);
  assert.equal(checkSetting("agent.harness", "codex"), null, "Codex sorts and reviews too");
  assert.match(checkSetting("agent.harness", "cursor")!, /one of claude-code, codex/);
  assert.equal(checkSetting("notify.quiet", ""), null);
  assert.match(checkSetting("notify.quiet", "7pm")!, /19:00-09:00/);
  assert.equal(checkSetting("app.hotkey", ""), null);
  assert.equal(checkSetting("app.hotkey", "CommandOrControl+Shift+K"), null);
  assert.match(checkSetting("app.hotkey", "K")!, /modifiers/);
  assert.match(checkSetting("handoff.prompt", "  ")!, /empty/);
  // There's no agent to pick: every agent is your own Claude Code.
  assert.match(checkSetting("agent.driver", "codex")!, /unknown/);
  assert.match(checkSetting("nope.nope", 1)!, /unknown/);
});

test("settings.json: bad entries fall back to defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-settings-"));
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ "github.poll_seconds": 5, "github.bots": ["ci-helper"], "x.y": 1 }));
  const { overrides, errors, raw } = readSettings(file);
  assert.deepEqual(overrides, { "github.bots": ["ci-helper"] });
  assert.deepEqual(
    errors.map((e) => e.path),
    ["github.poll_seconds", "x.y"],
  );
  assert.deepEqual(raw, { "github.poll_seconds": 5, "github.bots": ["ci-helper"], "x.y": 1 });
  const s = effective(overrides);
  assert.equal(s["github.poll_seconds"], 90);
  assert.deepEqual(s["github.bots"], ["ci-helper"]);
  runSync(writeSettings(file, { "notify.enabled": false }));
  assert.deepEqual(readSettings(file).overrides, { "notify.enabled": false });
  fs.writeFileSync(file, "{ not json");
  assert.equal(readSettings(file).errors[0]?.path, "settings.json");
  assert.equal(readSettings(file).raw, null);
  assert.equal(runSync(loadSettings(file)).raw, null, "what's in it is collected, never a failure");
  fs.writeFileSync(file, "[]");
  assert.deepEqual(readSettings(file).errors, [{ path: "settings.json", message: "must be a JSON object" }]);
  assert.deepEqual(runSync(loadSettings(path.join(dir, "none.json"))), { overrides: {}, errors: [], raw: {}, text: "" });
  assert.equal(readSettings(file).text, "[]", "what it read, so a watcher can tell it changed");
});

test("a settings.json that can't be read fails with FsError, and the desk starts on defaults with it as a problem", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-settings-"));
  const file = path.join(dir, "settings.json");
  fs.mkdirSync(file);
  const e = failureSync(loadSettings(file));
  assert.deepEqual([e._tag, e.op, e.path, e.code], ["FsError", "read", file, "EISDIR"]);
  assert.match(e.message, /^EISDIR: illegal operation on a directory/, "Node's words, which name what it did");
  assert.deepEqual(readSettings(file), {
    overrides: {},
    errors: [{ path: "settings.json", message: e.message }],
    raw: null,
    text: null,
  });
});

test("writeSettings fails with FsError when settings.json can't be written", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-settings-"));
  const file = path.join(dir, "gone", "settings.json");
  const e = failureSync(writeSettings(file, { "notify.enabled": false }));
  assert.deepEqual([e._tag, e.op, e.path, e.code], ["FsError", "write", `${file}.${process.pid}.tmp`, "ENOENT"]);
  assert.match(e.message, /^ENOENT: no such file or directory, open /);
});

test("settings that no longer exist (the Claude model and command) load without errors and stay in the file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-settings-"));
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ "analyze.model": "opus", "analyze.command": "/opt/bin/claude", "notify.enabled": false }));
  const { overrides, errors, raw } = readSettings(file);
  assert.deepEqual(errors, []);
  assert.deepEqual(overrides, { "notify.enabled": false });
  assert.deepEqual(raw, { "analyze.model": "opus", "analyze.command": "/opt/bin/claude", "notify.enabled": false });
  assert.equal(checkSetting("analyze.model", "opus"), 'unknown setting "analyze.model"', "and can't be set again");
  assert.equal(checkSetting("analyze.command", "/opt/bin/claude"), 'unknown setting "analyze.command"');
});

test("Now's and Today's folds give way to one for the queue: the old keys load without errors and are ignored", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-settings-"));
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ "queue.now_cards": 3, "queue.today_cards": 8, "queue.quiet_days": 7 }));
  const { overrides, errors, raw } = readSettings(file);
  assert.deepEqual(errors, []);
  assert.deepEqual(overrides, { "queue.quiet_days": 7 });
  assert.deepEqual(raw, { "queue.now_cards": 3, "queue.today_cards": 8, "queue.quiet_days": 7 });
  assert.equal(effective(overrides)["queue.cards"], 10);
  assert.match(checkSetting("queue.now_cards", 3)!, /unknown/);
  assert.equal(checkSetting("queue.cards", 0), null, "0 shows them all");
});

test("writeSettings writes through a symlinked settings.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-settings-"));
  const real = path.join(dir, "dotfiles.json");
  const link = path.join(dir, "settings.json");
  fs.writeFileSync(real, "{}");
  fs.symlinkSync(real, link);
  runSync(writeSettings(link, { "notify.enabled": false }));
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.deepEqual(JSON.parse(fs.readFileSync(real, "utf8")), { "notify.enabled": false });
  assert.deepEqual(fs.readdirSync(dir).sort(), ["dotfiles.json", "settings.json"]);
});

const LEGACY = `# header
poll_seconds = 60

[signals]
close_collaborator_min = 5   # default, so it isn't copied
bots = ["ci-helper"]
my_repos = []

[notify]
enabled = false
quiet = "19:00-09:00"

[handoff]
# comment
prompt = """
Review {item.url}.
[not a table] inside a string
Do not post."""
mine = """
x"""
issue = """
y"""

[analyze]
command = "/opt/bin/claude"
model = "sonnet"
`;

test("migrateLegacy moves settings out of config.toml and keeps boards", () => {
  const boards = defaultConfigText({ workOrgs: ["acme"] });
  const m = migrateLegacy(LEGACY + "\n" + boards)!;
  assert.deepEqual(m.moved, {
    "github.poll_seconds": 60,
    "github.bots": ["ci-helper"],
    "notify.enabled": false,
    "handoff.prompt": "Review {item.url}.\n[not a table] inside a string\nDo not post.",
    "handoff.mine": "x",
    "handoff.issue": "y",
  });
  assert.ok(m.text);
  assert.ok(m.text.startsWith("# header\n"));
  assert.deepEqual(parse(m.text), parse(boards));
  assert.deepEqual(parseConfig(m.text).errors, []);
  assert.ok(migrateLegacy(`poll_seconds = 60\n\n[notify]\nenabled = false\n\n${boards}`)!.text === boards, "no leading blank lines");
  assert.equal(migrateLegacy(boards), null);
});

test("migrateLegacy keeps the comments that describe the table after a dropped one", () => {
  const m = migrateLegacy(`[[spaces]]
id = "w"

[analyze]
# dropped with the table
command = "/opt/bin/claude"

# ── Work ──
# PRs to review
[[boards]]
id = "a"
space = "w"
query = "x"

[notify]
enabled = false
# about notify, dropped since [handoff] is dropped too

[handoff]
mine = """
# inside a string
x"""
# Mentions
[[boards]]
id = "b"
space = "w"
query = "y"
`)!;
  assert.equal(
    m.text,
    `[[spaces]]
id = "w"

# ── Work ──
# PRs to review
[[boards]]
id = "a"
space = "w"
query = "x"

# Mentions
[[boards]]
id = "b"
space = "w"
query = "y"
`,
  );
  assert.equal(m.moved["handoff.mine"], "# inside a string\nx");
});

test("defaults are what parseConfig uses without settings", () => {
  const cfg = parseConfig(defaultConfigText({ workOrgs: [] })).loaded!.config;
  assert.equal(cfg.poll_seconds, DEFAULTS["github.poll_seconds"]);
  assert.equal(cfg.handoff.prompt, DEFAULTS["handoff.prompt"]);
});

test("a secret setting is kept in secrets.json, yours alone to read, set only from the window, and never sent back: set, it reads as dots", async (c) => {
  const { setup } = await import("./helpers/desk.ts");
  const { createApp } = await import("../src/server.ts");
  const { run } = await import("./helpers/run.ts");
  const KEY = "sk-or-v1-1111111111111111111111111111111111111111111111111111111111111111";
  const DOTS = "•".repeat(8);
  const logs: string[] = [];
  const t = await setup([], {
    desk: {
      log: (m) => {
        logs.push(m);
      },
    },
  });
  c.after(t.cleanup);
  const def = (SETTINGS as readonly SettingDef[]).find((d) => d.key === "agent.decision_key")!;
  assert.deepEqual([def.type, def.default, t.desk.getSettings().values["agent.decision_key"]], ["secret", "", ""], "none by default");
  for (const [bad, why] of [
    [3, "must be one line with no spaces"],
    ["sk or", "must be one line with no spaces"],
    [`${DOTS}sk-or-new`, "paste the whole key in place of the dots"],
  ] as const)
    assert.equal(checkSetting("agent.decision_key", bad), why);

  const DESK = { origin: "http://localhost:47823", "sec-fetch-site": "same-origin", "content-type": "application/json" };
  const app = createApp(t.desk, 47823);
  const put = async (body: unknown, headers: Record<string, string> = DESK) => {
    const res = await app.request("http://127.0.0.1:47823/api/settings", { method: "PUT", headers, body: JSON.stringify(body) });
    return { status: res.status, text: await res.text() };
  };
  // Not from an agent, the CLI or curl: only the desk's own page sets or clears it; other settings as before.
  const agent = { "content-type": "application/json" };
  for (const body of [{ set: { "agent.decision_key": KEY } }, { reset: ["agent.decision_key"] }]) {
    const r = await put(body, agent);
    assert.deepEqual([r.status, (JSON.parse(r.text) as { tag: string }).tag], [403, "Forbidden"], JSON.stringify(body));
  }
  assert.equal(t.desk.settings["agent.decision_key"], "");
  assert.equal((await put({ set: { "queue.cards": 11 } }, agent)).status, 200);
  const saved = (await put({ set: { "agent.decision_key": KEY } })).text;
  assert.ok(!saved.includes(KEY), "the answer to the save doesn't repeat it");
  assert.equal(t.desk.settings["agent.decision_key"], KEY, "the desk has it");
  const file = path.join(t.home, "secrets.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { "agent.decision_key": KEY });
  assert.ok(!fs.readFileSync(path.join(t.home, "settings.json"), "utf8").includes(KEY), "not in settings.json");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const view = t.desk.getSettings();
  assert.deepEqual([view.values["agent.decision_key"], view.overridden.includes("agent.decision_key")], [DOTS, true]);
  for (const p of ["/api/settings", "/api/overview", "/api/automations", "/api/status", "/api/policy", "/api/config"]) {
    const body = await (await app.request(`http://127.0.0.1:47823${p}`)).text();
    assert.ok(!body.includes(KEY), `${p} doesn't carry it`);
  }
  // What a client was shown, sent back, changes nothing; another setting saved beside it leaves it alone.
  await put({ set: { "agent.decision_key": DOTS, "queue.cards": 12 } });
  assert.deepEqual([t.desk.settings["agent.decision_key"], t.desk.settings["queue.cards"]], [KEY, 12]);
  await run(t.desk.putSettings({ reset: ["agent.decision_key"] }));
  assert.deepEqual([t.desk.settings["agent.decision_key"], t.desk.getSettings().values["agent.decision_key"]], ["", ""], "reset clears it");
  assert.ok(!logs.join("\n").includes(KEY), "nothing logged it");
});

test("a secret in settings.json moves to secrets.json once, and secrets.json is never written through a link", async (c) => {
  const { setup } = await import("./helpers/desk.ts");
  const KEY = "sk-or-v1-3333333333333333333333333333333333333333333333333333333333333333";
  const t = await setup([], { settings: { "agent.decision_key": KEY, "queue.cards": 12 } });
  c.after(t.cleanup);
  const settings = path.join(t.home, "settings.json");
  const secrets = path.join(t.home, "secrets.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, "utf8")), { "queue.cards": 12 }, "moved out of settings.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(secrets, "utf8")), { "agent.decision_key": KEY });
  if (process.platform !== "win32") assert.equal(fs.statSync(secrets).mode & 0o777, 0o600);
  assert.deepEqual([t.desk.settings["agent.decision_key"], t.desk.settings["queue.cards"]], [KEY, 12]);
  if (process.platform === "win32") return;
  const elsewhere = path.join(t.home, "dotfiles-secrets.json");
  fs.writeFileSync(elsewhere, "{}");
  fs.rmSync(secrets);
  fs.symlinkSync(elsewhere, secrets);
  const r = runSync(t.desk.putSettings({ set: { "agent.decision_key": "sk-or-v1-new" } }));
  assert.deepEqual(r.errors, [
    {
      path: "secrets.json",
      message: `${secrets} is a link; the desk writes keys only to a file of its own. Replace it with a plain file.`,
    },
  ]);
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(elsewhere, "utf8"), "{}", "nothing written through it");
  assert.equal(runSync(t.desk.putSettings({ set: { "queue.cards": 9 } })).ok, true, "other settings save as before");
});
