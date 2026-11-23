import "../../test/helpers/no-agent.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { placeNotes, type Card, type Inquiry, type Note, type QueueView, type Standing } from "../../src/types.ts";
import { settle, settleNoteEdits, settleReviewerAsks, withDrops, withNoteEdits, withReviewerAsks } from "../src/pending.ts";

const NOW = "2026-11-17T12:00:00.000Z";
const note = (id: string, extra: Partial<Note> = {}): Note => ({
  id,
  at: "2026-11-17T10:00:00.000Z",
  text: `note ${id}`,
  remind_at: null,
  reminded_at: null,
  ...extra,
});
const ids = (ns: Note[]) => ns.map((n) => n.id);

test("a note write shows at once, placed as the desk places it", () => {
  const desk = placeNotes([note("a"), note("b", { section: "urgent" })], NOW);
  const shown = withNoteEdits(
    desk,
    {
      a: null, // done
      b: note("b", { section: "fyi" }), // moved
      "new-1": note("new-1", { at: NOW, text: "fresh" }), // written, not answered yet
    },
    NOW,
  );
  assert.deepEqual(ids(shown.urgent), []);
  assert.deepEqual(ids(shown.fyi), ["b"]);
  assert.deepEqual(ids(shown.open), ["new-1"]);
  // A reminder to come takes it off the Inbox to the Archive's Reminders.
  const later = withNoteEdits(desk, { b: note("b", { remind_at: "2026-11-18T09:00:00.000Z" }) }, NOW);
  assert.deepEqual(ids(later.later), ["b"]);
  assert.deepEqual(ids(later.urgent), []);
  assert.equal(withNoteEdits(desk, {}, NOW), desk);
});

test("a note edit drops once the desk's view has it", () => {
  const edits = { a: null, b: note("b", { section: "fyi" }), "new-1": note("new-1") };
  const before = placeNotes([note("a"), note("b")], NOW);
  assert.equal(settleNoteEdits(before, edits), edits);
  const after = placeNotes([note("b", { section: "fyi" })], NOW);
  assert.deepEqual(Object.keys(settleNoteEdits(after, edits)), ["new-1"]);
});

test("a reviewer change shows at once and drops once the review's requests have it", () => {
  const list: Standing[] = [
    { who: "Sam", state: "asked" },
    { who: "kofi", state: "commented" },
  ];
  const asks = { sam: "removed", kofi: "asked", dana: "asked" } as const;
  assert.deepEqual(withReviewerAsks(list, asks), [
    { who: "kofi", state: "asked" },
    { who: "dana", state: "asked" },
  ]);
  assert.equal(withReviewerAsks(list, {}), list);
  assert.deepEqual(
    withReviewerAsks([{ who: "marco", state: "approved" }], { marco: "asked" }),
    [{ who: "marco", state: "approved", again: true }],
    "asked again keeps their verdict, as the desk lists it",
  );
  const user = (reviewer: string) => ({ reviewer, type: "user" as const, codeowner: false });
  assert.equal(settleReviewerAsks([user("Sam")], asks), asks);
  assert.deepEqual(settleReviewerAsks([user("kofi"), user("dana")], asks), {});
  assert.deepEqual(settleReviewerAsks([{ reviewer: "web", type: "team", codeowner: false }], { "@web": "asked" }), {});
});

test("a drop shows at once: the row where you let it go, in its section, among its kind", () => {
  const card = (id: string, score: number) => ({ id, score }) as Card;
  const ask = (id: string, at: string) => ({ id, at }) as Inquiry;
  const v = {
    inbox: { urgent: [card("a", 9), card("b", 8)], standard: [card("c", 6), card("d", 5)], fyi: [] },
    inquiries: [ask("q1", "2026-11-17T09:00:00.000Z"), ask("q2", "2026-11-17T10:00:00.000Z")],
    notes: placeNotes([note("n1"), note("n2", { at: "2026-11-17T11:00:00.000Z" }), note("n3", { section: "fyi" })], NOW),
  } as unknown as QueueView;
  const cards = (w: QueueView) => Object.fromEntries(Object.entries(w.inbox).map(([k, cs]) => [k, cs.map((c) => c.id)]));
  assert.deepEqual(cards(withDrops(v, [{ id: "d", section: "urgent", after: "a", before: "b" }])), {
    urgent: ["a", "d", "b"],
    standard: ["c"],
    fyi: [],
  });
  assert.equal(withDrops(v, [{ id: "d", section: "urgent", before: "a" }]).inbox.urgent[0]?.section, "urgent");
  assert.deepEqual(cards(withDrops(v, [{ id: "a", section: "fyi" }])).fyi, ["a"], "no neighbours: where its score goes");
  assert.deepEqual(
    withDrops(v, [{ id: "ask:q2", section: "urgent", before: "ask:q1" }]).inquiries.map((q) => q.id),
    ["q2", "q1"],
  );
  assert.equal(withDrops(v, [{ id: "ask:q2", section: "fyi" }]), v, "a question stays in Urgent");
  const moved = withDrops(v, [{ id: "note:n2", section: "fyi", after: "note:n3" }]).notes;
  assert.deepEqual([ids(moved.open), ids(moved.fyi)], [["n1"], ["n3", "n2"]]);
});

test("settle drops the writes a read has and keeps the rest", () => {
  const shown = new Map([
    ["a", true],
    ["b", false],
  ]);
  const read = new Map([
    ["a", true],
    ["b", true],
  ]);
  assert.deepEqual([...settle(shown, (k, v) => read.get(k) === v)], [["b", false]]);
});

test("settle returns the same map when the read has none of the writes", () => {
  const shown = new Map([["a", 1]]);
  assert.equal(
    settle(shown, () => false),
    shown,
  );
  const none = new Map<string, number>();
  assert.equal(
    settle(none, () => true),
    none,
  );
});
