import { test } from "node:test";
import assert from "node:assert/strict";
import { Result } from "effect";
import { compile } from "../src/expr.ts";
import { analyze, FIELDS, weekdayHours } from "../src/signals.ts";
import { parseConfig, defaultConfigText } from "../src/config.ts";
import type { Item } from "../src/types.ts";
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
  const rule = Result.getOrThrow(compile("me.requested_codeowner && pr.my_area_files == 0"));
  assert.deepEqual(
    [yours, elsewhere, unknown].map((s) => Result.getOrThrow(rule.eval(s))),
    [false, true, false],
  );
});

test("a bot's PR opened for you is yours: its line names your login and it assigns you, or it names your profile name or one you gave", () => {
  const c = makeContext({ name: "Greg Pstrucha" });
  const named = { ...cfg, signals: { ...cfg.signals, my_names: ["greg.pstrucha"] } };
  const by = (o: Partial<Item>, conf = cfg) => analyze(makeItem({ author: "sentry-junior", author_bot: true, ...o }), c, conf, NOW).signals;
  const s = by({ requester: "@me", assignees: ["me"], via: "@me" });
  assert.deepEqual([s.me.author, s.author.me, s.author.via, s.author.bot], [true, true, "@me", true]);
  assert.equal(by({ requester: "greg.pstrucha" }, named).me.author, true, "a name you gave");
  assert.equal(by({ requester: "greg.pstrucha" }).me.author, true, "your GitHub profile name, compared by letters alone");
  assert.equal(by({ requester: "dana.k" }).me.author, false, "someone else's name");
  assert.equal(by({ requester: "", via: "Greg Pstrucha" }).me.author, false, "a via line its description's markers don't back");
  assert.equal(by({ via: "greg.pstrucha" }).me.author, true, "stored before requesters were read: its via line until it's fetched again");
  assert.equal(by({ requester: "@me" }).me.author, false, "not assigned to you");
  assert.equal(by({ requester: "@dana", assignees: ["me"] }).me.author, false, "opened for someone else");
  const human = analyze(makeItem({ author: "carol", requester: "@me", assignees: ["me"] }), c, cfg, NOW).signals;
  assert.equal(human.me.author, false, "only a bot opens PRs for people");
});

test("stacked: a PR whose base isn't its repo's default branch; unknown until the default branch is", () => {
  const s = (o: Partial<Item>) => analyze(makeItem(o), makeContext(), cfg, NOW).signals.pr.stacked;
  assert.equal(s({ base: "ref/sa-narrow", default_branch: "master" }), true);
  assert.equal(s({ base: "master", default_branch: "master" }), false);
  assert.equal(s({ base: "ref/sa-narrow", default_branch: undefined }), false, "stored before the default branch was fetched");
});

test("pr.reviewers, pr.people_requested and pr.teams_requested: who's on a PR besides you, for rules that sort a team ask away", () => {
  const user = (reviewer: string) => ({ reviewer, type: "user" as const, codeowner: false });
  const team = (reviewer: string) => ({ reviewer, type: "team" as const, codeowner: true });
  const review = (author: string, state: "approved" | "commented" | "pending", bot = false) => ({
    author,
    author_bot: bot,
    trusted: true,
    state,
    at: hoursAgo(30),
    commit: "abc",
  });
  const of = (o: Partial<Item>) => analyze(makeItem({ author: "carol", ...o }), ctx, cfg, NOW).signals;
  const ping = of({
    review_requests: [user("me"), user("sam"), { ...user("copilot"), bot: true }, team("ml-team"), team("backend")],
    reviews: [
      review("kai", "commented"),
      review("kai", "approved"),
      review("carol", "commented"), // the author answering a thread
      review("me", "commented"),
      review("sentry-warden", "commented", true),
      review("dana", "pending"),
    ],
  }).pr;
  assert.deepEqual(ping.reviewers, ["kai"], "you, the author, bots and a review not sent yet aren't someone on it");
  assert.deepEqual(ping.people_requested, ["sam"], "you and a bot aside");
  assert.deepEqual(ping.teams_requested, ["ml-team", "backend"]);
  const quiet = of({ review_requests: [team("ml-team")] });
  assert.deepEqual([quiet.pr.reviewers, quiet.pr.people_requested, quiet.pr.teams_requested], [[], [], ["ml-team"]]);
  // As a rule reads them: a wide ping, someone named, someone on it.
  const hit = (when: string, o: Partial<Item>) => Result.getOrThrow(Result.getOrThrow(compile(when)).eval(of(o)));
  assert.equal(hit("len(pr.teams_requested) >= 2", { review_requests: [team("a"), team("b")] }), true);
  assert.equal(hit("len(pr.people_requested) > 0 || len(pr.reviewers) > 0", { review_requests: [team("a")] }), false);
});

