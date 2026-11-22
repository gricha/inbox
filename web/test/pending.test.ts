import "../../test/helpers/no-agent.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { placeNotes, type Note, type Standing } from "../../src/types.ts";
import { settleNoteEdits, settleReviewerAsks, withNoteEdits, withReviewerAsks } from "../src/pending.ts";

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
