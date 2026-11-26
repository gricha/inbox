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
import type { PrText } from "../src/review.ts";
import { reviewAsk, setup } from "./helpers/desk.ts";
import { run } from "./helpers/run.ts";

const ID = "acme/api#1";
const ANSWER = {
  intent: "Streams rows and stops at a time budget.",
  intent_from: "stated",
  lean: "fix first",
  premises: [{ premise: "Callers read the partial flag", verdict: "fails", evidence: "src/sdk.ts:58 reads only the body" }],
  wrong: [
    { what: "?budget= isn't validated", why: "A typo turns the budget off", evidence: ["src/route.ts:30 Number(q)"], severity: "fix" },
  ],
  ask: [{ question: "Should the default budget apply to old callers?", why: "Their slow queries come back partial" }],
  author_fixes: ["Reject a non-numeric budget"],
  checked: { summary: "Read the diff and the SDK", tests: "41 passed", probes: 1 },
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

test("a deep review answers at once, runs on in the PR's checkout, and keeps what it found with the commit it read", async (c) => {
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
    { lean: v.deep?.lean, wrong: v.deep?.wrong.length, ask: v.deep?.ask.length, head: v.deep?.head_oid, model: v.deep?.model },
    { lean: "fix first", wrong: 1, ask: 1, head: v.item.head_oid, model: "claude-opus-5-5" },
  );
  assert.equal(fake.calls().length, 1, "one run for both asks");
  assert.ok(t.removed(), "its checkout is removed once it's done");
});

test("a deep review's run may probe in its checkout and never writes outward: no push, no GitHub writes, no MCP servers", async (c) => {
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
});

test("a deep review whose answer isn't one keeps its failure in your words, and the last good one stays", async (c) => {
  fakeClaude(c, { lean: "maybe" });
  const t = await deskWithCheckout(c);
  await run(t.desk.deepReview(ID));
  await until(async () => (await run(t.desk.reviewView(ID))).deep_error !== null);
  const v = await run(t.desk.reviewView(ID));
  assert.equal(v.deep, null);
  assert.match(v.deep_error ?? "", /didn't parse/);
});