test("pr.paths: the files a PR changes, for a rule that says it touches an area whatever its title says", () => {
  const of = (o: Partial<Item>) => analyze(makeItem({ author: "carol", ...o }), ctx, cfg, NOW).signals;
  const paths = ["src/sentry/seer/code_mode/tools.py", "tests/sentry/seer/test_tools.py", "README.md"];
  assert.deepEqual(of({ paths }).pr.paths, paths);
  assert.deepEqual(of({ paths: undefined }).pr.paths, [], "stored before its files were fetched: no path matches");
  assert.ok(
    FIELDS.some((f) => f.path === "pr.paths" && f.type === "string[]"),
    "listed with the rest",
  );
  // As a rule reads them: * is any run of characters, / included, so a directory covers what's under it.
  const hit = (when: string, changed: string[] | undefined = paths) =>
    Result.getOrThrow(Result.getOrThrow(compile(when)).eval(of({ paths: changed })));
  assert.equal(hit("any(pr.paths, 'src/sentry/seer/*')"), true, "at any depth");
  assert.equal(hit("any(pr.paths, 'src/sentry/warden/*')"), false);
  assert.equal(hit("any(pr.paths, '*/seer/*')"), true, "anywhere in the tree");
  assert.equal(hit("any(pr.paths, 'src/sentry/seer')"), false, "a glob is the whole path");
  assert.equal(hit("any(pr.paths, '*.md')"), true);
  assert.equal(hit("any(pr.paths, 'src/sentry/seer/*') || any(pr.paths, 'src/sentry/warden/*')"), true);
  assert.equal(hit("any(pr.paths, 'src/sentry/seer/*')", []), false);
  assert.equal(hit("len(pr.paths)"), 3);
});

