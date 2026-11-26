import "./helpers/no-agent.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { askClaude } from "../src/review.ts";
import { Store } from "../src/store.ts";
import { as, claudeUsage, meterTo, transcriptUsage } from "../src/usage.ts";
import { reviewAsk, setup } from "./helpers/desk.ts";
import { NOW } from "./helpers/items.ts";
import { run, runSync } from "./helpers/run.ts";
import { posix } from "./helpers/platform.ts";

test("claude's own modelUsage is a call's tokens and cost, by model", () => {
  assert.deepEqual(
    claudeUsage({
      "claude-haiku-5-5": {
        inputTokens: 900,
        outputTokens: 40,
        cacheReadInputTokens: 2000,
        cacheCreationInputTokens: 300,
        costUSD: 0.0021,
      },
    }),
    [{ model: "claude-haiku-5-5", input: 900, output: 40, cache_read: 2000, cache_write: 300, cost: 0.0021 }],
  );
  assert.deepEqual(claudeUsage(null), []);
});

test("a transcript's requests count once each, priced at list prices with an hour's cache write at twice input", () => {
  const msg = (id: string, model: string, usage: object, block = "text") =>
    JSON.stringify({ type: "assistant", timestamp: "2026-11-18T10:00:00Z", message: { id, model, usage, content: [{ type: block }] } });
  const opus = { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 };
  const hour = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 1_000_000,
    cache_creation: { ephemeral_1h_input_tokens: 1_000_000 },
  };
  const jsonl = [
    JSON.stringify({ type: "user", message: { content: "hi" } }),
    msg("m1", "claude-opus-5-5", opus),
    msg("m1", "claude-opus-5-5", opus, "tool_use"), // the same request's next block
    msg("m2", "claude-opus-5-5", hour),
    msg("m3", "<synthetic>", opus),
    msg("m4", "gpt-9", opus),
    "not json",
  ].join("\n");
  const got = transcriptUsage(jsonl);
  assert.deepEqual(
    got.map((r) => [r.id, r.usage.cost]),
    [
      ["m1", 4 + 2 + 0.2], // $4 in, $20 × 0.1 out, $0.20 cache read
      ["m2", 8], // an hour's write: 2 × $4
      ["m4", null], // no price known
    ],
  );
});

test("a call is kept under the work it was for, once, and summed by work and model", posix, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-usage-"));
  const bin = path.join(dir, "claude");
  const env = { structured_output: {}, modelUsage: { "claude-haiku-5-5": { inputTokens: 10, outputTokens: 2, costUSD: 0.25 } } };
  fs.writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\necho '${JSON.stringify(env)}'\n`);
  fs.chmodSync(bin, 0o755);
  const store = new Store(path.join(dir, "desk.db"));
  let n = 0;
  meterTo((work, usage) => {
    store.addUsage(`2026-11-1${8 - n}T00:00:00Z`, `c${n++}`, work, usage);
  });
  try {
    await run(askClaude("a", { model: "", command: bin, dir }).pipe(as("review")));
    await run(askClaude("b", { model: "", command: bin, dir }).pipe(as("review")));
    await run(askClaude("c", { model: "", command: bin, dir }));
  } finally {
    meterTo(null);
  }
  store.addUsage("2026-11-18T00:00:00Z", "c0", "review", [
    { model: "claude-haiku-5-5", input: 10, output: 2, cache_read: 0, cache_write: 0, cost: 0.25 },
  ]);
  const by = (since: string | null) => store.usage(since).map((r) => [r.work, r.model, r.calls, r.input, r.cost]);
  assert.deepEqual(by(null), [
    ["review", "claude-haiku-5-5", 2, 20, 0.5], // c0 again isn't counted twice
    ["other", "claude-haiku-5-5", 1, 10, 0.25], // a call that didn't say what it was for
  ]);
  assert.deepEqual(by("2026-11-18T00:00:00Z"), [["review", "claude-haiku-5-5", 1, 10, 0.25]], "the window");
  assert.equal(store.firstUsage(), "2026-11-16T00:00:00Z");
});

test("closed per day: your Done presses, your approvals off the desk and your merges, an item once a day; undone doesn't count", async (c) => {
  const t = await setup([reviewAsk(1), reviewAsk(2), reviewAsk(3)]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  runSync(t.desk.act("api#1", "done"));
  runSync(t.desk.undo(runSync(t.desk.act("api#2", "done")).undo_seq));
  const now = NOW.toISOString();
  const event = (item_id: string, kind: "merged" | "resolved", actor: string, data: Record<string, string> = {}) =>
    ({ at: now, source: "github", item_id, kind, actor, data }) as const;
  t.desk.store.addActivity([
    event("acme/api#1", "resolved", "", { reason: "you approved" }), // the same item the same day
    event("acme/api#3", "merged", "ME"),
    event("acme/api#4", "merged", "carol"), // someone else's merge isn't yours
    event("acme/api#5", "resolved", "", { reason: "approved by carol" }),
  ]);
  const closed = t.desk.usageView(30).closed;
  const d = NOW;
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  assert.deepEqual(closed, { [today]: 2 });
});
