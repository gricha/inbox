// The More menu's GitHub writes: close, draft, merge and reopen your own PR, request changes on someone else's, close an
// issue. The desk decides which an item allows, refuses the rest, and takes them only from its own window.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createApp } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { GitHubWriter } from "../src/github/write.ts";
import type { Item } from "../src/types.ts";
import { myPr, reviewAsk, setup } from "./helpers/desk.ts";
import { hoursAgo, makeItem } from "./helpers/items.ts";
import { refuseWrites } from "./helpers/writer.ts";
import { Cause, Effect, Exit, Fiber } from "effect";
import { GitHubRateLimited } from "../src/errors.ts";
import { failure, run, runSync } from "./helpers/run.ts";

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
    close: (pr) =>
      Effect.sync(() => {
        calls.push(["close", pr]);
        land(pr, { state: "closed", closed_at: hoursAgo(0) });
      }),
    closeIssue: (issue) =>
      Effect.sync(() => {
        calls.push(["closeIssue", issue]);
        land(issue, { state: "closed", closed_at: hoursAgo(0) });
      }),
    reopen: (pr) =>
      Effect.sync(() => {
        calls.push(["reopen", pr]);
        land(pr, { state: "open", closed_at: null });
      }),
    draft: (pr) =>
      Effect.sync(() => {
        calls.push(["draft", pr]);
        land(pr, { draft: true });
      }),
    ready: (pr) =>
      Effect.sync(() => {
        calls.push(["ready", pr]);
        land(pr, { draft: false });
      }),
    merge: (pr, head, method) =>
      Effect.sync(() => {
        calls.push(["merge", pr, head, method]);
        land(pr, { state: "merged", closed_at: hoursAgo(0), merged_by: "me" });
      }),
    requestChanges: (pr, commit, body) =>
      Effect.sync(() => {
        calls.push(["requestChanges", pr, commit, body]);
        return { url: "https://github.com/acme/api/pull/1#pullrequestreview-2" };
      }),
  };
  return { writer, calls };
}

async function withWriter(c: TestContext, items: Item[]) {
  let t: Awaited<ReturnType<typeof setup>> | null = null;
  const w = fakeWriter(() => t!);
  t = await setup(items, { desk: { writer: w.writer } });
  c.after(t.cleanup);
  await run(t.desk.sync());
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
    myPr(9, { ...READY, base: "feature-x", default_branch: "main" }),
    makeItem({ number: 7, kind: "issue", author: "me", node_id: "I_7" }),
  ]);
  runSync(t.desk.act("web#8", "inflight"));
  const actions = (ref: string) => runSync(t.desk.item(ref)).card.actions;
  assert.deepEqual(actions("api#1"), ["request_changes"], "someone else's open PR");
  assert.deepEqual(actions("web#3"), ["close", "draft"], "not approved: no merge");
  assert.deepEqual(actions("web#4"), ["close", "draft", "merge"], "approved, green and mergeable");
  assert.deepEqual(actions("web#5"), ["close", "ready"], "a draft: ready for review instead");
  assert.deepEqual(actions("web#6"), ["close", "draft"], "GitHub says it conflicts");
  assert.deepEqual(actions("web#8"), undefined, "in Merging the coordinator has it");
  assert.deepEqual(actions("api#7"), ["close"], "your issue");
  assert.deepEqual(actions("web#9"), ["close", "draft"], "stacked: it waits on the PR below");
  const view = await run(t.desk.reviewView("web#4"));
  assert.deepEqual(view.card.actions, ["close", "draft", "merge"], "the review's card says the same");

  const t2 = await setup([myPr(3, { ci: "green" })]);
  c.after(t2.cleanup);
  await run(t2.desk.sync());
  assert.equal(runSync(t2.desk.item("web#3")).card.actions, undefined, "no write client, no actions");
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
    Object.values(runSync(t.desk.queue()).sections)
      .flat()
      .map((x) => x.id);
  assert.ok(ids().includes("acme/web#3"));
  assert.equal((await post(close, DESK)).status, 200);
  assert.deepEqual(w.calls, [["close", "PR_acme/web_3"]]);
  assert.deepEqual(writes(t, "acme/web#3"), ["close"], "in the action log, not undone by the desk's undo");
  // Refreshed before the answer, without a full sync: it's closed, off the queue, and reopening is what's left.
  assert.ok(!ids().includes("acme/web#3"));
  assert.equal(runSync(t.desk.item("web#3")).card.resolved, "closed");
  assert.deepEqual(runSync(t.desk.item("web#3")).card.actions, ["reopen"]);
  assert.equal((await post(close, DESK)).status, 409, "closed already");

  assert.equal((await post({ id: "acme/web#3", action: "reopen" }, DESK)).status, 200);
  assert.deepEqual(w.calls, [
    ["close", "PR_acme/web_3"],
    ["reopen", "PR_acme/web_3"],
  ]);
  assert.equal(runSync(t.desk.item("web#3")).card.resolved, null);
  assert.ok(ids().includes("acme/web#3"));
});

