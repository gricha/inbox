// Someone else's PR you approved whose author has no say on the repo (a fork's contributor): they can't merge it, so the
// merge is yours. Approving doesn't resolve it or take it off your desk, Done does, and its row offers Hand off for merge.
import "./helpers/no-agent.ts";
import { test } from "node:test";
import { Effect } from "effect";
import assert from "node:assert/strict";
import { mergeOwed, waitsOf } from "../src/stage.ts";
import { reviewAsk, setup } from "./helpers/desk.ts";
import { hoursAgo } from "./helpers/items.ts";
import { run, runSync } from "./helpers/run.ts";
import { refuseWrites } from "./helpers/writer.ts";
import type { Item } from "../src/types.ts";

const approvedByMe = (n: number, o: Partial<Item> = {}) =>
  reviewAsk(n, {
    author: "outsider",
    review_requests: [],
    reviews: [{ author: "me", author_bot: false, state: "approved", at: hoursAgo(1), commit: "h4", trusted: true }],
    ci: "green",
    review_decision: "approved",
    mergeable: "clean",
    merge_method: "SQUASH",
    head_oid: "h4",
    author_can_merge: false,
    head_repo: "outsider/api",
    ...o,
  });

test("the merge is yours: approved by you, its author can't merge it, nobody holds it", () => {
  assert.equal(mergeOwed(approvedByMe(1), "me"), true);
  assert.equal(mergeOwed(approvedByMe(1, { author_can_merge: true }), "me"), false, "a collaborator merges their own");
  const { author_can_merge: _, ...old } = approvedByMe(1);
  assert.equal(mergeOwed(old, "me"), false, "stored before it was fetched");
  assert.equal(mergeOwed(approvedByMe(1, { draft: true }), "me"), false, "a draft");
  assert.equal(mergeOwed(approvedByMe(1, { head_repo: "acme/api" }), "me"), false, "its branch is in the repo: a bot's for a teammate");
  assert.equal(mergeOwed(approvedByMe(1, { head_repo: "" }), "me"), true, "a deleted fork");
  assert.equal(mergeOwed(approvedByMe(1, { can_merge: false }), "me"), false, "you can't merge it either");
  assert.equal(mergeOwed(approvedByMe(1, { review_decision: "required" }), "me"), false, "GitHub wants another approval");
  const held = approvedByMe(1);
  held.reviews.push({ author: "dana", author_bot: false, state: "changes_requested", at: hoursAgo(0), commit: "h4" });
  assert.equal(mergeOwed(held, "me"), false, "someone asked for changes");
  const changed = approvedByMe(1);
  changed.reviews.push({ author: "me", author_bot: false, state: "changes_requested", at: hoursAgo(0), commit: "h4" });
  assert.equal(mergeOwed(changed, "me"), false, "your latest verdict isn't an approval");
  const team = { author_can_merge: true, head_repo: "acme/api" };
  assert.equal(
    mergeOwed(approvedByMe(1, { ...team, maintains: true }), "me"),
    false,
    "a teammate merges their own, even where you maintain",
  );
  const bot = { author: "dependabot", author_bot: true, author_can_merge: false, head_repo: "acme/api", requester: "" };
  assert.equal(mergeOwed(approvedByMe(1, { ...bot, maintains: true }), "me"), true, "a bot's branch in a repo you maintain");
  // The bot pushed its own branch and never merges: a person who approved it has to, though they only have write access.
  assert.equal(
    mergeOwed(approvedByMe(1, { ...bot, maintains: false }), "me"),
    true,
    "a dependency bot's branch where you have write access",
  );
  assert.equal(
    mergeOwed(approvedByMe(1, { ...bot, maintains: false, requester: "@dana" }), "me"),
    false,
    "a bot's opened for a teammate: theirs to merge",
  );
  assert.equal(mergeOwed(approvedByMe(1, { ...bot, auto_merge: true }), "me"), false, "auto-merge on: GitHub merges it");
  assert.equal(mergeOwed(approvedByMe(1, { ...bot, maintains: false }), "me", "@dana"), false, "the desk read it as opened for a teammate");
  assert.equal(mergeOwed(approvedByMe(1, { auto_merge: true }), "me"), false, "auto-merge on, from a fork too");
  assert.equal(mergeOwed(approvedByMe(1, { ...bot, maintains: true, review_decision: "none" }), "me"), true, "a repo that needs no review");
  assert.equal(mergeOwed(approvedByMe(1, { ...bot, maintains: true, author: "me" }), "me"), false, "your own isn't owed");
  const o = { mine: false, unasked: false, askedYou: false, waitingOn: [] };
  assert.equal(waitsOf(approvedByMe(1, { ...bot, maintains: true }), "me", o), "is yours to merge: dependabot can't");
  assert.equal(waitsOf(approvedByMe(1), "me", o), "is yours to merge: outsider can't");
  assert.equal(waitsOf(approvedByMe(1, { author_can_merge: true }), "me", o), "is approved, for outsider to merge");
});

