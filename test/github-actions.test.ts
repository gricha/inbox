// The More menu's GitHub writes: close, draft, merge and reopen your own PR, request changes on someone else's, close an
// issue. The desk decides which an item allows, refuses the rest, and takes them only from its own window.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.ts";
import type { GitHubWriter } from "../src/github/write.ts";
import type { Item } from "../src/types.ts";
import { myPr, reviewAsk, setup } from "./helpers/desk.ts";
import { hoursAgo, makeItem } from "./helpers/items.ts";
import { refuseWrites } from "./helpers/writer.ts";

const READY = { ci: "green", review_decision: "approved", mergeable: "clean", merge_method: "SQUASH", head_oid: "h4" } as const;
const DESK = "http://localhost:47823";

// Plays GitHub: each write lands on the fake's item, as the next read of it would show.
function fakeWriter(t: () => Awaited<ReturnType<typeof setup>>) {
  const calls: string[][] = [];
  const land = (node: string, change: Partial<Item>) => {
    const gh = t().gh;
    const it = [...gh.items.values()].find((x) => x.node_id === node)!;
    gh.items.set(it.id, { ...it, ...change, updated_at: hoursAgo(0) });
  };
  const writer: GitHubWriter = {
    ...refuseWrites(),
    close: (pr) => {
      calls.push(["close", pr]);
      land(pr, { state: "closed", closed_at: hoursAgo(0) });
      return Promise.resolve();
    },
    closeIssue: (issue) => {
      calls.push(["closeIssue", issue]);
      land(issue, { state: "closed", closed_at: hoursAgo(0) });
      return Promise.resolve();
    },
    reopen: (pr) => {
      calls.push(["reopen", pr]);
      land(pr, { state: "open", closed_at: null });
      return Promise.resolve();
    },
    draft: (pr) => {
      calls.push(["draft", pr]);
      land(pr, { draft: true });
      return Promise.resolve();
    },
    merge: (pr, head, method) => {
      calls.push(["merge", pr, head, method]);
      land(pr, { state: "merged", closed_at: hoursAgo(0), merged_by: "me" });
      return Promise.resolve();
    },
    requestChanges: (pr, commit, body) => {
      calls.push(["requestChanges", pr, commit, body]);
      return Promise.resolve({ url: "https://github.com/acme/api/pull/1#pullrequestreview-2" });
    },
  };
  return { writer, calls };
}

async function withWriter(c: TestContext, items: Item[]) {
  let t: Awaited<ReturnType<typeof setup>> | null = null;
  const w = fakeWriter(() => t!);
  t = await setup(items, { desk: { writer: w.writer } });
  c.after(t.cleanup);
  await t.desk.sync();
  return { t, w };
}

// The desk's own window, or anyone else (an agent, the CLI, another site).
function client(t: Awaited<ReturnType<typeof setup>>) {
  const app = createApp(t.desk, 47823);
  return (body: unknown, origin?: string, site = "same-origin") =>
    app.request("http://127.0.0.1:47823/api/github", {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin, "sec-fetch-site": site } : {}) },
      body: JSON.stringify(body),
    });
}

const writes = (t: Awaited<ReturnType<typeof setup>>, id: string) =>
  t.desk.store.db
    .prepare("SELECT action FROM events WHERE item_id = ? AND undone = 1 ORDER BY seq")
    .all(id)
    .map((r) => r.action);

test("the desk says which GitHub writes each item allows, on its card", async (c) => {
  const { t } = await withWriter(c, [
    reviewAsk(1),
    myPr(3, { ci: "green" }),
    myPr(4, READY),
    myPr(5, { ci: "green", draft: true }),
    myPr(6, { ...READY, mergeable: "conflict" }),
    myPr(8, { ...READY, merge_method: undefined }),
    makeItem({ number: 7, kind: "issue", author: "me", node_id: "I_7" }),
  ]);
  t.desk.act("web#8", "inflight");
  const actions = (ref: string) => t.desk.item(ref).card.actions;
  assert.deepEqual(actions("api#1"), ["request_changes"], "someone else's open PR");
  assert.deepEqual(actions("web#3"), ["close", "draft"], "not approved: no merge");
  assert.deepEqual(actions("web#4"), ["close", "draft", "merge"], "approved, green and mergeable");
  assert.deepEqual(actions("web#5"), ["close"], "a draft already");
  assert.deepEqual(actions("web#6"), ["close", "draft"], "GitHub says it conflicts");
  assert.deepEqual(actions("web#8"), undefined, "in Merging the coordinator has it");
  assert.deepEqual(actions("api#7"), ["close"], "your issue");
  const view = await t.desk.reviewView("web#4");
  assert.deepEqual(view.card.actions, ["close", "draft", "merge"], "the review's card says the same");

  const t2 = await setup([myPr(3, { ci: "green" })]);
  c.after(t2.cleanup);
  await t2.desk.sync();
  assert.equal(t2.desk.item("web#3").card.actions, undefined, "no write client, no actions");
});

