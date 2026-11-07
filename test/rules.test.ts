import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, compileBoard, placedBy, queueOrder, quietText, type Entry } from "../src/rules.ts";
import { analyze } from "../src/signals.ts";
import { parseConfig, defaultConfigText } from "../src/config.ts";
import type { BoardConfig, Bucket, Card, Item } from "../src/types.ts";
import { hoursAgo, makeContext, makeItem, NOW } from "./helpers/items.ts";

const cfg = parseConfig(defaultConfigText({ workOrgs: ["acme"] })).loaded!.config;
const ctx = makeContext();

const entry = (item: Item, o: Partial<Entry> = {}, c = ctx): Entry => {
  const a = analyze(item, c, cfg, NOW);
  return {
    id: item.id,
    signals: a.signals,
    waiting_since: a.waiting_since,
    created_at: item.created_at,
    activity_at: a.activity_at,
    pinned: false,
    active: true,
    ...o,
  };
};

const board = (o: Partial<BoardConfig>): BoardConfig => ({
  id: "b",
  space: "s",
  name: "B",
  queries: ["q"],
  rules: [],
  default: "later",
  default_why: "default",
  sort: "waiting",
  ...o,
});

test("first matching rule wins; trace records each step", () => {
  const { board: b, errors } = compileBoard(
    board({
      rules: [
        { when: "pr.ci == 'red'", bucket: "now", why: "CI red" },
        { when: "author.close", bucket: "today", why: "close: {author.login}" },
        { when: "true", bucket: "fyi", why: "never reached" },
      ],
    }),
    "boards[0]",
  );
  assert.deepEqual(errors, []);
  const r = classify(b, [entry(makeItem())]);
  const p = r.placements.get("acme/api#1")!;
  assert.equal(p.bucket, "today");
  assert.equal(p.rule, 1);
  assert.equal(p.why, "close: alice");
  assert.deepEqual(
    p.trace.map((t) => t.matched),
    [false, true],
  );
});

test("filter removes items; default bucket otherwise", () => {
  const { board: b } = compileBoard(board({ filter: "!item.draft", default: "fyi", default_why: "by {item.author}" }), "x");
  const r = classify(b, [entry(makeItem({ number: 1 })), entry(makeItem({ number: 2, draft: true }))]);
  assert.deepEqual([...r.placements.keys()], ["acme/api#1"]);
  assert.equal(r.placements.get("acme/api#1")!.why, "by alice");
  assert.deepEqual(r.order.fyi, ["acme/api#1"]);
});

test("eval errors don't match and are traced", () => {
  const { board: b } = compileBoard(board({ rules: [{ when: "item.title > 1", bucket: "now" }] }), "x");
  const p = classify(b, [entry(makeItem())]).placements.get("acme/api#1")!;
  assert.equal(p.bucket, "later");
  assert.match(p.trace[0]?.error ?? "", /needs numbers/);
});

test("caps demote overflow in order; pinned and nocap are exempt", () => {
  const { board: b } = compileBoard(
    board({
      caps: { now: 2, today: 1 },
      rules: [
        { when: "'vip' in item.labels", bucket: "now", nocap: true },
        { when: "true", bucket: "now" },
      ],
    }),
    "x",
  );
  const items = [1, 2, 3, 4, 5].map((n) => makeItem({ number: n, created_at: hoursAgo(100 - n) }));
  const entries = items.map((it) => entry(it));
  entries.push(
    entry(makeItem({ number: 6, labels: ["vip"], created_at: hoursAgo(1) })),
    entry(makeItem({ number: 7, created_at: hoursAgo(1) }), { pinned: true }),
  );
  const r = classify(b, entries);
  assert.deepEqual(r.order.now, ["acme/api#7", "acme/api#6", "acme/api#1", "acme/api#2"]);
  assert.deepEqual(r.order.today, ["acme/api#3"]);
  assert.deepEqual(r.order.later, ["acme/api#4", "acme/api#5"]);
  assert.equal(r.placements.get("acme/api#3")!.demoted, "2 from B are urgent already");
  assert.equal(r.placements.get("acme/api#4")!.demoted, "the queue has 1 from B already");
  assert.equal(r.placements.get("acme/api#4")!.rule_bucket, "now");
});

