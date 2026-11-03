import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStacks, grouped, lineOf, oneLinePerStack, stackRef, stackView, toFetch, type Seat, type Stacks } from "../src/stacks.ts";
import type { Bucket, Card, Item } from "../src/types.ts";
import { idle, myPr, reviewAsk, setup, teamPing } from "./helpers/desk.ts";
import { hoursAgo, makeItem, NOW } from "./helpers/items.ts";

// A PR on branch b<n> of acme/api, based on `on`: a branch, or the number of the PR below it.
const pr = (n: number, on: string | number, o: Partial<Item> = {}) =>
  makeItem({ number: n, head_ref: `b${n}`, base: typeof on === "number" ? `b${on}` : on, ...o });
const id = (n: number, repo = "acme/api") => `${repo}#${n}`;
const ids = (...ns: number[]) => ns.map((n) => id(n));
const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();
const card = (n: number, bucket: Bucket, s: Stacks): Card => {
  const stack = stackRef(s, id(n));
  return { id: id(n), bucket, ...(stack && { stack }) } as Card;
};
const seats =
  (b: Record<number, Bucket>) =>
  (x: string): Seat => {
    const bucket = b[Number(x.split("#")[1])] ?? null;
    return { bucket, why: bucket ? `in ${bucket}` : "" };
  };

test("a stack links PRs by branch, across authors; a fork's branch is no parent, and a PR alone is no stack", () => {
  const s = buildStacks([
    pr(1, "main"),
    pr(2, 1, { author: "bob" }),
    pr(3, 2),
    pr(9, "main"),
    pr(11, "main", { head_repo: "someone/api", head_ref: "b20" }),
    pr(12, "b20"),
    makeItem({ number: 13, kind: "issue", head_ref: "b13" }),
  ]);
  assert.deepEqual(lineOf(s, id(2)), ids(1, 2, 3));
  assert.deepEqual(stackRef(s, id(2)), { id: id(1), pos: 2, size: 3 });
  assert.deepEqual(stackRef(s, id(3)), { id: id(1), pos: 3, size: 3 });
  for (const n of [9, 11, 12, 13]) assert.equal(stackRef(s, id(n)), undefined, `#${n}`);
});

test("forks: the line takes the branch with open PRs, then the longest, then the oldest; dead branches drop out", () => {
  const s = buildStacks([
    pr(1, "main"),
    pr(2, 1, { state: "closed" }), // dead: closed, nothing above it
    pr(3, 1),
    pr(4, 3),
    pr(5, 3), // a live fork off #3, shorter than #4's branch
    pr(6, 4, { draft: true }),
    pr(7, 4, { state: "closed" }), // dead fork off #4
    pr(8, 1, { state: "closed" }), // closed, but #9 is still based on its branch
    pr(9, 8),
  ]);
  assert.equal(s.nodes.has(id(2)), false);
  assert.equal(s.nodes.has(id(7)), false);
  assert.deepEqual(lineOf(s, id(1)), ids(1, 3, 4, 6));
  assert.deepEqual(lineOf(s, id(5)), ids(1, 3, 5));
  assert.deepEqual(stackRef(s, id(9)), { id: id(1), pos: 2, size: 2 }, "#8 is closed: it doesn't count");
  const v = stackView(s, id(4), seats({ 4: "now", 9: "today", 5: "later" }))!;
  assert.deepEqual(
    v.line.map((m) => [m.number, m.current, m.bucket]),
    [
      [1, false, null],
      [3, false, null],
      [4, true, "now"],
      [6, false, null],
    ],
  );
  assert.deepEqual(
    v.forks.map((m) => [m.number, m.parent, m.state]),
    [
      [5, id(3), "open"],
      [8, id(1), "closed"],
      [9, id(8), "open"],
    ],
  );
  assert.deepEqual([v.id, v.base, v.up, v.down], [id(1), "main", id(6), id(3)]);
  assert.equal(stackView(s, id(2), seats({})), null, "a dead branch is in no stack");

  const tie = buildStacks([pr(1, "main"), pr(3, 1), pr(2, 1)]);
  assert.deepEqual(lineOf(tie, id(1)), ids(1, 2), "two open branches as long: the oldest PR's");
});

