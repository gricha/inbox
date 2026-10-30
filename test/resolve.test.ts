import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfigText, parseConfig } from "../src/config.ts";
import { resolution } from "../src/resolve.ts";
import { DEFAULTS, type Settings } from "../src/settings.ts";
import { analyze } from "../src/signals.ts";
import type { Item } from "../src/types.ts";
import { hoursAgo, makeContext, makeItem, NOW } from "./helpers/items.ts";

const cfg = parseConfig(defaultConfigText({ workOrgs: ["acme"] })).loaded!.config;
const ctx = makeContext();
const resolve = (item: Item, settings: Partial<Settings> = {}) =>
  resolution(item, analyze(item, ctx, cfg, NOW).signals, { ...DEFAULTS, ...settings }, ctx.teams)?.reason ?? null;

const ask = (at: string, reviewer = "me", type: "user" | "team" = "user") => ({
  at,
  actor: "alice",
  actor_bot: false,
  reviewer,
  reviewer_type: type,
});
const review = (author: string, state: Item["reviews"][number]["state"], at: string, author_bot = false) => ({
  author,
  author_bot,
  state,
  at,
  commit: "abc",
});
// GitHub's decision once an approval is enough to merge; tests of "required" set it themselves.
const asked = (o: Partial<Item> = {}) =>
  makeItem({
    review_requests: [{ reviewer: "me", type: "user", codeowner: false }],
    request_events: [ask(hoursAgo(10))],
    review_decision: "approved",
    ...o,
  });
const teamAsked = (o: Partial<Item> = {}) =>
  makeItem({
    review_requests: [{ reviewer: "ml-team", type: "team", codeowner: true }],
    request_events: [ask(hoursAgo(10), "ml-team", "team")],
    review_decision: "approved",
    ...o,
  });

test("merged and closed resolve anything, your own PRs and issues too", () => {
  assert.equal(resolve(asked({ state: "merged" })), "merged");
  assert.equal(resolve(makeItem({ author: "me", state: "closed" })), "closed");
  assert.equal(resolve(makeItem({ kind: "issue", state: "closed" })), "closed");
  const r = resolution(
    makeItem({ state: "merged", merged_by: "dana", closed_at: hoursAgo(1) }),
    analyze(makeItem(), ctx, cfg, NOW).signals,
    DEFAULTS,
    [],
  );
  assert.deepEqual(r, { reason: "merged", actor: "dana", at: hoursAgo(1) });
});

test("an open ask stays open", () => {
  assert.equal(resolve(asked()), null);
  assert.equal(resolve(teamAsked()), null);
});

test("someone else approved after you were asked", () => {
  const it = asked({ reviews: [review("bob", "commented", hoursAgo(6)), review("carol", "approved", hoursAgo(2))] });
  assert.equal(resolve(it), "approved by carol");
  const r = resolution(it, analyze(it, ctx, cfg, NOW).signals, DEFAULTS, ctx.teams);
  assert.deepEqual(r, { reason: "approved by carol", actor: "carol", at: hoursAgo(2) });
  // The first approval after the ask names it.
  assert.equal(
    resolve(asked({ reviews: [review("dan", "approved", hoursAgo(5)), review("carol", "approved", hoursAgo(2))] })),
    "approved by dan",
  );
});

test("approvals that don't count: before the ask, yours, a bot's, or taken back", () => {
  assert.equal(resolve(asked({ reviews: [review("carol", "approved", hoursAgo(20))] })), null);
  assert.equal(resolve(asked({ reviews: [review("me", "approved", hoursAgo(2))] })), null);
  assert.equal(resolve(asked({ reviews: [review("renovate", "approved", hoursAgo(2), true)] })), null);
  assert.equal(resolve(asked({ reviews: [review("helper[bot]", "approved", hoursAgo(2))] })), null);
  assert.equal(resolve(asked({ reviews: [review("ci-buddy", "approved", hoursAgo(2))] }), { "github.bots": ["ci-buddy"] }), null);
  assert.equal(
    resolve(asked({ reviews: [review("carol", "approved", hoursAgo(3)), review("carol", "changes_requested", hoursAgo(1))] })),
    null,
  );
  assert.equal(resolve(asked({ reviews: [review("carol", "approved", hoursAgo(3)), review("carol", "dismissed", hoursAgo(1))] })), null);
  // A later comment doesn't take it back.
  assert.equal(
    resolve(asked({ reviews: [review("carol", "approved", hoursAgo(3)), review("carol", "commented", hoursAgo(1))] })),
    "approved by carol",
  );
});

test("asked again after the approval: back", () => {
  const it = asked({ request_events: [ask(hoursAgo(10)), ask(hoursAgo(1))], reviews: [review("carol", "approved", hoursAgo(3))] });
  assert.equal(resolve(it), null);
});

test("your changes request keeps it yours even when someone else approves", () => {
  const it = asked({ reviews: [review("me", "changes_requested", hoursAgo(5)), review("carol", "approved", hoursAgo(2))] });
  assert.equal(resolve(it), null);
});

test("an approval that isn't enough to merge (more reviews required) leaves it yours", () => {
  const reviews = [review("carol", "approved", hoursAgo(2))];
  assert.equal(resolve(teamAsked({ reviews, review_decision: "required" })), null);
  assert.equal(resolve(asked({ reviews, review_decision: "required" })), null);
});