test("merge is pinned to the head the desk judged ready, with the repo's merge method, and resolves the PR", async (c) => {
  const { t, w } = await withWriter(c, [myPr(4, READY), myPr(6, { ...READY, mergeable: "conflict" })]);
  await assert.rejects(run(t.desk.githubAct("web#6", "merge")), (e: Error & { status: number }) => e.status === 409);
  await assert.rejects(
    run(t.desk.githubAct("web#4", "merge", { head: "h3" })),
    (e: Error & { status: number }) => e.status === 409 && e.message.includes("new commits since you opened it"),
  );
  assert.deepEqual(w.calls, [], "a push since the review showed it merges nothing");
  await run(t.desk.githubAct("web#4", "merge", { head: "h4" }));
  assert.deepEqual(w.calls, [["merge", "PR_acme/web_4", "h4", "SQUASH"]]);
  assert.equal(runSync(t.desk.item("web#4")).card.resolved, "merged");
  assert.deepEqual(writes(t, "acme/web#4"), ["merge"]);
});

test("draft sends your open PR back to draft, and its card shows it as one; only merge and a change request are pinned", async (c) => {
  const { t, w } = await withWriter(c, [myPr(3, { ci: "green" })]);
  await run(t.desk.githubAct("web#3", "draft", { head: "a push ago" }));
  assert.deepEqual(w.calls, [["draft", "PR_acme/web_3"]]);
  const card = runSync(t.desk.item("web#3")).card;
  assert.deepEqual([card.draft, card.cta, card.actions], [true, "ready", ["close", "ready"]]);
});

test("ready in the More menu marks your draft ready, red CI or not, and it leaves your desk as a does", async (c) => {
  const { t, w } = await withWriter(c, [myPr(3, { ci: "red", draft: true })]);
  assert.equal(runSync(t.desk.item("web#3")).card.cta, "ready", "the row offers it too");
  await run(t.desk.githubAct("web#3", "ready"));
  assert.deepEqual(w.calls, [["ready", "PR_acme/web_3"]]);
  const d = runSync(t.desk.item("web#3"));
  assert.deepEqual([d.item.draft, d.card.status, d.card.actions], [false, "done", ["close", "draft"]]);
});

