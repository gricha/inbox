// What you marked viewed in a PR's review: kept by what each hunk changes, so a rebase keeps it and a push that rewrites a
// hunk drops that hunk alone. Marked only from the desk's window, and never sent to GitHub.
import "./helpers/no-agent.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import type { ReviewDeps } from "../src/desk.ts";
import { createApp } from "../src/server.ts";
import type { ReviewFile, ReviewView } from "../src/types.ts";
import { setup, WINDOW_HEADERS } from "./helpers/desk.ts";
import { makeItem } from "./helpers/items.ts";
import { run } from "./helpers/run.ts";

const ID = "acme/web#4";
const file = (patch: string): ReviewFile => ({
  path: "src/plan.ts",
  previous_path: null,
  status: "modified",
  additions: 2,
  deletions: 2,
  patch,
});
const PUSHED = file("@@ -10,3 +10,3 @@ fn plan() {\n a\n-old\n+new\n b\n@@ -40,3 +40,3 @@\n c\n-x\n+y\n d");
// Rebased onto a base that added lines above both hunks and changed one's context: the same changes, moved.
const REBASED = file("@@ -14,3 +14,3 @@ fn plan() {\n a2\n-old\n+new\n b\n@@ -44,3 +44,3 @@\n c\n-x\n+y\n d");
// A push that rewrote the second hunk.
const REWRITTEN = file("@@ -10,3 +10,3 @@ fn plan() {\n a\n-old\n+new\n b\n@@ -40,3 +40,3 @@\n c\n-x\n+z\n d");

async function viewed(c: TestContext) {
  let files = [PUSHED];
  const review: ReviewDeps = { fetchPr: () => Effect.succeed({ body: "", files }), generate: () => Effect.never };
  const t = await setup(
    [makeItem({ number: 4, repo: "acme/web", author: "dana", review_requests: [{ reviewer: "me", type: "user", codeowner: false }] })],
    { settings: { "policy.judge": false, "review.auto_ai": false }, desk: { review } },
  );
  c.after(t.cleanup);
  await run(t.desk.sync());
  const app = createApp(t.desk, 47823);
  const post = (body: unknown, headers: Record<string, string> = WINDOW_HEADERS) =>
    app.request(`http://127.0.0.1:47823/api/review/${encodeURIComponent(ID)}/viewed`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  // The diff GitHub has now: kept per head commit, so a new one is a fresh fetch.
  const push = (f: ReviewFile) => {
    files = [f];
    t.desk.store.set(`pr:${ID}`, null);
  };
  const view = () => run(t.desk.reviewView(ID, true));
  return { post, push, view };
}

// Which of the review's hunks show as viewed.
const seen = (v: ReviewView) => v.order.chunks.map((h) => v.viewed.includes(h.mark));

test("only the desk's window marks what you've viewed, with the hunks' marks", async (c) => {
  const { post, view } = await viewed(c);
  const marks = (await view()).order.chunks.map((h) => h.mark);
  assert.equal((await post({ marks, viewed: true }, {})).status, 403, "an agent's mark would fold code away from you");
  for (const bad of [
    { marks, viewed: "yes" },
    { marks: [], viewed: true },
    { marks: [""], viewed: true },
    { marks: ["x".repeat(65)], viewed: true },
    { viewed: true },
  ])
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  assert.deepEqual(seen(await view()), [false, false]);
});

test("a rebase keeps what you viewed; a push that rewrites a hunk unmarks that hunk alone", async (c) => {
  const { post, push, view } = await viewed(c);
  const marks = (await view()).order.chunks.map((h) => h.mark);
  assert.equal((await post({ marks, viewed: true })).status, 200);
  assert.deepEqual(seen(await view()), [true, true]);
  push(REBASED);
  assert.deepEqual(seen(await view()), [true, true], "moved, with other lines around it: still what you read");
  push(REWRITTEN);
  assert.deepEqual(seen(await view()), [true, false], "the rewritten hunk is new to you");
  assert.equal((await post({ marks: [marks[0]], viewed: false })).status, 200);
  assert.deepEqual(seen(await view()), [false, false]);
});
