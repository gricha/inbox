import "./helpers/no-agent.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { chains, loopThrough, type NodeState } from "../src/after.ts";
import type { Card, Item, QueueView } from "../src/types.ts";
import { QUIET, reviewAsk, setup } from "./helpers/desk.ts";
import { makeItem, NOW } from "./helpers/items.ts";
import { run, runSync } from "./helpers/run.ts";

const links = (o: Record<string, string[]>) => new Map(Object.entries(o));
const states =
  (o: Record<string, NodeState>) =>
  (id: string): NodeState =>
    o[id] ?? "open";
const plain = (c: ReturnType<typeof chains>) => ({ head: Object.fromEntries(c.head), steps: Object.fromEntries(c.steps) });

test("a chain hangs under its first step that isn't waiting; merging that one makes the next the head", () => {
  const l = links({ b: ["a"], c: ["b"], d: ["c"] });
  assert.deepEqual(plain(chains(l, states({}))), { head: { b: "a", c: "a", d: "a" }, steps: { a: ["b", "c", "d"] } });
  assert.deepEqual(plain(chains(l, states({ a: "complete" }))), { head: { c: "b", d: "b" }, steps: { b: ["c", "d"] } });
  // Done out of order: what's done waits on nothing, and what came after it doesn't wait on it.
  assert.deepEqual(plain(chains(l, states({ b: "complete" }))), { head: { d: "c" }, steps: { c: ["d"] } });
});

test("a PR closed without merging never completes: the chain stops there, under it", () => {
  const c = chains(links({ b: ["a"], c: ["b"] }), states({ a: "broken" }));
  assert.deepEqual(plain(c), { head: { b: "a", c: "a" }, steps: { a: ["b", "c"] } });
});

test("a step with several prerequisites waits on all of them and hangs after the last of them, in the order they run", () => {
  // x and y are independent heads; z waits on both, w on z.
  const l = links({ z: ["y", "x"], w: ["z"] });
  const c = chains(l, states({}));
  assert.deepEqual(plain(c), { head: { z: "y", w: "y" }, steps: { y: ["z", "w"] } });
  assert.deepEqual(c.waits.get("z"), ["x", "y"]);
  // x done: z still waits on y. y done first: z waits on x, under it.
  assert.deepEqual(chains(l, states({ x: "complete" })).waits.get("z"), ["y"]);
  assert.deepEqual(plain(chains(l, states({ y: "complete" }))), { head: { z: "x", w: "x" }, steps: { x: ["z", "w"] } });
  // In a line, the one it waits on that runs last is the one it follows.
  const line = chains(links({ q: ["p"], r: ["q", "p"] }), states({}));
  assert.deepEqual(plain(line), { head: { q: "p", r: "p" }, steps: { p: ["q", "r"] } });
  assert.deepEqual(line.waits.get("r"), ["p", "q"]);
});

test("a chain runs across a note: the note is a step like any other", () => {
  const l = links({ "note:n1": ["acme/api#1"], "acme/api#2": ["note:n1"] });
  assert.deepEqual(plain(chains(l, states({}))).steps, { "acme/api#1": ["note:n1", "acme/api#2"] });
  assert.deepEqual(plain(chains(l, states({ "acme/api#1": "complete" }))).steps, { "note:n1": ["acme/api#2"] });
  assert.deepEqual(plain(chains(l, states({ "acme/api#1": "complete", "note:n1": "complete" }))).steps, {});
});

test("loopThrough names the prerequisite that would close a loop", () => {
  const l = links({ b: ["a"], c: ["b"] });
  assert.equal(loopThrough(l, "a", ["c"]), "c");
  assert.equal(loopThrough(l, "a", ["x", "b"]), "b");
  assert.equal(loopThrough(l, "a", ["a"]), "a");
  assert.equal(loopThrough(l, "d", ["c"]), null);
  assert.equal(loopThrough(l, "c", ["a"]), null, "c after a and b is no loop");
});

// --- the desk

