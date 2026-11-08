// The event log, auto-resolve and the notifications feed, through a Desk over a FakeGitHub.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "../src/types.ts";
import { idle, reviewAsk, setup } from "./helpers/desk.ts";
import { hoursAgo, NOW } from "./helpers/items.ts";
import { run, runSync } from "./helpers/run.ts";
import { Effect } from "effect";
import { GitHubRateLimited } from "../src/errors.ts";

const later = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
const iso = (h: number) => later(h).toISOString();
const approve = (author: string, at: string) => ({ author, author_bot: false, state: "approved" as const, at, commit: "abc" });
const kinds = (desk: { store: { activity(q: { after: number; limit: number }): { kind: string; item_id: string }[] } }) =>
  desk.store.activity({ after: 0, limit: 100 }).map((e) => `${e.kind} ${e.item_id}`);

test("the first sync logs each item as new; an unchanged sync logs nothing", async () => {
  const t = await setup([reviewAsk(1), reviewAsk(2)]);
  await t.desk.sync();
  assert.deepEqual(kinds(t.desk), ["new acme/api#1", "new acme/api#2"]);
  await t.desk.sync();
  assert.equal(t.desk.store.lastSeq(), 2);
  assert.deepEqual(
    runSync(t.desk.overview()).connectors.map((c) => [c.id, c.name, c.status]),
    [["github", "GitHub", "ok"]],
  );
  t.cleanup();
});

test("a snapshot older than the stored one (the feed and the full pass raced) is dropped, not diffed backwards", async () => {
  const t = await setup([reviewAsk(1)]);
  await t.desk.sync();
  const old = reviewAsk(1);
  const pushed = reviewAsk(1, { updated_at: iso(0.5), head_oid: "def" });
  t.desk.ingest(t.desk.gh, [pushed]);
  t.desk.ingest(t.desk.gh, [old]);
  assert.deepEqual(kinds(t.desk), ["new acme/api#1", "pushed acme/api#1"]);
  assert.equal(t.desk.store.itemsById(["acme/api#1"]).get("acme/api#1")?.head_oid, "def");
  t.cleanup();
});

test("someone else approves: reviewed and resolved; it leaves Now for Resolved, keeping your triage state", async () => {
  const t = await setup([reviewAsk(1), reviewAsk(2)]);
  await t.desk.sync();
  runSync(t.desk.act("api#1", "pin"));
  t.setNow(later(1));
  t.gh.items.set("acme/api#1", reviewAsk(1, { updated_at: iso(0.5), reviews: [approve("bob", iso(0.5))], review_decision: "approved" }));
  await t.desk.sync();
  const log = t.desk.store.activity({ after: 2, limit: 10 });
  assert.deepEqual(
    log.map((e) => [e.kind, e.actor, e.data]),
    [
      ["reviewed", "bob", { state: "approved" }],
      ["resolved", "bob", { reason: "approved by bob" }],
    ],
  );
  assert.ok(log.every((e) => e.source === "github" && e.item_id === "acme/api#1"));

  const q = runSync(t.desk.queue());
  assert.deepEqual(
    q.sections.now.map((c) => c.id),
    ["acme/api#2"],
  );
  // Bob's approval is new activity, but a resolved row carries no "new" dot.
  assert.deepEqual(
    q.resolved.map((c) => [c.id, c.why, c.resolved, c.resolved_at, c.pinned, c.new]),
    [["acme/api#1", "approved by bob", "approved by bob", iso(0.5), true, false]],
  );
  assert.equal(q.sections.now[0]?.resolved_at, null);
  assert.deepEqual(
    runSync(t.desk.focus()).sections.now.map((c) => c.id),
    ["acme/api#2"],
  );
  const board = runSync(t.desk.board("acme-review"));
  assert.ok(![...Object.values(board.sections).flat(), ...board.hidden, ...board.cleared].some((c) => c.id === "acme/api#1"));
  assert.equal(board.board.counts.cleared, 0);
  const d = runSync(t.desk.item("api#1"));
  assert.equal(d.card.resolved, "approved by bob");
  assert.equal(d.state.pinned, true);
  assert.deepEqual(
    d.activity.map((e) => e.kind),
    ["resolved", "reviewed", "new"],
  );
  t.cleanup();
});

