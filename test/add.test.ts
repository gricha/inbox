import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import type { ReviewDeps } from "../src/desk.ts";
import { parseReview } from "../src/review.ts";
import type { AiReview } from "../src/types.ts";
import { createApp } from "../src/server.ts";
import { reviewAsk, setup, teamPing } from "./helpers/desk.ts";
import { hoursAgo, makeItem, NOW } from "./helpers/items.ts";
import { runSync } from "./helpers/run.ts";

// Adding starts Claude's read: never the real claude, even when run without the no-agent preload.
process.env.DESK_CLAUDE = "/nonexistent/claude";

const DAY = 24 * 3_600_000;
const ID = "acme/other#9";
// Someone else's PR no board's search returns: only desk_add brings it in.
const unknown = () => makeItem({ repo: "acme/other", number: 9, author: "dave" });

// Diffs and AI reviews that never reach an agent: each review is "being written" until finish() writes it.
function fakeReview() {
  const fetched: string[] = [];
  const started: string[] = [];
  const done = new Map<string, () => void>();
  const review: ReviewDeps = {
    fetchPr: (item) =>
      Effect.sync(() => {
        fetched.push(item.id);
        return { body: "", files: [] };
      }),
    generate: (item) =>
      Effect.callback<AiReview>((resume) => {
        started.push(item.id);
        const ai = parseReview({ verdict: "skim", risk: "low", summary: "fine", notes: [] }, []);
        done.set(item.id, () => {
          resume(Effect.succeed({ ...ai, head_oid: item.head_oid, model: "fake", at: NOW.toISOString() }));
        });
      }),
  };
  const finish = async (id: string) => {
    done.get(id)!();
    await new Promise((r) => {
      setTimeout(r, 20);
    });
  };
  return { review, fetched, started, finish };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++)
    await new Promise((r) => {
      setTimeout(r, 10);
    });
  assert.ok(cond(), "timed out waiting");
}

test("adding a PR the desk doesn't hold fetches it, pins it on the main page and starts its pre-review", async (c) => {
  const f = fakeReview();
  const t = await setup([teamPing(2)], { settings: { "policy.judge": false }, desk: { review: f.review } });
  c.after(t.cleanup);
  await t.desk.sync();
  t.gh.items.set(ID, unknown());
  const say = { id: "ic1", author: "dave", bot: false, body: "@me can you look?", at: hoursAgo(1), url: "https://github.com/x" };
  t.gh.contexts.set("PR_acme/other_9", { threads: [], reviews: [], comments: [say], commits: [] });
  await t.desk.sync();
  assert.equal(t.desk.snapshot().entries.has(ID), false, "no search returns it");

  const r = await t.desk.add("https://github.com/acme/other/pull/9/files");
  assert.deepEqual(t.gh.lookupCalls, [ID]);
  assert.equal(r.item.card.id, ID);
  assert.equal(r.item.state.pinned, true);
  assert.ok(r.undo_seq > 0);
  assert.equal(r.item.generating, true, "its AI review is being written");
  // The read fails on the missing claude: it started, and no real agent ran.
  await until(() => f.started.length > 0 && t.desk.convos.errors.has(ID));
  assert.deepEqual(f.started, [ID]);
  assert.deepEqual(f.fetched, [ID], "the diff once: the AI review joins the fetch add started");
  assert.deepEqual(
    t.desk.store.activity({ after: 0, limit: 10, item: ID }).map((e) => e.kind),
    ["new"],
    "held with its events from here",
  );

  const onPage = () => runSync(t.desk.focus()).sections.today.find((x) => x.id === ID);
  assert.equal(onPage(), undefined, "not until Claude has reviewed it");
  assert.equal(runSync(t.desk.focus()).reviewing, 1);
  await f.finish(ID);
  const row = onPage();
  assert.ok(row, "on the main page");
  assert.equal(runSync(t.desk.focus()).reviewing, 0);
  assert.equal(row.why, "you added it");
  assert.equal(runSync(t.desk.item(ID)).placements[0]?.board, "added");
  await t.desk.sync();
  assert.deepEqual(t.notes, [], "you put it there: no notification");

  runSync(t.desk.undo(r.undo_seq));
  assert.equal(
    runSync(t.desk.focus()).sections.today.some((x) => x.id === ID),
    false,
    "undo unpins it, and nothing else puts it there",
  );
});