test("merged PRs stay below: on their branches, or before GitHub moved the PR above to main when they merged", () => {
  const landed = buildStacks([pr(1, "main", { state: "merged" }), pr(2, 1, { state: "merged" }), pr(3, 2), pr(4, 3)]);
  assert.deepEqual(stackRef(landed, id(4)), { id: id(1), pos: 2, size: 2 }, "the count is what's still to land");
  assert.deepEqual(lineOf(landed, id(4)), ids(1, 2, 3, 4));
  assert.equal(stackRef(landed, id(1)), undefined, "a merged PR has no place in what's left");

  const merged = at(0);
  const s = buildStacks([
    pr(11, "main", { state: "merged", closed_at: merged }),
    pr(12, "main", { retargeted: { from: "b11", at: at(0.05) } }),
    pr(13, 12),
    pr(21, "main", { state: "merged", closed_at: at(60) }),
    pr(22, "main", { retargeted: { from: "b21", at: merged } }), // moved off before #21 merged: not below it
    pr(31, "main"),
    pr(32, "main", { retargeted: { from: "b31", at: merged } }), // moved off an open PR's branch by hand
  ]);
  const v = stackView(s, id(13), (x) => ({ bucket: null, why: x === id(11) ? "merged" : "" }))!;
  assert.deepEqual(
    v.line.map((m) => [m.number, m.state, m.why]),
    [
      [11, "merged", "merged"],
      [12, "open", ""],
      [13, "open", ""],
    ],
  );
  assert.deepEqual(stackRef(s, id(13)), { id: id(11), pos: 2, size: 2 });
  for (const n of [21, 22, 31, 32]) assert.equal(stackView(s, id(n), seats({})), null, `#${n}`);
  const one = buildStacks([pr(1, "main", { state: "merged" }), pr(2, 1)]);
  assert.equal(stackRef(one, id(2)), undefined, "one open PR left: no stack on its card...");
  assert.deepEqual(
    stackView(one, id(2), seats({}))?.line.map((m) => m.state),
    ["merged", "open"],
    "...but its chain still shows what merged below it",
  );
});

test("stale data that loops still makes a stack", () => {
  const s = buildStacks([pr(1, 2), pr(2, 1)]);
  assert.equal(s.nodes.size, 2);
  assert.equal(lineOf(s, id(1)).length, 2);
});

test("one line per stack: the lowest PR in the most urgent section stands for it and names the rest", () => {
  const s = buildStacks([pr(1, "main"), pr(2, 1), pr(3, 2), pr(4, 3), pr(5, 4), pr(9, "main"), pr(6, 2)]);
  const sections = {
    now: [card(9, "now", s), card(4, "now", s)],
    today: [card(3, "today", s), card(2, "today", s)],
    later: [card(1, "later", s), card(6, "later", s)],
    fyi: [card(5, "fyi", s)],
  };
  const order = ["now", "today", "later", "fyi"] as const;
  const leads = oneLinePerStack(sections, order, s);
  assert.deepEqual(
    order.map((k) => sections[k].map((c) => c.id)),
    [ids(9, 4), [], [], []],
  );
  assert.deepEqual(
    leads.map((c) => [c.id, c.stack]),
    [[id(4), { id: id(1), pos: 4, size: 5, folded: ids(1, 2, 3, 6, 5) }]],
  );

  const t = {
    now: [card(9, "now", s)],
    today: [card(3, "today", s), card(6, "today", s), card(2, "today", s)],
    later: [card(1, "later", s)],
  };
  oneLinePerStack(t, ["now", "today", "later"], s);
  assert.deepEqual(
    t.today.map((c) => [c.id, c.stack?.folded]),
    [[id(2), ids(1, 3, 6)]],
    "the lowest in Today, at its own place; on a tie the main line before a fork",
  );
  assert.deepEqual(
    t.now.map((c) => [c.id, c.stack]),
    [[id(9), undefined]],
  );
});

test("a stack's rows go together, bottom first, where its first row was", () => {
  const s = buildStacks([pr(1, "main"), pr(2, 1), pr(3, 2), pr(9, "main"), pr(10, "main")]);
  const rows = [9, 3, 10, 1, 2].map((n) => ({ n }));
  assert.deepEqual(
    grouped(rows, (r) => id(r.n), s).map((r) => r.n),
    [9, 1, 2, 3, 10],
  );
});

