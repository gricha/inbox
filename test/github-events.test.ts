import assert from "node:assert/strict";
import { test } from "node:test";
import { itemEvents, type DiffContext } from "../src/connectors/github-events.ts";
import type { Item } from "../src/types.ts";
import { hoursAgo, makeItem, NOW } from "./helpers/items.ts";

const ctx: DiffContext = { me: "me", teams: ["ml-team"], bots: ["acme-junior"], now: NOW.toISOString() };
const LAST_FETCH = hoursAgo(1);
const base = (o: Partial<Item> = {}) => makeItem({ detail_at: LAST_FETCH, ...o });
const asked = (o: Partial<Item> = {}) =>
  base({
    review_requests: [{ reviewer: "me", type: "user", codeowner: false }],
    request_events: [{ at: hoursAgo(5), actor: "alice", actor_bot: false, reviewer: "me", reviewer_type: "user" }],
    ...o,
  });
const kinds = (prev: Item | null, next: Item) => itemEvents(prev, next, ctx).map((e) => [e.kind, e.actor, e.data]);
const review = (author: string, state: Item["reviews"][number]["state"], at: string, author_bot = false) => ({
  author,
  author_bot,
  state,
  at,
  commit: "abc",
});

test("an item seen for the first time is new, and nothing else", () => {
  const events = itemEvents(null, asked(), ctx);
  assert.deepEqual(events, [{ at: NOW.toISOString(), item_id: "acme/api#1", kind: "new", actor: "alice", data: { kind: "pr" } }]);
});

test("the same snapshot twice says nothing", () => {
  const it = asked({
    reviews: [review("bob", "approved", hoursAgo(3))],
    comments: [{ author: "bob", author_bot: false, at: hoursAgo(2) }],
  });
  assert.deepEqual(itemEvents(it, { ...it, detail_at: NOW.toISOString() }, ctx), []);
});

test("review requested: for you by name, with who asked and when", () => {
  const next = asked({
    request_events: [{ at: hoursAgo(0.5), actor: "alice", actor_bot: false, reviewer: "me", reviewer_type: "user" }],
  });
  const events = itemEvents(base(), next, ctx);
  assert.deepEqual(events, [
    {
      at: hoursAgo(0.5),
      item_id: "acme/api#1",
      kind: "review_requested",
      actor: "alice",
      data: { reviewer: "me", type: "user", codeowner: false },
    },
  ]);
});

test("review requested: for your team; other people's and other teams' requests are ignored", () => {
  const next = base({
    review_requests: [
      { reviewer: "ML-Team", type: "team", codeowner: true },
      { reviewer: "carol", type: "user", codeowner: false },
      { reviewer: "web-team", type: "team", codeowner: true },
    ],
    request_events: [{ at: hoursAgo(0.2), actor: "bot-x", actor_bot: true, reviewer: "ML-Team", reviewer_type: "team" }],
  });
  assert.deepEqual(kinds(base(), next), [["review_requested", "bot-x", { reviewer: "ML-Team", type: "team", codeowner: true }]]);
});

test("re-requested while the request stands: a new request event is a new ask", () => {
  const prev = asked();
  const next = asked({
    request_events: [
      ...prev.request_events,
      { at: hoursAgo(0.1), actor: "alice", actor_bot: false, reviewer: "me", reviewer_type: "user" },
    ],
  });
  assert.deepEqual(kinds(prev, next), [["review_requested", "alice", { reviewer: "me", type: "user", codeowner: false }]]);
});

test("a request whose event predates the last fetch is still new, timed when noticed", () => {
  const next = asked();
  const [e] = itemEvents(base(), next, ctx);
  assert.equal(e?.kind, "review_requested");
  assert.equal(e?.actor, "alice");
  assert.equal(e?.at, NOW.toISOString());
});

test("request removed; but not when you reviewed, and not on merge", () => {
  const prev = asked();
  assert.deepEqual(kinds(prev, base()), [["request_removed", "", { reviewer: "me", type: "user" }]]);
  const reviewed = base({ reviews: [review("me", "approved", hoursAgo(0.2))] });
  assert.deepEqual(kinds(prev, reviewed), []);
  const merged = base({ state: "merged", merged_by: "alice", closed_at: hoursAgo(0.3) });
  assert.deepEqual(kinds(prev, merged), [["merged", "alice", {}]]);
});

test("a teammate's review clears the team request: removed", () => {
  const team = { reviewer: "ml-team", type: "team" as const, codeowner: true };
  const prev = base({ review_requests: [team] });
  const next = base({ reviews: [review("dana", "approved", hoursAgo(0.2))] });
  assert.deepEqual(kinds(prev, next), [
    ["reviewed", "dana", { state: "approved" }],
    ["request_removed", "", { reviewer: "ml-team", type: "team" }],
  ]);
});