test("over a cap, the lightest AI call leaves first: skip, then skim, then not reviewed yet, so a close look keeps its slot", () => {
  const { board: b } = compileBoard(board({ caps: { today: 2 }, rules: [{ when: "true", bucket: "today" }] }), "x");
  const items = [1, 2, 3, 4].map((n) => makeItem({ number: n, created_at: hoursAgo(100 - n) }));
  const r = classify(
    b,
    items.map((it) => entry(it, { ai: it.number === 1 ? "skip" : undefined })),
  );
  assert.deepEqual(r.order.today, ["acme/api#2", "acme/api#3"]);
  assert.deepEqual(r.order.later, ["acme/api#1", "acme/api#4"]);
  assert.equal(r.placements.get("acme/api#1")!.demoted, "the AI says skip it");
  assert.equal(r.placements.get("acme/api#4")!.demoted, "the queue has 2 from B already");
  const calls = classify(
    b,
    items.map((it) => entry(it, { ai: (["skim", undefined, "skim", "look"] as const)[it.number - 1] })),
  );
  assert.deepEqual(calls.order.today, ["acme/api#2", "acme/api#4"]);
  // Under the cap, a skip keeps its place.
  const under = classify(
    b,
    items.slice(0, 2).map((it) => entry(it, { ai: "skip" })),
  );
  assert.deepEqual(under.order.today, ["acme/api#1", "acme/api#2"]);
});

test("inactive items are placed but not sorted or counted toward caps", () => {
  const { board: b } = compileBoard(board({ caps: { now: 1 }, rules: [{ when: "true", bucket: "now" }] }), "x");
  const r = classify(b, [entry(makeItem({ number: 1 }), { active: false }), entry(makeItem({ number: 2 }))]);
  assert.deepEqual(r.order.now, ["acme/api#2"]);
  assert.deepEqual(r.inactive, ["acme/api#1"]);
});

test("sorts: waiting (oldest request first), updated, newest", () => {
  const a = makeItem({ number: 1, created_at: hoursAgo(10) });
  const c = makeItem({ number: 2, created_at: hoursAgo(30) });
  const mk = (sort: BoardConfig["sort"]) => classify(compileBoard(board({ sort }), "x").board, [entry(a), entry(c)]).order.later;
  assert.deepEqual(mk("waiting"), ["acme/api#2", "acme/api#1"]);
  assert.deepEqual(mk("newest"), ["acme/api#1", "acme/api#2"]);
});

test("default review rules: an ask by name is hard whoever added it; close collaborators' team pings hint Later", () => {
  const review = parseConfig(defaultConfigText({ workOrgs: ["acme"] })).loaded!.boards.find((x) => x.config.id === "acme-review")!;
  const direct = makeItem({
    number: 1,
    author: "carol",
    review_requests: [{ reviewer: "me", type: "user", codeowner: false }],
    request_events: [{ at: hoursAgo(1), actor: "carol", actor_bot: false, reviewer: "me", reviewer_type: "user" }],
  });
  const botAskClose = makeItem({
    number: 2,
    author: "alice",
    review_requests: [{ reviewer: "me", type: "user", codeowner: false }],
    request_events: [{ at: hoursAgo(1), actor: "helper", actor_bot: true, reviewer: "me", reviewer_type: "user" }],
  });
  const botAsk = makeItem({
    number: 3,
    author: "carol",
    review_requests: [{ reviewer: "me", type: "user", codeowner: false }],
    request_events: [{ at: hoursAgo(1), actor: "helper", actor_bot: true, reviewer: "me", reviewer_type: "user" }],
  });
  const teamPing = makeItem({ number: 4, author: "carol", review_requests: [{ reviewer: "ml-team", type: "team", codeowner: true }] });
  const closeTeamPing = makeItem({ number: 5, author: "alice", review_requests: [{ reviewer: "ml-team", type: "team", codeowner: true }] });
  const r = classify(
    review,
    [direct, botAskClose, botAsk, teamPing, closeTeamPing].map((it) => entry(it)),
  );
  const b = (n: number) => r.placements.get(`acme/api#${n}`)!;
  assert.deepEqual([b(1).bucket, b(1).why, b(1).floor], ["now", "carol asked you directly", "today"]);
  // A bot (Junior) adds asks by name for people: they reach your desk too.
  assert.deepEqual([b(2).bucket, b(2).why, b(2).floor], ["today", "asked you by name (added by helper)", "today"]);
  assert.deepEqual([b(3).bucket, b(3).why, b(3).hard], ["today", "asked you by name (added by helper)", true]);
  assert.equal(b(4).bucket, "fyi");
  assert.equal(b(4).why, "CODEOWNERS ping to @ml-team");
  assert.deepEqual([b(5).bucket, b(5).why], ["later", "close collaborator: you engaged with 12 of their PRs in 90 days"]);
});

