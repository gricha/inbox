// Merging (in flight): m on your own PR, the Merging tab (never the queue), the coordinator's notes and hand-backs, and Ready
// for review on your own draft (a GitHub write).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.ts";
import type { GitHubWriter } from "../src/github/write.ts";
import { REBASE } from "../src/coordinator.ts";
import type { Item } from "../src/types.ts";
import { myPr, reviewAsk, setup } from "./helpers/desk.ts";
import { hoursAgo, makeItem, NOW } from "./helpers/items.ts";
import { refuseWrites } from "./helpers/writer.ts";
import { Effect } from "effect";
import { GitHubGraphQLError } from "../src/errors.ts";
import { run, runSync } from "./helpers/run.ts";

function fakeWriter(refuse = false, refuseReviews = false) {
  const calls: (string | string[])[][] = [];
  const writer: GitHubWriter = {
    ...refuseWrites(),
    ready: (pr) =>
      Effect.suspend(() => {
        calls.push(["ready", pr]);
        return refuse ? Effect.fail(new GitHubGraphQLError({ message: "Resource not accessible" })) : Effect.void;
      }),
    requestReviews: (pr, users, teams) =>
      Effect.suspend(() => {
        calls.push(["request_reviews", pr, users, teams]);
        return refuseReviews ? Effect.fail(new GitHubGraphQLError({ message: "Could not resolve to a node" })) : Effect.void;
      }),
  };
  return { writer, calls };
}

// The desk's own window, or anyone else (an agent, the CLI, another site).
function client(t: Awaited<ReturnType<typeof setup>>) {
  const app = createApp(t.desk, 47823);
  return (p: string, body: unknown = {}, origin?: string, site = "same-origin") =>
    app.request(`http://127.0.0.1:47823${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin, "sec-fetch-site": site } : {}) },
      body: JSON.stringify(body),
    });
}

test("a hand-off puts your own open PR in Merging: it leaves the queue, and undo or b brings it back", async (c) => {
  const t = await setup([reviewAsk(1), myPr(3, { ci: "pending" })]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  const all = () => {
    const q = runSync(t.desk.queue());
    return [...Object.values(q.sections).flat(), ...q.hidden, ...q.cleared, ...q.resolved].map((x) => x.id);
  };
  assert.ok(all().includes("acme/web#3"));
  const r = runSync(t.desk.act("web#3", "inflight"));
  assert.ok(r.state.inflight_at);
  assert.ok(!all().includes("acme/web#3"));
  assert.deepEqual(
    runSync(t.desk.inflight()).rows.map((x) => [x.card.id, x.card.inflight, x.waits_on, x.note]),
    [["acme/web#3", true, "waits on CI", null]],
  );
  assert.deepEqual(runSync(t.desk.overview()).inflight, { total: 1 });
  assert.throws(() => runSync(t.desk.act("web#3", "inflight")), /in Merging already/);
  runSync(t.desk.undo(r.undo_seq));
  assert.ok(all().includes("acme/web#3"));
  assert.equal(runSync(t.desk.inflight()).rows.length, 0);
  runSync(t.desk.act("web#3", "inflight"));
  const back = runSync(t.desk.act("web#3", "takeback"));
  assert.equal(back.state.inflight_at, null);
  assert.ok(all().includes("acme/web#3"));
  runSync(t.desk.undo(back.undo_seq));
  assert.equal(runSync(t.desk.inflight()).rows.length, 1);
  assert.throws(() => runSync(t.desk.undo(undefined, "agent")), /in the desk's window/);
});

test("only the desk's own window hands a PR off or undoes a hand-off or Back to desk: the coordinator merges what's there", async (c) => {
  const t = await setup([myPr(3, { ci: "pending" })]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  const post = client(t);
  const desk = "http://localhost:47823";
  const act = (action: string, origin?: string, site?: string) => post("/api/act", { id: "acme/web#3", action }, origin, site);
  assert.equal((await act("inflight")).status, 403, "curl, the CLI or an agent");
  assert.equal((await act("inflight", desk, "none")).status, 403, "an Origin alone isn't the desk's page");
  assert.equal(runSync(t.desk.inflight()).rows.length, 0);
  assert.equal((await act("inflight", desk)).status, 200);
  const back = (await (await act("takeback", desk)).json()) as { undo_seq: number };
  assert.equal((await post("/api/undo", { seq: back.undo_seq })).status, 409, "an agent can't put it back in Merging");
  assert.equal((await act("undo")).status, 409, "nor through /api/act");
  assert.equal(runSync(t.desk.inflight()).rows.length, 0);
  assert.equal((await post("/api/undo", { seq: back.undo_seq }, desk)).status, 200);
  assert.equal(runSync(t.desk.inflight()).rows.length, 1);
});

test("a draft isn't handed off: Ready for review is yours, so it would wait on you in Merging", async (c) => {
  const t = await setup([myPr(3, { ci: "green", draft: true })]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  assert.throws(
    () => runSync(t.desk.act("web#3", "inflight")),
    (e: Error & { status: number }) => e.status === 409 && e.message.endsWith("mark it ready for review first"),
  );
  assert.equal(runSync(t.desk.inflight()).rows.length, 0);
});

test("a PR in Merging stays there whatever it waits on: never in the queue, focus or the status line", async (c) => {
  const ready = { ci: "green" as const, review_decision: "approved" as const, mergeable: "clean" as const };
  const t = await setup([reviewAsk(1), myPr(3, { ci: "red" }), myPr(4, ready), myPr(5, { ci: "pending" })]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  for (const n of [3, 4, 5]) runSync(t.desk.act(`web#${n}`, "inflight"));
  const q = runSync(t.desk.queue());
  const shown = [q.sections, runSync(t.desk.focus()).sections].flatMap((x) => Object.values(x).flat());
  assert.deepEqual([...new Set([...shown, ...q.hidden, ...q.cleared, ...q.resolved].map((x) => x.id))], ["acme/api#1"]);
  assert.equal(runSync(t.desk.status()).text, "desk 1");
  assert.deepEqual([runSync(t.desk.item("web#3")).card.bucket, runSync(t.desk.item("web#3")).card.why], ["fyi", "merging"]);
  assert.deepEqual(runSync(t.desk.overview()).inflight, { total: 3 });
});

