// Merging (in flight): m on your own PR, the Merging tab and what waits on you there (never in the queue), drafts, questions and
// hand-backs from agents, Send and auto-merge (the GitHub writes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.ts";
import type { GitHubWriter } from "../src/github/write.ts";
import type { PrContext } from "../src/github/index.ts";
import { myPr, reviewAsk, setup } from "./helpers/desk.ts";
import { hoursAgo } from "./helpers/items.ts";

// Babysitting stays off here: these tests are about the lane and the queue, not runs (babysit.test.ts has those).
const OFF = { "inflight.babysit": false };

function fakeWriter(refuse = "") {
  const calls: string[][] = [];
  const done = (...call: string[]) => {
    calls.push(call);
    return call[0] === refuse ? Promise.reject(new Error("Pull request is in clean status")) : Promise.resolve();
  };
  const writer: GitHubWriter = {
    approve: () => Promise.reject(new Error("no approvals here")),
    reply: (thread, body) => {
      calls.push(["reply", thread, body]);
      return Promise.resolve({ url: "https://github.com/acme/web/pull/3#discussion_r1" });
    },
    comment: (pr, body) => {
      calls.push(["comment", pr, body]);
      return Promise.resolve({ url: "https://github.com/acme/web/pull/3#issuecomment-1" });
    },
    ready: (pr) => done("ready", pr),
    autoMerge: (pr, method) => done("auto_merge", pr, method),
    autoMergeOff: (pr) => done("auto_merge_off", pr),
  };
  return { writer, calls };
}

const CTX: PrContext = {
  threads: [
    {
      id: "PRRT_open",
      resolved: false,
      outdated: false,
      path: "src/api.ts",
      line: 12,
      comments: [{ author: "dana", bot: false, trusted: true, body: "Should this retry?\nIt fails on 502s.", at: hoursAgo(2) }],
    },
    {
      id: "PRRT_done",
      resolved: true,
      outdated: false,
      path: "src/b.ts",
      line: 3,
      comments: [{ author: "dana", bot: false, trusted: true, body: "ok", at: hoursAgo(9) }],
    },
  ],
  reviews: [],
  comments: [],
  checks: [],
};

test("a hand-off puts your own open PR in Merging: it leaves the queue, and undo brings it back", async (c) => {
  const t = await setup([reviewAsk(1), myPr(3, { ci: "pending" })], { settings: OFF });
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
  const lane = t.desk.inflight().rows;
  assert.deepEqual(
    lane.map((x) => [x.card.id, x.card.inflight, x.needs_you, x.sitter.text]),
    [["acme/web#3", true, null, ""]],
    "babysitting is off here, so nothing is watching it",
  );
  assert.deepEqual(t.desk.overview().inflight, { total: 1, needs_you: 0 });
  assert.throws(() => t.desk.act("web#3", "inflight"), /in Merging already/);
  t.desk.undo(r.undo_seq);
  assert.ok(all().includes("acme/web#3"));
  assert.equal(t.desk.inflight().rows.length, 0);
  // Back to desk, which undo can also reverse.
  t.desk.act("web#3", "inflight");
  const back = t.desk.act("web#3", "takeback");
  assert.equal(back.state.inflight_at, null);
  assert.ok(all().includes("acme/web#3"));
  t.desk.undo(back.undo_seq);
  assert.equal(t.desk.inflight().rows.length, 1);
});

test("whatever a PR in Merging waits on you for, it stays there: never in the queue, focus or the status line, and counted", async (c) => {
  const ready = { ci: "green" as const, review_decision: "approved" as const, mergeable: "clean" as const };
  const t = await setup(
    [reviewAsk(1), myPr(3, { ci: "pending" }), myPr(4, { ci: "pending" }), myPr(5, ready), myPr(6, { ci: "pending" })],
    {
      settings: OFF,
    },
  );
  c.after(t.cleanup);
  await t.desk.sync();
  for (const n of [3, 4, 5, 6]) t.desk.act(`web#${n}`, "inflight");
  t.desk.escalate("web#3", "Keep v1?");
  await t.desk.draftReply("web#4", null, "Rebased on main.");
  const q = t.desk.queue();
  const shown = [q.sections, t.desk.focus().sections].flatMap((x) => Object.values(x).flat());
  assert.deepEqual([...new Set([...shown, ...q.hidden, ...q.cleared, ...q.resolved].map((x) => x.id))], ["acme/api#1"]);
  assert.equal(t.desk.status().text, "desk 1 ●1");
  assert.deepEqual(t.desk.overview().inflight, { total: 4, needs_you: 3 });
  assert.deepEqual(
    t.desk.inflight().rows.map((r) => !!r.needs_you),
    [true, true, true, false],
    "what waits on you first",
  );
});