const ids = (cs: Card[]) => cs.map((c) => c.id);
const onInbox = (v: QueueView) => [...v.inbox.urgent, ...v.inbox.standard, ...v.inbox.fyi];
const steps = (c: Card | undefined) => c?.waiting?.map((w) => [w.id, w.after]);
// Someone else's PR you're following, not asked of you: inbox_add puts it on the desk, pinned.
const theirs = (repo: string, n: number, o: Partial<Item> = {}) => makeItem({ repo, number: n, author: "octo", ...o });

async function desk(items: Item[], extra: Item[] = []) {
  const t = await setup(items, { settings: QUIET });
  for (const it of extra) t.gh.items.set(it.id, it);
  await run(t.desk.sync());
  for (const it of extra) await run(t.desk.add(it.id));
  return t;
}
const later = (t: Awaited<ReturnType<typeof setup>>, h: number) => {
  const at = new Date(NOW.getTime() + h * 3_600_000);
  t.setNow(at);
  return at.toISOString();
};
const merge = (t: Awaited<ReturnType<typeof setup>>, id: string, at: string, state: "merged" | "closed" = "merged") =>
  t.gh.items.set(id, { ...t.gh.items.get(id)!, state, closed_at: at, updated_at: at });

test("waiting steps leave the Inbox, its counts, the badge and notifications; the head carries them in order", async (c) => {
  const t = await desk([reviewAsk(1), reviewAsk(2), reviewAsk(3)]);
  c.after(t.cleanup);
  runSync(t.desk.setAfter("api#2", ["api#1"]));
  runSync(t.desk.setAfter("api#3", ["api#2"]));
  const v = runSync(t.desk.queue());
  assert.deepEqual(ids(onInbox(v)), ["acme/api#1"]);
  assert.deepEqual(steps(onInbox(v)[0]), [
    ["acme/api#2", "api#1"],
    ["acme/api#3", "api#2"],
  ]);
  const f = runSync(t.desk.focus());
  assert.deepEqual(ids([...f.sections.now, ...f.sections.today]), ["acme/api#1"]);
  const o = runSync(t.desk.overview());
  assert.equal(o.focus.now + o.focus.today, 1);
  // Its pin and section stay stored, and hold again once it no longer waits.
  runSync(t.desk.act("api#3", "pin"));
  runSync(t.desk.act("api#3", "fyi"));
  assert.deepEqual(ids(onInbox(runSync(t.desk.queue()))), ["acme/api#1"]);
  // Added after api#1 as it came: a new item that waits never notifies.
  t.gh.items.set("acme/api#5", reviewAsk(5));
  await run(t.desk.add("acme/api#5", undefined, undefined, ["api#1"]));
  later(t, 0.5);
  await run(t.desk.sync());
  assert.deepEqual(t.notes, []);
  assert.deepEqual(steps(onInbox(runSync(t.desk.queue())).find((x) => x.id === "acme/api#1"))?.length, 3);
});

test("when the head merges the next step is the head, on the Inbox where its own placement says, and notifies once", async (c) => {
  const t = await desk([reviewAsk(1), reviewAsk(2), reviewAsk(3)]);
  c.after(t.cleanup);
  runSync(t.desk.setAfter("api#2", ["api#1"]));
  runSync(t.desk.setAfter("api#3", ["api#2"]));
  runSync(t.desk.act("api#2", "fyi"));
  merge(t, "acme/api#1", later(t, 1));
  await run(t.desk.sync());
  const v = runSync(t.desk.queue());
  assert.deepEqual(ids(v.inbox.fyi), ["acme/api#2"], "in the section you moved it to");
  assert.deepEqual(steps(v.inbox.fyi[0]), [["acme/api#3", "api#2"]]);
  assert.deepEqual(t.notes, ["api#2 is next · api#1 merged"]);
  await run(t.desk.sync());
  assert.equal(t.notes.length, 1, "once");
});

