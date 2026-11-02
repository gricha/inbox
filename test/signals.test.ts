import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../src/expr.ts";
import { analyze } from "../src/signals.ts";
import { parseConfig, defaultConfigText } from "../src/config.ts";
import { hoursAgo, makeContext, makeItem, NOW } from "./helpers/items.ts";

const cfg = parseConfig(defaultConfigText({ workOrgs: ["acme"] })).loaded!.config;
const ctx = makeContext();

test("direct ask by a human", () => {
  const s = analyze(
    makeItem({
      review_requests: [{ reviewer: "me", type: "user", codeowner: false }],
      request_events: [{ at: hoursAgo(5), actor: "alice", actor_bot: false, reviewer: "me", reviewer_type: "user" }],
    }),
    ctx,
    cfg,
    NOW,
  ).signals;
  assert.equal(s.me.requested, true);
  assert.equal(s.me.requested_direct, true);
  assert.equal(s.me.requested_by, "alice");
  assert.equal(s.me.requested_by_bot, false);
  assert.equal(Math.round(s.me.requested_hours), 5);
});

test("team CODEOWNERS ping added by a bot", () => {
  const a = analyze(
    makeItem({
      author: "carol",
      review_requests: [
        { reviewer: "ml-team", type: "team", codeowner: true },
        { reviewer: "other-team", type: "team", codeowner: true },
      ],
      request_events: [{ at: hoursAgo(3), actor: "helper-bot", actor_bot: true, reviewer: "ml-team", reviewer_type: "team" }],
    }),
    ctx,
    cfg,
    NOW,
  );
  assert.equal(a.signals.me.requested, true);
  assert.equal(a.signals.me.requested_direct, false);
  assert.equal(a.signals.me.requested_team, "ml-team");
  assert.equal(a.signals.me.requested_codeowner, true);
  assert.equal(a.signals.me.requested_by_bot, true);
  assert.equal(a.signals.author.close, false);
  assert.equal(a.waiting_since, hoursAgo(3));
});

test("requests to other teams don't count", () => {
  const s = analyze(makeItem({ review_requests: [{ reviewer: "other-team", type: "team", codeowner: true }] }), ctx, cfg, NOW).signals;
  assert.equal(s.me.requested, false);
  assert.equal(s.me.requested_hours, -1);
});

test("your review, then new commits from the author", () => {
  const s = analyze(
    makeItem({
      reviews: [{ author: "me", author_bot: false, state: "changes_requested", at: hoursAgo(20), commit: "" }],
      head_committed_at: hoursAgo(2),
      head_author: "alice",
    }),
    ctx,
    cfg,
    NOW,
  ).signals;
  assert.equal(s.me.reviewed, true);
  assert.equal(s.me.review_state, "changes_requested");
  assert.equal(s.me.pushed_since_review, true);
  assert.equal(s.me.new_activity, true);
  assert.equal(Math.round(s.item.activity_hours), 2);
});

test("your PR: others' comments are new activity, bots are not", () => {
  const base = { author: "me", head_author: "me", head_committed_at: hoursAgo(30), created_at: hoursAgo(50) };
  const quiet = analyze(makeItem({ ...base, comments: [{ author: "codecov", author_bot: true, at: hoursAgo(1) }] }), ctx, cfg, NOW).signals;
  assert.equal(quiet.me.author, true);
  assert.equal(quiet.me.new_activity, false);
  const busy = analyze(makeItem({ ...base, thread_last: [{ author: "bob", author_bot: false, at: hoursAgo(1) }] }), ctx, cfg, NOW).signals;
  assert.equal(busy.me.new_activity, true);
});

test("approvals, affinity and repo facts", () => {
  const s = analyze(
    makeItem({
      reviews: [
        { author: "bob", author_bot: false, state: "changes_requested", at: hoursAgo(10), commit: "" },
        { author: "bob", author_bot: false, state: "approved", at: hoursAgo(5), commit: "" },
        { author: "dan", author_bot: false, state: "commented", at: hoursAgo(4), commit: "" },
        { author: "eve", author_bot: false, state: "approved", at: hoursAgo(3), commit: "" },
      ],
    }),
    ctx,
    cfg,
    NOW,
  ).signals;
  assert.equal(s.pr.approvals, 2);
  assert.equal(s.author.engaged_90d, 12);
  assert.equal(s.author.close, true);
  assert.equal(s.repo.my_prs_90d, 4);
  assert.equal(s.repo.mine, false);
  assert.equal(analyze(makeItem({ repo: "me/dotfiles" }), ctx, cfg, NOW).signals.repo.mine, true);
});