test("what to fetch: the PR below a bottom, PRs above open ones, stale members; never a fork's branch or a dead PR", () => {
  const old = hoursAgo(5);
  const items = [
    pr(2, 1), // its base's PR isn't stored
    pr(3, "main", { head_repo: "someone/api" }), // from a fork: nothing in acme/api can be based on it
    pr(4, "main", { retargeted: { from: "b40", at: hoursAgo(1) } }), // moved to main when the PR below merged
    pr(5, 1, { state: "closed" }),
    pr(10, "main"),
    pr(11, 10, { detail_at: old }), // off the boards, open, last fetched 5 hours ago
    pr(12, 11, { state: "merged", detail_at: old }),
    pr(13, 11, { detail_at: hoursAgo(0) }),
    pr(20, "main"), // in a stack nobody listed
    pr(21, 20, { detail_at: old }),
    makeItem({ repo: "acme/x", number: 6, head_ref: "b6", base: "dev", default_branch: "" }),
  ];
  const listed = new Set([id(2), id(3), id(4), id(5), id(10), id(6, "acme/x")]);
  const s = buildStacks(items);
  const got = toFetch(items, s, listed, hoursAgo(0.5));
  const probes = got.probes.map((p) => `${p.repo} ${p.dir} ${p.branch}`).sort();
  assert.deepEqual(probes, [
    "acme/api down b10",
    "acme/api down b11",
    "acme/api down b13",
    "acme/api down b2",
    "acme/api down b4",
    "acme/api up b1",
    "acme/api up b40",
    "acme/x down b6",
  ]);
  assert.deepEqual(
    got.stale.map((i) => i.id),
    [id(11)],
  );

  const known = [...items, makeItem({ repo: "acme/x", number: 7, default_branch: "main" })];
  assert.ok(
    toFetch(known, buildStacks(known), listed, hoursAgo(0.5)).probes.some(
      (p) => p.repo === "acme/x" && p.dir === "up" && p.branch === "dev",
    ),
    "the default branch comes from another PR in the repo when this one was stored without it",
  );
});

// The desk: what it fetches for stacks and how its views carry them.

const theirs = (n: number, on: string | number, o: Partial<Item> = {}) =>
  pr(n, on, { author: "carol", review_requests: [], request_events: [], ...o });

test("a stack asked of you at its bottom: the desk fetches the PRs above it quietly and lists the stack once", async (tc) => {
  const t = await setup([
    reviewAsk(1, { head_ref: "b1" }),
    theirs(2, 1),
    theirs(3, 2, { author: "dave", draft: true }),
    theirs(4, 3, { state: "closed" }),
    reviewAsk(9),
  ]);
  tc.after(t.cleanup);
  await t.desk.sync();
  assert.deepEqual(
    t.gh.probeCalls.filter((c) => c.includes(" b1") || c.includes(" b2") || c.includes(" b3")),
    ["acme/api down b1", "acme/api down b2", "acme/api down b3"],
    "a level a round, in one sync",
  );
  const stored = t.desk.store.itemsById(ids(2, 3, 4));
  assert.deepEqual([...stored.keys()].sort(), ids(2, 3));
  const events = t.desk.store.activity({ after: 0, limit: 100 });
  assert.deepEqual(
    events.filter((e) => e.item_id === id(2) || e.item_id === id(3)),
    [],
    "context for the stack, not news",
  );

  const q = t.desk.queue();
  const one = q.sections.now.find((c) => c.id === id(1));
  assert.deepEqual(one?.stack, { id: id(1), pos: 1, size: 3, folded: [] });
  assert.deepEqual(Object.keys(q.stacks), [id(1)]);
  const v = q.stacks[id(1)]!;
  assert.deepEqual(
    v.line.map((m) => [m.number, m.author, m.draft, m.current, m.bucket]),
    [
      [1, "carol", false, true, "now"],
      [2, "carol", false, false, null],
      [3, "dave", true, false, null],
    ],
  );
  assert.deepEqual([v.up, v.down], [id(2), null]);
  assert.equal(q.sections.now.find((c) => c.id === id(9))?.stack, undefined);

  const top = await t.desk.reviewView(id(3));
  assert.deepEqual([top.stack?.current, top.stack?.up, top.stack?.down], [id(3), null, id(2)], "a member no board lists opens too");
  assert.deepEqual(top.card.stack, { id: id(1), pos: 3, size: 3 });
  assert.equal(t.desk.item(id(2)).stack?.current, id(2));
});