test("default review rules: a bot's PR is hidden, but one it opened for a person isn't, and one it opened for you is yours", () => {
  const review = parseConfig(defaultConfigText({ workOrgs: ["acme"] })).loaded!.boards.find((x) => x.config.id === "acme-review")!;
  const asked = { review_requests: [{ reviewer: "ml-team", type: "team" as const, codeowner: false }] };
  const bot = { author: "sentry-junior", author_bot: true, ...asked };
  const items = [
    makeItem({ number: 1, author: "dependabot", author_bot: true, ...asked }),
    makeItem({ number: 2, ...bot, via: "Michelle Tran" }),
    makeItem({ number: 3, ...bot, via: "Me Myself" }),
    makeItem({ number: 4, ...bot, via: "@me" }),
  ];
  const r = classify(
    review,
    items.map((it) => entry(it, {}, makeContext({ name: "Me Myself" }))),
  );
  const b = (n: number) => r.placements.get(`acme/api#${n}`)!;
  assert.deepEqual([b(1).bucket, b(1).why], ["hide", "bot PR"]);
  assert.deepEqual([b(2).bucket, b(2).why], ["later", "review requested"]);
  assert.deepEqual([b(3).bucket, b(3).why], ["later", "your PR, opened through sentry-junior"]);
  assert.deepEqual([b(4).bucket, b(4).why], ["later", "your PR, opened through sentry-junior"]);
});

test("default My PRs rules: stacked PRs and a red CI from the last hour's push wait in Later, like PRs waiting on reviewers", () => {
  const mine = parseConfig(defaultConfigText({ workOrgs: ["acme"] })).loaded!.boards.find((x) => x.config.id === "acme-mine")!;
  const own = { author: "me", default_branch: "main" };
  const items = [
    makeItem({ number: 1, ...own, base: "ref/acting-user", ci: "red", head_committed_at: hoursAgo(5) }),
    makeItem({ number: 2, ...own, ci: "red", head_committed_at: hoursAgo(0.2), updated_at: hoursAgo(0.1) }),
    makeItem({ number: 3, ...own, ci: "red", head_committed_at: hoursAgo(5) }),
    makeItem({ number: 4, ...own, head_committed_at: hoursAgo(5) }),
    makeItem({ number: 5, ...own, base: "ref/x", review_decision: "changes_requested" }),
  ];
  const r = classify(
    mine,
    items.map((it) => entry(it)),
  );
  const b = (n: number) => r.placements.get(`acme/api#${n}`)!;
  assert.deepEqual([b(1).bucket, b(1).why], ["later", "stacked on ref/acting-user"]);
  assert.deepEqual([b(2).bucket, b(2).why], ["later", "waiting on reviewers"], "CI red from the push 12 minutes ago");
  assert.deepEqual([b(3).bucket, b(3).why], ["today", "CI failing"]);
  assert.deepEqual([b(4).bucket, b(4).why], ["later", "waiting on reviewers"]);
  assert.deepEqual([b(5).bucket, b(5).why], ["now", "changes requested"], "a person blocked on you, stacked or not");
});

