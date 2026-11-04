// Merging (in flight): m on your own PR, the Merging tab (never the queue), the coordinator's notes and hand-backs, and Ready
// for review on your own draft (a GitHub write).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.ts";
import type { GitHubWriter } from "../src/github/write.ts";
import { REBASE } from "../src/coordinator.ts";
import type { Item } from "../src/types.ts";
import { myPr, reviewAsk, setup } from "./helpers/desk.ts";
import { hoursAgo } from "./helpers/items.ts";
import { refuseWrites } from "./helpers/writer.ts";

function fakeWriter(refuse = false, refuseReviews = false) {
  const calls: (string | string[])[][] = [];
  const writer: GitHubWriter = {
    ...refuseWrites(),
    ready: (pr) => {
      calls.push(["ready", pr]);
      return refuse ? Promise.reject(new Error("Resource not accessible")) : Promise.resolve();
    },
    requestReviews: (pr, users, teams) => {
      calls.push(["request_reviews", pr, users, teams]);
      return refuseReviews ? Promise.reject(new Error("Could not resolve to a node")) : Promise.resolve();
    },
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
  await t.desk.sync();
  const all = () => {
    const q = t.desk.queue();
    return [...Object.values(q.sections).flat(), ...q.hidden, ...q.cleared, ...q.resolved].map((x) => x.id);
  };
  assert.ok(all().includes("acme/web#3"));
  const r = t.desk.act("web#3", "inflight");
  assert.ok(r.state.inflight_at);
  assert.ok(!all().includes("acme/web#3"));
  assert.deepEqual(
    t.desk.inflight().rows.map((x) => [x.card.id, x.card.inflight, x.waits_on, x.note]),
    [["acme/web#3", true, "waits on CI", null]],
  );
  assert.deepEqual(t.desk.overview().inflight, { total: 1 });
  assert.throws(() => t.desk.act("web#3", "inflight"), /in Merging already/);
  t.desk.undo(r.undo_seq);
  assert.ok(all().includes("acme/web#3"));
  assert.equal(t.desk.inflight().rows.length, 0);
  t.desk.act("web#3", "inflight");
  const back = t.desk.act("web#3", "takeback");
  assert.equal(back.state.inflight_at, null);
  assert.ok(all().includes("acme/web#3"));
  t.desk.undo(back.undo_seq);
  assert.equal(t.desk.inflight().rows.length, 1);
  assert.throws(() => t.desk.undo(undefined, "agent"), /in the desk's window/);
});

test("only the desk's own window hands a PR off or undoes a hand-off or Back to desk: the coordinator merges what's there", async (c) => {
  const t = await setup([myPr(3, { ci: "pending" })]);
  c.after(t.cleanup);
  await t.desk.sync();
  const post = client(t);
  const desk = "http://localhost:47823";
  const act = (action: string, origin?: string, site?: string) => post("/api/act", { id: "acme/web#3", action }, origin, site);
  assert.equal((await act("inflight")).status, 403, "curl, the CLI or an agent");
  assert.equal((await act("inflight", desk, "none")).status, 403, "an Origin alone isn't the desk's page");
  assert.equal(t.desk.inflight().rows.length, 0);
  assert.equal((await act("inflight", desk)).status, 200);
  const back = (await (await act("takeback", desk)).json()) as { undo_seq: number };
  assert.equal((await post("/api/undo", { seq: back.undo_seq })).status, 409, "an agent can't put it back in Merging");
  assert.equal((await act("undo")).status, 409, "nor through /api/act");
  assert.equal(t.desk.inflight().rows.length, 0);
  assert.equal((await post("/api/undo", { seq: back.undo_seq }, desk)).status, 200);
  assert.equal(t.desk.inflight().rows.length, 1);
});

test("a draft isn't handed off: Ready for review is yours, so it would wait on you in Merging", async (c) => {
  const t = await setup([myPr(3, { ci: "green", draft: true })]);
  c.after(t.cleanup);
  await t.desk.sync();
  assert.throws(
    () => t.desk.act("web#3", "inflight"),
    (e: Error & { status: number }) => e.status === 409 && e.message.includes("mark it ready first (a a)"),
  );
  assert.equal(t.desk.inflight().rows.length, 0);
});

test("a PR in Merging stays there whatever it waits on: never in the queue, focus or the status line", async (c) => {
  const ready = { ci: "green" as const, review_decision: "approved" as const, mergeable: "clean" as const };
  const t = await setup([reviewAsk(1), myPr(3, { ci: "red" }), myPr(4, ready), myPr(5, { ci: "pending" })]);
  c.after(t.cleanup);
  await t.desk.sync();
  for (const n of [3, 4, 5]) t.desk.act(`web#${n}`, "inflight");
  const q = t.desk.queue();
  const shown = [q.sections, t.desk.focus().sections].flatMap((x) => Object.values(x).flat());
  assert.deepEqual([...new Set([...shown, ...q.hidden, ...q.cleared, ...q.resolved].map((x) => x.id))], ["acme/api#1"]);
  assert.equal(t.desk.status().text, "desk 1");
  assert.deepEqual([t.desk.item("web#3").card.bucket, t.desk.item("web#3").card.why], ["fyi", "merging"]);
  assert.deepEqual(t.desk.overview().inflight, { total: 3 });
});

test("only your own open PRs are handed off for merge", async (c) => {
  const t = await setup([reviewAsk(1), myPr(3)]);
  c.after(t.cleanup);
  await t.desk.sync();
  assert.throws(
    () => t.desk.act("api#1", "inflight"),
    (e: Error & { status: number }) => e.status === 409 && e.message.includes("your own open PRs"),
  );
  assert.throws(() => t.desk.act("web#3", "takeback"), /isn't in Merging/);
});

test("in Merging, the coordinator owns it: done, snooze and mute are refused, and the judge leaves it alone", async (c) => {
  process.env.DESK_CLAUDE = "/nonexistent/claude";
  const t = await setup([myPr(3, { ci: "pending" })]);
  c.after(t.cleanup);
  await t.desk.sync();
  // Muted before you handed it off: handing off clears that.
  const muted = t.desk.act("web#3", "mute");
  const marked = t.desk.act("web#3", "inflight");
  assert.equal(marked.state.muted, false);
  for (const action of ["done", "snooze", "mute"] as const)
    assert.throws(
      () => t.desk.act("web#3", action),
      (e: Error & { status: number }) => e.status === 409 && e.message.includes("back to the desk (b)"),
    );
  // Undoing the hand-off brings back the mute.
  t.desk.undo(marked.undo_seq);
  assert.equal(t.desk.store.state("acme/web#3").muted, true);
  t.desk.undo(muted.undo_seq);
  t.desk.act("web#3", "inflight");
  t.desk.putPolicy("Waiting PRs are fyi.");
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
    myPr(9, { ...green, reviews: [outsider] }),
  ]);
  c.after(t.cleanup);
  await t.desk.sync();
  for (let n = 1; n <= 9; n++) t.desk.act(`web#${n}`, "inflight");
  const waits = Object.fromEntries(t.desk.inflight().rows.map((r) => [r.card.number, r.waits_on]));
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
  assert.deepEqual(t.desk.inflight().rows.find((r) => r.card.number === 9)!.approved_by, [], "the coordinator merges on it");
  assert.deepEqual(t.desk.inflight().rows.find((r) => r.card.number === 7)!.stacked, true, "the coordinator sees it sits on another PR");
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
  t.desk.coordinator.stop = async () => {};
  await t.desk.sync();
  let step = 0;
  const update = async (n: number, o: Partial<Item>) => {
    const it = t.gh.items.get(`acme/web#${n}`)!;
    t.gh.items.set(it.id, { ...it, ...o, updated_at: hoursAgo(1 - ++step / 10) });
    await t.desk.sync();
  };
  const main = () =>
    Object.values(t.desk.focus().sections)
      .flat()
      .map((x) => [x.id, x.why]);
  const merging = () => t.desk.inflight().rows.map((r) => [r.card.id, r.waits_on, r.rebase]);
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
  await t.desk.sync();
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
  t.desk.handBack("web#3", "can't rebase cleanly: both change the retry schedule");
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
  t.desk.putSettings({ set: { "agent.coordinator": true } });
  await t.desk.sync();
  assert.deepEqual(t.merging(), [["acme/web#3", "rebasing", true]]);
  t.desk.putSettings({ set: { "agent.coordinator": false } });
  await t.desk.sync();
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
  await t.desk.sync();
  assert.deepEqual(t.woke, [["acme/web#3", REBASE]], "not #5, quiet in Later");
});

