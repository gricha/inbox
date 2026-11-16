import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLAUDE_MODELS, codexModels, opencodeModels } from "../src/models.ts";
import { agentDefs } from "../src/settings.ts";
import { run } from "./helpers/run.ts";

const posix = { skip: process.platform === "win32" };

test("Codex's models are the ones its cache lists that reason, in its order; its efforts are the levels any takes", (c) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-codex-models-"));
  c.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });
  const levels = (...e: string[]) => e.map((effort) => ({ effort, description: "" }));
  fs.writeFileSync(
    path.join(home, "models_cache.json"),
    JSON.stringify({
      models: [
        {
          slug: "gpt-6-mini",
          display_name: "GPT-6 mini",
          visibility: "list",
          priority: 3,
          supported_reasoning_levels: levels("low", "medium"),
        },
        { slug: "gpt-6", display_name: "GPT-6", visibility: "list", priority: 1, supported_reasoning_levels: levels("medium", "xhigh") },
        { slug: "image-1", display_name: "Image", visibility: "list", priority: 2, supported_reasoning_levels: [] },
        { slug: "internal", display_name: "Hidden", visibility: "hide", priority: 0, supported_reasoning_levels: levels("high") },
      ],
    }),
  );
  const m = codexModels({ CODEX_HOME: home });
  assert.deepEqual(
    m.models.map((x) => [x.value, x.label]),
    [
      ["gpt-6", "GPT-6"],
      ["gpt-6-mini", "GPT-6 mini"],
    ],
  );
  assert.deepEqual(
    m.efforts.map((x) => x.value),
    ["low", "medium", "xhigh"],
  );
  assert.deepEqual(codexModels({ CODEX_HOME: path.join(home, "none") }), { models: [], efforts: [] }, "no cache: nothing to offer");
});

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