test("the PR below a stack's bottom is fetched; probes wait half an hour, then stale members are refreshed", async (tc) => {
  const t = await setup([theirs(1, "main"), reviewAsk(2, { head_ref: "b2", base: "b1" })]);
  tc.after(t.cleanup);
  await t.desk.sync();
  assert.ok(t.gh.probeCalls.includes("acme/api up b1"));
  assert.equal(t.desk.store.itemsById([id(1)]).get(id(1))?.state, "open");
  assert.deepEqual(t.desk.queue().sections.now[0]?.stack, { id: id(1), pos: 2, size: 2, folded: [] });

  const probed = t.gh.probeCalls.length;
  await t.desk.sync();
  assert.equal(t.gh.probeCalls.length, probed, "asked once per half hour");

  t.gh.items.set(id(1), { ...t.gh.items.get(id(1))!, state: "merged", closed_at: hoursAgo(0), updated_at: hoursAgo(0) });
  t.setNow(new Date(NOW.getTime() + 31 * 60_000));
  await t.desk.sync();
  assert.equal(t.desk.store.itemsById([id(1)]).get(id(1))?.state, "merged");
  assert.equal(t.desk.queue().sections.now[0]?.stack, undefined, "one open PR left");
  assert.deepEqual(
    (await t.desk.reviewView(id(2))).stack?.line.map((m) => [m.number, m.state, m.why]),
    [
      [1, "merged", "merged"],
      [2, "open", "carol asked you directly"],
    ],
  );
});

test("PRs stored before stacks: the desk refetches a few a pass for their branches and default branch", async (tc) => {
  const bare = (n: number): Item => {
    const { head_ref: _, default_branch: __, retargeted: ___, ...rest } = reviewAsk(n);
    return rest;
  };
  const t = await setup([bare(1), bare(2)]);
  tc.after(t.cleanup);
  await t.desk.sync();
  const fetched = t.gh.detailCalls.flat().length;
  t.gh.items.set(id(1), reviewAsk(1));
  t.gh.items.set(id(2), reviewAsk(2));
  await t.desk.sync();
  assert.equal(t.gh.detailCalls.flat().length, fetched + 2, "unchanged on GitHub, but stored without them");
  assert.equal(t.desk.store.itemsById([id(1)]).get(id(1))?.head_ref, "change-1");
  await t.desk.sync();
  assert.equal(t.gh.detailCalls.flat().length, fetched + 2, "once they have them, only changes refetch");
});

test("focus lists a stack once too, and Merging keeps a stack's PRs together with the chain", async (tc) => {
  const t = await setup([
    teamPing(1),
    reviewAsk(2, { base: "change-1" }),
    reviewAsk(3, { base: "change-2" }),
    myPr(5, { ci: "green" }),
    myPr(6, { ci: "green", base: "change-5" }),
    myPr(8, { ci: "green" }),
    myPr(7, { ci: "green", base: "change-6" }),
  ]);
  tc.after(t.cleanup);
  await t.desk.sync();
  const focus = t.desk.focus();
  assert.deepEqual(
    focus.sections.now.filter((c) => c.repo === "acme/api").map((c) => [c.id, c.stack?.folded]),
    [[id(2), [id(3)]]],
    "#2 and #3 are both asked of you; the lower one stands for the stack",
  );
  const q = t.desk.queue();
  assert.deepEqual(
    q.sections.now.filter((c) => c.repo === "acme/api").map((c) => [c.id, c.stack?.folded]),
    [[id(2), [id(1), id(3)]]],
    "the queue's line stands for #1 in FYI too",
  );
  assert.equal(
    q.sections.fyi.find((c) => c.id === id(1)),
    undefined,
  );
  assert.deepEqual(
    q.stacks[id(1)]?.line.map((m) => [m.number, m.bucket, m.current]),
    [
      [1, "fyi", false],
      [2, "now", true],
      [3, "now", false],
    ],
  );

  for (const n of [7, 8, 5, 6]) t.desk.act(id(n, "acme/web"), "inflight");
  const lane = t.desk.inflight();
  const web = (n: number) => id(n, "acme/web");
  const order = lane.rows.map((r) => r.card.id);
  const at5 = order.indexOf(web(5));
  assert.deepEqual(order.slice(at5, at5 + 3), [web(5), web(6), web(7)]);
  assert.deepEqual(Object.keys(lane.stacks), [web(5)]);
  assert.deepEqual(
    lane.stacks[web(5)]!.line.map((m) => [m.number, m.current]),
    [
      [5, true],
      [6, false],
      [7, false],
    ],
  );
  assert.deepEqual(lane.rows.find((r) => r.card.id === web(7))?.card.stack, { id: web(5), pos: 3, size: 3 });
});