test("CI that never ran doesn't hold a conflicting PR back: GitHub runs none on one", async (c) => {
  const t = await conflicts(c);
  t.desk.act("web#4", "pin");
  await t.update(4, { review_decision: "approved", ci: "pending", mergeable: "conflict" });
  assert.deepEqual(t.woke, [["acme/web#4", REBASE]]);
});

test("your handed-off PR's conflict stays the coordinator's to merge; one it hands back or you bring back stays yours", async (c) => {
  const t = await conflicts(c);
  t.desk.act("web#3", "inflight");
  await t.update(3, { mergeable: "conflict" });
  assert.deepEqual(t.merging(), [["acme/web#3", "waits on a merge conflict fix", false]]);
  t.desk.handBack("web#3", "can't rebase cleanly");
  await t.update(3, { comments_total: 1 });
  assert.deepEqual(t.main(), [["acme/web#3", "handed back: can't rebase cleanly"]]);
  t.desk.act("web#3", "inflight");
  t.desk.act("web#3", "takeback");
  await t.update(3, { comments_total: 2 });
  assert.deepEqual(t.merging(), []);
  assert.deepEqual(t.main(), [["acme/web#3", "approved and green: ready to merge"]]);
  assert.ok(!t.woke.some(([, what]) => what === REBASE));
});

