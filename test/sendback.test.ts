import "./helpers/no-agent.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Effect } from "effect";
import { repoAt, type Seen } from "../src/connectors/sessions.ts";
import type { ReviewDeps } from "../src/desk.ts";
import type { PrText } from "../src/review.ts";
import type { Card } from "../src/types.ts";
import { myPr, setup } from "./helpers/desk.ts";
import { run } from "./helpers/run.ts";

const ID = "acme/web#5";
const FILES = [
  { path: "src/route.ts", previous_path: null, status: "modified" as const, additions: 1, deletions: 1, patch: "@@ -30 +30 @@\n-a\n+b" },
];
const issue = {
  kind: "issue",
  text: "`budget=abc` turns the budget off.",
  ask: "Reject it with a 400.",
  at: "src/route.ts:30",
  evidence: "",
};
const answer = (notes: unknown[]) => ({
  goal: "Queries return what they found in time.",
  fit: "It does, but an unchecked budget turns it off.",
  intent_from: "stated",
  change: "Before, a query ran to the end; now it stops at a budget.",
  risk: "Every query caller; a revert undoes it.",
  risk_level: "medium",
  risk_reasons: [{ factor: "contract", why: "Callers can get partial rows" }],
  verdict: "look",
  intent_fit: "partial",
  since: "",
  interfaces: [],
  tags: [],
  lean: notes.length ? "fix first" : "ship",
  lean_why: "w",
  caveat: "",
  steps: [{ title: "The budget", why: "Checked between batches.", hunks: ["h1"], notes }],
  picture: { step: 0, title: "t", caption: "c", source: 'flowchart LR\n  a["route"] --> b["plan"]\n  b --> c["stream"]' },
});

// Your draft, opened by a session on its branch; the review answers `next()`, and the session's messages are kept.
async function draftDesk(c: TestContext) {
  const code = fs.mkdtempSync(path.join(os.tmpdir(), "desk-sendback-"));
  let next = answer([issue]);
  const deps: ReviewDeps = {
    fetchPr: () => Effect.succeed({ body: "why", files: FILES } satisfies PrText),
    generate: () => Effect.die("no AI review in these tests"),
    deep: () => Effect.succeed({ answer: next, model: "claude-opus-5-5", usage: [] }),
    checkout: () => Effect.succeed({ dir: code, done: Effect.void }),
  };
  const t = await setup([myPr(5, { draft: true, head_ref: "fix-budget", ci: "green", review_requests: [] })], {
    settings: { "policy.judge": false },
    desk: { review: deps },
    builtIns: true,
  });
  const told: { ref: string; text: string }[] = [];
  const seen: Seen = {
    kind: "cli",
    session_id: "s-1",
    name: "fix the budget",
    cwd: code,
    branch: "fix-budget",
    row: null,
    tail: null,
    codex: null,
    desktop: null,
    written: 1,
  };
  t.desk.sessions.openedBy = (repo, branch) => (repo === "acme/web" && branch === "fix-budget" ? seen : null);
  t.desk.sessions.send = (ref, text) =>
    Effect.sync(() => {
      told.push({ ref, text });
      return { started: true };
    });
  c.after(async () => {
    t.desk.stop();
    await t.cleanup();
    fs.rmSync(code, { recursive: true, force: true });
  });
  return { ...t, told, answers: (a: ReturnType<typeof answer>) => (next = a) };
}

const where = async (t: Awaited<ReturnType<typeof draftDesk>>) => {
  const q = await run(t.desk.queue());
  const inbox = [...q.inbox.urgent, ...q.inbox.standard, ...q.inbox.fyi].some((x: Card) => x.id === ID);
  const blocked = q.sections.blocked.find((x) => x.id === ID);
  return { inbox, blocked: blocked?.why ?? null };
};

test("your draft's review findings go back to the session that opened it, and it waits on Blocked until a clean review", async (c) => {
  const t = await draftDesk(c);
  await run(t.desk.sync());
  await run(t.desk.aiReview(ID));
  assert.equal(t.told.length, 1, "the session on its branch is told");
  assert.equal(t.told[0]!.ref, "session:s-1");
  assert.match(t.told[0]!.text, /Issue at src\/route\.ts:30: `budget=abc` turns the budget off\. Reject it with a 400\./);
  assert.match(t.told[0]!.text, /push to fix-budget/);
  assert.deepEqual(await where(t), { inbox: false, blocked: "sent back to fix the budget: 1 issue its review found" });

  // Its session pushes a fix; the review of the new commit comes back clean: it's on your desk.
  t.answers(answer([]));
  t.gh.items.set(ID, {
    ...t.gh.items.get(ID)!,
    head_oid: "fixed",
    updated_at: new Date(Date.parse(t.gh.items.get(ID)!.updated_at) + 60_000).toISOString(),
  });
  await run(t.desk.sync());
  await run(t.desk.aiReview(ID));
  assert.equal(t.told.length, 1, "nothing more to send back");
  assert.deepEqual(await where(t), { inbox: true, blocked: null });
});

test("a draft whose findings no session can take, or someone else's PR, is on your desk with its review as before", async (c) => {
  const t = await draftDesk(c);
  t.desk.sessions.openedBy = () => null;
  await run(t.desk.sync());
  await run(t.desk.aiReview(ID));
  assert.equal(t.told.length, 0);
  assert.deepEqual(await where(t), { inbox: true, blocked: null });
});

test("a session's repo is its directory's origin on GitHub, from a clone or one of its worktrees", (c) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desk-repo-"));
  c.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const clone = path.join(root, "web");
  fs.mkdirSync(path.join(clone, ".git", "worktrees", "fix"), { recursive: true });
  fs.writeFileSync(
    path.join(clone, ".git", "config"),
    '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/web.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
  );
  fs.writeFileSync(path.join(clone, ".git", "worktrees", "fix", "commondir"), "../..\n");
  const tree = path.join(root, "fix");
  fs.mkdirSync(path.join(tree, "src"), { recursive: true });
  fs.writeFileSync(path.join(tree, ".git"), `gitdir: ${path.join(clone, ".git", "worktrees", "fix")}\n`);
  assert.equal(repoAt(path.join(clone)), "acme/web");
  assert.equal(repoAt(path.join(tree, "src")), "acme/web", "a worktree's subdirectory reads its clone's origin");
  assert.equal(repoAt(path.join(root)), null, "not a clone");
});
