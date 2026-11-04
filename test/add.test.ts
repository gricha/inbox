import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewDeps } from "../src/desk.ts";
import { createApp } from "../src/server.ts";
import { reviewAsk, setup, teamPing } from "./helpers/desk.ts";
import { hoursAgo, makeItem, NOW } from "./helpers/items.ts";

const DAY = 24 * 3_600_000;
const ID = "acme/other#9";
// Someone else's PR no board's search returns: only desk_add brings it in.
const unknown = () => makeItem({ repo: "acme/other", number: 9, author: "dave" });

// Diffs and AI reviews that never reach an agent: each review stays "being written".
function fakeReview() {
  const fetched: string[] = [];
  const started: string[] = [];
  const review: ReviewDeps = {
    fetchPr: (item) => {
      fetched.push(item.id);
      return Promise.resolve({ body: "", files: [] });
    },
    generate: (item) => {
      started.push(item.id);
      return new Promise(() => {});
    },
  };
  return { review, fetched, started };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++)
    await new Promise((r) => {
      setTimeout(r, 10);
    });
  assert.ok(cond(), "timed out waiting");
}

test("adding a PR the desk doesn't hold fetches it, pins it on the main page and starts its pre-review", async (c) => {
  const f = fakeReview();
  const t = await setup([teamPing(2)], { settings: { "policy.judge": false }, desk: { review: f.review } });
  c.after(t.cleanup);
  await t.desk.sync();
  t.gh.items.set(ID, unknown());
  const say = { id: "ic1", author: "dave", bot: false, body: "@me can you look?", at: hoursAgo(1), url: "https://github.com/x" };
  t.gh.contexts.set("PR_acme/other_9", { threads: [], reviews: [], comments: [say], commits: [] });
  await t.desk.sync();
  assert.equal(t.desk.snapshot().entries.has(ID), false, "no search returns it");

  const r = await t.desk.add("https://github.com/acme/other/pull/9/files");
  assert.deepEqual(t.gh.lookupCalls, [ID]);
  assert.equal(r.item.card.id, ID);
  assert.equal(r.item.state.pinned, true);
  assert.ok(r.undo_seq > 0);
  assert.equal(r.item.generating, true, "its AI review is being written");
  // The read fails on the no-agent helper's missing claude: it started, and no real agent ran.
  await until(() => f.started.length > 0 && t.desk.convos.errors.has(ID));
  assert.deepEqual(f.started, [ID]);
  assert.deepEqual(f.fetched, [ID], "the diff once: the AI review joins the fetch add started");
  assert.deepEqual(
    t.desk.store.activity({ after: 0, limit: 10, item: ID }).map((e) => e.kind),
    ["new"],
    "held with its events from here",
  );

  const row = t.desk.focus().sections.today.find((x) => x.id === ID);
  assert.ok(row, "on the main page");
  assert.equal(row.why, "you added it");
  assert.equal(t.desk.item(ID).placements[0]?.board, "added");
  await t.desk.sync();
  assert.deepEqual(t.notes, [], "you put it there: no notification");

  t.desk.undo(r.undo_seq);
  assert.equal(
    t.desk.focus().sections.today.some((x) => x.id === ID),
    false,
    "undo unpins it, and nothing else puts it there",
  );
});

test("an added PR stays while it's pinned and open: refreshed each sync, never pruned; merged, it resolves and goes", async (c) => {
  const t = await setup([reviewAsk(1)], { settings: { "policy.judge": false } });
  c.after(t.cleanup);
  await t.desk.sync();
  t.gh.items.set(ID, unknown());
  await t.desk.add(ID);

  t.setNow(new Date(NOW.getTime() + 15 * DAY));
  const before = t.gh.detailCalls.length;
  await t.desk.sync();
  assert.ok(
    t.gh.detailCalls.slice(before).some((ids) => ids.includes(ID)),
    "no search says when it changed: refreshed",
  );
  assert.ok(
    t.desk.focus().sections.today.some((x) => x.id === ID),
    "past the 14 days an item no search returns is kept",
  );

  t.gh.items.set(ID, { ...unknown(), state: "merged", updated_at: new Date(NOW.getTime() + 15 * DAY + 60_000).toISOString() });
  t.setNow(new Date(NOW.getTime() + 15 * DAY + 5 * 60_000));
  await t.desk.sync();
  assert.equal(
    t.desk.focus().sections.today.some((x) => x.id === ID),
    false,
  );
  assert.ok(t.desk.queue().resolved.some((x) => x.id === ID && x.why === "merged"));

  t.setNow(new Date(NOW.getTime() + 30 * DAY));
  await t.desk.sync();
  assert.equal(t.desk.store.itemsById([ID]).has(ID), false, "merged, it's pruned like anything no search returns");
});

test("adding what the desk holds pins it; a bad ref is a 400, one GitHub doesn't have a 404", async (c) => {
  const t = await setup([reviewAsk(1), teamPing(2)], { settings: { "policy.judge": false } });
  c.after(t.cleanup);
  await t.desk.sync();
  assert.equal(
    t.desk.focus().sections.today.some((x) => x.id === "acme/api#2"),
    false,
    "a team ping is FYI",
  );
  const app = createApp(t.desk, 47823);
  const add = (body: unknown) =>
    app.request("http://127.0.0.1:47823/api/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const res = await add({ id: "api#2" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { item: { card: { board: string } }; undo_seq: number };
  assert.ok(body.undo_seq > 0);
  assert.equal(body.item.card.board, "acme-review", "held: pinned where its board has it");
  assert.ok(t.desk.focus().sections.today.some((x) => x.id === "acme/api#2"));
  assert.deepEqual(t.gh.lookupCalls, [], "nothing fetched");

  assert.equal((await add({})).status, 400);
  assert.equal((await add({ id: "not a ref" })).status, 400);
  assert.equal((await add({ id: "web#5" })).status, 400, "a short ref finds only what the desk holds");
  assert.equal((await add({ id: "acme/api#999" })).status, 404);
  assert.deepEqual(t.gh.lookupCalls, ["acme/api#999"]);
});