test("resolve_on_others_approval: team_only and never", () => {
  const direct = asked({ reviews: [review("carol", "approved", hoursAgo(2))] });
  const team = teamAsked({ reviews: [review("carol", "approved", hoursAgo(2))] });
  assert.equal(resolve(direct, { "github.resolve_on_others_approval": "team_only" }), null);
  assert.equal(resolve(team, { "github.resolve_on_others_approval": "team_only" }), "approved by carol");
  assert.equal(resolve(team, { "github.resolve_on_others_approval": "never" }), null);
  assert.equal(resolve(team, { "github.resolve_on_others_approval": "always" }), "approved by carol");
});

test("no longer requested and never reviewed; reviewing or never being asked keeps it", () => {
  assert.equal(resolve(makeItem({ request_events: [ask(hoursAgo(10))] })), "no longer requested");
  assert.equal(resolve(makeItem({ request_events: [ask(hoursAgo(10), "ml-team", "team")] })), "no longer requested");
  assert.equal(resolve(makeItem({ request_events: [ask(hoursAgo(10))], reviews: [review("me", "commented", hoursAgo(4))] })), null);
  assert.equal(resolve(makeItem()), null);
  assert.equal(resolve(makeItem({ request_events: [ask(hoursAgo(10), "web-team", "team")] })), null);
});

// After you approve, GitHub drops your ask: review_requests no longer lists you.
const youApproved = (o: Partial<Item> = {}) =>
  makeItem({ request_events: [ask(hoursAgo(10))], reviews: [review("me", "approved", hoursAgo(2))], ...o });

test("you approved: resolved by you, whatever else GitHub still needs", () => {
  const it = youApproved();
  assert.deepEqual(resolution(it, analyze(it, ctx, cfg, NOW).signals, DEFAULTS, ctx.teams), {
    reason: "you approved",
    actor: "me",
    at: hoursAgo(2),
  });
  assert.equal(resolve(youApproved({ review_decision: "required" })), "you approved", "more reviews required, but not yours");
  assert.equal(resolve(youApproved({ request_events: [ask(hoursAgo(10), "ml-team", "team")] })), "you approved", "asked via your team");
  // A later comment (a thread reply) doesn't take it back; yours names it before someone else's approval.
  const more = [review("me", "approved", hoursAgo(3)), review("carol", "approved", hoursAgo(2)), review("me", "commented", hoursAgo(1))];
  assert.equal(resolve(youApproved({ reviews: more, review_decision: "approved" })), "you approved");
  assert.equal(resolve(youApproved(), { "github.resolve_on_others_approval": "never" }), "you approved", "not about others' approvals");
});

test("you approved, then asked again (or still asked): back", () => {
  assert.equal(resolve(youApproved({ request_events: [ask(hoursAgo(10)), ask(hoursAgo(1))] })), null);
  assert.equal(
    resolve(youApproved({ request_events: [ask(hoursAgo(10)), ask(hoursAgo(1))], review_requests: [] })),
    null,
    "asked again after your approval, even if that ask was later withdrawn",
  );
  assert.equal(
    resolve(youApproved({ review_requests: [{ reviewer: "ml-team", type: "team", codeowner: true }] })),
    null,
    "GitHub still asks you",
  );
});

test("you approved, then a push or someone else's reply: back where its rules put it", () => {
  const pushed = youApproved({ reviews: [review("me", "approved", hoursAgo(2))], head_oid: "def", head_committed_at: hoursAgo(1) });
  assert.equal(resolve(pushed), null, "new commits since your approval");
  assert.equal(
    resolve(youApproved({ head_oid: "def", head_author: "me", head_committed_at: hoursAgo(1) })),
    "you approved",
    "your own push",
  );
  const reply = [{ author: "alice", author_bot: false, at: hoursAgo(1) }];
  assert.equal(resolve(youApproved({ comments: reply, comments_total: 1 })), null, "the author @mentions you after it");
  assert.equal(
    resolve(youApproved({ comments: [...reply, { author: "me", author_bot: false, at: hoursAgo(0.5) }], comments_total: 2 })),
    "you approved",
    "you answered",
  );
  assert.equal(resolve(youApproved({ comments: [{ author: "ci-bot[bot]", author_bot: true, at: hoursAgo(1) }] })), "you approved", "a bot");
  // Someone else approving after you: still resolved, under their name.
  const both = [review("me", "approved", hoursAgo(3)), review("carol", "approved", hoursAgo(1))];
  assert.equal(resolve(youApproved({ reviews: both, review_decision: "approved" })), "approved by carol");
});

test("your approval doesn't resolve when it isn't your latest verdict, nor when nobody asked you", () => {
  const taken = [review("me", "approved", hoursAgo(3)), review("me", "changes_requested", hoursAgo(1))];
  assert.equal(resolve(youApproved({ reviews: taken })), null, "your changes request still doesn't resolve");
  assert.equal(resolve(youApproved({ reviews: [review("me", "approved", hoursAgo(3)), review("me", "dismissed", hoursAgo(1))] })), null);
  assert.equal(resolve(youApproved({ reviews: [review("me", "changes_requested", hoursAgo(2))] })), null);
  assert.equal(resolve(youApproved({ request_events: [] })), null, "nobody asked you");
  assert.equal(resolve(youApproved({ author: "me" })), null, "your own PR");
});

test("your own PRs and issues only resolve by closing", () => {
  const mine = makeItem({ author: "me", request_events: [ask(hoursAgo(10))], reviews: [review("carol", "approved", hoursAgo(2))] });
  assert.equal(resolve(mine), null);
  assert.equal(resolve(makeItem({ kind: "issue", request_events: [ask(hoursAgo(10))] })), null);
});
