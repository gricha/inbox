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
const asked = (o: Partial<Item> = {}) =>
  makeItem({ review_requests: [{ reviewer: "me", type: "user", codeowner: false }], request_events: [ask(hoursAgo(10))], ...o });
const teamAsked = (o: Partial<Item> = {}) =>
  makeItem({
    review_requests: [{ reviewer: "ml-team", type: "team", codeowner: true }],
    request_events: [ask(hoursAgo(10), "ml-team", "team")],
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

test("your own PRs and issues only resolve by closing", () => {
  const mine = makeItem({ author: "me", request_events: [ask(hoursAgo(10))], reviews: [review("carol", "approved", hoursAgo(2))] });
  assert.equal(resolve(mine), null);
  assert.equal(resolve(makeItem({ kind: "issue", request_events: [ask(hoursAgo(10))] })), null);
});