test("default review rules: a CODEOWNERS ping hints Later when it changes code you work on, and isn't hard", () => {
  const review = parseConfig(defaultConfigText({ workOrgs: ["acme"] })).loaded!.boards.find((x) => x.config.id === "acme-review")!;
  const areas = makeContext({ areas: { "acme/api": { "src/auth/": 6 } } });
  const ping = (number: number, paths?: string[]) =>
    makeItem({ number, author: "carol", paths, review_requests: [{ reviewer: "ml-team", type: "team", codeowner: true }] });
  const items = [ping(1, ["src/auth/token.ts", "web/x.ts"]), ping(2, ["web/x.ts"]), ping(3)];
  const r = classify(
    review,
    items.map((it) => entry(it, {}, areas)),
  );
  const b = (n: number) => r.placements.get(`acme/api#${n}`)!;
  assert.deepEqual([b(1).bucket, b(1).why, b(1).hard], ["later", "CODEOWNERS ping to @ml-team, in code you work on", undefined]);
  assert.deepEqual([b(2).bucket, b(2).why], ["fyi", "CODEOWNERS ping to @ml-team"]);
  assert.equal(b(3).bucket, "fyi", "files not known yet: the fyi hint, until they are");
});

test("default My PRs rules: your draft touched in two weeks is on the desk by a hard rule; an older one waits in Later", () => {
  const mine = parseConfig(defaultConfigText({ workOrgs: ["acme"] })).loaded!.boards.find((x) => x.config.id === "acme-mine")!;
  const draft = (number: number, hours: number) =>
    makeItem({ number, author: "me", draft: true, ci: "red", created_at: hoursAgo(24 * 40), updated_at: hoursAgo(hours) });
  // Claude would sort them all away; the hard rule keeps the fresh ones on the desk anyway.
  const away = () => ({ bucket: "fyi" as const, why: "a draft", pending: false });
  const fresh = [1, 2, 3, 4, 5, 6, 7].map((n) => draft(n, 30 + n));
  const r = classify(
    mine,
    [...fresh, draft(8, 24 * 20)].map((it) => entry(it)),
    away,
    14,
  );
  const b = (n: number) => r.placements.get(`acme/api#${n}`)!;
  assert.deepEqual([b(1).bucket, b(1).why, b(1).hard], ["today", "your draft: finish it", true]);
  assert.equal(r.order.today.length, 7, "over the board's cap of 6, all of them");
  assert.deepEqual([b(8).bucket, b(8).rule_bucket, b(8).hard], ["fyi", "fyi", undefined]);
  assert.equal(r.placements.get("acme/api#8")!.hint?.why, "draft, quiet for 2+ weeks");
});

test("priority sorts within a bucket before the board sort", () => {
  const { board: b, errors } = compileBoard(
    board({ priority: "author.engaged_90d", sort: "waiting", caps: { today: 1 }, rules: [{ when: "true", bucket: "today" }] }),
    "x",
  );
  assert.deepEqual(errors, []);
  const older = makeItem({ number: 1, author: "bob", created_at: hoursAgo(100) });
  const closer = makeItem({ number: 2, author: "alice", created_at: hoursAgo(1) });
  const r = classify(b, [entry(older), entry(closer)]);
  assert.deepEqual(r.order.today, ["acme/api#2"]);
  assert.deepEqual(r.order.later, ["acme/api#1"]);
  assert.match(compileBoard(board({ priority: "author.nope" }), "boards[3]").errors[0]?.path ?? "", /boards\[3\]\.priority/);
});

