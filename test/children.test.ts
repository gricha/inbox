import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Cause, Effect, Exit } from "effect";
import { Desk } from "../src/desk.ts";
import { generateReview, runCommand } from "../src/review.ts";
import { FakeGitHub, makeItem, NOW } from "./helpers/items.ts";
import { failure, run } from "./helpers/run.ts";

const posix = { skip: process.platform === "win32" };

// A claude that never answers: it ignores SIGTERM, starts a child that outlives it unless its group is killed (as a hook
// would), and records both pids.
function stuckClaude(c: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-stuck-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(
    bin,
    `#!/bin/sh
trap '' TERM
sleep 300 &
echo "$$ $!" >> "$(dirname "$0")/pids"
cat > /dev/null
while :; do sleep 1; done
`,
  );
  fs.chmodSync(bin, 0o755);
  c.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // Whole lines only: the fake may be writing its last.
  const pids = () => {
    const f = path.join(dir, "pids");
    return fs.existsSync(f)
      ? fs
          .readFileSync(f, "utf8")
          .split("\n")
          .slice(0, -1)
          .flatMap((l) => l.split(" "))
          .map(Number)
      : [];
  };
  return { bin, pids };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A killed grandchild is a zombie until the parent it was left to reaps it: it answers kill(pid, 0) but runs nothing.
const running = (pid: number) => {
  if (!alive(pid)) return false;
  const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return stat !== "" && !stat.startsWith("Z");
};

async function until(cond: () => boolean, what = "timed out waiting"): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++)
    await new Promise((r) => {
      setTimeout(r, 10);
    });
  assert.ok(cond(), what);
}

test("closing the desk stops the judge and an AI review, what they started, and what ignores SIGTERM", posix, async (c) => {
  const fake = stuckClaude(c);
  process.env.DESK_CLAUDE = fake.bin;
  c.after(() => {
    process.env.DESK_CLAUDE = "/nonexistent/claude";
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-close-"));
  c.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });
  const item = makeItem({ number: 1, author: "carol", review_requests: [{ reviewer: "me", type: "user", codeowner: false }] });
  const gh: FakeGitHub = new FakeGitHub([item], (q) =>
    q.includes("review-requested:@me") && !q.includes("-review-requested") ? [item.id] : [],
  );
  const desk = new Desk({
    home,
    github: gh,
    now: () => NOW,
    notify: () => {},
    log: () => {},
    review: { fetchPr: () => Effect.succeed({ body: "", files: [] }), generate: generateReview },
  });
  await run(desk.init());
  await run(desk.sync());
  void run(desk.generate(item.id)).catch(() => {});
  // The judge and the AI review: a claude and its child each.
  await until(() => fake.pids().length === 4);
  const pids = fake.pids();
  assert.ok(pids.every(running));

  const t0 = Date.now();
  await run(desk.close());
  const took = Date.now() - t0;
  assert.deepEqual(pids.filter(running), [], "nothing left running once close() is back");
  assert.ok(took < 4000, `took ${took} ms`);
});

test("a call that times out takes what it started with it", posix, async (c) => {
  const fake = stuckClaude(c);
  const err = await failure(runCommand({ file: fake.bin, args: [], shell: false }, { timeout: 1500, missing: "missing" }));
  assert.deepEqual([err._tag, err.message], ["CommandTimeout", "no answer in 0 minutes, so it was stopped"]);
  const pids = fake.pids();
  assert.equal(pids.length, 2);
  await until(() => !pids.some(running));
});

test("an interrupted call takes what it started with it, and ends only once it has exited", posix, async (c) => {
  const fake = stuckClaude(c);
  const ac = new AbortController();
  const call = runCommand({ file: fake.bin, args: [], shell: false }, { timeout: 60_000, missing: "missing" });
  const exit = Effect.runPromiseExit(call, { signal: ac.signal });
  await until(() => fake.pids().length === 2);
  const pids = fake.pids();
  ac.abort();
  const e = await exit;
  assert.ok(Exit.isFailure(e) && Cause.hasInterruptsOnly(e.cause), "interrupted: nothing to store or report");
  assert.ok(!alive(pids[0]!), "the claude itself has exited when the call ends");
  await until(() => !pids.some(running));
});
