import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, compileBoard, quietText, type Entry } from "../src/rules.ts";
import { analyze } from "../src/signals.ts";
import { parseConfig, defaultConfigText } from "../src/config.ts";
import type { BoardConfig, Item } from "../src/types.ts";
import { hoursAgo, makeContext, makeItem, NOW } from "./helpers/items.ts";

const cfg = parseConfig(defaultConfigText({ workOrgs: ["acme"] })).loaded!.config;
const ctx = makeContext();

const entry = (item: Item, o: Partial<Entry> = {}, c = ctx): Entry => {
  const a = analyze(item, c, cfg, NOW);
  return {
    id: item.id,
    signals: a.signals,
    waiting_since: a.waiting_since,
    updated_at: item.updated_at,
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

test("default review rules: bot asks fall below close collaborators", () => {
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
  assert.equal(b(1).bucket, "now");
  assert.equal(b(1).why, "carol asked you directly");
  assert.equal(b(2).bucket, "today");
  assert.equal(b(3).bucket, "later");
  assert.equal(b(3).why, "added by helper (bot)");
  assert.equal(b(4).bucket, "fyi");
  assert.equal(b(4).why, "CODEOWNERS ping to @ml-team");
  // A close collaborator's CODEOWNERS ping is still nobody asking you by name.
  assert.deepEqual([b(5).bucket, b(5).why], ["fyi", "CODEOWNERS ping to @ml-team"]);
});

test("default review rules: a CODEOWNERS ping hints Today when it changes code you work on, and isn't hard", () => {
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
  assert.deepEqual([b(1).bucket, b(1).why, b(1).hard], ["today", "CODEOWNERS ping to @ml-team, in code you work on", undefined]);
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
