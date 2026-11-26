// A deep review (src/deep.ts) runs your own Claude Code in the PR's checkout with probing tools and nothing that writes
// outward, keeps what it answered with the commit it read, answers at once and runs on, and keeps a failure as its words.
import "./helpers/no-agent.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type { ReviewDeps } from "../src/desk.ts";
import { deepGuide, gradeOf, stepsOf } from "../src/deep.ts";
import { askClaude, type PrText } from "../src/review.ts";
import type { DeepReview } from "../src/types.ts";
import { reviewAsk, setup } from "./helpers/desk.ts";
import { posix } from "./helpers/platform.ts";
import { run } from "./helpers/run.ts";

const ID = "acme/api#1";
const ANSWER = {
  goal: "Long queries return the rows found so far.",
  fit: "The budget gets there; an unchecked `?budget=` undoes it.",
  intent_from: "stated",
  change: "Before, a query returned every row at the end; now it stops at a budget.",
  risk: "Every query caller; a revert undoes it.",
  risk_level: "medium",
  risk_reasons: [{ factor: "contract", why: "Callers get partial rows" }],
  verdict: "look",
  intent_fit: "partial",
  since: "",
  interfaces: [],
  tags: [],
  lean: "fix first",
  lean_why: "`?budget=` isn't validated (The budget).",
  caveat: "",
  steps: [
    {
      title: "The budget",
      why: "Checked between batches.",
      hunks: ["h1", "h99"],
      notes: [
        { kind: "issue", text: "`budget=abc` turns the budget off.", ask: "Reject it with a 400.", at: "src/route.ts:30", evidence: "" },
      ],
    },
  ],
  picture: {
    step: 0,
    title: "The budget",
    caption: "Where the budget is read.",
    source: 'flowchart LR\n  a["route"] --> b["plan"]\n  b --> c["stream"]',
  },
};