test("pr.waits, pr.waiting_on and me.owes_reply", () => {
  const user = (reviewer: string) => ({ reviewer, type: "user" as const, codeowner: false });
  const review = (author: string, state: "approved" | "changes_requested" | "commented") => ({
    author,
    author_bot: false,
    trusted: true,
    state,
    at: hoursAgo(30),
    commit: "abc",
  });
  const said = (author: string, h: number) => ({ author, author_bot: false, at: hoursAgo(h), resolved: false });
  const mine = (o: Partial<Item>) => makeItem({ author: "me", head_author: "me", ...o });
  const of = (it: Item) => analyze(it, ctx, cfg, NOW).signals;
  // sentry#129460: yours, asked of cvxluo, skaasten and 6 teams; markstory had the last word twice after his COMMENTED review.
  const asked = [
    user("cvxluo"),
    user("skaasten"),
    ...["a", "b", "c", "d", "e", "f"].map((t) => ({ reviewer: t, type: "team" as const, codeowner: true })),
  ];
  const live = of(
    mine({
      review_requests: asked,
      reviews: [review("markstory", "commented")],
      thread_last: [said("me", 27), said("markstory", 29), said("markstory", 28), said("me", 26), said("me", 25)],
    }),
  );
  assert.equal(live.pr.waits, "waits on your reply to markstory, then a review from cvxluo, skaasten and 6 more");
  assert.equal(live.pr.waiting_on.length, 8);
  assert.equal(live.me.owes_reply, true);
  // Then you pushed over both of his threads, which GitHub marks outdated: the push answered them.
  const stale = (h: number) => ({ ...said("markstory", h), outdated: true });
  const pushed = of(
    mine({
      review_requests: asked,
      reviews: [review("markstory", "commented")],
      head_committed_at: hoursAgo(1),
      updated_at: hoursAgo(0),
      thread_last: [said("me", 27), stale(29), stale(28), said("me", 26), said("me", 25)],
    }),
  );
  assert.deepEqual([pushed.pr.waits, pushed.me.owes_reply], ["waits on a review from cvxluo, skaasten and 6 more", false]);
  const theirs = of(makeItem({ author: "carol", review_requests: [user("me")], thread_last: [said("carol", 1)] }));
  assert.deepEqual([theirs.pr.waits, theirs.pr.waiting_on, theirs.me.owes_reply], ["waits on your review", [], false]);
  const approved = { review_decision: "approved" as const, reviews: [review("kofi", "approved")], review_requests: [user("sam")] };
  const rows: [string, Item, string][] = [
    ["an issue", makeItem({ kind: "issue" }), ""],
    ["merged", mine({ state: "merged" }), ""],
    ["your draft", mine({ draft: true }), "is your draft"],
    ["their draft", makeItem({ draft: true }), "is a draft"],
    ["your red CI", mine({ ci: "red" }), "waits on a CI fix"],
    ["their red CI", makeItem({ ci: "red" }), "has CI failing"],
    ["a conflict", mine({ mergeable: "conflict" }), "waits on a merge conflict fix"],
    ["a conflict, approved", mine({ mergeable: "conflict", ...approved }), "waits on a merge conflict fix"],
    [
      "a conflict before its review",
      mine({ mergeable: "conflict", review_requests: [user("sam")] }),
      "waits on a review from sam, and a merge conflict fix",
    ],
    ["their conflict", makeItem({ mergeable: "conflict", review_requests: [user("sam")] }), "waits on a merge conflict fix"],
    ["changes", mine({ reviews: [review("kofi", "changes_requested")] }), "has changes requested by kofi"],
    [
      "asked, hidden too",
      mine({ review_requests: [user("sam"), user("me")], review_requests_hidden: 2 }),
      "waits on a review from sam and 2 more",
    ],
    [
      "a reply, nobody asked",
      mine({ comments: [{ author: "priya", author_bot: false, at: hoursAgo(1) }], review_requests: [] }),
      "waits on your reply to priya, then a review",
    ],
    ["nobody asked", mine({ review_requests: [] }), "has nobody asked to review it"],
    ["a reviewer looked", mine({ reviews: [review("kai", "commented")] }), "waits on a review"],
    ["CI running", mine({ ...approved, ci: "pending" }), "waits on CI"],
    ["yours, ready", mine(approved), "is ready to merge"],
    ["theirs, approved", makeItem({ ...approved, author: "carol" }), "is approved, for carol to merge"],
  ];
  for (const [what, it, waits] of rows) assert.equal(of(it).pr.waits, waits, what);
  assert.deepEqual(of(mine(approved)).pr.waiting_on, [], "empty once it's approved");
  assert.deepEqual(
    of(mine({ review_requests: [user("sam"), user("me"), { reviewer: "copilot", type: "user", codeowner: false, bot: true }] })).pr
      .waiting_on,
    ["sam"],
    "you and bots left out",
  );
  const deps = of(mine({ requires: ["acme/api#9"] })).pr;
  assert.deepEqual(
    [deps.requires, deps.blocked, deps.blocked_by, deps.blocker, deps.blocker_waits, deps.blocker_mine, deps.blocks, deps.requires_closed],
    [[], false, [], "", "", false, [], []],
    "Desk.compute() fills the dependency fields",
  );
});