test("a PR a probe finds that the desk stored before it kept branches is fetched again, so it links", async (tc) => {
  const parent = theirs(1, "main");
  const { head_ref: _, retargeted: __, ...old } = parent;
  const t = await setup([reviewAsk(2, { head_ref: "b2", base: "b1" })]);
  tc.after(t.cleanup);
  t.desk.store.putItems([old], hoursAgo(1));
  t.gh.items.set(id(1), parent);
  await t.desk.sync();
  assert.deepEqual(t.desk.queue().sections.now[0]?.stack, { id: id(1), pos: 2, size: 2, folded: [] });
});

test("a ref counts the PR's own line: forks over a merged bottom are two PRs, not one 1/1 stack", () => {
  const s = buildStacks([pr(1, "main", { state: "merged" }), pr(2, 1), pr(3, 1)]);
  assert.deepEqual([stackRef(s, id(2)), stackRef(s, id(3))], [undefined, undefined]);
  const later = { later: [card(2, "later", s), card(3, "later", s)] };
  oneLinePerStack(later, ["later"], s);
  assert.deepEqual(
    later.later.map((c) => [c.id, c.stack]),
    [
      [id(2), undefined],
      [id(3), undefined],
    ],
  );
  assert.deepEqual(
    stackView(s, id(3), seats({}))?.forks.map((m) => m.number),
    [2],
    "the chain still shows the other branch",
  );

  const open = buildStacks([pr(1, "main"), pr(2, 1), pr(3, 1)]);
  assert.deepEqual(
    [1, 2, 3].map((n) => stackRef(open, id(n))),
    [
      { id: id(1), pos: 1, size: 2 },
      { id: id(1), pos: 2, size: 2 },
      { id: id(1), pos: 2, size: 2 },
    ],
  );
});

test("desktop notifications go per PR: a member asked while a lower one is in Now is news at once, and once", async (tc) => {
  const t = await setup([theirs(1, "main"), reviewAsk(2, { head_ref: "b2", base: "b1" }), theirs(3, 2)], {
    settings: { "notify.quiet": "" },
  });
  tc.after(t.cleanup);
  await t.desk.sync();
  t.gh.items.set(id(3), reviewAsk(3, { head_ref: "b3", base: "b2", updated_at: at(1) }));
  await t.desk.sync();
  assert.deepEqual(t.notes, ["api#3 · carol asked you directly"]);
  t.desk.act(id(2), "done");
  await t.desk.sync();
  assert.deepEqual(t.notes, ["api#3 · carol asked you directly"], "#3 standing for the stack now isn't news again");
});

test("a member stored quietly is news once a board lists it: its events since the desk last logged any", async (tc) => {
  const t = await setup([reviewAsk(1, { head_ref: "b1" }), theirs(2, 1)]);
  tc.after(t.cleanup);
  let lag = false; // the search index hasn't caught up with #2's ask yet
  const route = t.gh.route;
  t.gh.route = (q) => route(q).filter((x) => !(lag && x === id(2)));
  await t.desk.sync();
  t.setNow(new Date(NOW.getTime() + 31 * 60_000));
  t.gh.items.set(id(2), reviewAsk(2, { head_ref: "b2", base: "b1", updated_at: at(30) }));
  lag = true;
  await t.desk.sync();
  const of2 = () =>
    t.desk.store
      .activity({ after: 0, limit: 100 })
      .filter((e) => e.item_id === id(2))
      .map((e) => e.kind);
  assert.deepEqual(of2(), [], "the stale refresh stores the ask quietly");
  lag = false;
  t.setNow(new Date(NOW.getTime() + 33 * 60_000));
  await t.desk.sync();
  assert.deepEqual(of2(), ["new"]);
  await t.desk.sync();
  assert.deepEqual(of2(), ["new"], "once");

  const [gh] = t.desk.connectors;
  const said = t.desk.store.itemsById([id(2)]).get(id(2))!;
  t.desk.ingest(gh!, [{ ...said, ci: "red", updated_at: at(40) }], true);
  t.desk.ingest(gh!, [{ ...said, ci: "red", updated_at: at(41), draft: true }], true);
  t.desk.ingest(gh!, [{ ...said, ci: "red", updated_at: at(42), draft: true }]);
  assert.deepEqual(of2(), ["new", "ci"], "a change made while it was quiet is logged against what was last logged");
});