// A claude that writes its arguments down and answers with `answer`, or holds while `hold` exists.
function fakeClaude(c: TestContext, answer: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-deep-"));
  const bin = path.join(dir, "claude");
  const out = JSON.stringify({ is_error: false, result: "", structured_output: answer, modelUsage: { "claude-opus-5-5": {} } });
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(path.join(__dirname, "calls"), JSON.stringify(process.argv.slice(2)) + "\\n");
while (fs.existsSync(path.join(__dirname, "hold"))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
process.stdout.write(${JSON.stringify(out)});
`,
    { mode: 0o755 },
  );
  const was = process.env.DESK_CLAUDE;
  process.env.DESK_CLAUDE = bin;
  c.after(() => {
    process.env.DESK_CLAUDE = was;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const calls = () =>
    fs.existsSync(path.join(dir, "calls"))
      ? fs
          .readFileSync(path.join(dir, "calls"), "utf8")
          .trim()
          .split("\n")
          .map((l): string[] => JSON.parse(l))
      : [];
  return {
    calls,
    hold: () => {
      fs.writeFileSync(path.join(dir, "hold"), "");
    },
    release: () => {
      fs.rmSync(path.join(dir, "hold"));
    },
  };
}

async function deskWithCheckout(c: TestContext) {
  const code = fs.mkdtempSync(path.join(os.tmpdir(), "desk-deep-code-"));
  let removed = false;
  const deps: ReviewDeps = {
    fetchPr: () => Effect.succeed({ body: "why", files: [] } satisfies PrText),
    generate: () => Effect.die("no AI review in these tests"),
    deep: (prompt, dir, schema) => askClaude(prompt, { model: "", dir, read: true, probe: true, schema }),
    checkout: () =>
      Effect.succeed({
        dir: code,
        done: Effect.sync(() => {
          removed = true;
        }),
      }),
  };
  const t = await setup([reviewAsk(1)], { settings: { "policy.judge": false, "ai.auto": false }, desk: { review: deps } });
  c.after(async () => {
    t.desk.stop();
    await t.cleanup();
    fs.rmSync(code, { recursive: true, force: true });
  });
  await run(t.desk.sync());
  return { ...t, code, removed: () => removed };
}

const until = async (ok: () => Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await ok()) return;
    await new Promise((r) => {
      setTimeout(r, 25);
    });
  }
  assert.fail("timed out waiting");
};

test("a deep review answers at once, runs on in the PR's checkout, and keeps what it found with the commit it read", posix, async (c) => {
  const fake = fakeClaude(c, ANSWER);
  const t = await deskWithCheckout(c);
  fake.hold();
  const started = await run(t.desk.deepReview(ID));
  const busy = await run(t.desk.reviewView(ID));
  assert.equal(busy.deep_running, started.running, "the review page shows it running before it's done");
  assert.equal(busy.deep, null);
  assert.equal((await run(t.desk.deepReview(ID))).running, started.running, "asking again joins the run");
  fake.release();
  await until(async () => (await run(t.desk.reviewView(ID))).deep !== null);
  const v = await run(t.desk.reviewView(ID));
  assert.equal(v.deep_running, null);
  assert.equal(v.deep_error, null);
  assert.deepEqual(
    {
      lean: v.deep?.lean,
      why: v.deep?.lean_why,
      head: v.deep?.head_oid,
      model: v.deep?.model,
      picture: v.deep?.picture?.graph.kind,
    },
    { lean: "fix first", why: ANSWER.lean_why, head: v.item.head_oid, model: "claude-opus-5-5", picture: "flow" },
  );
  assert.equal(fake.calls().length, 1, "one run for both asks");
  // It is the PR's review: what the queue and the judge read (risk, its reasons, the verdict, the intent's fit) is its own.
  assert.deepEqual(
    { risk: v.ai?.risk, factors: v.ai?.risk_reasons?.map((r) => r.factor), verdict: v.ai?.verdict, fit: v.ai?.intent?.fit },
    { risk: "medium", factors: ["contract"], verdict: "look", fit: "partial" },
  );
  assert.equal((await run(t.desk.reviewView(ID))).generating, false, "a review of this commit isn't run again");
  assert.ok(t.removed(), "its checkout is removed once it's done");
});

test(
  "a deep review's run may probe in its checkout and never writes outward: no push, no GitHub writes, no MCP servers",
  posix,
  async (c) => {
    const fake = fakeClaude(c, ANSWER);
    const t = await deskWithCheckout(c);
    await run(t.desk.deepReview(ID));
    await until(async () => fake.calls().length > 0 && (await run(t.desk.reviewView(ID))).deep_running === null);
    const args = fake.calls()[0]!;
    const after = (flag: string) => args[args.indexOf(flag) + 1] ?? "";
    assert.equal(after("--tools"), "Read,Grep,Glob,Bash,Write,Edit");
    assert.equal(after("--permission-mode"), "bypassPermissions");
    for (const denied of ["Bash(git push:*)", "Bash(gh api:*)", "Bash(gh pr review:*)", "Bash(gh pr comment:*)", "Bash(gh pr merge:*)"])
      assert.ok(after("--disallowedTools").split(",").includes(denied), `${denied} is denied`);
    assert.ok(args.includes("--strict-mcp-config") && !args.includes("--mcp-config"), "none of your MCP servers");
    // It may clone a repo the change depends on (a deploy config, a chart) and read it, but not change one.
    const deny = after("--disallowedTools").split(",");
    for (const read of ["Bash(gh repo clone:*)", "Bash(gh repo view:*)", "Bash(gh repo:*)"])
      assert.ok(!deny.includes(read), `${read} is allowed`);
    for (const write of ["create", "delete", "edit", "fork", "rename", "archive", "sync", "deploy-key", "autolink"])
      assert.ok(deny.includes(`Bash(gh repo ${write}:*)`), `gh repo ${write} is denied`);
  },
);

test("the desk's own review is the deep review, and an AI review of the commit from before them still wants one", posix, async (c) => {
  const fake = fakeClaude(c, ANSWER);
  const t = await deskWithCheckout(c);
  const wants = () => {
    const snap = t.desk.snapshot();
    return t.desk.wantsAi(snap.entries.get(ID)!, snap);
  };
  await until(async () => (await run(t.desk.reviewView(ID))).deep !== null);
  assert.equal(fake.calls().length, 1, "the sync started it, as it would an AI review");
  assert.equal(wants(), false);
  // As if its review were from before deep reviews: the AI review of this commit is there, its deep review isn't.
  t.desk.store.putKvAt("deep:", ID, { review: null, error: null });
  assert.equal(wants(), true, "the old review leaves it wanting one");
  await run(t.desk.deepReview(ID));
  await until(async () => (await run(t.desk.reviewView(ID))).deep !== null);
  assert.equal(wants(), false, "its deep review of this commit settles it");
  assert.equal(fake.calls().length, 2);
});

test("a deep review whose answer isn't one keeps its failure in your words, and the last good one stays", posix, async (c) => {
  fakeClaude(c, { lean: "maybe" });
  const t = await deskWithCheckout(c);
  await run(t.desk.deepReview(ID));
  await until(async () => (await run(t.desk.reviewView(ID))).deep_error !== null);
  const v = await run(t.desk.reviewView(ID));
  assert.equal(v.deep, null);
  assert.match(v.deep_error ?? "", /didn't parse/);
});

test("a deep review's steps keep only this diff's hunks, become the Review tab's guide, and pin each finding to its line", () => {
  const files = [
    { path: "a.ts", previous_path: null, status: "modified" as const, additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" },
    { path: "src/b.ts", previous_path: null, status: "modified" as const, additions: 1, deletions: 0, patch: "@@ -3,0 +4 @@\n+c" },
  ];
  const blocker = { kind: "blocker" as const, text: "It hangs.", ask: "Bound it.", at: "b.ts:4", evidence: "probe: timed out" };
  const question = { kind: "question" as const, text: "Old callers change.", ask: "Only new ones?", at: "", evidence: "" };
  const steps = stepsOf(
    [
      { title: "Core", why: "What it's for.", hunks: ["h2", "h9"], notes: [blocker, question] },
      { title: "Gone", why: "Names nothing here.", hunks: ["h9"], notes: [] },
    ],
    files,
  );
  assert.deepEqual(steps, [{ title: "Core", why: "What it's for.", hunks: ["h2"], notes: [blocker, question] }]);
  const graph = { kind: "flow" as const, direction: "LR" as const, nodes: [], edges: [], groups: [] };
  const deep: DeepReview = {
    goal: "g",
    fit: "f",
    intent_from: "stated",
    change: "c",
    risk: "r",
    risk_level: "low",
    risk_reasons: [],
    verdict: "skim",
    intent_fit: "matches",
    since: "",
    interfaces: [],
    tags: [],
    lean: "fix first",
    lean_why: "w",
    caveat: "",
    steps,
    picture: { id: "deep", title: "t", caption: "c", graph, step: 0 },
    head_oid: "abc",
    model: "m",
    at: "2026-11-25T00:00:00Z",
    seconds: 1,
  };
  const ai = deepGuide(deep, files, null);
  assert.deepEqual(ai.guide?.steps, [
    {
      title: "Core",
      body: "What it's for.",
      check: "",
      asides: [{ flag: "question", body: "Old callers change. Only new ones?", evidence: "" }],
      diagram: "deep",
      hunks: [{ id: "h2", path: "src/b.ts" }],
    },
  ]);
  assert.deepEqual(ai.notes, [
    { path: "src/b.ts", line: 4, side: "new", body: "It hangs. Bound it.", flag: "blocker", evidence: "probe: timed out" },
  ]);
  assert.deepEqual(
    ai.chunks?.ranked.map((c) => [c.id, c.level]),
    [["h2", "look"]],
    "a hunk no step names is skipped",
  );
  // Weightiest first: the hunk with the blocker leads its step, and the blocker's note comes before the nit's.
  const nit = { kind: "nit" as const, text: "Rename it.", ask: "", at: "a.ts:1", evidence: "" };
  const both = deepGuide({ ...deep, steps: [{ title: "Both", why: "w", hunks: ["h1", "h2"], notes: [nit, blocker] }] }, files, null);
  assert.deepEqual(
    both.guide?.steps[0]?.hunks.map((h) => h.id),
    ["h2", "h1"],
  );
  assert.deepEqual(
    both.notes.map((n) => n.flag),
    ["blocker", "nit"],
  );
});

test("a deep review's grade is held to its own reasons: low with a data, security or irreversible consequence is medium", () => {
  const why = (factor: "data" | "security" | "irreversible" | "reach" | "contract") => [{ factor, why: "w" }];
  assert.deepEqual(gradeOf({ risk_level: "low", risk_reasons: why("data") }), { level: "medium", raised: "data" });
  assert.deepEqual(gradeOf({ risk_level: "low", risk_reasons: why("security") }), { level: "medium", raised: "security" });
  assert.deepEqual(gradeOf({ risk_level: "low", risk_reasons: why("reach") }), { level: "low", raised: null }, "a narrow reach stays low");
  assert.deepEqual(gradeOf({ risk_level: "high", risk_reasons: why("contract") }), { level: "high", raised: null }, "never lowered");
});
