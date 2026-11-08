// A source that isn't GitHub, held in memory (ids notes:1, notes:2…): the guard that the core stops assuming GitHub.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import type { Connector, Members } from "../src/connectors/connector.ts";
import type { Desk } from "../src/desk.ts";
import { NotFound } from "../src/errors.ts";
import type { ConnectorStatus, Head } from "../src/types.ts";
import { reviewAsk, setup } from "./helpers/desk.ts";
import { makeItem, NOW } from "./helpers/items.ts";
import { failureSync, run, runSync } from "./helpers/run.ts";

const DAY = 24 * 3_600_000;

interface Note extends Head {
  text: string;
}

// Its notes go into the desk's store as GitHub's items do, with none of GitHub's fields.
class Notes implements Connector {
  readonly id = "notes";
  readonly name = "Notes";
  desk: Desk;
  notes: Note[] = [];

  constructor(desk: Desk) {
    this.desk = desk;
  }

  // Kept by the source alone, until the desk fetches it.
  write(text: string): Note {
    const at = this.desk.now().toISOString();
    const note = { id: `${this.id}:${this.notes.length + 1}`, url: "", created_at: at, updated_at: at, text };
    this.notes.push(note);
    return note;
  }

  add(text: string): Note {
    const note = this.write(text);
    this.desk.store.putItems([note], note.updated_at);
    return note;
  }

  refOf(text: string, held: readonly string[]): { held: string[]; id: string } | null {
    return /^notes:\d+$/.test(text) ? { held: held.filter((id) => id === text), id: text } : null;
  }

  fetchOne(id: string): Effect.Effect<string, NotFound> {
    return Effect.suspend(() => {
      const note = this.notes.find((n) => n.id === id);
      if (!note) return Effect.fail(new NotFound({ message: `no note ${id}` }));
      this.desk.store.putItems([note], this.desk.now().toISOString());
      return Effect.succeed(note.id);
    });
  }

  // A notes board lists every note.
  boardIds(): Members {
    return { ids: new Set(this.notes.map((n) => n.id)), kept: new Set(), queries: [], unfetched: [] };
  }

  // Nothing to sync: its notes are in memory.
  start(): void {}
  stop(): void {}
  reschedule(): void {}
  reconcile(): Effect.Effect<void> {
    return Effect.void;
  }
  poll(): Effect.Effect<void> {
    return Effect.void;
  }
  events(): [] {
    return [];
  }
  status(): ConnectorStatus {
    return { id: this.id, name: this.name, status: "ok", synced_at: null, error: null };
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

test("a note's ref is its source's: the desk holds one by fetching it from there, and its exact id names its events", async (c) => {
  const t = await setup([reviewAsk(1)], { settings: { "policy.judge": false } });
  c.after(t.cleanup);
  await run(t.desk.sync());
  const notes = new Notes(t.desk);
  t.desk.connectors.push(notes);
  const note = notes.write("Call Ann about the release");
  assert.equal(runSync(t.desk.resolve("api#1")), "acme/api#1", "GitHub's refs are still GitHub's");
  assert.equal(failureSync(t.desk.resolve(note.id)).message, 'no item "notes:1" on the desk', "read by its source, not held");
  assert.equal(failureSync(t.desk.resolve("nope:1")).message, `can't read "nope:1"; use owner/repo#123, repo#123 or a GitHub URL`);
  assert.equal(runSync(t.desk.itemId(note.id)), note.id, "an exact id: its events outlive it");

  assert.equal(await run(t.desk.hold(note.id)), note.id);
  assert.deepEqual(t.desk.store.itemsById([note.id]).get(note.id), note, "fetched from its source and held whole");
  // Resolving it now would recompute the queue, which still reads every item as GitHub's.
});

// The notes board's query is GitHub's words, which it doesn't read: GitHub would answer it with acme/api#1.
const boards = `[[spaces]]
id = "acme"
name = "acme"
scope = "org:acme"

[[boards]]
id = "review"
space = "acme"
name = "PRs to review"
queries = ["is:pr is:open review-requested:@me"]
default = "today"

[[boards]]
id = "notes"
space = "acme"
name = "Notes"
source = "notes"
queries = ["is:open review-requested:@me label:notes"]
default = "today"
`;

test("a board lists only its source's items: a notes board the notes, which GitHub's boards don't, and GitHub doesn't search it", async (c) => {
  const t = await setup([reviewAsk(1)], { settings: { "policy.judge": false } });
  c.after(t.cleanup);
  fs.writeFileSync(path.join(t.home, "config.toml"), boards);
  runSync(t.desk.reloadConfig());
  const notes = new Notes(t.desk);
  t.desk.connectors.push(notes);
  // What a board places is still read as GitHub's, so this note carries GitHub's fields under its own id.
  const note = { ...makeItem({ kind: "issue", number: 1 }), ...notes.write("Call Ann about the release") };
  t.desk.store.putItems([note], note.updated_at);
  await run(t.desk.sync());

  const listed = (board: string) => [...t.desk.snapshot().boards.get(board)!.result.placements.keys()];
  assert.deepEqual(listed("notes"), [note.id]);
  assert.deepEqual(listed("review"), [reviewAsk(1).id]);
  assert.deepEqual(runSync(t.desk.board("notes")).board.queries, [], "its source's, not GitHub's");
  assert.ok(![...t.desk.store.queries().keys()].some((q) => q.includes("label:notes")), "GitHub searches its own boards only");
});
