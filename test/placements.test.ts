// Each item's log: where it stood on your desk each time that changed, and why.
import "./helpers/no-agent.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewAsk, setup, teamPing, UNSCORED } from "./helpers/desk.ts";
import { hoursAgo } from "./helpers/items.ts";
import { run, runSync } from "./helpers/run.ts";

const QUIET = { ...UNSCORED, "policy.judge": false };

test("an item's log: how it got where it is, each move and why, newest first; nothing new when nothing moved", async (c) => {
  const t = await setup([reviewAsk(1), teamPing(2)], { settings: QUIET });
  c.after(t.cleanup);
  await run(t.desk.sync());
  runSync(t.desk.queue());
  const log = (id: string) => runSync(t.desk.item(id)).log;
  const [first] = log("acme/api#1");
  assert.deepEqual(first?.changed, ["new"]);
  assert.equal(first?.where, "urgent");
  assert.equal(first?.reason, "Asked by name");
  assert.deepEqual(first?.rule, {
    board: "acme-review",
    id: "asked-directly",
    why: "carol asked you directly",
    when: "me.requested_direct && !me.requested_by_bot",
    bucket: "now",
  });
  assert.deepEqual(first?.criteria, ["Asked by name"]);
  assert.equal(log("acme/api#2")[0]?.where, "fyi");

  // Computing the queue again with nothing changed writes nothing.
  runSync(t.desk.queue());
  assert.equal(log("acme/api#1").length, 1);

  // You move it, then you're done with it: each is an entry, saying what changed.
  runSync(t.desk.act("acme/api#1", "fyi"));
  runSync(t.desk.queue());
  runSync(t.desk.act("acme/api#1", "done"));
  runSync(t.desk.queue());
  const [done, moved] = log("acme/api#1");
  assert.deepEqual([moved?.where, moved?.moved, moved?.changed], ["fyi", "fyi", ["where", "moved"]]);
  assert.deepEqual([done?.where, done?.status], ["cleared", "done"]);
  assert.ok(done?.changed.includes("status"));

  // Someone else approves the team ping: resolved, and why.
  const two = t.gh.items.get("acme/api#2")!;
  t.gh.items.set("acme/api#2", {
    ...two,
    review_decision: "approved",
    reviews: [{ author: "dana", author_bot: false, state: "approved", at: hoursAgo(1), commit: "abc" }],
    updated_at: hoursAgo(0),
  });
  await run(t.desk.sync());
  runSync(t.desk.queue());
  const [now] = log("acme/api#2");
  assert.deepEqual([now?.where, now?.resolved], ["resolved", "approved by dana"]);
});