test("asked again after the approval: unresolved, and back in Now", async () => {
  const approved = reviewAsk(1, { updated_at: iso(0.5), reviews: [approve("bob", hoursAgo(0.5))], review_decision: "approved" });
  const t = await setup([approved]);
  await t.desk.sync();
  assert.equal(runSync(t.desk.queue()).resolved.length, 1);
  t.setNow(later(2));
  t.gh.items.set(
    "acme/api#1",
    reviewAsk(1, {
      updated_at: iso(1.5),
      reviews: approved.reviews,
      review_decision: "approved",
      request_events: [
        ...approved.request_events,
        { at: iso(1.5), actor: "carol", actor_bot: false, reviewer: "me", reviewer_type: "user" },
      ],
    }),
  );
  await t.desk.sync();
  assert.deepEqual(kinds(t.desk).slice(-2), ["review_requested acme/api#1", "unresolved acme/api#1"]);
  assert.deepEqual(t.desk.store.activity({ after: 0, limit: 10 }).at(-1)?.data, { was: "approved by bob" });
  assert.deepEqual(
    runSync(t.desk.queue()).sections.now.map((c) => c.id),
    ["acme/api#1"],
  );
  t.cleanup();
});

test("an item that leaves every search gets one refresh: merged, resolved, and shown under Resolved for a while", async () => {
  const t = await setup([reviewAsk(1), reviewAsk(2)]);
  await t.desk.sync();
  t.setNow(later(0.25));
  t.gh.items.set("acme/api#1", reviewAsk(1, { state: "merged", merged_by: "dana", closed_at: iso(0.1), updated_at: iso(0.1) }));
  t.gh.detailCalls = [];
  await t.desk.sync();
  assert.deepEqual(t.gh.detailCalls, [["acme/api#1"]]);
  assert.deepEqual(kinds(t.desk).slice(2), ["merged acme/api#1", "resolved acme/api#1"]);
  assert.equal(t.desk.store.activity({ after: 2, limit: 1 })[0]?.actor, "dana");
  assert.deepEqual(
    runSync(t.desk.queue()).resolved.map((c) => [c.id, c.why, c.resolved_at]),
    [["acme/api#1", "merged", iso(0.1)]],
  );

  // Still gone an hour later: not refreshed again, still shown.
  t.setNow(later(1.25));
  t.gh.detailCalls = [];
  await t.desk.sync();
  assert.ok(!t.gh.detailCalls.flat().includes("acme/api#1"));
  assert.equal(runSync(t.desk.queue()).resolved.length, 1);

  // Three days after it left, it's off the desk.
  t.setNow(later(80));
  await t.desk.sync();
  assert.deepEqual(runSync(t.desk.queue()).resolved, []);
  t.cleanup();
});

test("you approved: still in the reviewed-by search, it passes the board's filter to show under Resolved for 3 days", async () => {
  const t = await setup([reviewAsk(1), reviewAsk(2)]);
  const route = t.gh.route;
  t.gh.route = (q) =>
    q.includes("reviewed-by:@me")
      ? [...t.gh.items.values()].filter((i) => i.reviews.some((r) => r.author === "me")).map((i) => i.id)
      : route(q);
  await t.desk.sync();
  t.setNow(later(0.25));
  t.gh.items.set("acme/api#1", reviewAsk(1, { review_requests: [], reviews: [approve("me", iso(0.1))], updated_at: iso(0.1) }));
  await t.desk.sync();
  assert.deepEqual(
    t.desk.store.activity({ after: 2, limit: 10 }).map((e) => [e.kind, e.actor, e.data]),
    [["resolved", "me", { reason: "you approved" }]],
  );
  assert.deepEqual(
    runSync(t.desk.queue()).resolved.map((c) => [c.id, c.why, c.resolved_at]),
    [["acme/api#1", "you approved", iso(0.1)]],
  );
  assert.ok(!runSync(t.desk.focus()).sections.now.some((c) => c.id === "acme/api#1"));

  t.setNow(later(80));
  await t.desk.sync();
  assert.deepEqual(runSync(t.desk.queue()).resolved, [], "three days on, the filter drops it again");
  t.cleanup();
});

test("a resolution with no time (no longer requested) doesn't pass a board's filter, however recently a bot touched the PR", async () => {
  const quiet = reviewAsk(1, {
    created_at: hoursAgo(30 * 24),
    head_committed_at: hoursAgo(30 * 24),
    review_requests: [],
    request_events: [{ at: hoursAgo(20 * 24), actor: "carol", actor_bot: false, reviewer: "me", reviewer_type: "user" }],
    updated_at: hoursAgo(1),
  });
  const t = await setup([quiet]);
  const route = t.gh.route;
  t.gh.route = (q) => (q.includes("mentions:@me") ? ["acme/api#1"] : route(q));
  await t.desk.sync();
  assert.equal(runSync(t.desk.item("api#1")).card.resolved, "no longer requested");
  assert.deepEqual(runSync(t.desk.queue()).resolved, [], "quiet for 20 days: the Mentions filter drops it, as before it resolved");
  t.cleanup();
});

