// A source that isn't GitHub, held in memory (ids notes:1, notes:2…): the guard that the core stops assuming GitHub.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { defaultConfigText } from "../src/config.ts";
import type { Connector, Members } from "../src/connectors/connector.ts";
import { Desk } from "../src/desk.ts";
import { NotFound, Upstream } from "../src/errors.ts";
import type { ConnectorStatus, Head } from "../src/types.ts";
import { reviewAsk, setup } from "./helpers/desk.ts";
import { FakeGitHub, makeItem, NOW } from "./helpers/items.ts";
import { failureSync, run, runSync } from "./helpers/run.ts";

const DAY = 24 * 3_600_000;

interface Note extends Head {
  text: string;
}

// Its part of a first config.toml: a board in the first space.
const NOTES_BOARD = `[[boards]]
id = "notes"
name = "Notes"
source = "notes"
default = "today"
`;

// Its notes go into the desk's store as GitHub's items do, with none of GitHub's fields.
class Notes implements Connector {
  readonly id = "notes";
  readonly name = "Notes";
  readonly automations = [];
  readonly criteria = [];
  readonly rules = {};
  desk: Desk;
  notes: Note[] = [];
  inits: boolean[] = []; // what each init was asked

  constructor(desk: Desk) {
    this.desk = desk;
  }

  // It needs nothing before the desk starts: its notes are in memory.
  init(first: boolean): Effect.Effect<string | null, Upstream> {
    return Effect.sync(() => {
      this.inits.push(first);
      return first ? NOTES_BOARD : null;
    });
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

test("a note outlives GitHub's 14-day prune, which drops GitHub's rows no search returns, and GitHub refreshes only its own pins", async (c) => {
  const t = await setup([reviewAsk(1)], { settings: { "policy.judge": false } });
  c.after(t.cleanup);
  await run(t.desk.sync());
  const notes = new Notes(t.desk);
  const note = notes.add("Call Ann about the release");
  // Open and pinned, as GitHub's own pins are, but not GitHub's to read.
  const pinned = { ...notes.write("Book the venue"), state: "open" as const };
  t.desk.store.putItems([pinned], NOW.toISOString());
  t.desk.store.putState({ ...t.desk.store.state(pinned.id), pinned: true });
  const unlisted = makeItem({ number: 9 });
  t.desk.store.putItems([unlisted], NOW.toISOString());
  const meta = t.desk.store.itemMeta().get(note.id);
  assert.deepEqual([meta?.node_id, meta?.detail_at], ["", NOW.toISOString()]);

  t.setNow(new Date(NOW.getTime() + 15 * DAY));
  t.gh.detailCalls = [];
  await run(t.desk.gh.pass()); // its pass alone: the recompute a sync ends with still reads every item as GitHub's
  const ids = [note.id, pinned.id, unlisted.id, reviewAsk(1).id];
  assert.deepEqual([...t.desk.store.itemsById(ids).keys()], [note.id, pinned.id, reviewAsk(1).id]);
  assert.deepEqual(t.desk.store.itemsById([note.id]).get(note.id), note, "stored whole");
  assert.ok(!t.gh.detailCalls.flat().some((id) => id.startsWith("notes:")), "GitHub asks about none of the notes");
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
  assert.equal(
    failureSync(t.desk.resolve("nope:1")).message,
    `can't read "nope:1"; use owner/repo#123, repo#123, a GitHub URL or an inbox:// link`,
  );
  assert.equal(runSync(t.desk.itemId(note.id)), note.id, "an exact id: its events outlive it");
  // Another source's id with a "/" and a "#" in it is still not GitHub's.
  assert.deepEqual(t.desk.gh.refOf("api#7", ["acme/api#1", "notes:acme/api#7"]), { held: [] });
  assert.deepEqual(t.desk.gh.refOf("#1", ["acme/api#1", "notes:acme/api#1"]), { held: ["acme/api#1"] });

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
  assert.deepEqual(t.desk.configErrors, [{ path: "boards[1].source", message: "must be one of github" }], "a source the desk doesn't run");
  assert.ok(!t.desk.loaded?.boards.some((b) => b.config.id === "notes"), "the last good config stays");
  const notes = new Notes(t.desk);
  t.desk.connectors.push(notes);
  runSync(t.desk.reloadConfig());
  assert.deepEqual(t.desk.configErrors, []);
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

test("init asks every source what it needs: a first config.toml is GitHub's then the notes' board, written once all have answered", async (c) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-test-"));
  const desks: Desk[] = [];
  c.after(() => {
    for (const d of desks) d.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const start = () => {
    const desk = new Desk({ home, github: new FakeGitHub([], () => []), now: () => NOW, notify: () => {}, log: () => {} });
    desks.push(desk);
    const notes = new Notes(desk);
    desk.connectors.push(notes);
    return { desk, notes };
  };
  const config = path.join(home, "config.toml");

  const failing = start();
  failing.notes.init = () => Effect.fail(new Upstream({ message: "notes are offline" }));
  await run(failing.desk.init());
  assert.equal(failing.desk.githubError?.message, "notes are offline");
  assert.equal(fs.existsSync(config), false, "GitHub's part isn't written alone");
  failing.desk.stop();

  const first = start();
  await run(first.desk.init());
  assert.equal(fs.readFileSync(config, "utf8"), `${defaultConfigText({ workOrgs: ["acme"] })}\n${NOTES_BOARD}`);
  assert.deepEqual(first.notes.inits, [true]);
  const board = first.desk.loaded?.boards.find((b) => b.config.id === "notes")?.config;
  assert.deepEqual([board?.source, board?.space], ["notes", "acme"]);
  assert.equal(first.desk.me(), "me");
  first.desk.gh.ctx = { ...first.desk.gh.ctx!, me: "ann" }; // what GitHub's connector knows, not yet in kv
  assert.deepEqual([first.desk.me(), first.desk.ctx?.me], ["ann", "ann"], "who you are is GitHub's");
  first.desk.stop();

  const again = start();
  await run(again.desk.init());
  assert.deepEqual(again.notes.inits, [false], "there's a config.toml: nothing to add to it");
  assert.equal(fs.readFileSync(config, "utf8"), `${defaultConfigText({ workOrgs: ["acme"] })}\n${NOTES_BOARD}`);
});
