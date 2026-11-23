// A connector turns one source (GitHub today) into item snapshots and events. The desk runs every connector it has.
import { Schema, type Effect } from "effect";
import type { LoadedConfig } from "../config.ts";
import type { GitHubReadError, NotFound, Upstream } from "../errors.ts";
import { decodeValues } from "../narrow.ts";
import type { CompiledBoard } from "../rules.ts";
import type { ActivityEvent, BuiltInAutomation, BuiltInCriterion, BuiltInRules, ConnectorStatus, Item } from "../types.ts";

export type NewEvent = Omit<ActivityEvent, "seq" | "source">;

// A resolved item shows on its boards this long, under Resolved, still listed or kept by its source.
export const KEEP_RESOLVED = 3 * 24 * 3_600_000;

// What one of a source's boards lists.
export interface Members {
  ids: ReadonlySet<string>;
  kept: ReadonlySet<string>; // listed only to show as resolved (GitHub's: every search's, so an unresolved one is on no board)
  queries: string[]; // what it reads (GitHub's searches), shown with the board
  unfetched: string[]; // of those, the ones not read yet
  error?: string; // what the last read of one failed with
}

export interface Connector {
  readonly id: string; // "github"; the `source` of its events and of its boards
  readonly name: string; // "GitHub"
  readonly automations: readonly BuiltInAutomation[]; // what it comes with, run by the desk as yours are: Settings → its part
  readonly criteria: readonly BuiltInCriterion[]; // what it comes with for the Inbox's order, asked as yours are: Settings → Automations → Urgency
  // What it comes with for its boards, by the name a board's `builtin` gives: read on every load, so a release's reach every desk.
  readonly rules: Readonly<Record<string, BuiltInRules>>;
  // Before the desk starts: what it must have (GitHub: your context); first: its part of the first config.toml, else null.
  init(first: boolean): Effect.Effect<string | null, GitHubReadError | Upstream>;
  start(): void; // its loops: the full reconcile and the cheap change feed
  stop(): void;
  reschedule(): void; // settings changed; re-arm the timers
  look(): void; // a window shows: read now if what it has is old, and sooner while it shows
  reconcile(): Effect.Effect<void>; // a full pass over everything the config subscribes to; what fails it shows in status()
  poll(): Effect.Effect<void>; // the change feed: refresh what changed, start a reconcile if something new appeared
  events(prev: Item | null, next: Item): NewEvent[]; // what changed between two snapshots of one item
  status(): ConnectorStatus;
  // The held ids `text` names, and `id` when it names one exactly (what fetchOne reads; a short ref doesn't); null: not its ref.
  refOf(text: string, held: readonly string[]): { held: string[]; id?: string } | null;
  fetchOne(id: string): Effect.Effect<string, Upstream | NotFound>; // reads the item `id` names and stores it; answers the id it's stored under
  // scope: its space's; loaded: the config being computed (a preview's, or the desk's), whose signals GitHub's {close_authors} reads.
  boardIds(board: CompiledBoard, scope: string, loaded: LoadedConfig): Members;
}

// An automation's or criterion's id: lowercase letters, digits and -, up to 40.
export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

// kv `key`: a plugin's definitions you switched, by "<plugin>.<id>": on or off, and when.
type Kept = { get(key: string): unknown; set(key: string, value: unknown): void };
const SwitchSchema = Schema.Struct({ on: Schema.Boolean, at: Schema.String });

// What the plugins come with (`of` each connector), as the code defines each now, on or off as you switched it (else as it
// comes): "<plugin>.<id>", yours to switch only.
export function pluginDefs<D extends { id: string; help: string; on: boolean }>(
  store: Kept,
  key: string,
  connectors: readonly Connector[],
  of: (c: Connector) => readonly D[],
) {
  const switched = decodeValues(SwitchSchema, store.get(key));
  return connectors.flatMap((c) =>
    of(c).map(({ id: own, help, on, ...def }) => {
      const id = `${c.id}.${own}`;
      const s = switched[id];
      return Object.assign({ id }, def, { on: s?.on ?? on, by: "you" as const, updated_at: s?.at ?? "", plugin: c.id, help });
    }),
  );
}

// You switched a plugin's definition on or off, at `at`.
export function switchPlugin(store: Kept, key: string, id: string, on: boolean, at: string): void {
  store.set(key, { ...decodeValues(SwitchSchema, store.get(key)), [id]: { on, at } });
}