test("an added PR stays while it's pinned and open: refreshed each sync, never pruned; merged, it resolves and goes", async (c) => {
  const t = await setup([reviewAsk(1)], { settings: { "policy.judge": false } });
  c.after(t.cleanup);
  await t.desk.sync();
  t.gh.items.set(ID, unknown());
  await t.desk.add(ID);

  t.setNow(new Date(NOW.getTime() + 15 * DAY));
  const before = t.gh.detailCalls.length;
  await t.desk.sync();
  assert.ok(
    t.gh.detailCalls.slice(before).some((ids) => ids.includes(ID)),
    "no search says when it changed: refreshed",
  );
  assert.ok(
    runSync(t.desk.focus()).sections.today.some((x) => x.id === ID),
    "past the 14 days an item no search returns is kept",
  );

  t.gh.items.set(ID, { ...unknown(), state: "merged", updated_at: new Date(NOW.getTime() + 15 * DAY + 60_000).toISOString() });
  t.setNow(new Date(NOW.getTime() + 15 * DAY + 5 * 60_000));
  await t.desk.sync();
  assert.equal(
    runSync(t.desk.focus()).sections.today.some((x) => x.id === ID),
    false,
  );
  assert.ok(runSync(t.desk.queue()).resolved.some((x) => x.id === ID && x.why === "merged"));

  t.setNow(new Date(NOW.getTime() + 30 * DAY));
  await t.desk.sync();
  assert.equal(t.desk.store.itemsById([ID]).has(ID), false, "merged, it's pruned like anything no search returns");
});

test("adding what the desk holds pins it; a bad ref is a 400, one GitHub doesn't have a 404", async (c) => {
  const t = await setup([reviewAsk(1), teamPing(2)], { settings: { "policy.judge": false } });
  c.after(t.cleanup);
  await t.desk.sync();
  assert.equal(
    runSync(t.desk.focus()).sections.today.some((x) => x.id === "acme/api#2"),
    false,
    "a team ping is FYI",
  );
  const app = createApp(t.desk, 47823);
  const add = (body: unknown) =>
    app.request("http://127.0.0.1:47823/api/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const res = await add({ id: "api#2" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { item: { card: { board: string } }; undo_seq: number };
  assert.ok(body.undo_seq > 0);
  assert.equal(body.item.card.board, "acme-review", "held: pinned where its board has it");
  assert.ok(runSync(t.desk.focus()).sections.today.some((x) => x.id === "acme/api#2"));
  assert.deepEqual(t.gh.lookupCalls, [], "nothing fetched");

  assert.equal((await add({})).status, 400);
  assert.equal((await add({ id: "not a ref" })).status, 400);
  assert.equal((await add({ id: "web#5" })).status, 400, "a short ref finds only what the desk holds");
  assert.equal((await add({ id: "acme/api#999" })).status, 404);
  assert.deepEqual(t.gh.lookupCalls, ["acme/api#999"]);
});

test("an agent's hand-off says why it's on your desk, beside the rule's why, until you act on it", async (c) => {
  const t = await setup([reviewAsk(1), teamPing(2)], { settings: { "policy.judge": false } });
  c.after(t.cleanup);
  await t.desk.sync();
  t.gh.items.set(ID, unknown());
  const card = (id: string) => runSync(t.desk.item(id)).card;
  const asked = card("acme/api#1").why;

  const first = await t.desk.add("api#1", "  the retry budget\nchanged\u202e  ", "seer retry fix");
  await t.desk.add(ID, "needs your call on the token transport", "seer write gate");
  await t.desk.add("api#2", "your sign-off on the schema", "");
  assert.deepEqual(card("acme/api#1").handoff, { why: "the retry budget changed", from: "seer retry fix" }, "one plain line");
  assert.equal(card("acme/api#1").why, asked, "the rule's why stays its own");
  assert.deepEqual(card(ID).handoff, { why: "needs your call on the token transport", from: "seer write gate" });
  assert.deepEqual(card("acme/api#2").handoff, { why: "your sign-off on the schema", from: "" });
  assert.deepEqual(runSync(t.desk.focus()).sections.now.find((x) => x.id === "acme/api#1")?.handoff?.from, "seer retry fix");

  // Dealt with, it's yours: the ask doesn't come back with the item; undo brings it back.
  const done = runSync(t.desk.act("api#1", "done"));
  assert.equal(card("acme/api#1").handoff, undefined);
  runSync(t.desk.undo(done.undo_seq));
  assert.equal(card("acme/api#1").handoff?.why, "the retry budget changed");

  // Each add's why goes with its own pin: a later one, or yours without a why, stands until it's undone.
  const second = await t.desk.add("api#1", "now it's a schema change too", "seer retry fix");
  assert.equal(card("acme/api#1").handoff?.why, "now it's a schema change too");
  const bare = await t.desk.add("api#1");
  assert.equal(card("acme/api#1").handoff, undefined);
  runSync(t.desk.undo(bare.undo_seq));
  runSync(t.desk.undo(second.undo_seq));
  assert.equal(card("acme/api#1").handoff?.why, "the retry budget changed");
  runSync(t.desk.undo(first.undo_seq));
  assert.equal(card("acme/api#1").handoff, undefined, "unpinned: no hand-off");

  // Your own pin is yours.
  runSync(t.desk.act(ID, "unpin"));
  runSync(t.desk.act(ID, "pin"));
  assert.equal(card(ID).handoff, undefined);

  await assert.rejects(t.desk.add("api#2", " \n "), /the why is empty/);
  const app = createApp(t.desk, 47823);
  const res = await app.request("http://127.0.0.1:47823/api/add", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "api#2", why: ["not a line"] }),
  });
  assert.equal(res.status, 400);
});

