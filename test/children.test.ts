import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Desk } from "../src/desk.ts";
import { generateReview, runCommand } from "../src/review.ts";
import { FakeGitHub, makeItem, NOW } from "./helpers/items.ts";

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
  const pids = () => {
    const f = path.join(dir, "pids");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split(/\s+/).filter(Boolean).map(Number) : [];
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

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++)
    await new Promise((r) => {
      setTimeout(r, 10);
    });
  assert.ok(cond(), "timed out waiting");
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
    review: { fetchPr: () => Promise.resolve({ body: "", files: [] }), generate: generateReview },
  });
  await desk.init();
  await desk.sync();
  void desk.generate(item.id).catch(() => {});
  // The judge and the AI review: a claude and its child each.
  await until(() => fake.pids().length === 4);
  const pids = fake.pids();
  assert.ok(pids.every(alive));

  const t0 = Date.now();
  await desk.close();
  assert.deepEqual(pids.filter(alive), [], "nothing left running");
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
});

test("a call that times out takes what it started with it", posix, async (c) => {
  const fake = stuckClaude(c);
  const run = runCommand({ file: fake.bin, args: [], shell: false }, { timeout: 1500, missing: "missing" });
  await assert.rejects(run, /no answer in 0 minutes, so it was stopped/);
  const pids = fake.pids();
  assert.equal(pids.length, 2);
  await until(() => !pids.some(alive));
});