test("a PR closed without merging stops its chain: the next steps keep waiting under it, in the Archive", async (c) => {
  const t = await desk([reviewAsk(1), reviewAsk(2)]);
  c.after(t.cleanup);
  runSync(t.desk.setAfter("api#2", ["api#1"]));
  merge(t, "acme/api#1", later(t, 1), "closed");
  await run(t.desk.sync());
  const v = runSync(t.desk.queue());
  assert.deepEqual(ids(onInbox(v)), []);
  assert.deepEqual(ids(v.resolved), ["acme/api#1"]);
  assert.deepEqual(steps(v.resolved[0]), [["acme/api#2", "api#1"]]);
  assert.deepEqual(t.notes, []);
  // Stop waiting: it's on the Inbox by its own placement, and you did it, so it doesn't notify.
  runSync(t.desk.setAfter("api#2", []));
  await run(t.desk.sync());
  assert.deepEqual(ids(onInbox(runSync(t.desk.queue()))), ["acme/api#2"]);
  assert.deepEqual(t.notes, []);
});

test("several prerequisites: it waits until all are complete", async (c) => {
  const t = await desk([reviewAsk(1), reviewAsk(2), reviewAsk(3)]);
  c.after(t.cleanup);
  runSync(t.desk.setAfter("api#3", ["api#1", "api#2"]));
  const v = runSync(t.desk.queue());
  assert.deepEqual(ids(onInbox(v)).toSorted(), ["acme/api#1", "acme/api#2"]);
  assert.deepEqual(steps(onInbox(v).find((x) => x.id === "acme/api#2")), [["acme/api#3", "api#1 and api#2"]]);
  merge(t, "acme/api#2", later(t, 1));
  await run(t.desk.sync());
  const w = runSync(t.desk.queue());
  assert.deepEqual(ids(onInbox(w)), ["acme/api#1"]);
  assert.deepEqual(steps(onInbox(w)[0]), [["acme/api#3", "api#1"]]);
  merge(t, "acme/api#1", later(t, 2));
  await run(t.desk.sync());
  assert.deepEqual(ids(onInbox(runSync(t.desk.queue()))), ["acme/api#3"]);
  assert.deepEqual(t.notes, ["api#3 is next · api#1 and api#2 merged"]);
});