test("your pin keeps an item in Today or above, whatever the rules or Claude say", () => {
  const { board: b } = compileBoard(
    board({
      rules: [
        { when: "item.number == 1", bucket: "fyi", why: "a team ping" },
        { when: "item.number == 2", bucket: "now", why: "asked you" },
      ],
    }),
    "x",
  );
  const items = [makeItem({ number: 1 }), makeItem({ number: 2 }), makeItem({ number: 3 })];
  const entries = items.map((it) => entry(it, it.number === 3 ? { pinned: true } : { pinned: true, floor: "today" }));
  const answers: Record<number, Bucket | null> = { 1: "hide", 2: "later", 3: "fyi" };
  const judged = classify(b, entries, (id) => ({ bucket: answers[Number(id.split("#")[1])]!, why: "", pending: false }));
  const p = (n: number, r = judged) => r.placements.get(`acme/api#${n}`)!;
  assert.deepEqual(
    [p(1).bucket, p(1).why, p(1).hint?.bucket, p(1).hard, placedBy(p(1))],
    ["today", "a team ping", "fyi", undefined, "pin"],
  );
  assert.deepEqual([p(2).bucket, placedBy(p(2))], ["today", "pin"], "Claude's later, kept up by the pin");
  assert.deepEqual([p(3).bucket, placedBy(p(3))], ["fyi", "claude"], "pinned with no floor: the coordinator's pin");
  const rules = classify(b, entries);
  assert.deepEqual([p(1, rules).bucket, p(2, rules).bucket, placedBy(p(1, rules))], ["today", "now", undefined], "with the judge off too");
  const unsorted = classify(b, entries, () => ({ bucket: null, why: "", pending: true }));
  assert.deepEqual([p(1, unsorted).bucket, placedBy(p(1, unsorted)), placedBy(p(2, unsorted))], ["today", "pin", "pending"]);
});

test("quiet items leave Now and Today for Later, before caps; pinned items and a fresh ask stay", () => {
  const { board: b } = compileBoard(
    board({
      caps: { today: 1 },
      rules: [
        { when: "item.number == 1", bucket: "now", why: "conflicts with main" },
        { when: "true", bucket: "today", why: "today" },
      ],
    }),
    "x",
  );
  const days = (d: number) => hoursAgo(d * 24);
  const old = makeItem({ number: 1, author: "me", updated_at: days(143) });
  const stale = makeItem({ number: 2, updated_at: days(20) });
  const pinned = makeItem({ number: 3, updated_at: days(30) });
  // GitHub's updatedAt can lag a fresh ask (a stored snapshot); the ask itself says it's new.
  const asked = makeItem({
    number: 4,
    updated_at: days(40),
    review_requests: [{ reviewer: "me", type: "user", codeowner: false }],
    request_events: [{ at: days(2), actor: "carol", actor_bot: false, reviewer: "me", reviewer_type: "user" }],
  });
  const fresh = makeItem({ number: 5, updated_at: days(13) });
  const entries = [entry(old), entry(stale), entry(pinned, { pinned: true }), entry(asked), entry(fresh)];

  const r = classify(b, entries, undefined, 14);
  const p = (n: number) => r.placements.get(`acme/api#${n}`)!;
  assert.deepEqual([p(1).bucket, p(1).rule_bucket, p(1).demoted], ["later", "now", "quiet for 5 months"]);
  assert.deepEqual([p(2).bucket, p(2).demoted], ["later", "quiet for 3 weeks"]);
  assert.equal(r.order.now.length, 0);
  // Quiet ones leave before the cap counts, so Today's one slot (the pinned one doesn't count) goes to the fresh ask.
  assert.deepEqual(r.order.today, ["acme/api#3", "acme/api#4"]);
  assert.deepEqual([p(5).bucket, p(5).demoted], ["later", "the queue has 1 from B already"]);
  assert.deepEqual(r.order.later, ["acme/api#5", "acme/api#1", "acme/api#2"]);

  const off = classify(b, entries, undefined, 0);
  assert.equal(off.placements.get("acme/api#1")!.bucket, "now", "0 turns it off");
  assert.equal(off.placements.get("acme/api#1")!.demoted, undefined);
});

test("quiet for: days, then weeks, then months", () => {
  assert.equal(quietText(7 * 24 + 5), "quiet for 7 days");
  assert.equal(quietText(14 * 24), "quiet for 2 weeks");
  assert.equal(quietText(20 * 24), "quiet for 3 weeks");
  assert.equal(quietText(143 * 24), "quiet for 5 months");
});