test("a merge you owe isn't resolved by your approval, Done puts it away, and its row hands it off for merge", async (c) => {
  const writer = { ...refuseWrites(), approve: () => Effect.succeed({ url: "" }) };
  const fresh = approvedByMe(68, { reviews: [] });
  const theirs = approvedByMe(69, { reviews: [], author_can_merge: true });
  const t = await setup([approvedByMe(66), approvedByMe(67, { author_can_merge: true }), fresh, theirs], { desk: { writer } });
  c.after(t.cleanup);
  const route = t.gh.route;
  t.gh.route = (q) => (q.includes("review-requested:@me") ? ["acme/api#66", "acme/api#67", "acme/api#68", "acme/api#69"] : route(q)); // as reviewed-by:@me lists them
  await run(t.desk.sync());
  // The window opens the next item as you press Approve, unless approving keeps this one for Hand off for merge.
  assert.equal((await run(t.desk.reviewView("api#68"))).approve.keeps, true, "approving makes the merge yours");
  assert.equal((await run(t.desk.reviewView("api#69"))).approve.keeps, undefined, "a collaborator merges their own");
  const card = (ref: string) => runSync(t.desk.item(ref)).card;
  assert.equal(card("api#66").resolved, null);
  assert.equal(card("api#67").resolved, "you approved", "a collaborator's: your part is done");
  assert.equal(card("api#66").cta, "handoff");
  assert.ok(card("api#66").actions?.includes("merge"), "More merges it now");
  assert.deepEqual(await run(t.desk.approve("api#68", fresh.head_oid)), { url: "", stays: true }, "the window keeps its row");
  assert.equal(card("api#68").status, "active", "approving a merge that's now yours keeps it on your desk");
  runSync(t.desk.act("api#68", "done"));
  await run(t.desk.sync());
  assert.equal(card("api#68").status, "done", "Done puts it away");
  runSync(t.desk.act("api#66", "inflight"));
  assert.equal(card("api#66").inflight, true, "handed off: Merging has it");
});

test("a dependency bot's PR you approved and must merge is on your desk once it's ready, though the rules hide bot PRs", async (c) => {
  const bump = approvedByMe(70, {
    author: "dependabot",
    author_bot: true,
    head_repo: "acme/api",
    requester: "",
    maintains: false,
    can_merge: true,
  });
  const red = approvedByMe(71, { ...bump, number: 71, id: "acme/api#71", url: "https://github.com/acme/api/pull/71", ci: "red" });
  const writer = { ...refuseWrites(), approve: () => Effect.succeed({ url: "" }) };
  const t = await setup([bump, red], { builtIns: true, desk: { writer } });
  c.after(t.cleanup);
  const route = t.gh.route;
  t.gh.route = (q) => (q.includes("review-requested:@me") ? ["acme/api#70", "acme/api#71"] : route(q));
  await run(t.desk.sync());
  const q = await run(t.desk.queue());
  const shown = [...q.inbox.urgent, ...q.inbox.standard, ...q.inbox.fyi];
  const row = shown.find((x) => x.id === "acme/api#70");
  assert.equal(row?.why, "yours to merge: dependabot can't", "a bot never merges its own: it's on your desk");
  assert.equal(row?.cta, "handoff");
  assert.notEqual(row?.stage, "handed back", "nobody handed it back");
  assert.equal(
    shown.some((x) => x.id === "acme/api#71"),
    false,
    "one that isn't ready stays where your rules put it",
  );
});