test("adding a done, snoozed or muted item brings it back, and its one undo puts that back too", async (c) => {
  const t = await setup([reviewAsk(1)], { settings: { "policy.judge": false } });
  c.after(t.cleanup);
  await t.desk.sync();
  const onDesk = () =>
    [...runSync(t.desk.focus()).sections.now, ...runSync(t.desk.focus()).sections.today].some((x) => x.id === "acme/api#1");
  for (const action of ["done", "snooze", "mute"] as const) {
    runSync(t.desk.act("api#1", action));
    assert.equal(onDesk(), false, action);
    const before = runSync(t.desk.item("api#1")).state;
    const r = await t.desk.add("acme/api#1");
    assert.equal(r.item.card.status, "active", action);
    assert.ok(onDesk(), `${action}: on the main page`);
    runSync(t.desk.undo(r.undo_seq));
    assert.deepEqual(runSync(t.desk.item("api#1")).state, before, `${action}: one undo`);
  }
});

test("what you pin yourself is on your desk at once, reviewed or not; an agent's add waits for Claude's review", async (c) => {
  const f = fakeReview();
  const t = await setup([teamPing(2)], { settings: { "policy.judge": false }, desk: { review: f.review } });
  c.after(t.cleanup);
  await t.desk.sync();
  const onDesk = (id: string) =>
    [...runSync(t.desk.focus()).sections.now, ...runSync(t.desk.focus()).sections.today].some((x) => x.id === id);
  assert.equal(onDesk("acme/api#2"), false, "a team ping is FYI");
  runSync(t.desk.act("api#2", "pin"));
  assert.equal(onDesk("acme/api#2"), true);
  assert.equal(runSync(t.desk.item("api#2")).held, false);

  t.gh.items.set(ID, unknown());
  await t.desk.add(ID, "your call on the token transport", "seer write gate");
  assert.equal(onDesk(ID), false);
  assert.equal(runSync(t.desk.item(ID)).held, true);
});

test("adding several PRs at once starts their AI reviews two at a time, as the background ones run", async (c) => {
  const f = fakeReview();
  const t = await setup([teamPing(2)], { settings: { "policy.judge": false }, desk: { review: f.review } });
  c.after(t.cleanup);
  await t.desk.sync();
  for (const n of [9, 10, 11]) t.gh.items.set(`acme/other#${n}`, makeItem({ repo: "acme/other", number: n, author: "dave" }));
  await Promise.all([9, 10, 11].map((n) => t.desk.add(`acme/other#${n}`)));
  assert.equal(t.desk.generating.size, 2);
});