test("only your own open PRs are handed off for merge", async (c) => {
  const t = await setup([reviewAsk(1), myPr(3)]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  assert.throws(
    () => runSync(t.desk.act("api#1", "inflight")),
    (e: Error & { status: number }) => e.status === 409 && e.message.includes("your own open PRs"),
  );
  assert.throws(() => runSync(t.desk.act("web#3", "takeback")), /isn't in Merging/);
});

test("in Merging, the coordinator owns it: done, snooze and mute are refused, and the judge leaves it alone", async (c) => {
  process.env.DESK_CLAUDE = "/nonexistent/claude";
  const t = await setup([myPr(3, { ci: "pending" })]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  // Muted before you handed it off: handing off clears that.
  const muted = runSync(t.desk.act("web#3", "mute"));
  const marked = runSync(t.desk.act("web#3", "inflight"));
  assert.equal(marked.state.muted, false);
  for (const action of ["done", "snooze", "mute"] as const)
    assert.throws(
      () => runSync(t.desk.act("web#3", action)),
      (e: Error & { status: number }) => e.status === 409 && e.message.endsWith("bring it back to the desk first"),
    );
  // Undoing the hand-off brings back the mute.
  runSync(t.desk.undo(marked.undo_seq));
  assert.equal(t.desk.store.state("acme/web#3").muted, true);
  runSync(t.desk.undo(muted.undo_seq));
  runSync(t.desk.act("web#3", "inflight"));
  runSync(t.desk.putPolicy("Waiting PRs are fyi."));
  assert.ok(!t.desk.judge.queue().some((g) => g.item.id === "acme/web#3"));
});

test("what a PR in Merging waits on: the first thing between it and a merge", async (c) => {
  const green = { ci: "green" as const, mergeable: "clean" as const };
  const approved = {
    ...green,
    reviews: [{ author: "marco", author_bot: false, trusted: true, state: "approved" as const, at: hoursAgo(1), commit: "c1" }],
  };
  const outsider = { author: "drive-by", author_bot: false, trusted: false, state: "approved" as const, at: hoursAgo(1), commit: "c1" };
  const t = await setup([
    myPr(1, { ci: "red", mergeable: "conflict" }),
    myPr(2, { ...green, mergeable: "conflict" }),
    myPr(3, { ...green, reviews: [{ author: "dana", author_bot: false, state: "changes_requested", at: hoursAgo(1), commit: "c1" }] }),
    myPr(4, { ci: "pending" }),
    myPr(5, { ...approved, threads_unresolved: 1 }),
    myPr(6, { ...green, review_requests: [{ reviewer: "backend", type: "team", codeowner: true }] }),
    myPr(7, { ...approved, base: "feat/a", default_branch: "main" }),
    myPr(8, approved),
    myPr(9, { ...green, review_requests: [], reviews: [outsider] }), // reviewed, if not by a collaborator: not one nobody's asked
  ]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  for (let n = 1; n <= 9; n++) runSync(t.desk.act(`web#${n}`, "inflight"));
  const waits = Object.fromEntries(runSync(t.desk.inflight()).rows.map((r) => [r.card.number, r.waits_on]));
  assert.deepEqual(waits, {
    1: "waits on a CI fix",
    2: "waits on a merge conflict fix",
    3: "waits on a second look from dana",
    4: "waits on CI",
    5: "waits on 1 unresolved thread",
    6: "waits on a review from @backend",
    7: "waits on feat/a to merge first",
    8: "ready to merge",
    9: "waits on a review",
  });
  assert.deepEqual(runSync(t.desk.inflight()).rows.find((r) => r.card.number === 9)!.approved_by, [], "the coordinator merges on it");
  assert.deepEqual(
    runSync(t.desk.inflight()).rows.find((r) => r.card.number === 7)!.stacked,
    true,
    "the coordinator sees it sits on another PR",
  );
});

const SAVED = { id: "c0ffee01", url: "https://claude.ai/code/session_01Fakec0ffee01" };

// Your own PR #3, approved and green, #4, green and waiting on review, and #5, approved and green but quiet for 40 days; a
// coordinator was started, and its wakes are kept, not delivered.
async function conflicts(c: TestContext, settings: Record<string, unknown> = {}) {
  const ready = { ci: "green", review_decision: "approved", mergeable: "clean" } as const;
  const t = await setup([myPr(3, ready), myPr(4, { ci: "green" }), myPr(5, { ...ready, updated_at: hoursAgo(40 * 24) })], {
    settings: { "policy.judge": false, "notify.quiet": "", ...settings },
  });
  c.after(t.cleanup);
  t.desk.store.set("coordinator_bg", SAVED);
  const woke: [string, string][] = [];
  t.desk.coordinator.wake = (id, what) => {
    woke.push([id, what]);
  };
  t.desk.coordinator.stop = () => {};
  await run(t.desk.sync());
  let step = 0;
  const update = async (n: number, o: Partial<Item>) => {
    const it = t.gh.items.get(`acme/web#${n}`)!;
    t.gh.items.set(it.id, { ...it, ...o, updated_at: hoursAgo(1 - ++step / 10) });
    await run(t.desk.sync());
  };
  const main = () =>
    Object.values(runSync(t.desk.focus()).sections)
      .flat()
      .map((x) => [x.id, x.why]);
  const merging = () => runSync(t.desk.inflight()).rows.map((r) => [r.card.id, r.waits_on, r.rebase]);
  return { ...t, woke, update, main, merging };
}

test("your PR that's ready to merge but conflicts goes to the coordinator to rebase, once, off your desk and unannounced", async (c) => {
  const t = await conflicts(c);
  assert.deepEqual(t.main(), [["acme/web#3", "approved and green: ready to merge"]]);
  await t.update(3, { mergeable: "conflict" });
  assert.deepEqual(t.woke, [["acme/web#3", REBASE]]);
  assert.deepEqual(t.merging(), [["acme/web#3", "rebasing", true]]);
  assert.deepEqual(t.main(), []);
  await t.update(3, { comments_total: 1 });
  await run(t.desk.sync());
  assert.equal(t.woke.length, 1, "once per conflict, not every sync");
  assert.deepEqual(t.notes, []);
  // GitHub sees it mergeable again: it leaves Merging by itself, and is ready to merge on your desk.
  await t.update(3, { mergeable: "unknown", head_oid: "def" });
  assert.deepEqual(t.merging(), [["acme/web#3", "rebasing", true]], "not while GitHub works it out");
  await t.update(3, { mergeable: "clean" });
  assert.deepEqual(t.merging(), []);
  assert.deepEqual(t.desk.merging("acme/web#3"), {});
  assert.deepEqual(t.main(), [["acme/web#3", "approved and green: ready to merge"]]);
  assert.deepEqual(t.notes, ["web#3 · approved and green: ready to merge"]);
  await t.update(3, { mergeable: "conflict" });
  assert.equal(t.woke.length, 2, "a new conflict goes again");
});

test("a conflict on your PR that isn't ready to merge yet is nobody's: nothing goes to the coordinator, nothing notifies", async (c) => {
  const t = await conflicts(c);
  await t.update(4, { mergeable: "conflict" });
  await t.update(3, { mergeable: "conflict", ci: "pending" });
  await t.update(3, { draft: true, ci: "green" });
  assert.deepEqual([t.woke, t.merging(), t.notes], [[], [], []]);
  assert.ok(!t.main().some(([id]) => id === "acme/web#4"));
});

test("a rebase the coordinator hands back tops your desk with its reason, and isn't sent again for that conflict", async (c) => {
  const t = await conflicts(c);
  await t.update(3, { mergeable: "conflict" });
  runSync(t.desk.handBack("web#3", "can't rebase cleanly: both change the retry schedule"));
  await t.update(3, { comments_total: 1 });
  assert.deepEqual(t.main(), [["acme/web#3", "handed back: can't rebase cleanly: both change the retry schedule"]]);
  assert.deepEqual([t.woke.length, t.merging()], [1, []]);
  // You fix it yourself: once it's mergeable, the hand-back is done with.
  await t.update(3, { mergeable: "clean" });
  assert.deepEqual(t.main(), [["acme/web#3", "approved and green: ready to merge"]]);
});

test("with the coordinator off, a ready PR's conflict stays yours: nothing is sent and it stays on your desk", async (c) => {
  const t = await conflicts(c, { "agent.coordinator": false });
  await t.update(3, { mergeable: "conflict" });
  assert.deepEqual([t.woke, t.merging()], [[], []]);
  assert.deepEqual(t.main(), [["acme/web#3", "approved and green: ready to merge"]]);
  // On, it goes; off again, it comes back to your desk.
  runSync(t.desk.putSettings({ set: { "agent.coordinator": true } }));
  await run(t.desk.sync());
  assert.deepEqual(t.merging(), [["acme/web#3", "rebasing", true]]);
  runSync(t.desk.putSettings({ set: { "agent.coordinator": false } }));
  await run(t.desk.sync());
  assert.deepEqual([t.merging(), t.main()], [[], [["acme/web#3", "approved and green: ready to merge"]]]);
});

test("nothing is sent from a desk that never started a coordinator, or for your PR that isn't on your desk", async (c) => {
  const t = await conflicts(c);
  t.desk.store.set("coordinator_bg", null);
  await t.update(3, { mergeable: "conflict" });
  assert.deepEqual([t.woke, t.merging()], [[], []], "a scratch desk's would be a second coordinator");
  t.desk.store.set("coordinator_bg", SAVED);
  const quiet = t.gh.items.get("acme/web#5")!;
  t.gh.items.set(quiet.id, { ...quiet, mergeable: "conflict" });
  await run(t.desk.sync());
  assert.deepEqual(t.woke, [["acme/web#3", REBASE]], "not #5, quiet in Later");
});

test("CI that never ran doesn't hold a conflicting PR back: GitHub runs none on one", async (c) => {
  const t = await conflicts(c);
  runSync(t.desk.act("web#4", "pin"));
  await t.update(4, { review_decision: "approved", ci: "pending", mergeable: "conflict" });
  assert.deepEqual(t.woke, [["acme/web#4", REBASE]]);
});

test("your handed-off PR's conflict stays the coordinator's to merge; one it hands back or you bring back stays yours", async (c) => {
  const t = await conflicts(c);
  runSync(t.desk.act("web#3", "inflight"));
  await t.update(3, { mergeable: "conflict" });
  assert.deepEqual(t.merging(), [["acme/web#3", "waits on a merge conflict fix", false]]);
  runSync(t.desk.handBack("web#3", "can't rebase cleanly"));
  await t.update(3, { comments_total: 1 });
  assert.deepEqual(t.main(), [["acme/web#3", "handed back: can't rebase cleanly"]]);
  runSync(t.desk.act("web#3", "inflight"));
  runSync(t.desk.act("web#3", "takeback"));
  await t.update(3, { comments_total: 2 });
  assert.deepEqual(t.merging(), []);
  assert.deepEqual(t.main(), [["acme/web#3", "approved and green: ready to merge"]]);
  assert.ok(!t.woke.some(([, what]) => what === REBASE));
});

test("desk_note: the coordinator's latest line on a PR in Merging shows on its row; m again starts without it", async (c) => {
  const t = await setup([reviewAsk(1), myPr(3, { ci: "pending" })]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  const post = client(t);
  const id = encodeURIComponent("acme/web#3");
  assert.equal((await post(`/api/inflight/${id}/note`, { text: "Fixing lint" })).status, 409, "not in Merging yet");
  runSync(t.desk.act("web#3", "inflight"));
  assert.equal((await post(`/api/inflight/${id}/note`, { text: "Fixing lint" })).status, 200, "local only, so agents may");
  t.setNow(new Date(Date.parse(hoursAgo(0)) + 60_000));
  assert.equal((await post(`/api/inflight/${id}/note`, { text: "Pushed\nabc1234,\tCI running" })).status, 200);
  assert.deepEqual(runSync(t.desk.inflight()).rows[0]!.note, {
    text: "Pushed abc1234, CI running",
    at: new Date(Date.parse(hoursAgo(0)) + 60_000).toISOString(),
  });
  assert.equal((await post(`/api/inflight/${id}/note`, { text: "  " })).status, 400);
  assert.equal((await post(`/api/inflight/${id}/note`, {})).status, 400);
  assert.equal((await post(`/api/inflight/${encodeURIComponent("acme/api#1")}/note`, { text: "x" })).status, 409, "not yours");
  runSync(t.desk.act("web#3", "takeback"));
  runSync(t.desk.act("web#3", "inflight"));
  assert.equal(runSync(t.desk.inflight()).rows[0]!.note, null);
});

test("desk_hand_back: the PR leaves Merging for the top of Now with the why, writes nothing, and notifies", async (c) => {
  const w = fakeWriter();
  const t = await setup([reviewAsk(1), myPr(3, { ci: "pending" }), myPr(4, { ci: "pending" })], {
    settings: { "notify.quiet": "" },
    desk: { writer: w.writer },
  });
  c.after(t.cleanup);
  await run(t.desk.sync());
  runSync(t.desk.act("web#3", "inflight"));
  runSync(t.desk.act("web#4", "inflight"));
  t.desk.notifyNew();
  const post = client(t);
  const res = await post(`/api/inflight/${encodeURIComponent("acme/web#3")}/handback`, { why: "Dana wants the cache\nredesigned first" });
  assert.equal(res.status, 200);
  assert.deepEqual(w.calls, [], "a hand-back writes nothing to GitHub");
  assert.equal(t.desk.store.state("acme/web#3").inflight_at, null);
  assert.deepEqual(
    runSync(t.desk.inflight()).rows.map((r) => r.card.id),
    ["acme/web#4"],
  );
  const [top] = runSync(t.desk.queue()).sections.now;
  assert.deepEqual(
    [top?.id, top?.why, top?.handed_back, top?.inflight],
    ["acme/web#3", "handed back: Dana wants the cache redesigned first", true, false],
  );
  assert.deepEqual(t.notes, ["web#3 · handed back: Dana wants the cache redesigned first"]);
  assert.equal((await post(`/api/inflight/${encodeURIComponent("acme/web#3")}/handback`, { why: "again" })).status, 409);
  // Done puts it away for good; m again starts afresh.
  t.setNow(new Date(Date.parse(hoursAgo(0)) + 60_000));
  runSync(t.desk.act("web#3", "done"));
  assert.ok(!runSync(t.desk.queue()).sections.now.some((x) => x.id === "acme/web#3"));
  runSync(t.desk.act("web#3", "restore"));
  runSync(t.desk.act("web#3", "inflight"));
  assert.deepEqual(t.desk.merging("acme/web#3"), {});
});

test("your own open draft carries one call to action, Ready for review; a a marks it ready on GitHub, once, from the desk's window", async (c) => {
  const w = fakeWriter();
  const t = await setup(
    [reviewAsk(1), myPr(3, { ci: "green", draft: true }), myPr(4, { ci: "green" }), myPr(5, { ci: "red", draft: true })],
    {
      desk: { writer: w.writer },
    },
  );
  c.after(t.cleanup);
  await run(t.desk.sync());
  const cta = (ref: string) => runSync(t.desk.item(ref)).card.cta;
  assert.deepEqual(
    [cta("web#3"), cta("web#4"), cta("api#1"), cta("web#5")],
    ["ready", undefined, undefined, "ready"],
    "a red draft too: CI is the coordinator's once it's ready",
  );
  const post = client(t);
  const ready = (ref: string, origin?: string, site?: string) => post(`/api/review/${encodeURIComponent(ref)}/ready`, {}, origin, site);
  assert.equal((await ready("acme/web#3")).status, 403, "MCP and the CLI can't");
  assert.equal((await ready("acme/web#3", "https://evil.example")).status, 403);
  assert.equal((await ready("acme/web#3", "http://localhost:47823", "none")).status, 403, "an Origin alone isn't the desk's page");
  assert.deepEqual(w.calls, []);
  assert.equal((await ready("acme/web#4", "http://localhost:47823")).status, 409, "not a draft");
  assert.equal((await ready("acme/api#1", "http://localhost:47823")).status, 409, "not yours");
  assert.equal((await ready("acme/web#3", "http://localhost:47823")).status, 200);
  assert.deepEqual(w.calls, [["ready", "PR_acme/web_3"]]);
  const logged = t.desk.store.db.prepare("SELECT action FROM events WHERE item_id = 'acme/web#3' AND undone = 1").all();
  assert.deepEqual(
    logged.map((r) => r.action),
    ["ready"],
  );
  // GitHub says it's ready now: the call to action goes, and the rules place it from here.
  const it = t.gh.items.get("acme/web#3")!;
  t.gh.items.set(it.id, { ...it, draft: false, updated_at: hoursAgo(0) });
  await run(t.desk.sync());
  assert.equal(cta("web#3"), undefined);
});

test("Ready for review asks the reviewers you picked with it, after marking it ready, and logs both", async (c) => {
  const w = fakeWriter();
  const t = await setup([myPr(3, { ci: "green", draft: true }), myPr(4, { ci: "green", draft: true })], { desk: { writer: w.writer } });
  c.after(t.cleanup);
  await run(t.desk.sync());
  const post = client(t);
  const ready = (ref: string, body: unknown) => post(`/api/review/${encodeURIComponent(ref)}/ready`, body, "http://localhost:47823");
  assert.equal((await ready("acme/web#3", { users: "U_dana" })).status, 400, "a list of node ids, not one");
  assert.equal((await ready("acme/web#3", { users: [""] })).status, 400);
  assert.deepEqual(w.calls, []);
  const asked = await ready("acme/web#3", { users: ["U_dana"], teams: ["T_backend"] });
  assert.deepEqual([asked.status, await asked.json()], [200, { ok: true, done: true }]);
  assert.equal((await ready("acme/web#4", {})).status, 200, "nobody picked: only marked ready");
  assert.deepEqual(w.calls, [
    ["ready", "PR_acme/web_3"],
    ["request_reviews", "PR_acme/web_3", ["U_dana"], ["T_backend"]],
    ["ready", "PR_acme/web_4"],
  ]);
  const logged = t.desk.store.db.prepare("SELECT item_id, action FROM events WHERE undone = 1 ORDER BY seq").all();
  assert.deepEqual(
    logged.map((r) => `${String(r.item_id)} ${String(r.action)}`),
    ["acme/web#3 ready", "acme/web#3 request_reviews", "acme/web#4 ready"],
  );
});

test("a review request GitHub refuses after Ready for review says it's ready anyway", async (c) => {
  const w = fakeWriter(false, true);
  const t = await setup([myPr(3, { ci: "green", draft: true })], { desk: { writer: w.writer } });
  c.after(t.cleanup);
  await run(t.desk.sync());
  await assert.rejects(
    run(t.desk.markReady("web#3", { users: ["U_x"], teams: [] })),
    (e: Error & { status: number }) =>
      e.status === 502 && e.message === "Marked it ready, but GitHub didn't ask for the reviews: Could not resolve to a node",
  );
  const logged = t.desk.store.db.prepare("SELECT action FROM events WHERE item_id = 'acme/web#3' AND undone = 1").all();
  assert.deepEqual(
    logged.map((r) => r.action),
    ["ready"],
  );
  assert.equal(runSync(t.desk.item("web#3")).card.status, "active", "refused, so it's back on your desk");
});

test("Ready for review with nobody asked to review it isn't done: it stays out of the Archive and tops your desk with Add reviewers", async (c) => {
  const draft = { ci: "green" as const, draft: true };
  const t = await setup([myPr(3, { ...draft, review_requests: [] }), myPr(4, { ...draft, review_requests: [] }), myPr(5, draft)], {
    settings: { "policy.judge": false, "notify.quiet": "" },
    desk: { writer: fakeWriter().writer },
  });
  c.after(t.cleanup);
  await run(t.desk.sync());
  const card = (ref: string) => runSync(t.desk.item(ref)).card;
  const archive = () =>
    runSync(t.desk.queue())
      .cleared.map((x) => x.id)
      .sort();
  // GitHub has what the press wrote by the time the desk reads the PR again.
  const lands = (n: number, asked: Item["review_requests"] = []) => {
    const it = t.gh.items.get(`acme/web#${n}`)!;
    t.gh.items.set(it.id, { ...it, draft: false, review_requests: [...it.review_requests, ...asked], updated_at: hoursAgo(0) });
  };
  lands(3);
  const alone = await run(t.desk.markReady("web#3"));
  assert.deepEqual([card("web#3").status, archive()], ["active", []], "nobody's asked, so it isn't done");
  assert.deepEqual([card("web#3").cta, card("web#3").handed_back], ["reviewers", undefined], "a workflow may still ask someone");
  assert.deepEqual(alone, { done: false });

  lands(4, [{ reviewer: "sam", type: "user", codeowner: false }]);
  assert.deepEqual(await run(t.desk.markReady("web#4", { users: ["U_sam"], teams: [] })), { done: true }, "asked in the same press");
  lands(5);
  assert.deepEqual(await run(t.desk.markReady("web#5")), { done: true }, "dana was asked while it was a draft");
  assert.deepEqual([card("web#4").status, card("web#5").status, archive()], ["done", "done", ["acme/web#4", "acme/web#5"]]);

  t.setNow(new Date(NOW.getTime() + 11 * 60_000));
  await run(t.desk.sync());
  const top = runSync(t.desk.focus()).sections.now[0];
  assert.deepEqual(
    [top?.id, top?.group, top?.cta, card("web#3").why],
    ["acme/web#3", "back", "reviewers", "nobody's asked to review it: add reviewers"],
    "ten minutes on, it's on top of your desk",
  );
  assert.deepEqual(archive(), ["acme/web#4", "acme/web#5"]);
  assert.deepEqual(t.notes, ["web#3 · nobody's asked to review it: add reviewers"]);
});

test("reviewers to pick from are GitHub's for your own PR, without you; anyone else's PR has none", async (c) => {
  const t = await setup([reviewAsk(1), myPr(3, { draft: true })]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  t.gh.reviewerList = [
    { id: "U_dana", login: "dana", name: "Dana", team: false, suggested: true },
    { id: "U_me", login: "Me", name: "", team: false, suggested: false },
    { id: "T_backend", login: "backend", name: "Backend", team: true, suggested: false },
  ];
  const app = createApp(t.desk, 47823);
  const res = await app.request(`http://127.0.0.1:47823/api/reviewers/${encodeURIComponent("acme/web#3")}?q=%20da`);
  assert.equal(res.status, 200);
  assert.deepEqual(
    ((await res.json()) as { login: string }[]).map((r) => r.login),
    ["dana", "backend"],
  );
  assert.deepEqual(t.gh.reviewerCalls, ["acme/web#3 da"]);
  await assert.rejects(run(t.desk.reviewers("api#1", "")), (e: Error & { status: number }) => e.status === 409);
});

test("a refused Ready for review says why, and nothing is logged", async (c) => {
  const w = fakeWriter(true);
  const t = await setup([myPr(3, { ci: "green", draft: true })], { desk: { writer: w.writer } });
  c.after(t.cleanup);
  await run(t.desk.sync());
  await assert.rejects(run(t.desk.markReady("web#3")), /GitHub didn't mark it ready: Resource not accessible/);
  const t2 = await setup([myPr(3, { ci: "green", draft: true })]);
  c.after(t2.cleanup);
  await run(t2.desk.sync());
  assert.equal(runSync(t2.desk.item("web#3")).card.cta, undefined, "no writer, no call to action");
});

test("d on your own PR is plain done: it leaves the queue and comes back when someone else acts", async (c) => {
  const t = await setup([myPr(3, { ci: "red" })]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  const all = () =>
    Object.values(runSync(t.desk.queue()).sections)
      .flat()
      .map((x) => x.id);
  assert.ok(all().includes("acme/web#3"));
  const r = runSync(t.desk.act("web#3", "done"));
  assert.deepEqual([r.state.inflight_at, runSync(t.desk.inflight()).rows.length], [null, 0]);
  assert.ok(!all().includes("acme/web#3"));
  assert.ok(runSync(t.desk.queue()).cleared.some((x) => x.id === "acme/web#3"));
});

test("your ready PR nobody's asked to review tops your desk with Add reviewers; m refuses it; asking someone clears it", async (c) => {
  const w = fakeWriter();
  const green = { ci: "green" as const, review_requests: [] };
  const t = await setup([reviewAsk(1), myPr(3, green), myPr(4, { ...green, draft: true }), myPr(5, { ci: "green" })], {
    settings: { "policy.judge": false },
    desk: { writer: w.writer },
  });
  c.after(t.cleanup);
  await run(t.desk.sync());
  const card = (ref: string) => runSync(t.desk.item(ref)).card;
  assert.deepEqual(
    [card("web#3").cta, card("web#3").why, card("web#3").handed_back, card("web#3").bucket],
    ["reviewers", "nobody's asked to review it: add reviewers", true, "now"],
  );
  const top = runSync(t.desk.focus()).sections.now[0];
  assert.deepEqual([top?.id, top?.group, top?.stage], ["acme/web#3", "back", "waiting for review"], "on top; nobody handed it back");
  assert.equal(card("web#4").cta, "ready", "a draft: Ready for review comes first");
  assert.equal(card("web#5").cta, undefined, "dana's asked");
  assert.throws(() => runSync(t.desk.act("web#3", "inflight")), /nobody's asked to review acme\/web#3: add reviewers first/);

  const post = client(t);
  const desk = "http://localhost:47823";
  const ask = (ref: string, body: unknown, origin?: string) => post(`/api/review/${encodeURIComponent(ref)}/reviewers`, body, origin);
  assert.equal((await ask("acme/web#3", { users: ["U_dana"] })).status, 403, "MCP and the CLI can't");
  assert.equal((await ask("acme/web#3", {}, desk)).status, 400, "nobody picked");
  assert.equal((await ask("acme/web#3", { users: [1] }, desk)).status, 400);
  assert.equal((await ask("acme/web#4", { users: ["U_dana"] }, desk)).status, 409, "a draft: Ready for review asks them");
  assert.equal((await ask("acme/api#1", { users: ["U_dana"] }, desk)).status, 409, "not yours");
  assert.deepEqual(w.calls, []);
  assert.equal((await ask("acme/web#3", { users: ["U_dana"], teams: ["T_backend"] }, desk)).status, 200);
  assert.deepEqual(w.calls, [["request_reviews", "PR_acme/web_3", ["U_dana"], ["T_backend"]]]);
  assert.equal(card("web#3").status, "done", "your part is done until someone reviews");
  assert.equal(
    [...runSync(t.desk.focus()).sections.now, ...runSync(t.desk.focus()).sections.today].some((x) => x.id === "acme/web#3"),
    false,
    "off your desk",
  );

  // GitHub has the request: nothing to ask any more.
  t.gh.items.set("acme/web#3", { ...myPr(3, { ci: "green" }), updated_at: hoursAgo(0) });
  await run(t.desk.sync());
  assert.deepEqual([card("web#3").cta, card("web#3").handed_back], [undefined, undefined]);
});

test("a review someone left counts as asked; a bot's or your own doesn't", async (c) => {
  const review = (author: string, bot = false) => ({ author, author_bot: bot, state: "commented" as const, at: hoursAgo(1), commit: "c1" });
  const t = await setup(
    [
      myPr(3, { ci: "green", review_requests: [], reviews: [review("marco")] }),
      myPr(4, { ci: "green", review_requests: [], reviews: [review("cursor", true), review("me")] }),
    ],
    { settings: { "policy.judge": false } },
  );
  c.after(t.cleanup);
  await run(t.desk.sync());
  assert.equal(runSync(t.desk.item("web#3")).card.handed_back, undefined);
  assert.equal(runSync(t.desk.item("web#4")).card.why, "nobody's asked to review it: add reviewers");
});

test("a PR in Merging nobody's asked to review any more comes back to you on the next sync, with Add reviewers", async (c) => {
  const t = await setup([myPr(3, { ci: "green" })], {
    settings: { "policy.judge": false, "notify.quiet": "" },
    desk: { writer: fakeWriter().writer },
  });
  c.after(t.cleanup);
  await run(t.desk.sync());
  runSync(t.desk.act("web#3", "inflight"));
  assert.equal(runSync(t.desk.item("web#3")).card.inflight, true);
  t.gh.items.set("acme/web#3", { ...myPr(3, { ci: "green", review_requests: [] }), updated_at: hoursAgo(0.05) });
  await run(t.desk.sync());
  assert.equal(runSync(t.desk.item("web#3")).card.inflight, true, "a few minutes: a workflow may be asking someone");
  t.setNow(new Date(NOW.getTime() + 30 * 60_000));
  await run(t.desk.sync());
  const d = runSync(t.desk.item("web#3"));
  assert.deepEqual(
    [d.card.inflight, d.card.handed_back, d.card.cta, d.card.why],
    [false, true, "reviewers", "handed back: nobody's asked to review it: add reviewers"],
  );
  const by = t.desk.store.db.prepare("SELECT agent FROM events WHERE item_id = 'acme/web#3' AND action = 'takeback'").all();
  assert.deepEqual(
    by.map((r) => r.agent),
    ["desk"],
    "the desk's, not an agent's",
  );
  assert.equal(
    runSync(t.desk.inflight()).rows.some((r) => r.card.id === "acme/web#3" && r.state === "open"),
    false,
    "out of Merging",
  );
});

test("what counts as asked: a bot's request or review doesn't, one GitHub hides from you does; nor does a listed bot", async (c) => {
  const green = { ci: "green" as const, review_requests: [] };
  const t = await setup(
    [
      myPr(3, { ...green, review_requests: [{ reviewer: "copilot-pull-request-reviewer", type: "user", codeowner: false, bot: true }] }),
      myPr(4, { ...green, review_requests_hidden: 1 }),
      myPr(5, { ...green, reviews: [{ author: "sentry-review", author_bot: false, state: "commented", at: hoursAgo(1), commit: "c1" }] }),
    ],
    { settings: { "policy.judge": false, "github.bots": ["sentry-review"] } },
  );
  c.after(t.cleanup);
  await run(t.desk.sync());
  const unasked = (ref: string) => runSync(t.desk.item(ref)).signals.pr.unasked;
  assert.deepEqual([unasked("web#3"), unasked("web#4"), unasked("web#5")], [true, false, true]);
});

test("nobody's asked: not while a workflow may still ask, not once it's quiet, not when no board lists it; Reply doesn't hide it", async (c) => {
  const green = { ci: "green" as const, review_requests: [] };
  const say = { author: "marco", author_bot: false, at: hoursAgo(1) };
  const t = await setup(
    [
      myPr(3, { ...green, updated_at: hoursAgo(0.05) }),
      myPr(4, { ...green, updated_at: hoursAgo(40 * 24), created_at: hoursAgo(40 * 24) }),
      myPr(5, { ...green, comments: [say] }),
    ],
    { settings: { "policy.judge": false, "notify.quiet": "" }, desk: { writer: fakeWriter().writer } },
  );
  c.after(t.cleanup);
  await run(t.desk.sync());
  const card = (ref: string) => runSync(t.desk.item(ref)).card;
  assert.equal(card("web#3").handed_back, undefined, "minutes old");
  assert.equal(card("web#4").handed_back, undefined, "quiet for 40 days: Later has it");
  assert.equal(card("web#5").cta, "reviewers", "a comment waits on you, but nobody would review your answer");
  const row = [...runSync(t.desk.focus()).sections.now, ...runSync(t.desk.focus()).sections.today].find((x) => x.id === "acme/web#5");
  assert.equal(row?.cta, "reviewers");

  t.gh.route = () => []; // it left every search: nothing refreshes it any more
  await run(t.desk.sync());
  assert.equal(card("web#5").handed_back, undefined, "no board lists it");
});

test("Add reviewers and m's refusal agree, from the first minute; quiet is Later's: no update in quiet_days, not age", async (c) => {
  const green = { ci: "green" as const, review_requests: [] };
  const t = await setup(
    [myPr(3, { ...green, updated_at: hoursAgo(0.05) }), myPr(4, { ...green, created_at: hoursAgo(20 * 24), updated_at: hoursAgo(1) })],
    { settings: { "policy.judge": false }, desk: { writer: fakeWriter().writer } },
  );
  c.after(t.cleanup);
  await run(t.desk.sync());
  const card = (ref: string) => runSync(t.desk.item(ref)).card;
  assert.deepEqual([card("web#3").cta, card("web#3").handed_back], ["reviewers", undefined], "not on top yet, but it says what m needs");
  assert.throws(() => runSync(t.desk.act("web#3", "inflight")), /add reviewers first/);
  assert.deepEqual([card("web#4").cta, card("web#4").handed_back], ["reviewers", true], "20 days old, pushed to an hour ago");
});

test("on a bot's PR opened for you, your own review doesn't count as anyone reviewing it", async (c) => {
  const t = await setup([], { settings: { "policy.judge": false } });
  c.after(t.cleanup);
  await run(t.desk.sync());
  const mine = { author: "me", author_bot: false, state: "commented" as const, at: hoursAgo(1), commit: "c1" };
  t.gh.items.set(
    "acme/web#8",
    makeItem({ number: 8, repo: "acme/web", author: "junior[bot]", author_bot: true, via: "@me", ci: "green", reviews: [mine] }),
  );
  await run(t.desk.add("acme/web#8"));
  const s = runSync(t.desk.item("web#8")).signals;
  assert.deepEqual([s.me.author, s.pr.unasked], [true, true]);
});

test("a blocked PR in Merging waits on its blocker, and the coordinator is woken 'unblocked: \u2026 merged'", async (c) => {
  const approved = { author: "kofi", author_bot: false, trusted: true, state: "approved" as const, at: hoursAgo(45), commit: "abc" };
  const t = await setup(
    [
      myPr(1, {
        repo: "getsentry/getsentry",
        ci: "green",
        review_decision: "approved",
        reviews: [approved],
        requires: ["getsentry/sentry#129460"],
      }),
      myPr(129460, { repo: "getsentry/sentry", ci: "green" }),
    ],
    { settings: { "policy.judge": false } },
  );
  c.after(t.cleanup);
  const woke: [string, string][] = [];
  t.desk.coordinator.wake = (id, what) => {
    woke.push([id, what]);
  };
  await run(t.desk.sync());
  runSync(t.desk.act("getsentry#1", "inflight"));
  const row = runSync(t.desk.inflight()).rows[0]!;
  assert.deepEqual(
    [row.waits_on, row.blocked_by],
    ["waits on sentry#129460 to merge first", { ref: "sentry#129460", waits: "waits on a review from dana" }],
  );
  const at = new Date(NOW.getTime() + 3_600_000).toISOString();
  const dep = t.gh.items.get("getsentry/sentry#129460")!;
  t.gh.items.set(dep.id, { ...dep, state: "merged", closed_at: at, updated_at: at });
  t.setNow(new Date(at));
  await run(t.desk.sync());
  assert.deepEqual(
    woke.filter(([, what]) => what.startsWith("unblocked")),
    [["getsentry/getsentry#1", "unblocked: sentry#129460 merged"]],
  );
  assert.equal(runSync(t.desk.inflight()).rows[0]!.waits_on, "ready to merge");
});

test("a Merging PR whose required PR closed without merging says so, and the coordinator is woken with it, not 'unblocked'", async (c) => {
  const approved = { author: "kofi", author_bot: false, trusted: true, state: "approved" as const, at: hoursAgo(45), commit: "abc" };
  const t = await setup(
    [
      myPr(9, { ci: "green", review_decision: "approved", reviews: [approved], requires: ["acme/api#5"] }),
      myPr(5, { repo: "acme/api", ci: "green" }),
    ],
    { settings: { "policy.judge": false } },
  );
  c.after(t.cleanup);
  const woke: [string, string][] = [];
  t.desk.coordinator.wake = (id, what) => {
    woke.push([id, what]);
  };
  await run(t.desk.sync());
  runSync(t.desk.act("web#9", "inflight"));
  woke.length = 0;
  const at = new Date(NOW.getTime() + 3_600_000).toISOString();
  t.gh.items.set("acme/api#5", { ...t.gh.items.get("acme/api#5")!, state: "closed", closed_at: at, updated_at: at });
  t.setNow(new Date(at));
  await run(t.desk.sync());
  const row = runSync(t.desk.inflight()).rows.find((r) => r.card.id === "acme/web#9")!;
  assert.deepEqual([row.waits_on, row.requires_closed], ["needs api#5, closed without merging", ["api#5"]]);
  assert.deepEqual(woke, [["acme/web#9", "needs api#5, closed without merging"]]);
});
