// Your order on the Inbox: a row you drag keeps its place among the desk's, across sections, syncs and restarts, until
// the item's next activity.
import "./helpers/no-agent.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Desk } from "../src/desk.ts";
import { arrange, rankAt, type Ranked } from "../src/order.ts";
import { createApp } from "../src/server.ts";
import type { InboxSection, Place } from "../src/types.ts";
import { reviewAsk, setup, teamPing } from "./helpers/desk.ts";
import { hoursAgo, NOW } from "./helpers/items.ts";
import { run, runSync } from "./helpers/run.ts";
import { posix } from "./helpers/platform.ts";

const QUIET = { "policy.judge": false, "review.auto_ai": false, "notify.quiet": "" };

type Row = { id: string; key: number; place?: Place };
const R: Ranked<Row> = { id: (r) => r.id, key: (r) => r.key, place: (r) => r.place };
const ids = (rows: Row[]) => arrange(rows, R).map((r) => r.id);
// Drops `id` between `after` and `before` in rows (as arranged), as the desk stores it.
function drop(rows: Row[], id: string, after?: string, before?: string, at = "2026-10-27T12:00:00Z"): Row[] {
  const p = rankAt(arrange(rows, R), R, id, after, before);
  assert.ok(p, `a drop of ${id}`);
  return rows.map((r) => (r.id === id ? { ...r, place: { section: "standard", ...p, at } } : r));
}

test("a dropped row lands between its neighbours, and what the desk scores later lands around it", () => {
  const rows: Row[] = [
    { id: "a", key: 9 },
    { id: "b", key: 7 },
    { id: "c", key: 5 },
    { id: "d", key: 3 },
  ];
  const moved = drop(rows, "d", "a", "b");
  assert.deepEqual(ids(moved), ["a", "d", "b", "c"]);
  assert.deepEqual(ids(drop(rows, "a", undefined, "d")), ["b", "c", "a", "d"], "dropped above the last");
  assert.deepEqual(ids(drop(rows, "c", undefined, "a")), ["c", "a", "b", "d"], "dropped at the top");
  assert.deepEqual(ids(drop(rows, "a", "d")), ["b", "c", "d", "a"], "dropped at the bottom");
  // A new row the desk scores 8 goes above the one you put at 8's neighbourhood, one scored 7.5 below it.
  assert.deepEqual(ids([...moved, { id: "n", key: 8.5 }].toSorted((x, y) => y.key - x.key)), ["a", "n", "d", "b", "c"]);
  assert.deepEqual(ids([...moved, { id: "n", key: 7.5 }].toSorted((x, y) => y.key - x.key)), ["a", "d", "n", "b", "c"]);
});

test("among equal keys a row sits by the neighbour you dropped it by; the newer of two drops is nearer", () => {
  const rows: Row[] = ["a", "b", "c", "d"].map((id) => ({ id, key: 5 }));
  const one = drop(rows, "d", "a", "b", "2026-10-27T12:00:00Z");
  assert.deepEqual(ids(one), ["a", "d", "b", "c"]);
  const two = drop(one, "c", "a", "d", "2026-10-27T12:01:00Z");
  assert.deepEqual(ids(two), ["a", "c", "d", "b"]);
  // The row it was dropped after leaves: it holds by its rank among the rest.
  assert.deepEqual(ids(two.filter((r) => r.id !== "a")), ["c", "d", "b"]);
});

test("a drop names the rows you saw: one left out is the row next to the other, so a filtered list lands by them", () => {
  const rows: Row[] = [
    { id: "a", key: 9 },
    { id: "hidden", key: 8 },
    { id: "b", key: 7 },
    { id: "c", key: 5 },
  ];
  // Filtered to a, b, c: c dropped after a, the last row seen above where it went.
  assert.deepEqual(ids(drop(rows, "c", "a")), ["a", "c", "hidden", "b"]);
  assert.deepEqual(ids(drop(rows, "c", undefined, "b")), ["a", "hidden", "c", "b"]);
  assert.equal(rankAt(rows, R, "c", "nope"), null, "a row not in the list");
  assert.equal(rankAt(rows, R, "c"), undefined, "no neighbours: where the desk puts it");
});