test("setAfter refuses a loop, itself, and refs the desk can't name, in plain words", async (c) => {
  const t = await desk([reviewAsk(1), reviewAsk(2), reviewAsk(3)]);
  c.after(t.cleanup);
  runSync(t.desk.setAfter("api#2", ["api#1"]));
  runSync(t.desk.setAfter("api#3", ["api#2"]));
  assert.throws(() => runSync(t.desk.setAfter("api#1", ["api#3"])), /api#1 after api#3 would make a loop: api#3 already comes after api#1/);
  assert.throws(() => runSync(t.desk.setAfter("api#1", ["acme/api#1"])), /api#1 can't come after itself/);
  assert.throws(() => runSync(t.desk.setAfter("api#1", ["acme/api#99"])), /no item "acme\/api#99" on the desk/);
  assert.throws(() => runSync(t.desk.setAfter("api#1", ["note:nope"])), /no note "note:nope"/);
  assert.throws(() => runSync(t.desk.setAfter("note:nope", [])), /no note "note:nope"/);
  assert.equal(t.desk.afterLinks().has("acme/api#1"), false);
  // inbox_add checks its after first: nothing is added when one can't be named.
  t.gh.items.set("acme/web#7", theirs("acme/web", 7));
  assert.throws(() => runSync(t.desk.add("acme/web#7", undefined, undefined, ["acme/api#99"])), /no item "acme\/api#99"/);
  assert.equal(t.desk.snapshot().entries.has("acme/web#7"), false);
});

test("a chain runs through a note: it's the head once the PR merges, and its Done brings the next step", async (c) => {
  const t = await desk([reviewAsk(1), reviewAsk(2)]);
  c.after(t.cleanup);
  const n = runSync(t.desk.saveNote(null, { text: "Run the Seer load test", remind: "" }));
  runSync(t.desk.setAfter(`note:${n.id}`, ["api#1"]));
  runSync(t.desk.setAfter("api#2", [`note:${n.id}`]));
  const v = runSync(t.desk.queue());
  assert.deepEqual(v.notes.open, []);
  assert.deepEqual(steps(onInbox(v)[0]), [
    [`note:${n.id}`, "api#1"],
    ["acme/api#2", "Run the Seer load test"],
  ]);
  assert.equal(onInbox(v)[0]?.waiting?.[0]?.kind, "note");
  merge(t, "acme/api#1", later(t, 1));
  await run(t.desk.sync());
  const w = runSync(t.desk.queue());
  assert.deepEqual(ids(onInbox(w)), []);
  assert.deepEqual(
    w.notes.open.map((x) => [x.id, x.waiting?.map((s) => s.id)]),
    [[n.id, ["acme/api#2"]]],
  );
  assert.deepEqual(t.notes, ["Run the Seer load test is next · api#1 merged"]);
  runSync(t.desk.doneNote(n.id));
  assert.deepEqual(ids(onInbox(runSync(t.desk.queue()))), ["acme/api#2"]);
  assert.deepEqual(t.notes.at(-1), "api#2 is next · your note is done");
  assert.equal(t.desk.afterLinks().has(`note:${n.id}`), false, "the done note's own links go with it");
});

test("a head that doesn't need you is on Blocked with its chain, whatever its pin; it notifies once it needs you", async (c) => {
  // Someone else's draft you follow, pinned by inbox_add, then your step after it.
  const t = await desk([reviewAsk(2)], [theirs("acme/ops", 9, { draft: true })]);
  c.after(t.cleanup);
  runSync(t.desk.setAfter("api#2", ["ops#9"]));
  later(t, 0.5);
  await run(t.desk.sync());
  const v = runSync(t.desk.queue());
  assert.deepEqual(ids(onInbox(v)), []);
  assert.deepEqual(
    v.sections.blocked.map((x) => [x.id, x.why, steps(x)]),
    [["acme/ops#9", "is a draft", [["acme/api#2", "ops#9"]]]],
  );
  assert.equal(runSync(t.desk.overview()).focus.today, 0);
  assert.deepEqual(t.notes, [], "Blocked never notifies");
  // It's asked of you now: the chain's row comes onto the Inbox, and says so once.
  t.gh.items.set("acme/ops#9", {
    ...t.gh.items.get("acme/ops#9")!,
    draft: false,
    review_requests: [{ reviewer: "me", type: "user", codeowner: false }],
    updated_at: later(t, 1),
  });
  await run(t.desk.sync());
  const w = runSync(t.desk.queue());
  assert.deepEqual(ids(onInbox(w)), ["acme/ops#9"]);
  assert.deepEqual(ids(w.sections.blocked), []);
  assert.equal(t.notes.length, 1);
  assert.match(t.notes[0]!, /^ops#9 · /);
});

test("a head you approved, for its author to merge, stays on Blocked, not the Archive, until the chain is done", async (c) => {
  const approved = reviewAsk(1, {
    review_requests: [],
    reviews: [
      {
        author: "me",
        author_bot: false,
        trusted: true,
        state: "approved",
        at: new Date(NOW.getTime() - 3_600_000).toISOString(),
        commit: "abc",
      },
    ],
    review_decision: "approved",
  });
  const t = await desk([reviewAsk(2)], [approved]);
  c.after(t.cleanup);
  runSync(t.desk.setAfter("api#2", ["api#1"]));
  const v = runSync(t.desk.queue());
  assert.deepEqual(
    v.sections.blocked.map((x) => [x.id, x.why, x.resolved]),
    [["acme/api#1", "is approved, for carol to merge", "you approved"]],
  );
  assert.deepEqual(ids(v.resolved), []);
  assert.deepEqual(ids(onInbox(v)), []);
});
