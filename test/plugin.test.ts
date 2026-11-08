// A source that isn't GitHub, held in memory (ids notes:1, notes:2…): the guard that the core stops assuming GitHub.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Desk } from "../src/desk.ts";
import type { Head } from "../src/types.ts";
import { reviewAsk, setup } from "./helpers/desk.ts";
import { makeItem, NOW } from "./helpers/items.ts";
import { run } from "./helpers/run.ts";

const DAY = 24 * 3_600_000;

interface Note extends Head {
  text: string;
}

// Its notes go into the desk's store as GitHub's items do, with none of GitHub's fields.
class Notes {
  readonly id = "notes";
  desk: Desk;
  notes: Note[] = [];

  constructor(desk: Desk) {
    this.desk = desk;
  }

  add(text: string): Note {
    const at = this.desk.now().toISOString();
    const note = { id: `${this.id}:${this.notes.length + 1}`, url: "", created_at: at, updated_at: at, text };
    this.notes.push(note);
    this.desk.store.putItems([note], at);
    return note;
  }
}

test("a note outlives GitHub's 14-day prune, which still drops GitHub's rows no search returns", async (c) => {
  const t = await setup([reviewAsk(1)], { settings: { "policy.judge": false } });
  c.after(t.cleanup);
  await run(t.desk.sync());
  const note = new Notes(t.desk).add("Call Ann about the release");
  const unlisted = makeItem({ number: 9 });
  t.desk.store.putItems([unlisted], NOW.toISOString());
  const meta = t.desk.store.itemMeta().get(note.id);
  assert.deepEqual([meta?.node_id, meta?.detail_at], ["", NOW.toISOString()]);

  t.setNow(new Date(NOW.getTime() + 15 * DAY));
  await run(t.desk.gh.pass()); // its pass alone: the recompute a sync ends with still reads every item as GitHub's
  const ids = [note.id, unlisted.id, reviewAsk(1).id];
  assert.deepEqual([...t.desk.store.itemsById(ids).keys()], [note.id, reviewAsk(1).id]);
  assert.deepEqual(t.desk.store.itemsById([note.id]).get(note.id), note, "stored whole");
});
