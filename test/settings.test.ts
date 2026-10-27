import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { checkSetting, DEFAULTS, effective, migrateLegacy, readSettings, SETTINGS, writeSettings } from "../src/settings.ts";
import { defaultConfigText, parseConfig } from "../src/config.ts";

test("every setting's default is valid", () => {
  for (const d of SETTINGS) assert.equal(checkSetting(d.key, d.default), null, d.key);
});

test("checkSetting", () => {
  assert.match(checkSetting("github.poll_seconds", 10)!, /at least 30/);
  assert.match(checkSetting("github.poll_seconds", 60.5)!, /whole number/);
  assert.equal(checkSetting("github.poll_seconds", 60), null);
  assert.match(checkSetting("github.my_repos", ["getsentry"])!, /owner\/name/);
  assert.equal(checkSetting("github.my_repos", ["getsentry/sentry"]), null);
  assert.equal(checkSetting("notify.quiet", ""), null);
  assert.match(checkSetting("notify.quiet", "7pm")!, /19:00-09:00/);
  assert.equal(checkSetting("app.hotkey", ""), null);
  assert.equal(checkSetting("app.hotkey", "CommandOrControl+Shift+K"), null);
  assert.match(checkSetting("app.hotkey", "K")!, /modifiers/);
  assert.match(checkSetting("handoff.prompt", "  ")!, /empty/);
  assert.match(checkSetting("nope.nope", 1)!, /unknown/);
});

test("settings.json: bad entries fall back to defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-settings-"));
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ "github.poll_seconds": 5, "github.bots": ["ci-helper"], "x.y": 1 }));
  const { overrides, errors, raw } = readSettings(file);
  assert.deepEqual(overrides, { "github.bots": ["ci-helper"] });
  assert.deepEqual(errors.map((e) => e.path), ["github.poll_seconds", "x.y"]);
  assert.deepEqual(raw, { "github.poll_seconds": 5, "github.bots": ["ci-helper"], "x.y": 1 });
  const s = effective(overrides);
  assert.equal(s["github.poll_seconds"], 90);
  assert.deepEqual(s["github.bots"], ["ci-helper"]);
  writeSettings(file, { "notify.enabled": false });
  assert.deepEqual(readSettings(file).overrides, { "notify.enabled": false });
  fs.writeFileSync(file, "{ not json");
  assert.equal(readSettings(file).errors[0].path, "settings.json");
  assert.equal(readSettings(file).raw, null);
});

test("writeSettings writes through a symlinked settings.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-settings-"));
  const real = path.join(dir, "dotfiles.json");
  const link = path.join(dir, "settings.json");
  fs.writeFileSync(real, "{}");
  fs.symlinkSync(real, link);
  writeSettings(link, { "notify.enabled": false });
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.deepEqual(JSON.parse(fs.readFileSync(real, "utf8")), { "notify.enabled": false });
  assert.deepEqual(fs.readdirSync(dir).sort(), ["dotfiles.json", "settings.json"]);
});

const LEGACY = `# header
poll_seconds = 60

[signals]
close_collaborator_min = 3   # default, so it isn't copied
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
    "analyze.command": "/opt/bin/claude",
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
  assert.equal(m.text, `[[spaces]]
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
`);
  assert.equal(m.moved["handoff.mine"], "# inside a string\nx");
});

test("defaults are what parseConfig uses without settings", () => {
  const cfg = parseConfig(defaultConfigText({ workOrgs: [] })).loaded!.config;
  assert.equal(cfg.poll_seconds, DEFAULTS["github.poll_seconds"]);
  assert.equal(cfg.handoff.prompt, DEFAULTS["handoff.prompt"]);
});
