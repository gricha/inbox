// In flight: d on your own PR, the lane, needs-you in Now, drafts and questions from agents, and Send (the reply write).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.ts";
import type { GitHubWriter } from "../src/github/write.ts";
import type { PrContext } from "../src/github/index.ts";
import { myPr, reviewAsk, setup } from "./helpers/desk.ts";
import { hoursAgo } from "./helpers/items.ts";

// Babysitting stays off here: these tests are about the lane and the queue, not runs (babysit.test.ts has those).
const OFF = { "inflight.babysit": false };

function fakeWriter() {
  const calls: string[][] = [];
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

test("d on your own open PR puts it in flight: it leaves the queue for the lane, and undo brings it back", async (c) => {
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
    [["acme/web#3", true, null, "watching"]],
  );
  assert.deepEqual(t.desk.overview().inflight, { total: 1, needs_you: 0 });
  assert.throws(() => t.desk.act("web#3", "inflight"), /already in flight/);
  t.desk.undo(r.undo_seq);
  assert.ok(all().includes("acme/web#3"));
  assert.equal(t.desk.inflight().rows.length, 0);
  // d again takes it back, which undo can also reverse.
  t.desk.act("web#3", "inflight");
  const back = t.desk.act("web#3", "takeback");
  assert.equal(back.state.inflight_at, null);
  assert.ok(all().includes("acme/web#3"));
  t.desk.undo(back.undo_seq);
  assert.equal(t.desk.inflight().rows.length, 1);
});

test("only your own open PRs go in flight", async (c) => {
  const t = await setup([reviewAsk(1), myPr(3)], { settings: OFF });
  c.after(t.cleanup);
  await t.desk.sync();
  assert.throws(
    () => t.desk.act("api#1", "inflight"),
    (e: Error & { status: number }) => e.status === 409 && e.message.includes("your own open PRs"),
  );
  assert.throws(() => t.desk.act("web#3", "takeback"), /isn't in flight/);
});

test("in flight, its babysitter owns it: done, snooze and mute are refused, and the judge and coordinator leave it alone", async (c) => {
  const t = await setup([myPr(3, { ci: "pending" })], { settings: { ...OFF, "analyze.command": "/nonexistent/claude" } });
  c.after(t.cleanup);
  await t.desk.sync();
  // Muted before you marked it: marking clears that, so its questions can reach Now.
  const muted = t.desk.act("web#3", "mute");
  const marked = t.desk.act("web#3", "inflight");
  assert.equal(marked.state.muted, false);
  t.desk.escalate("web#3", "Keep v1 or bump?");
  for (const action of ["done", "snooze", "mute"] as const)
    assert.throws(
      () => t.desk.act("web#3", action, undefined, { agent: "coordinator", reason: "policy" }),
      (e: Error & { status: number }) => e.status === 409 && e.message.includes("take it back"),
    );
  assert.deepEqual(
    t.desk.focus().sections.now.map((x) => x.id),
    ["acme/web#3"],
  );
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

test("with babysitting off, an in-flight PR comes back to Now when CI fails, and when it's ready to merge", async (c) => {
  const t = await setup(
    [myPr(3, { ci: "red" }), myPr(4, { ci: "green", review_decision: "approved", mergeable: "clean" }), myPr(5, { ci: "pending" })],
    {
      settings: OFF,
    },
  );
  c.after(t.cleanup);
  await t.desk.sync();
  for (const n of [3, 4, 5]) t.desk.act(`web#${n}`, "inflight");
  const now = t.desk.queue().sections.now;
  assert.deepEqual(
    now.map((x) => [x.id, x.why]),
    [
      ["acme/web#3", "CI failing"],
      ["acme/web#4", "approved and green: merge it"],
    ],
  );
  assert.ok(now.every((x) => x.inflight));
  assert.ok(!t.desk.queue().sections.today.some((x) => x.id === "acme/web#5"));
  assert.deepEqual(t.desk.overview().inflight, { total: 3, needs_you: 2 });
  assert.equal(t.desk.focus().sections.now.length, 2);
});

test("desk_escalate: the PR goes to Now with the question as its why, notifies, and x dismisses it", async (c) => {
  const t = await setup([myPr(3, { ci: "pending" })], { settings: { ...OFF, "notify.quiet": "" } });
  c.after(t.cleanup);
  await t.desk.sync();
  t.desk.act("web#3", "inflight");
  t.desk.notifyNewNow(); // the baseline, as after a sync
  assert.throws(() => t.desk.escalate("web#9", "x?"), /no item/);
  const r = t.desk.escalate("web#3", "  Bump the API version,\nor keep v1 compatible?  ");
  assert.equal(r.question, "Bump the API version, or keep v1 compatible?");
  const [top] = t.desk.queue().sections.now;
  assert.equal(top?.why, "Bump the API version, or keep v1 compatible?");
  assert.equal(t.desk.inflight().rows[0]?.sitter.text, "needs you: Bump the API version, or keep v1 compatible?");
  assert.deepEqual(t.notes, ["web#3 · Bump the API version, or keep v1 compatible?"]);
  t.desk.dismiss("web#3");
  assert.equal(t.desk.queue().sections.now.length, 0);
  assert.throws(() => {
    t.desk.dismiss("web#3");
  }, /nothing to dismiss/);
});

test("escalating or drafting needs your in-flight PR", async (c) => {
  const t = await setup([myPr(3), reviewAsk(1)], { settings: OFF });
  c.after(t.cleanup);
  await t.desk.sync();
  assert.throws(() => t.desk.escalate("web#3", "?"), /isn't one of your open PRs in flight/);
  await assert.rejects(t.desk.draftReply("api#1", null, "hi"), /isn't one of your open PRs in flight/);
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
  assert.equal(t.desk.queue().sections.now[0]?.why, "reply ready to send");
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
  const post = (p: string, body: unknown, origin?: string) =>
    app.request(`http://127.0.0.1:47823${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify(body),
    });
  const id = encodeURIComponent("acme/web#3");
  const draft = (await (await post(`/api/inflight/${id}/draft`, { body: "Thanks!" })).json()) as { draft: { id: string } };
  assert.equal((await post(`/api/inflight/${id}/send`, { draft_id: draft.draft.id })).status, 403);
  assert.equal((await post(`/api/inflight/${id}/send`, { draft_id: draft.draft.id }, "https://evil.example")).status, 403);
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