test("only your own open PRs are handed off for merge", async (c) => {
  const t = await setup([reviewAsk(1), myPr(3)], { settings: OFF });
  c.after(t.cleanup);
  await t.desk.sync();
  assert.throws(
    () => t.desk.act("api#1", "inflight"),
    (e: Error & { status: number }) => e.status === 409 && e.message.includes("your own open PRs"),
  );
  assert.throws(() => t.desk.act("web#3", "takeback"), /isn't in Merging/);
});

test("in Merging, Claude owns it: done, snooze and mute are refused, and the judge and coordinator leave it alone", async (c) => {
  process.env.DESK_CLAUDE = "/nonexistent/claude";
  const t = await setup([myPr(3, { ci: "pending" })], { settings: OFF });
  c.after(t.cleanup);
  await t.desk.sync();
  // Muted before you marked it: marking clears that, so its questions reach you.
  const muted = t.desk.act("web#3", "mute");
  const marked = t.desk.act("web#3", "inflight");
  assert.equal(marked.state.muted, false);
  t.desk.escalate("web#3", "Keep v1 or bump?");
  for (const action of ["done", "snooze", "mute"] as const)
    assert.throws(
      () => t.desk.act("web#3", action, undefined, { agent: "coordinator", reason: "policy" }),
      (e: Error & { status: number }) => e.status === 409 && e.message.includes("back to the desk (b)"),
    );
  assert.deepEqual(t.desk.focus().sections, { now: [], today: [] }, "Merging has it, question and all");
  assert.equal(t.desk.overview().inflight.needs_you, 1);
  // Undoing the mark brings back the mute.
  t.desk.undo(marked.undo_seq);
  assert.equal(t.desk.store.state("acme/web#3").muted, true);
  t.desk.undo(muted.undo_seq);
  t.desk.act("web#3", "inflight");

  // Its comments and red CI are the babysitter's to act on, and the judge doesn't ask about it.
  t.desk.putPolicy("Waiting PRs are fyi.");
  assert.ok(!t.desk.judge.queue().some((g) => g.item.id === "acme/web#3"));
  const cursor = t.desk.store.lastSeq();
  const it = t.gh.items.get("acme/web#3")!;
  t.gh.items.set(it.id, {
    ...it,
    updated_at: hoursAgo(0.5),
    ci: "red",
    comments: [{ author: "dana", author_bot: false, at: hoursAgo(0.5) }],
  });
  await t.desk.sync();
  assert.ok(t.desk.store.activity({ after: cursor, limit: 10 }).some((e) => e.kind === "commented"));
  assert.deepEqual(t.desk.coordinator.pending(cursor), []);
});

test("with Claude off, a PR in Merging waits on you there when CI fails and when it's ready to merge, never in the queue", async (c) => {
  const t = await setup(
    [myPr(3, { ci: "red" }), myPr(4, { ci: "green", review_decision: "approved", mergeable: "clean" }), myPr(5, { ci: "pending" })],
    {
      settings: OFF,
    },
  );
  c.after(t.cleanup);
  await t.desk.sync();
  for (const n of [3, 4, 5]) t.desk.act(`web#${n}`, "inflight");
  assert.deepEqual(Object.values(t.desk.queue().sections).flat(), []);
  assert.deepEqual(
    t.desk.inflight().rows.map((r) => [r.card.id, r.needs_you]),
    [
      ["acme/web#3", "CI failing"],
      ["acme/web#4", "ready to merge"],
      ["acme/web#5", null],
    ],
    "what waits on you first",
  );
  // Its review and detail say so, as Merging does, and stay out of Now whatever its boards would say.
  assert.deepEqual(
    [t.desk.item("web#3").card.bucket, t.desk.item("web#3").card.why, t.desk.item("web#5").card.why],
    ["fyi", "merging: CI failing", "merging"],
  );
  assert.deepEqual(t.desk.overview().inflight, { total: 3, needs_you: 2 });
  assert.deepEqual([t.desk.overview().focus.now, t.desk.overview().focus.today, t.desk.status().text], [0, 0, ""]);
});

test("desk_escalate: the PR waits on you in Merging with the question as its why, notifies, and x dismisses it", async (c) => {
  const t = await setup([myPr(3, { ci: "pending" })], { settings: { ...OFF, "notify.quiet": "" } });
  c.after(t.cleanup);
  await t.desk.sync();
  t.desk.act("web#3", "inflight");
  t.desk.notifyNew(); // the baseline, as after a sync
  assert.throws(() => t.desk.escalate("web#9", "x?"), /no item/);
  const r = t.desk.escalate("web#3", "  Bump the API version,\nor keep v1 compatible?  ");
  assert.equal(r.question, "Bump the API version, or keep v1 compatible?");
  assert.equal(t.desk.queue().sections.now.length, 0);
  assert.equal(t.desk.item("web#3").card.why, "your agent asks: Bump the API version, or keep v1 compatible?", "who asks");
  assert.equal(t.desk.inflight().rows[0]?.sitter.text, "needs you: Bump the API version, or keep v1 compatible?");
  assert.equal(t.desk.overview().inflight.needs_you, 1);
  assert.deepEqual(t.notes, ["web#3 · your agent asks: Bump the API version, or keep v1 compatible?"]);
  t.desk.dismiss("web#3");
  assert.equal(t.desk.overview().inflight.needs_you, 0);
  assert.throws(() => {
    t.desk.dismiss("web#3");
  }, /nothing to dismiss/);
});

test("escalating or drafting needs your PR in Merging", async (c) => {
  const t = await setup([myPr(3), reviewAsk(1)], { settings: OFF });
  c.after(t.cleanup);
  await t.desk.sync();
  assert.throws(() => t.desk.escalate("web#3", "?"), /isn't one of your open PRs in Merging/);
  await assert.rejects(t.desk.draftReply("api#1", null, "hi"), /isn't one of your open PRs in Merging/);
});

test("desk_draft_reply: a reply to one of the PR's threads waits for Send, which posts it once and logs it", async (c) => {
  const w = fakeWriter();
  const t = await setup([myPr(3, { ci: "pending" })], { settings: OFF, desk: { writer: w.writer } });
  c.after(t.cleanup);
  t.gh.contexts.set("PR_acme/web_3", CTX);
  await t.desk.sync();
  t.desk.act("web#3", "inflight");
  await assert.rejects(t.desk.draftReply("web#3", "PRRT_elsewhere", "Done"), /no review thread "PRRT_elsewhere"/);
  await assert.rejects(t.desk.draftReply("web#3", null, "   "), /empty/);
  const first = await t.desk.draftReply("web#3", "PRRT_open", "Yes, it retries now.");
  const d = await t.desk.draftReply("web#3", "PRRT_open", "Yes: it retries 502s twice, in abc123.");
  assert.equal(d.to, "dana on src/api.ts:12");
  assert.equal(d.quote, "Should this retry? It fails on 502s.");
  const row = t.desk.inflight().rows[0]!;
  assert.deepEqual(
    row.drafts.map((x) => x.body),
    ["Yes: it retries 502s twice, in abc123."],
    "a new draft for the same thread replaces the old one",
  );
  assert.equal(row.needs_you, "reply ready to send");
  assert.deepEqual([t.desk.queue().sections.now, t.desk.item("web#3").card.why], [[], "merging: reply ready to send"]);
  await assert.rejects(t.desk.sendDraft("web#3", first.id), /no draft/);
  assert.deepEqual(await t.desk.sendDraft("web#3", d.id), { url: "https://github.com/acme/web/pull/3#discussion_r1" });
  assert.deepEqual(w.calls, [["reply", "PRRT_open", "Yes: it retries 502s twice, in abc123."]]);
  await assert.rejects(t.desk.sendDraft("web#3", d.id), /sent already/);
  assert.equal(t.desk.inflight().rows[0]?.drafts.length, 0);
  const logged = t.desk.store.db.prepare("SELECT action, undone FROM events WHERE action = 'reply'").all();
  assert.deepEqual(
    logged.map((r) => [r.action, r.undone]),
    [["reply", 1]],
  );
  // A comment on the PR itself goes through addComment.
  const pc = await t.desk.draftReply("web#3", null, "Rebased on main; ready for another look.");
  assert.equal(pc.to, "the PR");
  await t.desk.sendDraft("web#3", pc.id);
  assert.deepEqual(w.calls[1], ["comment", "PR_acme/web_3", "Rebased on main; ready for another look."]);
});

test("Send is the desk window's: the route refuses a request without the desk's Origin, so MCP and the CLI can't send", async (c) => {
  const w = fakeWriter();
  const t = await setup([myPr(3, { ci: "pending" })], { settings: OFF, desk: { writer: w.writer } });
  c.after(t.cleanup);
  await t.desk.sync();
  t.desk.act("web#3", "inflight");
  const app = createApp(t.desk, 47823);
  const post = (p: string, body: unknown, origin?: string, site = "same-origin") =>
    app.request(`http://127.0.0.1:47823${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin, "sec-fetch-site": site } : {}) },
      body: JSON.stringify(body),
    });
  const id = encodeURIComponent("acme/web#3");
  const draft = (await (await post(`/api/inflight/${id}/draft`, { body: "Thanks!" })).json()) as { draft: { id: string } };
  assert.equal((await post(`/api/inflight/${id}/send`, { draft_id: draft.draft.id })).status, 403);
  assert.equal((await post(`/api/inflight/${id}/send`, { draft_id: draft.draft.id }, "https://evil.example")).status, 403);
  assert.equal(
    (await post(`/api/inflight/${id}/send`, { draft_id: draft.draft.id }, "http://localhost:47823", "none")).status,
    403,
    "an Origin alone isn't the desk's page: approve's same-origin check applies too",
  );
  assert.equal(w.calls.length, 0);
  const ok = await post(`/api/inflight/${id}/send`, { draft_id: draft.draft.id }, "http://localhost:47823");
  assert.equal(ok.status, 200);
  assert.equal(w.calls.length, 1);
  // Escalate and dismiss are local, so tools may call them.
  assert.equal((await post(`/api/inflight/${id}/escalate`, { question: "Merge now?" })).status, 200);
  assert.equal((await post(`/api/inflight/${id}/dismiss`, {})).status, 200);
  assert.equal((await post(`/api/inflight/${id}/escalate`, {})).status, 400);
  assert.equal(((await (await app.request("http://127.0.0.1:47823/api/inflight")).json()) as { rows: unknown[] }).rows.length, 1);
});

test("what agents may do to a PR in Merging: its babysitter drafts and asks on its own PR only, the coordinator not at all", async (c) => {
  const t = await setup([myPr(3, { ci: "pending" }), myPr(4, { ci: "pending" })], { settings: OFF });
  c.after(t.cleanup);
  await t.desk.sync();
  t.desk.act("web#3", "inflight");
  t.desk.act("web#4", "inflight");
  const app = createApp(t.desk, 47823);
  const id = encodeURIComponent("acme/web#3");
  const post = (p: string, body: unknown, headers: Record<string, string>) =>
    app.request(`http://127.0.0.1:47823${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const coordinator = { "x-desk-agent": "coordinator" };
  const sitter = (pr: string) => ({ "x-desk-agent": "babysitter", "x-desk-pr": pr });
  // A wake carries GitHub text from anything on the desk: no questions that park a babysitter, no drafts you'd send as its.
  t.desk.coordinator.running = { n: 7, since: new Date().toISOString(), kind: "events" };
  assert.equal((await post(`/api/inflight/${id}/escalate`, { question: "Merge without review?" }, coordinator)).status, 403);
  assert.equal((await post(`/api/inflight/${id}/draft`, { body: "See https://evil.example" }, coordinator)).status, 403);
  t.desk.coordinator.running = null;
  assert.equal((await post(`/api/inflight/${id}/draft`, { body: "Done." }, sitter("acme/web#4"))).status, 403);
  assert.equal((await post(`/api/inflight/${id}/draft`, { body: "Done." }, sitter("acme/web#3"))).status, 200);
  assert.equal((await post(`/api/inflight/${id}/escalate`, { question: "Bump v2?" }, sitter("acme/web#3"))).status, 200);
  const row = t.desk.inflight().rows.find((r) => r.card.id === "acme/web#3")!;
  assert.deepEqual([row.drafts[0]?.by, row.escalation?.by], ["babysitter", "babysitter"]);
  // Another agent over MCP (no header) is "an agent", not the babysitter.
  assert.equal((await t.desk.draftReply("web#4", null, "Thanks!")).by, "agent");

  // Undo from an agent can't put back a PR you took back (which would restart its babysitter), nor undo your marks.
  const back = t.desk.act("web#4", "takeback");
  assert.throws(() => t.desk.undo(back.undo_seq, "agent"), /only the user undoes bringing a PR back to the desk/);
  assert.throws(() => t.desk.undo(undefined, "coordinator"), /only the user undoes/);
  t.desk.undo(back.undo_seq);
  assert.ok(t.desk.store.state("acme/web#4").inflight_at, "you can");
  // The coordinator undoes only its own actions.
  const mine = t.desk.act("web#4", "pin");
  assert.throws(() => t.desk.undo(mine.undo_seq, "coordinator"), /wasn't yours/);
  const its = t.desk.act("web#4", "unpin", undefined, { agent: "coordinator", reason: "noise" });
  assert.equal(t.desk.undo(its.undo_seq, "coordinator").action, "unpin");
});

test("ready to merge keeps waiting on you while Claude answers a later comment, so it notifies once", async (c) => {
  const t = await setup([myPr(3, { ci: "green", review_decision: "approved", mergeable: "clean" })], {
    settings: { ...OFF, "inflight.babysit": true, "notify.quiet": "" },
  });
  c.after(t.cleanup);
  t.desk.mcpUrl = "http://127.0.0.1:9/mcp";
  await t.desk.sync();
  t.desk.act("web#3", "inflight");
  t.desk.notifyNew();
  for (let i = 0; i < 3; i++) {
    t.desk.sitter.queue.push("acme/web#3"); // a reviewer commented: a run is queued, then runs
    t.desk.changed();
    assert.equal(t.desk.inflight().rows[0]?.needs_you, "ready to merge");
    t.desk.notifyNew();
    t.desk.sitter.queue = [];
    t.desk.changed();
    t.desk.notifyNew();
  }
  assert.deepEqual(t.notes, ["web#3 · merging: ready to merge"]);
});

// Your PR as the desk reads it once it knows the repo's merge settings.
const allows = { auto_merge: false, auto_merge_allowed: true, merge_method: "SQUASH" as const };

test("m turns on auto-merge with the repo's merge method, a draft marked ready first; Back to desk turns it off", async (c) => {
  const w = fakeWriter();
  const t = await setup([myPr(3, { ci: "pending", draft: true, ...allows })], { settings: OFF, desk: { writer: w.writer } });
  c.after(t.cleanup);
  await t.desk.sync();
  const r = await t.desk.handOff("web#3");
  assert.ok(r.state.inflight_at);
  assert.equal(r.auto_merge.on, true);
  assert.deepEqual(w.calls, [
    ["ready", "PR_acme/web_3"],
    ["auto_merge", "PR_acme/web_3", "SQUASH"],
  ]);
  const logged = () =>
    t.desk.store.db
      .prepare("SELECT action, undone FROM events WHERE action NOT IN ('inflight', 'takeback') ORDER BY seq")
      .all()
      .map((x) => [x.action, x.undone]);
  assert.deepEqual(logged(), [
    ["ready", 1],
    ["auto_merge", 1],
  ]);
  // On, as far as the desk knows until GitHub is read again.
  assert.deepEqual([t.desk.inflight().rows[0]?.auto_merge, t.desk.inflight().rows[0]?.merge_note], [true, null]);
  // GitHub has it on: Merging says so, and a PR that's ready waits for GitHub, not for you.
  const it = t.gh.items.get("acme/web#3")!;
  t.gh.items.set(it.id, {
    ...it,
    draft: false,
    auto_merge: true,
    ci: "green",
    review_decision: "approved",
    mergeable: "clean",
    updated_at: hoursAgo(1),
  });
  await t.desk.sync();
  const row = t.desk.inflight().rows[0]!;
  assert.deepEqual([row.auto_merge, row.merge_note, row.needs_you], [true, null, null]);
  assert.equal(t.desk.queue().sections.now.length, 0);

  const back = await t.desk.backToDesk("web#3");
  assert.deepEqual([back.state.inflight_at, back.auto_merge_off], [null, true]);
  assert.deepEqual(w.calls.at(-1), ["auto_merge_off", "PR_acme/web_3"]);
  assert.deepEqual(logged().at(-1), ["auto_merge_off", 1]);
  assert.equal(t.desk.inflight().rows.length, 0);
});

test("nothing is written when the repo doesn't allow auto-merge, it's on already, or the setting is off; GitHub refusing is said", async (c) => {
  const w = fakeWriter("auto_merge");
  const ready = { ci: "green" as const, review_decision: "approved" as const, mergeable: "clean" as const };
  const t = await setup(
    [
      myPr(3, { ...ready, draft: true, auto_merge: false, auto_merge_allowed: false }),
      myPr(4, { ...ready, ...allows, auto_merge: true }),
      myPr(5, { ci: "pending", ...allows }),
      myPr(6, { ci: "pending", ...allows }),
      myPr(7, { ci: "pending" }),
    ],
    { settings: OFF, desk: { writer: w.writer } },
  );
  c.after(t.cleanup);
  await t.desk.sync();
  const no = await t.desk.handOff("web#3");
  assert.deepEqual(no.auto_merge, { on: false, why: "the repo doesn't allow auto-merge", at: no.auto_merge.at });
  const already = await t.desk.handOff("web#4");
  assert.deepEqual([already.auto_merge.on, already.auto_merge.why], [false, null]);
  assert.deepEqual(w.calls, []);
  const rows = () => new Map(t.desk.inflight().rows.map((r) => [r.card.id, r]));
  // Nobody merges #3 for you: ready to merge, it waits on you. #4 GitHub merges.
  assert.deepEqual(
    [rows().get("acme/web#3")?.merge_note, rows().get("acme/web#3")?.needs_you],
    ["the repo doesn't allow auto-merge", null],
    "still a draft",
  );
  assert.deepEqual([rows().get("acme/web#4")?.auto_merge, rows().get("acme/web#4")?.needs_you], [true, null]);
  const it = t.gh.items.get("acme/web#3")!;
  t.gh.items.set(it.id, { ...it, draft: false, updated_at: hoursAgo(1) });
  await t.desk.sync();
  assert.equal(rows().get("acme/web#3")?.needs_you, "ready to merge");
  assert.ok(!t.desk.queue().sections.now.some((x) => x.id === "acme/web#3"), "in Merging, not the queue");
  // Back to desk turns off only what the desk turned on.
  await t.desk.backToDesk("web#3");
  await t.desk.backToDesk("web#4");
  assert.deepEqual(w.calls, []);

  // GitHub refuses: the PR is in Merging anyway, and its row says why you merge it.
  const refused = await t.desk.handOff("web#5");
  assert.equal(refused.auto_merge.why, "GitHub didn't turn auto-merge on: Pull request is in clean status");
  assert.deepEqual(w.calls, [["auto_merge", "PR_acme/web_5", "SQUASH"]]);
  assert.equal(rows().get("acme/web#5")?.merge_note, "GitHub didn't turn auto-merge on: Pull request is in clean status");

  t.desk.putSettings({ set: { "inflight.auto_merge": false } });
  const off = await t.desk.handOff("web#6");
  assert.equal(off.auto_merge.why, "auto-merge is off in Settings");
  t.desk.putSettings({ set: { "inflight.auto_merge": true } });
  // Stored before the desk asked, and the refresh didn't say: don't guess.
  const asked = t.gh.detailCalls.length;
  const unknown = await t.desk.handOff("web#7");
  assert.equal(unknown.auto_merge.why, "the desk couldn't read whether the repo allows auto-merge");
  assert.deepEqual(t.gh.detailCalls.slice(asked), [["acme/web#7"]], "it asked GitHub first");
  assert.equal(w.calls.length, 1);
});

test("m and b are the desk window's: no agent, CLI or MCP route reaches the auto-merge writes", async (c) => {
  const w = fakeWriter();
  const t = await setup([myPr(3, { ci: "pending", ...allows })], { settings: OFF, desk: { writer: w.writer } });
  c.after(t.cleanup);
  await t.desk.sync();
  const app = createApp(t.desk, 47823);
  const id = encodeURIComponent("acme/web#3");
  const post = (p: string, headers: Record<string, string> = {}, body: unknown = {}) =>
    app.request(`http://127.0.0.1:47823${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  for (const route of ["handoff", "back"]) {
    assert.equal((await post(`/api/inflight/${id}/${route}`)).status, 403);
    assert.equal((await post(`/api/inflight/${id}/${route}`, { "x-desk-agent": "babysitter", "x-desk-pr": "acme/web#3" })).status, 403);
    assert.equal((await post(`/api/inflight/${id}/${route}`, { origin: "http://localhost:47823", "sec-fetch-site": "none" })).status, 403);
  }
  // Marking it in Merging another way writes nothing.
  assert.equal((await post("/api/act", {}, { id: "acme/web#3", action: "inflight" })).status, 200);
  assert.equal((await post("/api/act", {}, { id: "acme/web#3", action: "takeback" })).status, 200);
  assert.equal(w.calls.length, 0);
  const desk = { origin: "http://localhost:47823", "sec-fetch-site": "same-origin" };
  assert.equal((await post(`/api/inflight/${id}/handoff`, desk)).status, 200);
  assert.equal(w.calls.length, 1);
  assert.equal((await post(`/api/inflight/${id}/back`, desk)).status, 200);
  assert.deepEqual(w.calls.at(-1), ["auto_merge_off", "PR_acme/web_3"]);
});

test("Claude hands a PR back: it leaves Merging for the top of Now with the reason, writes nothing, and says auto-merge is still on", async (c) => {
  const w = fakeWriter();
  const t = await setup([reviewAsk(1), myPr(3, { ci: "pending", ...allows }), myPr(4, { ci: "pending" })], {
    settings: { ...OFF, "notify.quiet": "" },
    desk: { writer: w.writer },
  });
  c.after(t.cleanup);
  await t.desk.sync();
  await t.desk.handOff("web#3");
  t.desk.act("web#4", "inflight");
  const it = t.gh.items.get("acme/web#3")!;
  t.gh.items.set(it.id, { ...it, auto_merge: true, updated_at: hoursAgo(1) });
  await t.desk.sync();
  t.desk.notifyNew();
  const calls = w.calls.length;
  const app = createApp(t.desk, 47823);
  const handBack = (pr: string, headers: Record<string, string>) =>
    app.request(`http://127.0.0.1:47823/api/inflight/${encodeURIComponent(pr)}/escalate`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ question: "Dana wants the cache redesigned first", hand_back: true }),
    });
  // Only its own babysitter, never the coordinator.
  assert.equal((await handBack("acme/web#3", { "x-desk-agent": "babysitter", "x-desk-pr": "acme/web#4" })).status, 403);
  assert.equal((await handBack("acme/web#3", { "x-desk-agent": "coordinator" })).status, 403);
  assert.equal((await handBack("acme/web#3", { "x-desk-agent": "babysitter", "x-desk-pr": "acme/web#3" })).status, 200);
  assert.equal(w.calls.length, calls, "a hand-back writes nothing to GitHub");
  assert.equal(t.desk.store.state("acme/web#3").inflight_at, null);
  assert.deepEqual(
    t.desk.inflight().rows.map((r) => r.card.id),
    ["acme/web#4"],
  );
  const [top] = t.desk.queue().sections.now;
  assert.deepEqual(
    [top?.id, top?.why, top?.handed_back, top?.inflight, top?.chips.includes("auto-merge on")],
    ["acme/web#3", "handed back: Dana wants the cache redesigned first", true, false, true],
  );
  assert.deepEqual(t.notes, ["web#3 · handed back: Dana wants the cache redesigned first"]);
  assert.deepEqual(t.desk.overview().inflight, { total: 1, needs_you: 0 });
  // The coordinator can't put it away; you can, and then it's an ordinary PR again.
  assert.throws(
    () => t.desk.act("web#3", "done", undefined, { agent: "coordinator", reason: "waiting" }),
    (e: Error & { status: number }) => e.status === 403 && e.message.includes("handed"),
  );
  t.setNow(new Date(Date.parse(hoursAgo(0)) + 60_000));
  t.desk.act("web#3", "done");
  assert.ok(!t.desk.queue().sections.now.some((x) => x.id === "acme/web#3"));
  // m again starts afresh.
  t.desk.act("web#3", "restore");
  await t.desk.handOff("web#3");
  assert.equal(t.desk.sitter.record("acme/web#3").handback, null);
});

test("after a hand-back, b turns off the auto-merge m turned on; m again keeps it the desk's", async (c) => {
  const w = fakeWriter();
  const t = await setup([myPr(3, { ci: "pending", ...allows })], { settings: OFF, desk: { writer: w.writer } });
  c.after(t.cleanup);
  await t.desk.sync();
  let clock = Date.parse(hoursAgo(0));
  const onGitHub = async (on: boolean) => {
    const it = t.gh.items.get("acme/web#3")!;
    t.gh.items.set(it.id, { ...it, auto_merge: on, updated_at: new Date(clock).toISOString() });
    t.setNow(new Date((clock += 60_000)));
    await t.desk.sync();
  };
  const card = () => t.desk.queue().sections.now.find((x) => x.id === "acme/web#3");
  await t.desk.handOff("web#3");
  await onGitHub(true);
  t.desk.escalate("web#3", "Dana wants a redesign", { agent: "babysitter", pr: "acme/web#3" }, true);
  assert.deepEqual([card()?.handed_back, card()?.desk_auto_merge], [true, true]);
  // m again: no new write, and it's still the desk's to turn off.
  const again = await t.desk.handOff("web#3");
  assert.equal(again.auto_merge.on, true);
  assert.deepEqual(w.calls, [["auto_merge", "PR_acme/web_3", "SQUASH"]]);
  t.desk.escalate("web#3", "still a redesign", { agent: "babysitter", pr: "acme/web#3" }, true);
  const b = await t.desk.backToDesk("web#3");
  assert.deepEqual([b.state.inflight_at, b.auto_merge_off], [null, true]);
  assert.deepEqual(w.calls.at(-1), ["auto_merge_off", "PR_acme/web_3"]);
  assert.deepEqual([card()?.handed_back, card()?.desk_auto_merge], [true, undefined], "still yours to deal with, auto-merge off");
  await onGitHub(false);
  await assert.rejects(t.desk.backToDesk("web#3"), /isn't in Merging/);
  // Undoing a hand-off leaves it on too: b turns it off from the card.
  await t.desk.handOff("web#3");
  await onGitHub(true);
  t.desk.undo();
  assert.equal(t.desk.store.state("acme/web#3").inflight_at, null);
  const out = Object.values(t.desk.queue().sections)
    .flat()
    .find((x) => x.id === "acme/web#3");
  assert.deepEqual([out?.inflight, out?.desk_auto_merge], [false, true]);
  assert.equal((await t.desk.backToDesk("web#3")).auto_merge_off, true);
  assert.equal(w.calls.filter((x) => x[0] === "auto_merge_off").length, 2);
});

test("b writes nothing when GitHub has auto-merge off already, and a b during m's writes stops the rest", async (c) => {
  const w = fakeWriter();
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const writer: GitHubWriter = { ...w.writer, ready: (pr) => w.writer.ready(pr).then(() => held) };
  const t = await setup([myPr(3, { ci: "pending", ...allows }), myPr(4, { ci: "pending", draft: true, ...allows })], {
    settings: OFF,
    desk: { writer },
  });
  c.after(t.cleanup);
  await t.desk.sync();
  await t.desk.handOff("web#3");
  // A push turned it off on GitHub, and the desk has read that since.
  const it = t.gh.items.get("acme/web#3")!;
  t.gh.items.set(it.id, { ...it, auto_merge: false, updated_at: hoursAgo(0) });
  t.setNow(new Date(Date.parse(hoursAgo(0)) + 60_000));
  await t.desk.sync();
  assert.equal(t.desk.inflight().rows.find((r) => r.card.id === "acme/web#3")?.merge_note, "auto-merge was turned off on GitHub");
  const b = await t.desk.backToDesk("web#3");
  assert.deepEqual([b.state.inflight_at, b.auto_merge_off], [null, false]);
  assert.deepEqual(w.calls, [["auto_merge", "PR_acme/web_3", "SQUASH"]]);

  const m = t.desk.handOff("web#4");
  await new Promise((r) => {
    setTimeout(r, 10);
  });
  assert.equal((await t.desk.backToDesk("web#4")).auto_merge_off, false);
  release();
  const r = await m;
  assert.deepEqual([r.auto_merge.on, r.auto_merge.why], [false, "it was back on your desk before auto-merge went on"]);
  assert.deepEqual(w.calls.slice(1), [["ready", "PR_acme/web_4"]], "no auto-merge for a PR already back on your desk");
});

test("d on your own PR is plain done: it leaves the queue and comes back when someone else acts", async (c) => {
  const t = await setup([myPr(3, { ci: "red" })], { settings: OFF });
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
