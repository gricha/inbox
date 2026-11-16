import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLAUDE_MODELS, codexModels, opencodeModels } from "../src/models.ts";
import { agentDefs, DEFAULTS, rulesModel } from "../src/settings.ts";
import { run } from "./helpers/run.ts";

const posix = { skip: process.platform === "win32" };

test(
  "Codex's models are what `codex debug models` lists and reasons with, in its order; its efforts are the levels any takes",
  posix,
  async (c) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-codex-models-"));
    c.after(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const levels = (...e: string[]) => e.map((effort) => ({ effort, description: "" }));
    const catalog = {
      models: [
        {
          slug: "gpt-6-mini",
          display_name: "GPT-6 mini",
          visibility: "list",
          priority: 3,
          supported_reasoning_levels: levels("low", "medium"),
        },
        { slug: "gpt-6", display_name: "GPT-6", visibility: "list", priority: 1, supported_reasoning_levels: levels("medium", "ultra") },
        { slug: "image-1", display_name: "Image", visibility: "list", priority: 2, supported_reasoning_levels: [] },
        { slug: "internal", display_name: "Hidden", visibility: "hide", priority: 0, supported_reasoning_levels: levels("high") },
      ],
    };
    fs.writeFileSync(path.join(dir, "catalog.json"), JSON.stringify(catalog));
    const bin = path.join(dir, "codex");
    fs.writeFileSync(bin, `#!/bin/sh\n[ "$1 $2" = "debug models" ] && cat "${path.join(dir, "catalog.json")}"\n`);
    fs.chmodSync(bin, 0o755);
    const m = await run(codexModels(bin));
    assert.deepEqual(
      m.models.map((x) => [x.value, x.label]),
      [
        ["gpt-6", "GPT-6"],
        ["gpt-6-mini", "GPT-6 mini"],
      ],
    );
    assert.deepEqual(
      m.efforts.map((x) => x.value),
      ["low", "medium", "ultra"],
    );
    assert.deepEqual(await run(codexModels(path.join(dir, "missing"))), { models: [], efforts: [] }, "not installed: nothing to offer");
  },
);

test("OpenCode's models are what `opencode models` lists, one provider/model a line; it takes no effort", posix, async (c) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-opencode-models-"));
  c.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const bin = path.join(dir, "opencode");
  fs.writeFileSync(bin, `#!/bin/sh\n[ "$1" = models ] && printf 'opencode/big-pickle\\nopenai/gpt-6\\n\\nnot a model\\n'\n`);
  fs.chmodSync(bin, 0o755);
  assert.deepEqual(await run(opencodeModels(bin)), {
    models: [
      { value: "opencode/big-pickle", label: "opencode/big-pickle" },
      { value: "openai/gpt-6", label: "openai/gpt-6" },
    ],
    efforts: [],
  });
  assert.deepEqual(await run(opencodeModels(path.join(dir, "missing"))), { models: [], efforts: [] }, "not installed: nothing to offer");
});

test("your agent's model and effort settings offer what it takes as choices, and stay text fields when nothing's known", () => {
  const def = (key: string, defs = agentDefs("claude-code", CLAUDE_MODELS)) => defs.find((d) => d.key === key)!;
  assert.deepEqual(
    def("agent.coordinator_model").choices?.map((x) => x.value),
    ["fable", "opus", "sonnet", "haiku"],
  );
  assert.deepEqual(
    def("agent.coordinator_effort").choices?.map((x) => x.value),
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.equal(def("agent.coordinator_model", agentDefs("opencode", { models: [], efforts: [] })).choices, undefined);
  assert.equal(def("agent.coordinator_effort", agentDefs("codex")).choices, undefined);
});

test("each agent keeps its own model and effort: switching agents puts one's away and brings the other's back", async (c) => {
  const { setup } = await import("./helpers/desk.ts");
  const was = process.env.DESK_CODEX;
  process.env.DESK_CODEX = path.join(os.tmpdir(), "desk-no-codex-here");
  c.after(() => {
    if (was === undefined) delete process.env.DESK_CODEX;
    else process.env.DESK_CODEX = was;
  });
  const t = await setup([], { settings: { "agent.coordinator_model": "opus", "agent.coordinator_effort": "high" } });
  c.after(() => {
    t.desk.stop();
  });
  const now = () => [
    t.desk.settings["agent.harness"],
    t.desk.settings["agent.coordinator_model"],
    t.desk.settings["agent.coordinator_effort"],
  ];
  await run(t.desk.putSettings({ set: { "agent.harness": "codex" } }));
  assert.deepEqual(now(), ["codex", "", ""], "Codex's first time: its own defaults, not Claude's opus");
  await run(t.desk.putSettings({ set: { "agent.coordinator_model": "gpt-6", "agent.coordinator_effort": "ultra" } }));
  await run(t.desk.putSettings({ set: { "agent.harness": "claude-code" } }));
  assert.deepEqual(now(), ["claude-code", "opus", "high"], "Claude Code's come back");
  await run(t.desk.putSettings({ set: { "agent.harness": "codex" } }));
  assert.deepEqual(now(), ["codex", "gpt-6", "ultra"], "and Codex's");
  await run(t.desk.putSettings({ set: { "agent.harness": "claude-code", "agent.coordinator_model": "sonnet" } }));
  assert.deepEqual(now(), ["claude-code", "sonnet", "high"], "a model set with the switch wins");
});

test("rules are applied on the cheapest model: Haiku on Claude Code, your own default where your agent names none, or what you set", () => {
  const s = (harness: string, set = "") => ({ ...DEFAULTS, "agent.harness": harness, "agent.rules_model": set });
  assert.equal(rulesModel(s("claude-code")), "haiku");
  assert.equal(rulesModel(s("codex")), undefined);
  assert.equal(rulesModel(s("opencode")), undefined);
  assert.equal(rulesModel(s("codex", "gpt-5.6-luna")), "gpt-5.6-luna");
});