test("unrequested without a review: request removed, resolved as no longer requested", async () => {
  const t = await setup([reviewAsk(1)]);
  await t.desk.sync();
  t.setNow(later(1));
  t.gh.items.set("acme/api#1", reviewAsk(1, { review_requests: [], updated_at: iso(0.5) }));
  await t.desk.sync();
  assert.deepEqual(kinds(t.desk).slice(1), ["request_removed acme/api#1", "resolved acme/api#1"]);
  assert.deepEqual(
    runSync(t.desk.queue()).resolved.map((c) => c.why),
    ["no longer requested"],
  );
  t.cleanup();
});

test("settings: never resolving on others' approvals puts it back", async () => {
  const t = await setup([reviewAsk(1, { reviews: [approve("bob", hoursAgo(0.5))], review_decision: "approved" })]);
  await t.desk.sync();
  assert.equal(runSync(t.desk.queue()).resolved.length, 1);
  runSync(t.desk.putSettings({ set: { "github.resolve_on_others_approval": "never" } }));
  await idle(t.desk);
  assert.equal(runSync(t.desk.queue()).resolved.length, 0);
  assert.equal(runSync(t.desk.queue()).sections.now[0]?.id, "acme/api#1");
  t.cleanup();
});

test("notifications: a tracked item is refreshed and diffed right away; the poll honours X-Poll-Interval", async () => {
  const t = await setup([reviewAsk(1)]);
  await t.desk.sync();
  await run(t.desk.gh.poll()); // the first poll learns where the feed stands
  assert.equal(t.gh.feedCalls.length, 1);
  assert.equal(t.gh.feedCalls[0]?.since, hoursAgo(1));

  t.setNow(later(1));
  t.gh.items.set("acme/api#1", reviewAsk(1, { updated_at: iso(0.9), comments: [{ author: "dana", author_bot: false, at: iso(0.9) }] }));
  t.gh.threads = [{ thread: "t1", item: "acme/api#1", reason: "review_requested", updated_at: iso(0.9) }];
  t.gh.pollInterval = 120;
  t.gh.detailCalls = [];
  const searches = t.gh.searches.length;
  await run(t.desk.gh.poll());
  assert.deepEqual(t.gh.detailCalls, [["acme/api#1"]]);
  assert.equal(t.gh.searches.length, searches, "no reconcile for a tracked item");
  assert.deepEqual(kinds(t.desk).at(-1), "commented acme/api#1");
  assert.equal(t.desk.gh.feed.interval, 120);
  assert.equal(t.gh.feedCalls[1]?.last_modified, "lm-1");
  // The same thread update again is skipped.
  t.gh.threads = [{ thread: "t1", item: "acme/api#1", reason: "review_requested", updated_at: iso(0.9) }];
  t.gh.detailCalls = [];
  await run(t.desk.gh.poll());
  assert.deepEqual(t.gh.detailCalls, []);
  t.cleanup();
});

test("notifications: something new asking for you starts an early reconcile; other noise doesn't", async () => {
  const t = await setup([]);
  await t.desk.sync();
  await run(t.desk.gh.poll());
  t.gh.items.set("acme/api#7", reviewAsk(7));
  t.gh.threads = [
    { thread: "t2", item: "acme/api#8", reason: "subscribed", updated_at: hoursAgo(0.1) },
    { thread: "t3", item: null, reason: "ci_activity", updated_at: hoursAgo(0.1) },
  ];
  const before = t.gh.searches.length;
  await run(t.desk.gh.poll());
  await idle(t.desk);
  assert.equal(t.gh.searches.length, before);
  t.gh.threads = [{ thread: "t4", item: "acme/api#7", reason: "review_requested", updated_at: hoursAgo(0.1) }];
  await run(t.desk.gh.poll());
  await idle(t.desk);
  assert.ok(t.gh.searches.length > before);
  assert.deepEqual(kinds(t.desk), ["new acme/api#7"]);
  t.cleanup();
});

test("notifications: a mention on a tracked item is logged once; not on the first poll", async () => {
  const t = await setup([reviewAsk(1)]);
  await t.desk.sync();
  t.gh.threads = [{ thread: "t1", item: "acme/api#1", reason: "mention", updated_at: hoursAgo(0.5) }];
  await run(t.desk.gh.poll());
  assert.ok(!kinds(t.desk).includes("mentioned acme/api#1"));
  t.gh.threads = [{ thread: "t9", item: "acme/api#1", reason: "team_mention", updated_at: hoursAgo(0.2) }];
  await run(t.desk.gh.poll());
  t.gh.threads = [{ thread: "t9", item: "acme/api#1", reason: "team_mention", updated_at: hoursAgo(0.1) }];
  await run(t.desk.gh.poll());
  const mentions = t.desk.store.activity({ after: 0, limit: 10 }).filter((e) => e.kind === "mentioned");
  assert.deepEqual(
    mentions.map((e) => e.data),
    [{ reason: "team_mention" }],
  );
  t.cleanup();
});

