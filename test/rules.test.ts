import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, compileBoard, type Entry } from "../src/rules.ts";
import { analyze } from "../src/signals.ts";
import { parseConfig, defaultConfigText } from "../src/config.ts";
import type { BoardConfig, Item } from "../src/types.ts";
import { hoursAgo, makeContext, makeItem, NOW } from "./helpers/items.ts";

const cfg = parseConfig(defaultConfigText({ workOrgs: ["acme"] })).loaded!.config;
const ctx = makeContext();

const entry = (item: Item, o: Partial<Entry> = {}): Entry => {
  const a = analyze(item, ctx, cfg, NOW);
  return { id: item.id, signals: a.signals, waiting_since: a.waiting_since, updated_at: item.updated_at, created_at: item.created_at, activity_at: a.activity_at, pinned: false, active: true, ...o };
};

const board = (o: Partial<BoardConfig>): BoardConfig => ({
  id: "b", space: "s", name: "B", queries: ["q"], rules: [], default: "later", default_why: "default", sort: "waiting", ...o,
});

test("first matching rule wins; trace records each step", () => {
  const { board: b, errors } = compileBoard(board({
    rules: [
      { when: "pr.ci == 'red'", bucket: "now", why: "CI red" },
      { when: "author.close", bucket: "today", why: "close: {author.login}" },
      { when: "true", bucket: "fyi", why: "never reached" },
    ],
  }), "boards[0]");
  assert.deepEqual(errors, []);
  const r = classify(b, [entry(makeItem())]);
  const p = r.placements.get("acme/api#1")!;
  assert.equal(p.bucket, "today");
  assert.equal(p.rule, 1);
  assert.equal(p.why, "close: alice");
  assert.deepEqual(p.trace.map((t) => t.matched), [false, true]);
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
  assert.match(p.trace[0].error!, /needs numbers/);
});

test("caps demote overflow in order; pinned and nocap are exempt", () => {
  const { board: b } = compileBoard(board({
    caps: { now: 2, today: 1 },
    rules: [
      { when: "'vip' in item.labels", bucket: "now", nocap: true },
      { when: "true", bucket: "now" },
    ],
  }), "x");
  const items = [1, 2, 3, 4, 5].map((n) => makeItem({ number: n, created_at: hoursAgo(100 - n) }));
  const entries = items.map((it) => entry(it));
  entries.push(entry(makeItem({ number: 6, labels: ["vip"], created_at: hoursAgo(1) })));
  entries.push(entry(makeItem({ number: 7, created_at: hoursAgo(1) }), { pinned: true }));
  const r = classify(b, entries);
  assert.deepEqual(r.order.now, ["acme/api#7", "acme/api#6", "acme/api#1", "acme/api#2"]);
  assert.deepEqual(r.order.today, ["acme/api#3"]);
  assert.deepEqual(r.order.later, ["acme/api#4", "acme/api#5"]);
  assert.equal(r.placements.get("acme/api#3")!.demoted, "Now was full (2)");
  assert.equal(r.placements.get("acme/api#4")!.demoted, "Today was full (1)");
  assert.equal(r.placements.get("acme/api#4")!.rule_bucket, "now");
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
  const direct = makeItem({ number: 1, author: "carol", review_requests: [{ reviewer: "me", type: "user", codeowner: false }], request_events: [{ at: hoursAgo(1), actor: "carol", actor_bot: false, reviewer: "me", reviewer_type: "user" }] });
  const botAskClose = makeItem({ number: 2, author: "alice", review_requests: [{ reviewer: "me", type: "user", codeowner: false }], request_events: [{ at: hoursAgo(1), actor: "helper", actor_bot: true, reviewer: "me", reviewer_type: "user" }] });
  const botAsk = makeItem({ number: 3, author: "carol", review_requests: [{ reviewer: "me", type: "user", codeowner: false }], request_events: [{ at: hoursAgo(1), actor: "helper", actor_bot: true, reviewer: "me", reviewer_type: "user" }] });
  const teamPing = makeItem({ number: 4, author: "carol", review_requests: [{ reviewer: "ml-team", type: "team", codeowner: true }] });
  const r = classify(review, [direct, botAskClose, botAsk, teamPing].map((it) => entry(it)));
  const b = (n: number) => r.placements.get(`acme/api#${n}`)!;
  assert.equal(b(1).bucket, "now");
  assert.equal(b(1).why, "carol asked you directly");
  assert.equal(b(2).bucket, "today");
  assert.equal(b(3).bucket, "later");
  assert.equal(b(3).why, "added by helper (bot)");
  assert.equal(b(4).bucket, "fyi");
  assert.equal(b(4).why, "CODEOWNERS ping to @ml-team");
});

test("priority sorts within a bucket before the board sort", () => {
  const { board: b, errors } = compileBoard(board({ priority: "author.engaged_90d", sort: "waiting", caps: { today: 1 }, rules: [{ when: "true", bucket: "today" }] }), "x");
  assert.deepEqual(errors, []);
  const older = makeItem({ number: 1, author: "bob", created_at: hoursAgo(100) });
  const closer = makeItem({ number: 2, author: "alice", created_at: hoursAgo(1) });
  const r = classify(b, [entry(older), entry(closer)]);
  assert.deepEqual(r.order.today, ["acme/api#2"]);
  assert.deepEqual(r.order.later, ["acme/api#1"]);
  assert.match(compileBoard(board({ priority: "author.nope" }), "boards[3]").errors[0].path, /boards\[3\]\.priority/);
});
