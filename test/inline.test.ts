// Your comment on a line of a PR's diff: sent only from the desk's window (a fake writer), on GitHub's line and side,
// pinned to the commit the review showed, and not the end of reviewing it.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import type { ReviewDeps } from "../src/desk.ts";
import type { GitHubWriter, InlineThread } from "../src/github/write.ts";
import { createApp } from "../src/server.ts";
import { setup } from "./helpers/desk.ts";
import { makeItem } from "./helpers/items.ts";
import { refuseWrites } from "./helpers/writer.ts";

const HEAD = "a".repeat(40);
const DESK = { origin: "http://localhost:47823", "sec-fetch-site": "same-origin" };

async function inline(c: TestContext, fail?: string) {
  const calls: [string, string, InlineThread][] = [];
  const writer: GitHubWriter = {
    ...refuseWrites("not here"),
    inlineComment: (pr, commit, thread) => {
      if (fail) return Promise.reject(new Error(fail));
      calls.push([pr, commit, thread]);
      return Promise.resolve({ url: "https://github.com/acme/web/pull/4#discussion_r1" });
    },
  };
  const t = await setup(
    [makeItem({ number: 4, repo: "acme/web", author: "dana", review_requests: [{ reviewer: "me", type: "user", codeowner: false }] })],
    {
      settings: { "policy.judge": false, "review.auto_ai": false },
      desk: { writer },
    },
  );
  c.after(t.cleanup);
  await t.desk.sync();
  const app = createApp(t.desk, 47823);
  const post = (body: unknown, headers: Record<string, string> = DESK) =>
    app.request(`http://127.0.0.1:47823/api/review/${encodeURIComponent("acme/web#4")}/inline`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { t, calls, post };
}

const ok = { path: "src/plan.ts", line: 42, side: "new", body: "Off by one?", head_oid: HEAD };

test("an inline comment goes only from the desk's window, with what GitHub needs", async (c) => {
  const { calls, post } = await inline(c);
  assert.equal((await post(ok, {})).status, 403, "curl, the CLI and agents");
  assert.equal((await post(ok, { ...DESK, origin: "https://evil.example" })).status, 403);
  for (const bad of [
    { ...ok, path: "" },
    { ...ok, line: 0 },
    { ...ok, line: 4.5 },
    { ...ok, side: "left" },
    { ...ok, start: { line: 40 } },
    { ...ok, start: null },
    { ...ok, head_oid: "" },
    { ...ok, body: 3 },
  ])
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await post({ ...ok, body: "  " })).status, 400, "an empty comment");
  assert.equal((await post({ ...ok, body: "x".repeat(5_001) })).status, 400, "a long one");
  assert.deepEqual(calls, []);
});

test("new lines are GitHub's RIGHT, removed ones LEFT, a range starts where you began; pinned to the review's commit", async (c) => {
  const { calls, post } = await inline(c);
  const res = await post(ok);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, url: "https://github.com/acme/web/pull/4#discussion_r1" });
  assert.equal((await post({ ...ok, line: 7, side: "old", body: " Why drop this? " })).status, 200);
  assert.equal((await post({ ...ok, start: { line: 38, side: "old" } })).status, 200);
  assert.equal((await post({ ...ok, start: { line: 42, side: "new" } })).status, 200, "a range of one line is that line");
  assert.deepEqual(calls, [
    ["PR_acme/web_4", HEAD, { path: "src/plan.ts", line: 42, side: "RIGHT", body: "Off by one?" }],
    ["PR_acme/web_4", HEAD, { path: "src/plan.ts", line: 7, side: "LEFT", body: "Why drop this?" }],
    ["PR_acme/web_4", HEAD, { path: "src/plan.ts", line: 42, side: "RIGHT", startLine: 38, startSide: "LEFT", body: "Off by one?" }],
    ["PR_acme/web_4", HEAD, { path: "src/plan.ts", line: 42, side: "RIGHT", body: "Off by one?" }],
  ]);
});

test("an inline comment is logged and leaves the PR where it is: Approve and Request changes are still yours", async (c) => {
  const { t, post } = await inline(c);
  assert.equal((await post(ok)).status, 200);
  const logged = t.desk.store.db.prepare("SELECT action FROM events WHERE item_id = 'acme/web#4' AND action = 'inline_comment'").all();
  assert.equal(logged.length, 1);
  assert.equal(t.desk.store.state("acme/web#4").done_at, null);
  assert.equal((await t.desk.reviewView("acme/web#4")).approve.ok, true);
});

test("GitHub's refusal says so; a merged PR takes none", async (c) => {
  const { t, post } = await inline(c, "pull_request_review_thread.line must be part of the diff");
  const res = await post(ok);
  assert.equal(res.status, 502);
  assert.match(((await res.json()) as { error: string }).error, /must be part of the diff/);
  t.gh.items.get("acme/web#4")!.state = "merged";
  await t.desk.sync();
  const merged = await post(ok);
  assert.equal(merged.status, 409);
  assert.match(((await merged.json()) as { error: string }).error, /it's merged/);
});

test("the review says which commit its diff is at: GitHub's, ahead of the desk's last sync after a push", async (c) => {
  const pushed = "f".repeat(40);
  let head: string | undefined = pushed;
  const review: ReviewDeps = {
    fetchPr: () => Effect.succeed({ body: "", files: [], ...(head && { head }) }),
    generate: () => Effect.never,
  };
  const t = await setup(
    [makeItem({ number: 4, repo: "acme/web", author: "dana", review_requests: [{ reviewer: "me", type: "user", codeowner: false }] })],
    {
      settings: { "policy.judge": false, "review.auto_ai": false },
      desk: { review },
    },
  );
  c.after(t.cleanup);
  await t.desk.sync();
  const v = await t.desk.reviewView("acme/web#4");
  assert.equal(v.diff_head, pushed, "a comment pins to the commit whose lines it shows");
  assert.notEqual(v.item.head_oid, pushed);
  head = undefined;
  t.desk.store.set("pr:acme/web#4", null);
  assert.equal((await t.desk.reviewView("acme/web#4")).diff_head, v.item.head_oid, "no head from GitHub: the desk's");
});