test("reviews by others: approved, changes requested, commented; not you, bots, pending or dismissals", () => {
  const prev = base({ reviews: [review("bob", "approved", hoursAgo(3))] });
  const next = base({
    reviews: [
      review("bob", "dismissed", hoursAgo(3)),
      review("carol", "changes_requested", hoursAgo(0.9)),
      review("me", "commented", hoursAgo(0.8)),
      review("dependabot", "approved", hoursAgo(0.7), true),
      review("acme-junior", "commented", hoursAgo(0.6)),
      review("dana", "commented", hoursAgo(0.5)),
      review("erin", "pending", hoursAgo(0.4)),
      review("frank", "approved", hoursAgo(0.3)),
    ],
  });
  assert.deepEqual(kinds(prev, next), [
    ["reviewed", "carol", { state: "changes_requested" }],
    ["reviewed", "dana", { state: "commented" }],
    ["reviewed", "frank", { state: "approved" }],
  ]);
});

test("an old review that slides into the window isn't replayed", () => {
  const prev = base({ reviews: [review("bob", "commented", hoursAgo(2))] });
  const next = base({ reviews: [review("old", "approved", hoursAgo(30)), review("bob", "commented", hoursAgo(2))] });
  assert.deepEqual(kinds(prev, next), []);
});

test("pushed: by whom, timed after the last fetch; the CI restart it causes isn't news", () => {
  const prev = base({ head_oid: "a1", ci: "green" });
  const next = base({ head_oid: "b2", head_author: "alice", head_committed_at: hoursAgo(30), ci: "pending" });
  const events = itemEvents(prev, next, ctx);
  assert.deepEqual(
    events.map((e) => [e.kind, e.actor, e.data, e.at]),
    [["pushed", "alice", { oid: "b2" }, NOW.toISOString()]],
  );
  // A commit dated after the last fetch keeps its own time.
  const fresh = base({ head_oid: "c3", head_author: "alice", head_committed_at: hoursAgo(0.25) });
  assert.equal(itemEvents(prev, fresh, ctx)[0]?.at, hoursAgo(0.25));
});

test("CI transitions: red, green, pending; not to none", () => {
  const at = (from: Item["ci"], to: Item["ci"]) => kinds(base({ ci: from }), base({ ci: to }));
  assert.deepEqual(at("pending", "red"), [["ci", "", { from: "pending", to: "red" }]]);
  assert.deepEqual(at("red", "green"), [["ci", "", { from: "red", to: "green" }]]);
  assert.deepEqual(at("green", "pending"), [["ci", "", { from: "green", to: "pending" }]]);
  assert.deepEqual(at("green", "none"), []);
  // A push whose CI already failed reports both.
  assert.deepEqual(
    kinds(base({ head_oid: "a", ci: "green" }), base({ head_oid: "b", ci: "red", head_author: "me" })).map(([k]) => k),
    ["pushed", "ci"],
  );
});

test("your PR starting to conflict with its base; not while it stays conflicting, nor while GitHub works it out", () => {
  const at = (from: Item["mergeable"], to: Item["mergeable"]) => kinds(base({ mergeable: from }), base({ mergeable: to }));
  assert.deepEqual(at("clean", "conflict"), [["conflict", "", { base: "main" }]]);
  assert.deepEqual(at("unknown", "conflict"), [["conflict", "", { base: "main" }]]);
  assert.deepEqual(at("conflict", "conflict"), []);
  assert.deepEqual(at("clean", "unknown"), []);
});

test("comments by others; not you, not bots, and not old ones shifting into the last-10 window", () => {
  const c = (author: string, at: string, author_bot = false) => ({ author, author_bot, at });
  const prev = base({ comments: [c("bob", hoursAgo(5))] });
  const next = base({
    comments: [
      c("old", hoursAgo(9)),
      c("bob", hoursAgo(5)),
      c("me", hoursAgo(0.5)),
      c("sentry-io", hoursAgo(0.4), true),
      c("acme-junior", hoursAgo(0.35)),
      c("carol", hoursAgo(0.3)),
    ],
  });
  assert.deepEqual(kinds(prev, next), [["commented", "carol", {}]]);
  assert.equal(itemEvents(prev, next, ctx)[0]?.at, hoursAgo(0.3));
});

test("merged, closed, reopened", () => {
  const open = base();
  assert.deepEqual(kinds(open, base({ state: "merged", merged_by: "dana", closed_at: hoursAgo(0.2) })), [["merged", "dana", {}]]);
  assert.deepEqual(kinds(open, base({ state: "closed", closed_at: hoursAgo(0.2) })), [["closed", "", {}]]);
  assert.deepEqual(kinds(base({ state: "closed" }), open), [["reopened", "", {}]]);
  // A snapshot stored before closed_at existed: timed when noticed.
  assert.equal(itemEvents(open, base({ state: "merged" }), ctx)[0]?.at, NOW.toISOString());
});

test("assigned to you", () => {
  assert.deepEqual(kinds(base({ assignees: ["carol"] }), base({ assignees: ["carol", "Me"] })), [["assigned", "", {}]]);
  assert.deepEqual(kinds(base({ assignees: ["me"] }), base({ assignees: ["me", "carol"] })), []);
});

test("several changes at once come out in time order", () => {
  const prev = asked({ ci: "pending" });
  const next = asked({
    ci: "red",
    reviews: [review("bob", "approved", hoursAgo(0.5))],
    comments: [{ author: "carol", author_bot: false, at: hoursAgo(0.75) }],
  });
  const events = itemEvents(prev, next, ctx);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["commented", "reviewed", "ci"],
  );
  assert.ok(events.every((e, i) => i === 0 || events[i - 1]!.at <= e.at));
});