test("request changes needs what you wrote, is pinned to the commit you read, and never on your own PR", async (c) => {
  const { t, w } = await withWriter(c, [reviewAsk(1, { head_oid: "h1" }), myPr(3, { ci: "green" })]);
  await assert.rejects(run(t.desk.githubAct("api#1", "request_changes", { head: "h1", body: "  " })), /say what needs to change/);
  await assert.rejects(run(t.desk.githubAct("web#3", "request_changes", { head: "abc", body: "Fix it" })), /can't request changes/);
  await assert.rejects(
    run(t.desk.githubAct("api#1", "request_changes", { body: "Fix it" })),
    (e: Error & { status: number }) => e.status === 400,
    "pinned to the commit you read, like approve",
  );
  const r = await run(t.desk.githubAct("api#1", "request_changes", { head: "h1", body: "Please add a test\n" }));
  assert.equal(r.url, "https://github.com/acme/api/pull/1#pullrequestreview-2");
  assert.deepEqual(w.calls, [["requestChanges", "PR_acme/api_1", "h1", "Please add a test"]]);
  assert.deepEqual(writes(t, "acme/api#1"), ["request_changes"]);
});

test("a bot's PR whose untrusted via line names you gets no close, draft or merge", async (c) => {
  const { t, w } = await withWriter(c, [reviewAsk(9, { author: "junior[bot]", author_bot: true, via: "@me", ...READY })]);
  assert.equal(runSync(t.desk.item("api#9")).signals.me.author, true, "the rules still call it yours");
  assert.equal(runSync(t.desk.item("api#9")).card.actions, undefined);
  await assert.rejects(run(t.desk.githubAct("api#9", "merge")), (e: Error & { status: number }) => e.status === 409);
  assert.deepEqual(w.calls, []);
});

test("a second write while the first's refresh still reads GitHub is refused, not sent twice", async (c) => {
  const { t, w } = await withWriter(c, [myPr(3, { ci: "green" })]);
  const details = t.gh.details.bind(t.gh);
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  t.gh.details = (hits) => Effect.promise(() => held).pipe(Effect.andThen(details(hits)));
  const first = run(t.desk.githubAct("web#3", "close"));
  await new Promise((r) => {
    setImmediate(r);
  });
  const second = run(t.desk.githubAct("web#3", "close")).then(
    () => "sent",
    (e: Error) => e.message,
  );
  release();
  await first;
  assert.match(await second, /already writing/);
  assert.deepEqual(w.calls, [["close", "PR_acme/web_3"]]);
});

test("a write its caller stops waiting for still lands, is logged and refreshed, and its lock goes with it", async (c) => {
  const { t, w } = await withWriter(c, [myPr(3, { ci: "green" })]);
  const close = w.writer.close.bind(w.writer);
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  w.writer.close = (pr) => Effect.promise(() => held).pipe(Effect.andThen(close(pr)));
  const fiber = Effect.runFork(t.desk.githubAct("web#3", "close"));
  const busy = await failure(t.desk.githubAct("web#3", "close"));
  assert.deepEqual([busy._tag, busy.message, busy.status], ["Busy", "already writing to acme/web#3 on GitHub", 409]);
  const gone = Effect.runPromise(Fiber.interrupt(fiber)); // a client that left: it waits for the write's region
  release();
  await gone;
  assert.deepEqual(w.calls, [["close", "PR_acme/web_3"]]);
  assert.deepEqual(writes(t, "acme/web#3"), ["close"], "in the action log");
  const d = runSync(t.desk.item("web#3"));
  assert.deepEqual([d.card.resolved, d.card.actions], ["closed", ["reopen"]], "refreshed as if it had waited");
  await run(t.desk.githubAct("web#3", "reopen"));
  assert.deepEqual(w.calls.at(-1), ["reopen", "PR_acme/web_3"], "not Busy: the lock went with the write");
});

test("a write in flight when the desk stops still lands, is logged and done, and answers; the store closes after it", async (c) => {
  const { t, w } = await withWriter(c, [myPr(3, { ci: "green" }), myPr(5, { ci: "green" })]);
  const close = w.writer.close.bind(w.writer);
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  w.writer.close = (pr) => Effect.promise(() => held).pipe(Effect.andThen(close(pr)));
  const answer = run(t.desk.githubAct("web#3", "close"));
  await new Promise((r) => {
    setImmediate(r);
  });
  let closed = false;
  const closing = Effect.runPromise(
    t.desk.close().pipe(
      Effect.andThen(
        Effect.sync(() => {
          closed = true;
        }),
      ),
    ),
  );
  assert.equal(t.desk.stopped, true, "stopping is at once");
  await new Promise((r) => {
    setImmediate(r);
  });
  assert.equal(closed, false, "close() waits for the write");
  const late = Effect.runPromiseExit(t.desk.githubAct("web#5", "close"));
  release();
  assert.deepEqual(await answer, { url: "" }, "its own result, not a 500 from a closed store");
  await closing;
  const exit = await late;
  assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause), "a stopped desk sends no new write: interrupted");
  assert.deepEqual(w.calls, [["close", "PR_acme/web_3"]]);
  assert.throws(() => t.desk.store.db.prepare("SELECT 1"), /not open/, "the last write closed it");
  const store = new Store(path.join(t.home, "desk.db"));
  const logged = store.db
    .prepare("SELECT action FROM events WHERE item_id = ? AND undone = 1")
    .all("acme/web#3")
    .map((r) => r.action);
  const done = store.state("acme/web#3").done_at;
  store.close();
  assert.deepEqual(logged, ["close"], "in the action log");
  assert.ok(done, "done after it, as if the desk were still up");
});