test("configured bots", () => {
  const botCfg = { ...cfg, signals: { ...cfg.signals, bots: ["Renovate"] } };
  const s = analyze(makeItem({ author: "renovate" }), ctx, botCfg, NOW).signals;
  assert.equal(s.author.bot, true);
  assert.equal(s.author.close, false);
});

test("bot thread comments on your PR are not activity", () => {
  const base = { author: "me", head_author: "me", head_committed_at: hoursAgo(30), created_at: hoursAgo(50) };
  const s = analyze(makeItem({ ...base, thread_last: [{ author: "cursor", author_bot: true, at: hoursAgo(1) }] }), ctx, cfg, NOW).signals;
  assert.equal(s.me.new_activity, false);
});

test("a thread reply doesn't hide your changes request; pushes are compared by commit", () => {
  const item = makeItem({
    head_oid: "c2",
    head_committed_at: hoursAgo(2),
    reviews: [
      { author: "me", author_bot: false, state: "changes_requested", at: hoursAgo(20), commit: "c1" },
      { author: "me", author_bot: false, state: "commented", at: hoursAgo(1), commit: "c2" },
    ],
  });
  const s = analyze(item, ctx, cfg, NOW).signals;
  assert.equal(s.me.review_state, "changes_requested");
  assert.equal(s.me.pushed_since_review, true);
  // A backdated commit still counts: the head moved past the reviewed commit.
  const backdated = analyze({ ...item, head_committed_at: hoursAgo(100) }, ctx, cfg, NOW).signals;
  assert.equal(backdated.me.pushed_since_review, true);
  const same = analyze({ ...item, head_oid: "c1" }, ctx, cfg, NOW).signals;
  assert.equal(same.me.pushed_since_review, false);
});

test("future-dated commits are clamped to GitHub's updatedAt", () => {
  const a = analyze(makeItem({ updated_at: hoursAgo(3), head_committed_at: "2099-01-01T00:00:00Z" }), ctx, cfg, NOW);
  assert.equal(a.activity_at, hoursAgo(3));
  assert.equal(Math.round(a.signals.pr.pushed_hours), 3);
});

test("requests you made yourself are not someone else's activity", () => {
  const a = analyze(
    makeItem({
      author: "me",
      head_author: "me",
      head_committed_at: hoursAgo(30),
      created_at: hoursAgo(50),
      request_events: [{ at: hoursAgo(1), actor: "me", actor_bot: false, reviewer: "ml-team", reviewer_type: "team" }],
      review_requests: [{ reviewer: "ml-team", type: "team", codeowner: false }],
    }),
    ctx,
    cfg,
    NOW,
  );
  assert.equal(a.others_at, null);
  assert.equal(a.signals.me.new_activity, false);
});

test("a CODEOWNERS ping that changes code you work in, one that doesn't, and one not known yet", () => {
  const withAreas = makeContext({ areas: { "acme/api": { "src/auth/": 6 } } });
  const ping = { author: "carol", review_requests: [{ reviewer: "ml-team", type: "team" as const, codeowner: true }] };
  const at = (paths?: string[]) => analyze(makeItem({ ...ping, ...(paths && { paths }) }), withAreas, cfg, NOW).signals;
  const yours = at(["src/auth/session.ts", "src/auth/token.ts", "docs/auth.md"]);
  const elsewhere = at(["src/billing/plan.ts"]);
  const unknown = at();
  assert.deepEqual([yours.pr.my_area_files, yours.pr.my_area], [2, true]);
  assert.deepEqual([elsewhere.pr.my_area_files, elsewhere.pr.my_area], [0, false]);
  assert.deepEqual([unknown.pr.my_area_files, unknown.pr.my_area], [-1, false]);
  const rule = compile("me.requested_codeowner && pr.my_area_files == 0");
  if (!rule.ok) throw new Error(rule.error);
  assert.deepEqual([rule.eval(yours), rule.eval(elsewhere), rule.eval(unknown)], [false, true, false]);
});