test("desk_note: the coordinator's latest line on a PR in Merging shows on its row; m again starts without it", async (c) => {
  const t = await setup([reviewAsk(1), myPr(3, { ci: "pending" })]);
  c.after(t.cleanup);
  await t.desk.sync();
  const post = client(t);
  const id = encodeURIComponent("acme/web#3");
  assert.equal((await post(`/api/inflight/${id}/note`, { text: "Fixing lint" })).status, 409, "not in Merging yet");
  t.desk.act("web#3", "inflight");
  assert.equal((await post(`/api/inflight/${id}/note`, { text: "Fixing lint" })).status, 200, "local only, so agents may");
  t.setNow(new Date(Date.parse(hoursAgo(0)) + 60_000));
  assert.equal((await post(`/api/inflight/${id}/note`, { text: "Pushed\nabc1234,\tCI running" })).status, 200);
  assert.deepEqual(t.desk.inflight().rows[0]!.note, {
    text: "Pushed abc1234, CI running",
    at: new Date(Date.parse(hoursAgo(0)) + 60_000).toISOString(),
  });
  assert.equal((await post(`/api/inflight/${id}/note`, { text: "  " })).status, 400);
  assert.equal((await post(`/api/inflight/${id}/note`, {})).status, 400);
  assert.equal((await post(`/api/inflight/${encodeURIComponent("acme/api#1")}/note`, { text: "x" })).status, 409, "not yours");
  t.desk.act("web#3", "takeback");
  t.desk.act("web#3", "inflight");
  assert.equal(t.desk.inflight().rows[0]!.note, null);
});

