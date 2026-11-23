// me/notes-app#12: its diff and AI review for the website's demo.
import type { Canned } from "../diffs.ts";
import { file } from "../patch.ts";

export const review: Canned = {
  files: [
    file(
      "src/sync/api.ts",
      "modified",
      `@@ -1,10 +1,20 @@
+import type { NoteId } from "../notes/types.ts";
+import type { Clock } from "./clock.ts";
 import type { Change } from "./merge.ts";

+// A deleted note, kept so a device that still has it deletes it too.
+export interface Tombstone {
+  id: NoteId;
+  clock: Clock;
+}
+
 export interface PullRequest {
   cursor: number;
+  tombstones: Tombstone[];
 }

 export interface PullResponse {
   changes: Change[];
+  tombstones: Tombstone[];
   cursor: number;
 }`,
    ),
    file(
      "src/sync/clock.ts",
      "added",
      `@@ -0,0 +1,26 @@
+// A Lamport clock per device: the counter orders writes, the device id breaks ties.
+export interface Clock {
+  counter: number;
+  device: string;
+}
+
+// What a device keeps between writes: the highest counter it has seen.
+export interface ClockState {
+  last: number;
+  device: string;
+}
+
+// One past anything this device has seen, so a local write sorts after every change it merged.
+export function nextClock(state: ClockState): Clock {
+  state.last += 1;
+  return { counter: state.last, device: state.device };
+}
+
+export function tick(state: ClockState, seen: Clock): void {
+  if (seen.counter > state.last) state.last = seen.counter;
+}
+
+export function compare(a: Clock, b: Clock): number {
+  if (a.counter !== b.counter) return a.counter - b.counter;
+  return a.device < b.device ? -1 : a.device > b.device ? 1 : 0;
+}`,
    ),
    file(
      "src/sync/merge.ts",
      "modified",
      `@@ -1,8 +1,9 @@
 import type { Note, NoteId } from "../notes/types.ts";
-import type { SyncApi } from "./api.ts";
+import type { SyncApi, Tombstone } from "./api.ts";
+import { compare, nextClock, tick, type Clock, type ClockState } from "./clock.ts";
 import type { SyncStore } from "./store.ts";

 export interface Change {
   note: Note;
-  updatedAt: number;
+  clock: Clock;
 }
@@ -29,9 +30,27 @@ export function changesSince(store: SyncStore, cursor: number): Change[] {
   return store.changedSince(cursor);
 }

-// Applies a pulled change unless this device has a newer copy.
-export function merge(store: SyncStore, remote: Change): void {
+// Last writer wins by clock, and a tombstone beats any write older than the delete.
+export function merge(store: SyncStore, state: ClockState, remote: Change): void {
+  tick(state, remote.clock);
+  const dead = store.tombstone(remote.note.id);
+  if (dead && compare(dead.clock, remote.clock) >= 0) return;
   const local = store.get(remote.note.id);
-  if (local && local.updatedAt >= remote.updatedAt) return;
-  store.put(remote.note, remote.updatedAt);
+  if (local && compare(local.clock, remote.clock) >= 0) return;
+  store.put(remote.note, remote.clock);
+}
+
+export function mergeDelete(store: SyncStore, state: ClockState, remote: Tombstone): void {
+  tick(state, remote.clock);
+  const local = store.get(remote.id);
+  if (local && compare(local.clock, remote.clock) > 0) return;
+  store.deleteNote(remote.id, remote.clock);
+}
+
+export function writeLocal(store: SyncStore, state: ClockState, note: Note): void {
+  store.put(note, nextClock(state));
+}
+
+export function deleteLocal(store: SyncStore, state: ClockState, id: NoteId): void {
+  store.deleteNote(id, nextClock(state));
 }
@@ -58,8 +77,14 @@ export async function push(api: SyncApi, store: SyncStore): Promise<void> {
   store.markPushed(changes.length);
 }

-export async function pull(api: SyncApi, store: SyncStore): Promise<void> {
-  const { changes, cursor } = await api.pull({ cursor: store.cursor() });
-  for (const c of changes) merge(store, c);
+export async function pull(api: SyncApi, store: SyncStore, state: ClockState): Promise<void> {
+  const { changes, tombstones, cursor } = await api.pull({ cursor: store.cursor(), tombstones: syncTombstones(store) });
+  for (const t of tombstones) mergeDelete(store, state, t);
+  for (const c of changes) merge(store, state, c);
   store.setCursor(cursor);
 }
+
+// Every tombstone this device holds goes up with each pull, so a device that missed a delete still applies it.
+export function syncTombstones(store: SyncStore): Tombstone[] {
+  return store.allTombstones();
+}`,
    ),
    file(
      "src/sync/store.ts",
      "modified",
      `@@ -1,9 +1,15 @@
 import type { Note, NoteId } from "../notes/types.ts";
+import type { Tombstone } from "./api.ts";
+import type { Clock } from "./clock.ts";
 import type { Change } from "./merge.ts";

 export interface SyncStore {
-  get(id: NoteId): (Note & { updatedAt: number }) | undefined;
-  put(note: Note, updatedAt: number): void;
+  get(id: NoteId): (Note & { clock: Clock }) | undefined;
+  put(note: Note, clock: Clock): void;
+  // Removes the note and keeps a tombstone with the delete's clock, in one transaction.
+  deleteNote(id: NoteId, clock: Clock): void;
+  tombstone(id: NoteId): Tombstone | undefined;
+  allTombstones(): Tombstone[];
   changedSince(cursor: number): Change[];
   cursor(): number;
   setCursor(cursor: number): void;`,
    ),
    file(
      "test/sync/merge.test.ts",
      "added",
      `@@ -0,0 +1,43 @@
+import { test } from "node:test";
+import assert from "node:assert/strict";
+import { nextClock, type ClockState } from "../../src/sync/clock.ts";
+import { merge, mergeDelete } from "../../src/sync/merge.ts";
+import { memoryStore } from "../helpers/memory-store.ts";
+
+const note = (id: string, body: string) => ({ id, body });
+const at = (counter: number, device = "phone") => ({ counter, device });
+const laptop = (): ClockState => ({ last: 0, device: "laptop" });
+
+test("the later write wins, whichever arrives first", () => {
+  const store = memoryStore();
+  merge(store, laptop(), { note: note("n1", "new"), clock: at(2) });
+  merge(store, laptop(), { note: note("n1", "old"), clock: at(1) });
+  assert.equal(store.get("n1")?.body, "new");
+});
+
+test("a delete beats an older write", () => {
+  const store = memoryStore();
+  mergeDelete(store, laptop(), { id: "n1", clock: at(3) });
+  merge(store, laptop(), { note: note("n1", "stale"), clock: at(2) });
+  assert.equal(store.get("n1"), undefined);
+});
+
+test("a write after the delete brings the note back", () => {
+  const store = memoryStore();
+  mergeDelete(store, laptop(), { id: "n1", clock: at(3) });
+  merge(store, laptop(), { note: note("n1", "again"), clock: at(4) });
+  assert.equal(store.get("n1")?.body, "again");
+});
+
+test("equal counters break on the device id", () => {
+  const store = memoryStore();
+  merge(store, laptop(), { note: note("n1", "from laptop"), clock: at(5, "laptop") });
+  merge(store, laptop(), { note: note("n1", "from phone"), clock: at(5, "phone") });
+  assert.equal(store.get("n1")?.body, "from phone");
+});
+
+test("merging moves this device's clock past what it saw", () => {
+  const state = laptop();
+  merge(memoryStore(), state, { note: note("n1", "x"), clock: at(9) });
+  assert.equal(nextClock(state).counter, 10);
+});`,
    ),
  ],
  ai: {
    verdict: "look",
    risk: "medium",
    summary:
      "Replaces timestamp sync with a Lamport clock per device and last-writer-wins merge, and keeps a tombstone for every delete so a device that missed one still applies it. Each pull now sends this device's tombstones and applies the server's before its changes.",
    concerns: [
      "Tombstones never go away: nothing in the diff removes one, and `syncTombstones()` sends every tombstone this device holds on each pull, so on a long-lived notebook every sync grows with every delete it has ever had. Once every device has synced past a tombstone it can be dropped.",
    ],
    notes: [
      {
        path: "src/sync/merge.ts",
        side: "new",
        line: 88,
        body: "Every pull ships the whole list, and the list only grows. Nothing prunes it here or in the store, and no test checks how much a pull sends.",
      },
      {
        path: "src/sync/merge.ts",
        side: "new",
        line: 37,
        body: "The tombstone is checked before the local copy, so a stale write from a device that missed the delete can't bring the note back.",
      },
      {
        path: "src/sync/merge.ts",
        side: "new",
        line: 46,
        body: "A local edit made after the delete keeps the note; anything older is deleted and leaves a tombstone of its own.",
      },
      {
        path: "src/sync/clock.ts",
        side: "new",
        line: 14,
        body: "Every local write takes its clock here: one past the highest counter this device has seen, including counters merged in by `tick()`.",
      },
      {
        path: "src/sync/clock.ts",
        side: "new",
        line: 25,
        body: "Equal counters fall back to the device id, so two devices that wrote at the same counter pick the same winner.",
      },
      {
        path: "test/sync/merge.test.ts",
        side: "new",
        line: 0,
        body: "Covers ordering, deletes, a note written again after its delete, and ties. Nothing checks that an old tombstone is ever dropped.",
      },
    ],
    chunks: {
      ranked: [
        { id: "h5", path: "src/sync/merge.ts", level: "look", why: "every tombstone on every pull" },
        { id: "h4", path: "src/sync/merge.ts", level: "look", why: "tombstone checked before the write" },
        { id: "h2", path: "src/sync/clock.ts", level: "skim", why: "Lamport clock, device breaks ties" },
        { id: "h6", path: "src/sync/store.ts", level: "skim", why: "tombstones in the store" },
        { id: "h1", path: "src/sync/api.ts", level: "skim", why: "tombstones on the wire" },
        { id: "h7", path: "test/sync/merge.test.ts", level: "skim", why: "" },
      ],
      unread: [],
      total: 7,
    },
    guide: {
      steps: [
        {
          title: "The clock",
          body: "Each device keeps a Lamport counter. `nextClock()` stamps a local write one past anything it has seen, `tick()` moves the counter past every change merged in, and `compare()` orders two clocks, the device id breaking ties.",
          check: "Two devices comparing the same pair of clocks pick the same winner.",
          hunks: [{ id: "h2", path: "src/sync/clock.ts" }],
        },
        {
          title: "Tombstones in the store and on the wire",
          body: "A delete now removes the note and keeps a tombstone with the delete's clock. Pull requests and responses both carry a list of them.",
          check: "",
          hunks: [
            { id: "h6", path: "src/sync/store.ts" },
            { id: "h1", path: "src/sync/api.ts" },
          ],
        },
        {
          title: "The merge",
          body: "`merge()` checks the tombstone first, then the local copy, and the higher clock wins. `mergeDelete()` deletes unless the local copy was written after the delete. The tests walk each ordering.",
          check: "A stale write from a device that missed a delete can't bring the note back.",
          hunks: [
            { id: "h3", path: "src/sync/merge.ts" },
            { id: "h4", path: "src/sync/merge.ts" },
            { id: "h7", path: "test/sync/merge.test.ts" },
          ],
        },
        {
          title: "What a pull sends",
          body: "`pull()` sends `syncTombstones()` with every request, then applies the server's tombstones and its changes.",
          check: "Nothing ever drops a tombstone, so what each pull sends grows with every delete.",
          hunks: [{ id: "h5", path: "src/sync/merge.ts" }],
        },
      ],
    },
  },
};
