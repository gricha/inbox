// The light model: its model and effort reach each agent's command, and a tier model your agent lacks gives way to its default.
import "./helpers/no-agent.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { driverOf } from "../src/agents.ts";
import { Light } from "../src/light.ts";
import { DEFAULTS, type Settings } from "../src/settings.ts";
import { setup } from "./helpers/desk.ts";
import { run } from "./helpers/run.ts";
import { posix } from "./helpers/platform.ts";

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } } };

// A claude and a codex that record each call's args; codex refuses gpt-5.6-luna while `noluna` exists, as an account without it does.
function fakes(c: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-fake-light-"));
  const at = (f: string) => path.join(dir, f);
  fs.writeFileSync(
    at("claude"),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> "${at("claude.args")}"; echo --- >> "${at("claude.args")}"; cat > /dev/null\nprintf '{"type":"result","is_error":false,"structured_output":{"ok":true}}'\n`,
  );
  fs.writeFileSync(
    at("codex"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("mcp")) { process.stdout.write("[]"); process.exit(0); }
fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(at("codex.calls"))}, JSON.stringify(args) + "\\n");
const say = (o) => fs.writeSync(1, JSON.stringify(o) + "\\n");
const m = args.indexOf("--model");
if (m >= 0 && args[m + 1] === "gpt-5.6-luna" && fs.existsSync(${JSON.stringify(at("noluna"))})) {
  say({ type: "turn.failed", error: { message: '{"error":{"message":"gpt-5.6-luna is not a valid model ID","code":400}}' } });
  process.exit(0);
}
fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ ok: true }));
say({ type: "turn.completed" });
`,
  );
  fs.chmodSync(at("claude"), 0o755);
  fs.chmodSync(at("codex"), 0o755);
  const was = { claude: process.env.DESK_CLAUDE, codex: process.env.DESK_CODEX };
  process.env.DESK_CLAUDE = at("claude");
  process.env.DESK_CODEX = at("codex");
  c.after(() => {
    if (was.claude === undefined) delete process.env.DESK_CLAUDE;
    else process.env.DESK_CLAUDE = was.claude;
    if (was.codex === undefined) delete process.env.DESK_CODEX;
    else process.env.DESK_CODEX = was.codex;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const claudeCalls = () =>
    fs.existsSync(at("claude.args"))
      ? fs
          .readFileSync(at("claude.args"), "utf8")
          .split("---\n")
          .filter(Boolean)
          .map((x) => x.trim().split("\n"))
      : [];
  const codexCalls = (): string[][] =>
    fs.existsSync(at("codex.calls"))
      ? fs
          .readFileSync(at("codex.calls"), "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as string[])
      : [];
  return { dir, at, claudeCalls, codexCalls };
}

function light(home: string, set: Partial<Settings>, logs: string[] = []) {
  const settings: Settings = { ...DEFAULTS, ...set };
  return new Light({
    settings,
    home,
    decisions: undefined,
    agent: () => driverOf(settings["agent.harness"]),
    agentRuns: () => ({ model: settings["agent.coordinator_model"], effort: settings["agent.coordinator_effort"] }),
    log: (m) => {
      logs.push(m);
    },
  });
}

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test(
  "the light model's model and effort reach each command: Claude Code's --model and --effort, Codex's --model and reasoning effort",
  posix,
  async (c) => {
    const f = fakes(c);
    await run(light(f.dir, { "agent.harness": "claude-code" }).ask("hi", SCHEMA));
    const [claude] = f.claudeCalls();
    assert.deepEqual([after(claude!, "--model"), after(claude!, "--effort")], ["claude-haiku-5-5", "low"]);

    await run(
      light(f.dir, { "agent.harness": "claude-code", "agent.light_model": "sonnet", "agent.light_effort": "medium" }).ask("hi", SCHEMA),
    );
    const [, set] = f.claudeCalls();
    assert.deepEqual([after(set!, "--model"), after(set!, "--effort")], ["sonnet", "medium"], "what you set");

    await run(light(f.dir, { "agent.harness": "codex" }).ask("hi", SCHEMA));
    const [codex] = f.codexCalls();
    assert.deepEqual([after(codex!, "--model"), after(codex!, "-c")], ["gpt-5.6-luna", 'model_reasoning_effort="low"']);
  },
);

test(
  "a tier model your agent doesn't have gives way to your agent's model, at the same effort, and isn't tried again",
  posix,
  async (c) => {
    const f = fakes(c);
    fs.writeFileSync(f.at("noluna"), "");
    const logs: string[] = [];
    const l = light(f.dir, { "agent.harness": "codex", "agent.coordinator_model": "gpt-6" }, logs);
    const { answer } = await run(l.ask("hi", SCHEMA));
    assert.deepEqual(answer, { ok: true });
    const [luna, plain] = f.codexCalls();
    assert.equal(after(luna!, "--model"), "gpt-5.6-luna");
    assert.equal(after(plain!, "--model"), "gpt-6", "your agent's model, never the CLI's own default");
    assert.ok(plain!.includes('model_reasoning_effort="low"'));
    assert.match(logs.join("\n"), /Codex has no gpt-5\.6-luna; your agent's model runs instead/);
    await run(l.ask("again", SCHEMA));
    assert.equal(f.codexCalls().length, 3);
    assert.equal(after(f.codexCalls()[2]!, "--model"), "gpt-6", "not asked for Luna again");

    // A model you set fails as itself.
    const yours = light(f.dir, { "agent.harness": "codex", "agent.light_model": "gpt-5.6-luna" });
    await assert.rejects(run(yours.ask("hi", SCHEMA)), /not a valid model ID/);
  },
);

test("agent.rules_model is read as the light model, saved under its new name on start, and kept per agent under either name", async (c) => {
  const t = await setup([], { settings: { "agent.rules_model": "sonnet" } });
  c.after(t.cleanup);
  assert.equal(t.desk.settings["agent.light_model"], "claude-sonnet-5-5", "Claude Code's alias, read as the version it is now");
  const file = JSON.parse(fs.readFileSync(path.join(t.home, "settings.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual([file["agent.light_model"], "agent.rules_model" in file], ["sonnet", false]);

  // An agent's models put away before the rename come back as the light model.
  t.desk.store.set("agent_models", { codex: { "agent.rules_model": "gpt-5.5" } });
  await run(t.desk.putSettings({ set: { "agent.harness": "codex" } }));
  assert.equal(t.desk.settings["agent.light_model"], "gpt-5.5");
  await run(t.desk.putSettings({ set: { "agent.harness": "claude-code" } }));
  assert.equal(t.desk.settings["agent.light_model"], "claude-sonnet-5-5");
});