test("desk_hand_back: the PR leaves Merging for the top of Now with the why, writes nothing, and notifies", async (c) => {
  const w = fakeWriter();
  const t = await setup([reviewAsk(1), myPr(3, { ci: "pending" }), myPr(4, { ci: "pending" })], {
    settings: { "notify.quiet": "" },
    desk: { writer: w.writer },
  });
  c.after(t.cleanup);
  await t.desk.sync();
  t.desk.act("web#3", "inflight");
  t.desk.act("web#4", "inflight");
  t.desk.notifyNew();
  const post = client(t);
  const res = await post(`/api/inflight/${encodeURIComponent("acme/web#3")}/handback`, { why: "Dana wants the cache\nredesigned first" });
  assert.equal(res.status, 200);
  assert.deepEqual(w.calls, [], "a hand-back writes nothing to GitHub");
  assert.equal(t.desk.store.state("acme/web#3").inflight_at, null);
  assert.deepEqual(
    t.desk.inflight().rows.map((r) => r.card.id),
    ["acme/web#4"],
  );
  const [top] = t.desk.queue().sections.now;
  assert.deepEqual(
    [top?.id, top?.why, top?.handed_back, top?.inflight],
    ["acme/web#3", "handed back: Dana wants the cache redesigned first", true, false],
  );
  assert.deepEqual(t.notes, ["web#3 · handed back: Dana wants the cache redesigned first"]);
  assert.equal((await post(`/api/inflight/${encodeURIComponent("acme/web#3")}/handback`, { why: "again" })).status, 409);
  // Done puts it away for good; m again starts afresh.
  t.setNow(new Date(Date.parse(hoursAgo(0)) + 60_000));
  t.desk.act("web#3", "done");
  assert.ok(!t.desk.queue().sections.now.some((x) => x.id === "acme/web#3"));
  t.desk.act("web#3", "restore");
  t.desk.act("web#3", "inflight");
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
  await t.desk.sync();
  const cta = (ref: string) => t.desk.item(ref).card.cta;
  assert.deepEqual(
    [cta("web#3"), cta("web#4"), cta("api#1"), cta("web#5")],
    ["ready", undefined, undefined, undefined],
    "a red draft is finished first",
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
  await t.desk.sync();
  assert.equal(cta("web#3"), undefined);
});

test("Ready for review asks the reviewers you picked with it, after marking it ready, and logs both", async (c) => {
  const w = fakeWriter();
  const t = await setup([myPr(3, { ci: "green", draft: true }), myPr(4, { ci: "green", draft: true })], { desk: { writer: w.writer } });
  c.after(t.cleanup);
  await t.desk.sync();
  const post = client(t);
  const ready = (ref: string, body: unknown) => post(`/api/review/${encodeURIComponent(ref)}/ready`, body, "http://localhost:47823");
  assert.equal((await ready("acme/web#3", { users: "U_dana" })).status, 400, "a list of node ids, not one");
  assert.equal((await ready("acme/web#3", { users: [""] })).status, 400);
  assert.deepEqual(w.calls, []);
  assert.equal((await ready("acme/web#3", { users: ["U_dana"], teams: ["T_backend"] })).status, 200);
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
  await t.desk.sync();
  await assert.rejects(
    t.desk.markReady("web#3", { users: ["U_x"], teams: [] }),
    (e: Error & { status: number }) =>
      e.status === 502 && e.message === "Marked it ready, but GitHub didn't ask for the reviews: Could not resolve to a node",
  );
  const logged = t.desk.store.db.prepare("SELECT action FROM events WHERE item_id = 'acme/web#3' AND undone = 1").all();
  assert.deepEqual(
    logged.map((r) => r.action),
    ["ready"],
  );
});

test("reviewers to pick from are GitHub's for your own PR, without you; anyone else's PR has none", async (c) => {
  const t = await setup([reviewAsk(1), myPr(3, { draft: true })]);
  c.after(t.cleanup);
  await t.desk.sync();
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
  await assert.rejects(t.desk.reviewers("api#1", ""), (e: Error & { status: number }) => e.status === 409);
});

test("a refused Ready for review says why, and nothing is logged", async (c) => {
  const w = fakeWriter(true);
  const t = await setup([myPr(3, { ci: "green", draft: true })], { desk: { writer: w.writer } });
  c.after(t.cleanup);
  await t.desk.sync();
  await assert.rejects(t.desk.markReady("web#3"), /GitHub didn't mark it ready: Resource not accessible/);
  const t2 = await setup([myPr(3, { ci: "green", draft: true })]);
  c.after(t2.cleanup);
  await t2.desk.sync();
  assert.equal(t2.desk.item("web#3").card.cta, undefined, "no writer, no call to action");
});

test("d on your own PR is plain done: it leaves the queue and comes back when someone else acts", async (c) => {
  const t = await setup([myPr(3, { ci: "red" })]);
  c.after(t.cleanup);
  await t.desk.sync();
  const all = () =>
    Object.values(t.desk.queue().sections)
      .flat()
      .map((x) => x.id);
  assert.ok(all().includes("acme/web#3"));
  const r = t.desk.act("web#3", "done");
  assert.deepEqual([r.state.inflight_at, t.desk.inflight().rows.length], [null, 0]);
  assert.ok(!all().includes("acme/web#3"));
  assert.ok(t.desk.queue().cleared.some((x) => x.id === "acme/web#3"));
});
