import assert from "node:assert/strict";
import test from "node:test";
import { runSync } from "./helpers/run.ts";
import { setup } from "./helpers/desk.ts";

test("a note leads Standard; with a reminder it waits in the Archive, then notifies once and leads Urgent; Done removes it", async (c) => {
  const t = await setup([]);
  c.after(t.cleanup);
  const start = t.desk.now();
  const plain = runSync(t.desk.saveNote(null, { text: "  Write up the compaction idea ", remind: "" }));
  const later = runSync(t.desk.saveNote(null, { text: "Check the p95 dashboard", remind: "3h" }));
  assert.equal(plain.text, "Write up the compaction idea");
  assert.equal(later.remind_at, new Date(start.getTime() + 3 * 3_600_000).toISOString());
  const ids = () => {
    const n = runSync(t.desk.queue()).notes;
    return { due: n.due.map((x) => x.id), open: n.open.map((x) => x.id), later: n.later.map((x) => x.id) };
  };
  assert.deepEqual(ids(), { due: [], open: [plain.id], later: [later.id] });

  t.desk.remindDue();
  assert.deepEqual(t.notes, [], "nothing is due yet");
  t.setNow(new Date(start.getTime() + 3 * 3_600_000 + 1000));
  t.desk.remindDue();
  t.desk.remindDue();
  assert.deepEqual(t.notes, ["Check the p95 dashboard"], "notified once");
  assert.deepEqual(ids(), { due: [later.id], open: [plain.id], later: [] });

  // A new time is a new reminder.
  const moved = runSync(t.desk.saveNote(later.id, { text: "Check the p95 dashboard again", remind: "1h" }));
  assert.equal(moved.reminded_at, null);
  assert.deepEqual(ids().later, [later.id]);

  runSync(t.desk.doneNote(plain.id));
  assert.deepEqual(ids().open, []);
});

test("a note needs words and a reminder in the future", async (c) => {
  const t = await setup([]);
  c.after(t.cleanup);
  assert.throws(() => runSync(t.desk.saveNote(null, { text: "  ", remind: "" })), /the note is empty/);
  assert.throws(() => runSync(t.desk.saveNote(null, { text: "x", remind: "2001-01-01T00:00:00Z" })), /can't read the reminder/);
  assert.throws(() => {
    runSync(t.desk.doneNote("nope"));
  }, /no note "nope"/);
});