test("notifications: a failed refresh leaves the cursor, so the next poll handles the same threads", async () => {
  const t = await setup([reviewAsk(1)]);
  await t.desk.sync();
  await run(t.desk.gh.poll());
  const since = t.desk.gh.feed.since;
  t.setNow(later(1));
  t.gh.items.set("acme/api#1", reviewAsk(1, { updated_at: iso(0.9), comments: [{ author: "dana", author_bot: false, at: iso(0.9) }] }));
  const threads = [{ thread: "t1", item: "acme/api#1", reason: "mention", updated_at: iso(0.9) }];
  const details = t.gh.details.bind(t.gh);
  // details fails only with a rate limit; anything else it dies with leaves the cursor too
  t.gh.details = () => Effect.die(new Error("GitHub HTTP 500"));
  t.gh.threads = threads;
  await run(t.desk.gh.poll());
  assert.equal(t.desk.gh.feedError, "GitHub HTTP 500");
  assert.equal(t.desk.gh.feed.since, since);
  assert.deepEqual(t.desk.gh.feed.seen, {});

  t.gh.details = details;
  t.gh.threads = threads; // GitHub sends them again: the cursor didn't move
  await run(t.desk.gh.poll());
  assert.equal(t.gh.feedCalls.at(-1)?.since, since);
  assert.deepEqual(kinds(t.desk).slice(1), ["commented acme/api#1", "mentioned acme/api#1"]);
  assert.notEqual(t.desk.gh.feed.since, since);
  t.cleanup();
});

test("notifications: a rate-limit pause skips polls", async () => {
  const t = await setup([reviewAsk(1)]);
  await t.desk.sync();
  t.desk.gh.pausedUntil = Date.now() + 60_000;
  await run(t.desk.gh.poll());
  assert.equal(t.gh.feedCalls.length, 0);
  assert.equal(runSync(t.desk.overview()).connectors[0]?.status, "paused");
  t.gh.notifications = () =>
    Effect.fail(new GitHubRateLimited({ resetAt: iso(1), message: `GitHub rate limited until ${iso(1)} (HTTP 403)` }));
  t.desk.gh.pausedUntil = 0;
  await run(t.desk.gh.poll());
  assert.equal(t.desk.gh.pausedUntil, Date.parse(iso(1)));
  t.cleanup();
});

test("activity: after, item and limit; a long-poll answers when an event lands, or when the wait is up", async () => {
  const t = await setup([reviewAsk(1), reviewAsk(2)]);
  await t.desk.sync();
  assert.deepEqual(
    (await t.desk.activity({ after: 1 })).events.map((e) => e.seq),
    [2],
  );
  assert.deepEqual(await t.desk.activity({ after: 0, item: "api#2" }).then((p) => [p.events.map((e) => e.item_id), p.last_seq]), [
    ["acme/api#2"],
    2,
  ]);
  assert.equal((await t.desk.activity({ after: 0, limit: 1 })).last_seq, 1);
  // Nothing new: the cursor stays at the log's end.
  const empty = await t.desk.activity({ after: 2 });
  assert.deepEqual(empty, { events: [], last_seq: 2 });

  const started = Date.now();
  const waiting = t.desk.activity({ after: 2, wait: 30 });
  setTimeout(() => {
    t.desk.record("github", [{ at: NOW.toISOString(), item_id: "acme/api#1", kind: "commented", actor: "dana", data: {} }]);
  }, 20);
  const page = await waiting;
  assert.deepEqual(
    page.events.map((e) => [e.seq, e.kind]),
    [[3, "commented"]],
  );
  assert.ok(Date.now() - started < 5000);

  const ac = new AbortController();
  const aborted = t.desk.activity({ after: 3, wait: 30, signal: ac.signal });
  ac.abort();
  assert.deepEqual(await aborted, { events: [], last_seq: 3 });

  // An exact id still works once the item is gone from the desk.
  assert.deepEqual((await t.desk.activity({ item: "acme/gone#9" })).events, []);
  t.cleanup();
});

test("done on a resolved item stays done when it comes back", async () => {
  const approved = (o: Partial<Item> = {}) => reviewAsk(1, { reviews: [approve("bob", hoursAgo(0.5))], review_decision: "approved", ...o });
  const t = await setup([approved()]);
  await t.desk.sync();
  runSync(t.desk.act("api#1", "done"));
  assert.equal(runSync(t.desk.queue()).resolved[0]?.status, "done");
  runSync(t.desk.putSettings({ set: { "github.resolve_on_others_approval": "never" } }));
  await idle(t.desk);
  assert.deepEqual(
    runSync(t.desk.queue()).cleared.map((c) => [c.id, c.status]),
    [["acme/api#1", "done"]],
  );
  t.cleanup();
});