test("the feed takes a member stored quietly for one the desk doesn't hold: an ask on it starts a reconcile", async (tc) => {
  const t = await setup([reviewAsk(1, { head_ref: "b1" }), theirs(2, 1)]);
  tc.after(t.cleanup);
  await t.desk.sync();
  await t.desk.gh.poll();
  t.gh.items.set(id(2), reviewAsk(2, { head_ref: "b2", base: "b1", updated_at: at(1) }));
  t.gh.threads = [{ thread: "t1", item: id(2), reason: "review_requested", updated_at: at(1) }];
  const searches = t.gh.searches.length;
  await t.desk.gh.poll();
  await idle(t.desk);
  assert.ok(t.gh.searches.length > searches);
  assert.deepEqual(
    t.desk.store
      .activity({ after: 0, limit: 100 })
      .filter((e) => e.item_id === id(2))
      .map((e) => e.kind),
    ["new"],
  );
});

test("off-board members of a stack the boards list aren't pruned with the items no search returns", async (tc) => {
  const t = await setup([reviewAsk(1, { head_ref: "b1" }), theirs(2, 1), theirs(3, 2), theirs(9, "main")]);
  tc.after(t.cleanup);
  await t.desk.sync();
  t.desk.store.putItems([theirs(9, "main")], NOW.toISOString());
  const day = 24 * 60 * 60_000;
  t.setNow(new Date(NOW.getTime() + 14 * day - 10 * 60_000));
  await t.desk.sync();
  t.setNow(new Date(NOW.getTime() + 14 * day + 60_000));
  await t.desk.sync();
  assert.deepEqual(
    t.desk.item(id(1)).stack?.line.map((m) => m.number),
    [1, 2, 3],
  );
  assert.equal(t.desk.store.itemsById([id(9)]).has(id(9)), false, "an item in no stack still goes");
});

test("QueueView.stacks has every stack a card in the view carries, cleared ones too", async (tc) => {
  const t = await setup([reviewAsk(1, { head_ref: "b1" }), reviewAsk(2, { head_ref: "b2", base: "b1" })]);
  tc.after(t.cleanup);
  await t.desk.sync();
  t.desk.act(id(1), "mute");
  t.desk.act(id(2), "mute");
  const q = t.desk.queue();
  assert.deepEqual(
    q.cleared.map((c) => c.stack?.id),
    [id(1), id(1)],
  );
  assert.deepEqual(Object.keys(q.stacks), [id(1)]);
  assert.equal(q.stacks[id(1)]?.current, id(1));
});

test("probes for stacks go first: a busy board doesn't stop a chain filling in one pass", async (tc) => {
  const plain = Array.from({ length: 130 }, (_, i) => reviewAsk(100 + i));
  const t = await setup([...plain, theirs(1, "main"), reviewAsk(2, { head_ref: "b2", base: "b1" }), theirs(3, 2), theirs(4, 3)]);
  tc.after(t.cleanup);
  await t.desk.sync();
  assert.deepEqual(
    t.desk.item(id(2)).stack?.line.map((m) => m.number),
    [1, 2, 3, 4],
  );
  assert.ok(t.gh.probeCalls.length <= 120, `${t.gh.probeCalls.length} probes`);
  t.setNow(new Date(NOW.getTime() + 60_000));
  await t.desk.sync();
  t.setNow(new Date(NOW.getTime() + 120_000));
  await t.desk.sync();
  assert.ok(
    plain.every((p) => t.gh.probeCalls.includes(`acme/api down ${p.head_ref}`)),
    "the rest of the board's PRs are asked over the next passes",
  );
});
