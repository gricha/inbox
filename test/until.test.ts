// Snoozing until something happens: the item waits in Later until CI passes, new commits land, it's approved, out of draft
// or its conflict is fixed, then comes back once, however the condition moves after.
import { test } from "node:test";
import assert from "node:assert/strict";
import { myPr, reviewAsk, setup } from "./helpers/desk.ts";
import { NOW } from "./helpers/items.ts";
import { runSync } from "./helpers/run.ts";

const later = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();
const approve = { author: "alice", author_bot: false, trusted: true, state: "approved" as const, at: later(0.5), commit: "abc" };

test("until CI passes: snoozed while it's red, back once it's green, and red again later doesn't snooze it again", async (c) => {
  const t = await setup([reviewAsk(1, { ci: "red" })]);
  c.after(t.cleanup);
  await t.desk.sync();
  const card = () => runSync(t.desk.item("api#1")).card;
  assert.deepEqual(card().wake_on, ["ci", "push"]);

  runSync(t.desk.act("api#1", "snooze", "ci"));
  assert.deepEqual([card().status, card().snooze_when, card().snooze_until], ["snoozed", "ci", null]);
  assert.equal(runSync(t.desk.queue()).cleared[0]?.id, "acme/api#1", "in Later meanwhile");

  // Someone comments: still red, so it keeps waiting (a time snooze would wake here).
  t.setNow(new Date(later(1)));
  t.gh.items.set(
    "acme/api#1",
    reviewAsk(1, { ci: "red", updated_at: later(0.5), comments: [{ author: "carol", author_bot: false, at: later(0.5) }] }),
  );
  await t.desk.sync();
  assert.equal(card().status, "snoozed");

  t.gh.items.set("acme/api#1", reviewAsk(1, { ci: "green", updated_at: later(0.9) }));
  await t.desk.sync();
  assert.deepEqual([card().status, card().snooze_when], ["active", null]);
  assert.equal(t.desk.store.state("acme/api#1").snooze_when, null, "it happened, so the snooze is over");

  t.gh.items.set("acme/api#1", reviewAsk(1, { ci: "red", updated_at: later(0.95) }));
  await t.desk.sync();
  assert.equal(card().status, "active");
});

test("until new commits waits for a head past the one you saw; restore and undo end it", async (c) => {
  const t = await setup([reviewAsk(1, { head_oid: "aaa" }), reviewAsk(2)]);
  c.after(t.cleanup);
  await t.desk.sync();
  runSync(t.desk.act("api#1", "snooze", "push"));
  assert.equal(t.desk.store.state("acme/api#1").snooze_when, "push:aaa");
  assert.equal(runSync(t.desk.item("api#1")).card.snooze_when, "push");
  t.gh.items.set("acme/api#1", reviewAsk(1, { head_oid: "bbb", updated_at: later(0.5) }));
  await t.desk.sync();
  assert.equal(runSync(t.desk.item("api#1")).card.status, "active");

  runSync(t.desk.act("api#2", "snooze", "push"));
  runSync(t.desk.act("api#2", "restore"));
  assert.equal(runSync(t.desk.item("api#2")).card.status, "active");
  assert.equal(t.desk.store.state("acme/api#2").snooze_when, null);
  runSync(t.desk.undo());
  assert.equal(runSync(t.desk.item("api#2")).card.snooze_when, "push", "undoing the restore brings the snooze back");
  runSync(t.desk.undo());
  assert.equal(runSync(t.desk.item("api#2")).card.status, "active", "undoing the snooze ends it");
});

test("your PR waits until it's approved; a draft until it's ready; a conflict until it's fixed; a closed one keeps waiting", async (c) => {
  const t = await setup([
    myPr(1, { ci: "green", mergeable: "conflict" }),
    reviewAsk(2, { draft: true }),
    reviewAsk(3),
    myPr(4, { ci: "green", review_decision: "approved", reviews: [approve], mergeable: "conflict" }),
  ]);
  c.after(t.cleanup);
  await t.desk.sync();
  assert.deepEqual(runSync(t.desk.item("web#1")).card.wake_on, ["approved", "conflict"]);
  assert.deepEqual(runSync(t.desk.item("api#2")).card.wake_on, ["push", "ready"]);

  runSync(t.desk.act("web#1", "snooze", "approved"));
  runSync(t.desk.act("api#2", "snooze", "ready"));
  runSync(t.desk.act("api#3", "snooze", "push"));
  runSync(t.desk.act("web#4", "snooze", "conflict"));
  t.gh.items.set(
    "acme/web#1",
    myPr(1, { ci: "green", mergeable: "conflict", review_decision: "approved", reviews: [approve], updated_at: later(0.5) }),
  );
  t.gh.items.set("acme/api#2", reviewAsk(2, { draft: false, updated_at: later(0.5) }));
  t.gh.items.set("acme/api#3", reviewAsk(3, { state: "closed", updated_at: later(0.5) }));
  t.gh.items.set(
    "acme/web#4",
    myPr(4, { ci: "green", review_decision: "approved", reviews: [approve], mergeable: "clean", updated_at: later(0.5) }),
  );
  await t.desk.sync();
  assert.deepEqual(
    ["web#1", "api#2", "web#4"].map((r) => runSync(t.desk.item(r)).card.status),
    ["active", "active", "active"],
  );
  assert.equal(runSync(t.desk.item("api#3")).card.resolved, "closed", "closed: in the Archive, as any closed item");
  // Reopened with the same commits, it still waits (a reopen from the desk puts the snooze back while GitHub says closed).
  assert.equal(t.desk.store.state("acme/api#3").snooze_when, "push:abc");
  t.gh.items.set("acme/api#3", reviewAsk(3, { updated_at: later(0.6) }));
  await t.desk.sync();
  assert.equal(runSync(t.desk.item("api#3")).card.status, "snoozed");
});

test("a condition that has already happened, or doesn't fit the item, is refused", async (c) => {
  const t = await setup([reviewAsk(1), myPr(2, { ci: "green", review_decision: "approved", reviews: [approve] })]);
  c.after(t.cleanup);
  await t.desk.sync();
  assert.throws(() => runSync(t.desk.act("api#1", "snooze", "ci")), /can't wait until CI passes; it can until new commits/);
  assert.throws(() => runSync(t.desk.act("api#1", "snooze", "approved")), /can't wait until it's approved/);
  assert.throws(() => runSync(t.desk.act("web#2", "snooze", "approved")), /can't wait until it's approved$/);
  assert.equal(runSync(t.desk.item("web#2")).card.wake_on, undefined, "nothing to wait on");
  assert.throws(() => runSync(t.desk.act("api#1", "snooze", "toString")), /can't read snooze time/);
});

test("until it's approved follows the desk's approved, also where GitHub requires no review", async (c) => {
  const t = await setup([
    myPr(1, { ci: "green", review_decision: "none" }),
    myPr(2, { ci: "green", review_decision: "none", reviews: [approve] }),
  ]);
  c.after(t.cleanup);
  await t.desk.sync();
  assert.equal(runSync(t.desk.item("web#2")).card.wake_on, undefined, "approved already: nothing to wait on");
  runSync(t.desk.act("web#1", "snooze", "approved"));
  t.gh.items.set("acme/web#1", myPr(1, { ci: "green", review_decision: "none", reviews: [approve], updated_at: later(0.5) }));
  await t.desk.sync();
  assert.deepEqual([runSync(t.desk.item("web#1")).card.stage, runSync(t.desk.item("web#1")).card.status], ["approved", "active"]);
});