test("close goes through the write client once, from the desk's window only; the item refreshes and u's reopen is allowed", async (c) => {
  const { t, w } = await withWriter(c, [reviewAsk(1), myPr(3, { ci: "green" })]);
  const post = client(t);
  const close = { id: "acme/web#3", action: "close" };
  assert.equal((await post(close)).status, 403, "MCP and the CLI can't");
  assert.equal((await post(close, "https://evil.example")).status, 403);
  assert.equal((await post(close, DESK, "none")).status, 403, "an Origin alone isn't the desk's page");
  assert.equal((await post({ id: "acme/web#3", action: "delete" }, DESK)).status, 400);
  assert.equal((await post({ id: "acme/web#3", action: "reopen" }, DESK)).status, 409, "it's open");
  assert.equal((await post({ id: "acme/api#1", action: "close" }, DESK)).status, 409, "not yours");
  assert.deepEqual(w.calls, []);

  const ids = () =>
    Object.values(t.desk.queue().sections)
      .flat()
      .map((x) => x.id);
  assert.ok(ids().includes("acme/web#3"));
  assert.equal((await post(close, DESK)).status, 200);
  assert.deepEqual(w.calls, [["close", "PR_acme/web_3"]]);
  assert.deepEqual(writes(t, "acme/web#3"), ["close"], "in the action log, not undone by the desk's undo");
  // Refreshed before the answer, without a full sync: it's closed, off the queue, and reopening is what's left.
  assert.ok(!ids().includes("acme/web#3"));
  assert.equal(t.desk.item("web#3").card.resolved, "closed");
  assert.deepEqual(t.desk.item("web#3").card.actions, ["reopen"]);
  assert.equal((await post(close, DESK)).status, 409, "closed already");

  assert.equal((await post({ id: "acme/web#3", action: "reopen" }, DESK)).status, 200);
  assert.deepEqual(w.calls, [
    ["close", "PR_acme/web_3"],
    ["reopen", "PR_acme/web_3"],
  ]);
  assert.equal(t.desk.item("web#3").card.resolved, null);
  assert.ok(ids().includes("acme/web#3"));
});

test("merge is pinned to the head the desk judged ready, with the repo's merge method, and resolves the PR", async (c) => {
  const { t, w } = await withWriter(c, [myPr(4, READY), myPr(6, { ...READY, mergeable: "conflict" })]);
  await assert.rejects(t.desk.githubAct("web#6", "merge"), (e: Error & { status: number }) => e.status === 409);
  await assert.rejects(
    t.desk.githubAct("web#4", "merge", { head: "h3" }),
    (e: Error & { status: number }) => e.status === 409 && e.message.includes("new commits since you opened it"),
  );
  assert.deepEqual(w.calls, [], "a push since the review showed it merges nothing");
  await t.desk.githubAct("web#4", "merge", { head: "h4" });
  assert.deepEqual(w.calls, [["merge", "PR_acme/web_4", "h4", "SQUASH"]]);
  assert.equal(t.desk.item("web#4").card.resolved, "merged");
  assert.deepEqual(writes(t, "acme/web#4"), ["merge"]);
});

test("draft sends your open PR back to draft, and its card shows it as one; only merge and a change request are pinned", async (c) => {
  const { t, w } = await withWriter(c, [myPr(3, { ci: "green" })]);
  await t.desk.githubAct("web#3", "draft", { head: "a push ago" });
  assert.deepEqual(w.calls, [["draft", "PR_acme/web_3"]]);
  const card = t.desk.item("web#3").card;
  assert.deepEqual([card.draft, card.cta, card.actions], [true, "ready", ["close"]]);
});

test("request changes needs what you wrote, is pinned to the commit you read, and never on your own PR", async (c) => {
  const { t, w } = await withWriter(c, [reviewAsk(1, { head_oid: "h1" }), myPr(3, { ci: "green" })]);
  await assert.rejects(t.desk.githubAct("api#1", "request_changes", { head: "h1", body: "  " }), /say what needs to change/);
  await assert.rejects(t.desk.githubAct("web#3", "request_changes", { head: "abc", body: "Fix it" }), /can't request changes/);
  const r = await t.desk.githubAct("api#1", "request_changes", { head: "h1", body: "Please add a test\n" });
  assert.equal(r.url, "https://github.com/acme/api/pull/1#pullrequestreview-2");
  assert.deepEqual(w.calls, [["requestChanges", "PR_acme/api_1", "h1", "Please add a test"]]);
  assert.deepEqual(writes(t, "acme/api#1"), ["request_changes"]);
});

test("an issue you opened closes with closeIssue", async (c) => {
  const { t, w } = await withWriter(c, [makeItem({ number: 7, kind: "issue", author: "me", node_id: "I_7" })]);
  await t.desk.githubAct("api#7", "close");
  assert.deepEqual(w.calls, [["closeIssue", "I_7"]]);
  assert.equal(t.desk.item("api#7").card.resolved, "closed");
});

test("a refused write says why, and nothing is logged; an agent's /api/act can't reach any of them", async (c) => {
  const t = await setup([myPr(3, { ci: "green" })], { desk: { writer: refuseWrites("Resource not accessible") } });
  c.after(t.cleanup);
  await t.desk.sync();
  await assert.rejects(
    t.desk.githubAct("web#3", "close"),
    (e: Error & { status: number }) => e.status === 502 && e.message.includes("Resource not accessible"),
  );
  assert.deepEqual(writes(t, "acme/web#3"), []);
  assert.throws(() => t.desk.act("web#3", "close" as never, undefined, "agent"), /unknown action/);
});