const inbox = (t: Awaited<ReturnType<typeof setup>>) => runSync(t.desk.queue()).inbox;
const order = (t: Awaited<ReturnType<typeof setup>>, s: InboxSection) => inbox(t)[s].map((c) => c.id);
const sectionOf = (t: Awaited<ReturnType<typeof setup>>, id: string) =>
  (["urgent", "standard", "fyi"] as const).find((s) => inbox(t)[s].some((c) => c.id === id));

test("you place a PR in its section and across sections; it holds through syncs and a restart; undo takes it back", posix, async (c) => {
  const t = await setup([reviewAsk(1), reviewAsk(2), reviewAsk(3), reviewAsk(4), teamPing(5)], { settings: QUIET });
  c.after(t.cleanup);
  await run(t.desk.sync());
  const was = order(t, "urgent");
  assert.deepEqual(was.toSorted(), ["acme/api#1", "acme/api#2", "acme/api#3", "acme/api#4"]);
  const last = was.at(-1)!;
  runSync(t.desk.place(last, "urgent", { before: was[0]! }));
  assert.deepEqual(order(t, "urgent"), [last, ...was.slice(0, -1)], "the last, dragged to the top");
  // Into another section, at that spot.
  const home = sectionOf(t, "acme/api#5");
  assert.notEqual(home, "urgent");
  const moved = runSync(t.desk.place("acme/api#5", "urgent", { after: last }));
  assert.deepEqual(order(t, "urgent").slice(0, 2), [last, "acme/api#5"]);
  // The window, the phone and agents read the same view, from the desk's store: a sync and a new desk on it keep it.
  await run(t.desk.sync());
  assert.deepEqual(order(t, "urgent").slice(0, 2), [last, "acme/api#5"]);
  await run(t.desk.close());
  const again = new Desk({ home: t.home, github: t.gh, now: () => NOW, notify: () => {}, log: () => {} });
  await run(again.init());
  await run(again.sync());
  assert.deepEqual(
    runSync(again.queue())
      .inbox.urgent.slice(0, 2)
      .map((x) => x.id),
    [last, "acme/api#5"],
  );
  runSync(again.act("acme/api#5", "undo"));
  assert.equal(
    runSync(again.queue()).inbox[home!].some((x) => x.id === "acme/api#5"),
    true,
    "undo: back where it was",
  );
  assert.ok(moved.undo_seq > 0);
  await run(again.close());
  fs.rmSync(t.home, { recursive: true, force: true });
});

test("a placement ends with the item's next activity or when you're done with it; the section you moved it to stays", posix, async (c) => {
  const t = await setup([reviewAsk(1), reviewAsk(2), reviewAsk(3), teamPing(5)], { settings: QUIET });
  c.after(t.cleanup);
  await run(t.desk.sync());
  const home = sectionOf(t, "acme/api#5");
  const was = order(t, "urgent");
  runSync(t.desk.place(was[0]!, "urgent", { after: was.at(-1)! }));
  assert.equal(order(t, "urgent").at(-1), was[0]);
  runSync(t.desk.place("acme/api#5", "urgent", { before: was[1]! }));
  assert.equal(order(t, "urgent")[0], "acme/api#5");
  // Someone comments on the first: it goes back where the desk puts it.
  const first = t.gh.items.get(was[0]!)!;
  t.gh.items.set(first.id, { ...first, updated_at: hoursAgo(0), comments: [{ author: "dana", author_bot: false, at: hoursAgo(0) }] });
  await run(t.desk.sync());
  assert.notEqual(order(t, "urgent").at(-1), was[0], "a comment ends where you dragged it");
  // Its own sync, nothing new: #5 holds, in the section you dragged it to.
  assert.equal(order(t, "urgent")[0], "acme/api#5");
  const five = t.gh.items.get("acme/api#5")!;
  t.gh.items.set(five.id, {
    ...five,
    updated_at: hoursAgo(0),
    head_oid: "new",
    comments: [{ author: "carol", author_bot: false, at: hoursAgo(0) }],
  });
  await run(t.desk.sync());
  assert.equal(sectionOf(t, "acme/api#5"), "urgent", "a push ends the place, not the move to Urgent");
  runSync(t.desk.act("acme/api#5", "done"));
  runSync(t.desk.act("acme/api#5", "restore"));
  assert.equal(sectionOf(t, "acme/api#5"), home, "done ends both");
  assert.equal(t.desk.store.state("acme/api#5").place, null);
});