// Local times in the week of Monday 2 November 2026, which has no clock change: the counts don't depend on the machine's time zone.
const L = (day: number, hour: number, min = 0) => new Date(2026, 10, day, hour, min);

test("weekdayHours counts every hour of Monday to Friday, local time, and none of Saturday's or Sunday's", () => {
  const h = (from: Date, to: Date) => weekdayHours(from.toISOString(), to);
  assert.equal(h(L(6, 15), L(9, 15)), 24, "Friday 15:00 to Monday 15:00");
  assert.equal(h(L(5, 10), L(9, 10)), 48, "Thursday 10:00 to Monday 10:00");
  assert.equal(h(L(6, 17), L(9, 8)), 15, "Friday 17:00 to Monday 08:00: Friday's last 7 hours and Monday's first 8, nights too");
  assert.equal(h(L(7, 10), L(8, 10)), 0, "Saturday to Sunday");
  assert.equal(h(L(7, 10), L(9, 1)), 1, "from a Saturday: Monday's hour alone");
  assert.equal(h(L(3, 9), L(3, 9, 30)), 0.5, "part of an hour");
  assert.equal(h(L(2, 0), L(9, 0)), 120, "a week is five days");
  assert.equal(h(L(9, 0), L(2, 0)), 0, "from the future");
});

test("pr.ready_weekday_hours and pr.asked_weekday_hours: how long a PR has been ready, and those asked by name asked", () => {
  const user = (reviewer: string, bot = false) => ({ reviewer, type: "user" as const, codeowner: false, bot });
  const team = { reviewer: "backend", type: "team" as const, codeowner: true };
  const ask = (reviewer: string, h: number, type: "user" | "team" = "user") => ({
    at: hoursAgo(h),
    actor: "me",
    actor_bot: false,
    reviewer,
    reviewer_type: type,
  });
  const pr = (o: Partial<Item>) => analyze(makeItem({ author: "me", ...o }), ctx, cfg, NOW).signals.pr;
  assert.equal(pr({ ready_at: hoursAgo(6), created_at: hoursAgo(20) }).ready_weekday_hours, 6, "since its latest Ready for review");
  assert.equal(pr({ ready_at: null, created_at: hoursAgo(5) }).ready_weekday_hours, 5, "never a draft: since it opened");
  assert.equal(pr({ ready_at: hoursAgo(6), draft: true }).ready_weekday_hours, -1, "a draft again");
  assert.equal(pr({ state: "merged" }).ready_weekday_hours, -1);
  assert.equal(pr({ kind: "issue" }).ready_weekday_hours, -1);
  const { ready_at: _, ...stored } = makeItem({ author: "me" });
  assert.equal(analyze(stored, ctx, cfg, NOW).signals.pr.ready_weekday_hours, -1, "stored before the desk read when");

  const asked = { ready_at: hoursAgo(20), review_requests: [user("sam"), user("kai")], request_events: [ask("sam", 9), ask("kai", 4)] };
  assert.equal(pr(asked).asked_weekday_hours, 4, "the latest request to someone still asked");
  assert.equal(pr({ ...asked, review_requests: [user("sam")] }).asked_weekday_hours, 9, "kai reviewed, so GitHub asks kai no more");
  assert.equal(pr({ ...asked, ready_at: hoursAgo(2) }).asked_weekday_hours, 2, "asked while it was a draft: since it went ready");
  assert.equal(pr({ ...asked, request_events: [] }).asked_weekday_hours, 20, "no request the desk has read: since it went ready");
  const others = {
    review_requests: [team, user("copilot", true), user("me")],
    request_events: [ask("backend", 3, "team"), ask("copilot", 3), ask("me", 3)],
  };
  assert.equal(pr({ ...asked, ...others }).asked_weekday_hours, -1, "a team, a bot and you aren't someone asked by name");
  assert.equal(pr({ ...asked, draft: true }).asked_weekday_hours, -1);
  const docs = FIELDS.filter((f) => f.path.endsWith("_weekday_hours")).map((f) => [f.path, f.type]);
  assert.deepEqual(docs, [
    ["pr.ready_weekday_hours", "number"],
    ["pr.asked_weekday_hours", "number"],
  ]);
});