test("the queue's order within Now or Today: handed back, close looks, then the rest; someone else's red PR and skip last", () => {
  const card = (n: number, o: Partial<Card> = {}): Card =>
    ({ id: `acme/api#${n}`, kind: "pr", author: `a${n}`, ci: "green", chips: [], resolved: null, ...o }) as Card;
  const look = { state: "ready" as const, verdict: "look" as const };
  const cards = [
    card(1, { preflight: { state: "ready", verdict: "skip" } }),
    card(2, { preflight: { state: "ready", verdict: "skim" } }),
    card(3, { preflight: { state: "stale", verdict: "look" } }),
    card(4, { preflight: look }),
    card(5, { author: "me", ci: "green", chips: ["approved"] }),
    card(6, { ci: "red", chips: ["CI red"], preflight: look }),
    card(7, { demoted: "3 from PRs to review are urgent already" }),
    card(8, { preflight: { state: "ready", verdict: "skim", risk: "high" } }),
    card(9, { author: "me", handed_back: true, why: "handed back: Dana wants a redesign" }),
    // An AI review you asked for on your own PR says skip: handed back, it still comes first.
    card(10, { author: "me", handed_back: true, preflight: { state: "ready", verdict: "skip" } }),
  ];
  assert.deepEqual(
    queueOrder(cards, "me").map((c) => c.id.split("#")[1]),
    ["9", "10", "4", "8", "3", "7", "5", "2", "6", "1"],
  );
});

test("final = true: Claude isn't asked, and its answer doesn't move it, in any bucket", () => {
  const rules = (final: boolean) =>
    compileBoard(
      board({
        rules: [
          { when: "item.number == 1", bucket: "blocked", why: "blocked by api#9", final },
          { when: "item.number == 2", bucket: "now", why: "asked you", final },
        ],
      }),
      "x",
    ).board;
  const entries = [entry(makeItem({ number: 1 })), entry(makeItem({ number: 2 }))];
  const today = () => ({ bucket: "today" as const, why: "Claude says today", pending: false });
  const p = (b: ReturnType<typeof rules>, n: number) => classify(b, entries, today).placements.get(`acme/api#${n}`)!;
  for (const [n, bucket] of [
    [1, "blocked"],
    [2, "now"],
  ] as const)
    assert.deepEqual(
      [p(rules(true), n).bucket, p(rules(true), n).why, p(rules(true), n).judge, placedBy(p(rules(true), n))],
      [bucket, n === 1 ? "blocked by api#9" : "asked you", undefined, undefined],
    );
  assert.deepEqual([p(rules(false), 1).bucket, p(rules(false), 2).bucket], ["today", "today"], "without final, Claude's today");
});

test("a hard blocked rule: Claude may lift it, never below Blocked", () => {
  const { board: b } = compileBoard(board({ rules: [{ when: "true", bucket: "blocked", why: "blocked by api#9", hard: true }] }), "x");
  const at = (bucket: Bucket) =>
    classify(b, [entry(makeItem())], () => ({ bucket, why: "", pending: false })).placements.get("acme/api#1")!.bucket;
  assert.deepEqual([at("today"), at("later")], ["today", "blocked"]);
});

test("your pin lifts a final blocked rule to today, keeping the rule's why, and the card says your pin placed it", () => {
  const { board: b } = compileBoard(board({ rules: [{ when: "true", bucket: "blocked", why: "blocked by api#9", final: true }] }), "x");
  const p = classify(b, [entry(makeItem(), { pinned: true, floor: "today" })], () => ({ bucket: "fyi", why: "", pending: false }));
  const got = p.placements.get("acme/api#1")!;
  assert.deepEqual([got.bucket, got.why, got.judge, placedBy(got)], ["today", "blocked by api#9", undefined, "pin"]);
});

test("blocked isn't capped or made quiet", () => {
  const { board: b } = compileBoard(
    board({ caps: { now: 1, today: 2 }, rules: [{ when: "true", bucket: "blocked", why: "blocked by api#9", final: true }] }),
    "x",
  );
  const old = Array.from({ length: 8 }, (_, i) => entry(makeItem({ number: i + 1, updated_at: hoursAgo(30 * 24) })));
  const r = classify(b, old, undefined, 1);
  assert.equal(r.order.blocked.length, 8);
  assert.deepEqual(
    [...r.placements.values()].map((p) => [p.bucket, p.demoted]),
    Array.from({ length: 8 }, () => ["blocked", undefined]),
  );
});