test("notes and questions keep your order among their kind; the desk refuses what can't go there", posix, async (c) => {
  const t = await setup([reviewAsk(1), teamPing(5)], { settings: QUIET });
  c.after(t.cleanup);
  await run(t.desk.sync());
  const note = (text: string, minutes: number) => {
    t.setNow(new Date(NOW.getTime() + minutes * 60_000));
    return runSync(t.desk.saveNote(null, { text, remind: "" }));
  };
  const [a, b, n3] = [note("one", 1), note("two", 2), note("three", 3)];
  const notes = () => runSync(t.desk.queue()).notes.open.map((n) => n.text);
  assert.deepEqual(notes(), ["three", "two", "one"]);
  runSync(t.desk.place(`note:${a.id}`, "standard", { before: `note:${n3.id}` }));
  assert.deepEqual(notes(), ["one", "three", "two"]);
  runSync(t.desk.place(`note:${b.id}`, "fyi", {}));
  assert.deepEqual(
    runSync(t.desk.queue()).notes.fyi.map((n) => n.text),
    ["two"],
  );
  runSync(t.desk.saveNote(a.id, { text: "one, said again", remind: "" }));
  assert.equal(notes()[0], "one, said again", "new words keep where you put it");
  const ask = (q: string) => runSync(t.desk.inquire({ question: q, from: "a session", context: "x ".repeat(120), item: "acme/api#1" })).id;
  const [q1, q2] = [ask("First?"), ask("Second?")];
  runSync(t.desk.place(`ask:${q2}`, "urgent", { before: `ask:${q1}` }));
  assert.deepEqual(
    runSync(t.desk.queue()).inquiries.map((q) => q.id),
    [q2, q1],
  );
  const refused = (e: Parameters<typeof runSync>[0]) => {
    assert.throws(() => {
      runSync(e);
    });
  };
  refused(t.desk.place(`ask:${q1}`, "standard", {}));
  refused(t.desk.place("acme/api#1", "urgent", { after: "acme/api#5" })); // #5 isn't in Urgent
  refused(t.desk.place(`note:${a.id}`, "standard", { after: "acme/api#5" })); // a note goes among notes
});

test("POST /api/place takes a row and its neighbours; a bad section is refused in words", posix, async (c) => {
  const t = await setup([reviewAsk(1), reviewAsk(2)], { settings: QUIET });
  c.after(t.cleanup);
  await run(t.desk.sync());
  const app = createApp(t.desk, 47823);
  const post = (body: unknown) =>
    app.request("http://127.0.0.1:47823/api/place", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:47823", "sec-fetch-site": "same-origin" },
      body: JSON.stringify(body),
    });
  const was = order(t, "urgent");
  const ok = await post({ id: was[1], section: "urgent", before: was[0] });
  assert.equal(ok.status, 200);
  assert.deepEqual(order(t, "urgent"), [was[1], was[0]]);
  const bad = await post({ id: was[1], section: "later" });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /urgent\|standard\|fyi/);
});