test("a write sent once the desk has stopped and closed its store ends as interrupted before it reads anything", async (c) => {
  const { t, w } = await withWriter(c, [myPr(3, { ci: "green" }), myPr(5, { ci: "green", draft: true })]);
  const post = client(t);
  t.desk.changed(); // the next read computes from the store
  await run(t.desk.close());
  const late = [
    t.desk.githubAct("web#5", "close"),
    t.desk.approve("web#5", "h"),
    t.desk.comment("web#5", "hi"),
    t.desk.reply("web#5", "c1", "hi"),
    t.desk.inlineComment("web#5", { path: "a.ts", line: 1, side: "new" }, "hi", "h"),
    t.desk.markReady("web#5"),
    t.desk.askReviewers("web#5", { users: ["U_1"], teams: [] }),
  ];
  for (const write of late) {
    const exit = await Effect.runPromiseExit<unknown, unknown>(write);
    assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "it ran");
  }
  assert.equal((await post({ id: "acme/web#5", action: "close" }, DESK)).status, 499, "a quiet 499, not a 500 from the closed store");
  assert.deepEqual(w.calls, []);
});

test("an issue you opened closes with closeIssue", async (c) => {
  const { t, w } = await withWriter(c, [makeItem({ number: 7, kind: "issue", author: "me", node_id: "I_7" })]);
  await run(t.desk.githubAct("api#7", "close"));
  assert.deepEqual(w.calls, [["closeIssue", "I_7"]]);
  assert.equal(runSync(t.desk.item("api#7")).card.resolved, "closed");
});

test("a refused write says why, and nothing is logged; an agent's /api/act can't reach any of them", async (c) => {
  const t = await setup([myPr(3, { ci: "green" })], { desk: { writer: refuseWrites("Resource not accessible") } });
  c.after(t.cleanup);
  await run(t.desk.sync());
  await assert.rejects(
    run(t.desk.githubAct("web#3", "close")),
    (e: Error & { status: number }) => e.status === 502 && e.message.includes("Resource not accessible"),
  );
  assert.deepEqual(writes(t, "acme/web#3"), []);
  assert.throws(() => runSync(t.desk.act("web#3", "close" as never, undefined, "agent")), /unknown action/);
});

test("a write whose refresh reads nothing isn't offered again until a read shows the change", async (c) => {
  const { t, w } = await withWriter(c, [myPr(4, READY), myPr(3, { ci: "green" })]);
  const details = t.gh.details.bind(t.gh);
  // A batch GitHub refuses: details skips it, so the refresh stores nothing and nothing pauses.
  t.gh.details = () => Effect.succeed([]);
  await run(t.desk.githubAct("web#4", "close"));
  assert.equal(t.desk.store.itemsById(["acme/web#4"]).get("acme/web#4")?.state, "open", "the refresh read nothing");
  assert.equal(t.desk.gh.pausedUntil, 0);
  assert.equal(runSync(t.desk.item("web#4")).card.actions, undefined, "the snapshot still says open, but nothing is offered");
  await assert.rejects(run(t.desk.githubAct("web#4", "merge")), /409|can't/);
  // The rate limit, the one way details fails: the refresh pauses the loops until its reset, and the write still answers.
  const resetAt = new Date(Date.now() + 60_000).toISOString();
  t.gh.details = () => Effect.fail(new GitHubRateLimited({ resetAt, message: `GitHub rate limited until ${resetAt} (HTTP 403)` }));
  await run(t.desk.githubAct("web#3", "close"));
  assert.equal(t.desk.gh.pausedUntil, Date.parse(resetAt));
  assert.equal(runSync(t.desk.item("web#3")).card.actions, undefined);
  assert.deepEqual(w.calls, [
    ["close", "PR_acme/web_4"],
    ["close", "PR_acme/web_3"],
  ]);
  t.gh.details = details;
  t.desk.gh.pausedUntil = 0; // the reset came
  await run(t.desk.sync());
  assert.deepEqual(runSync(t.desk.item("web#4")).card.actions, ["reopen"], "a read shows it closed");
  assert.deepEqual(runSync(t.desk.item("web#3")).card.actions, ["reopen"]);
});