test("the owner's two nudges as rules: a workday ready with nobody asked by name, two since someone was, weekends aside", () => {
  const PICK = "me.author && !item.draft && pr.ready_weekday_hours >= 24 && len(pr.people_requested) == 0 && len(pr.reviewers) == 0";
  const FOLLOW_UP = "me.author && !item.draft && pr.asked_weekday_hours >= 48 && len(pr.reviewers) == 0";
  const hit = (when: string, it: Item, now: Date) =>
    Result.getOrThrow(Result.getOrThrow(compile(when)).eval(analyze(it, ctx, cfg, now).signals));
  const both = (it: Item, now: Date) => [hit(PICK, it, now), hit(FOLLOW_UP, it, now)];
  const mine = (o: Partial<Item>) => makeItem({ author: "me", created_at: L(2, 9).toISOString(), ...o });
  const codeowners = { reviewer: "backend", type: "team" as const, codeowner: true };
  const review = (author: string, bot = false) => ({
    author,
    author_bot: bot,
    state: "commented" as const,
    at: L(6, 16).toISOString(),
    commit: "abc",
  });

  // A CODEOWNERS repo: a team is asked as it goes ready, Friday 15:00, and nobody by name.
  const team = mine({ ready_at: L(6, 15).toISOString(), review_requests: [codeowners] });
  assert.deepEqual(both(team, L(9, 14)), [false, false], "Monday 14:00: 71 hours on the clock, 23 of them on weekdays");
  assert.deepEqual(both(team, L(9, 15)), [true, false], "Monday 15:00: a workday, the team's ask or not");
  const opened = mine({ ready_at: null, created_at: L(2, 12).toISOString() });
  assert.deepEqual(
    [both(opened, L(3, 11)), both(opened, L(3, 12))],
    [
      [false, false],
      [true, false],
    ],
    "never a draft, nobody asked at all",
  );
  assert.deepEqual(
    both({ ...team, reviews: [review("sentry-warden", true)] }, L(9, 15)),
    [true, false],
    "a bot's review isn't someone on it",
  );
  assert.deepEqual(both({ ...team, reviews: [review("kai")] }, L(9, 15)), [false, false], "kai's on it");
  assert.deepEqual(both({ ...team, draft: true }, L(9, 15)), [false, false], "a draft again");
  assert.deepEqual(both({ ...team, state: "merged" }, L(9, 15)), [false, false], "merged with no review: nothing to chase");
  assert.deepEqual(both({ ...team, author: "carol" }, L(9, 15)), [false, false], "someone else's");

  // Asked by name: sam, Thursday 10:00, beside the team.
  const sam = { reviewer: "sam", type: "user" as const, codeowner: false };
  const asked = mine({
    ready_at: null,
    review_requests: [codeowners, sam],
    request_events: [{ at: L(5, 10).toISOString(), actor: "me", actor_bot: false, reviewer: "sam", reviewer_type: "user" }],
  });
  assert.deepEqual(both(asked, L(9, 9)), [false, false], "Monday 09:00: 47 weekday hours since sam was asked");
  assert.deepEqual(both(asked, L(9, 10)), [false, true], "Monday 10:00: two workdays; follow up, not pick a reviewer");
  const reviewed = { ...asked, review_requests: [codeowners], reviews: [review("sam")] };
  assert.deepEqual(both(reviewed, L(9, 10)), [false, false], "sam reviewed: GitHub asks sam no more, and someone's on it");
});
