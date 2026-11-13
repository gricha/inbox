// SQLite cache of every source's items (GitHub's today), your local triage state, and the event log.
import { DatabaseSync } from "node:sqlite";
import { Effect, Result, Schema } from "effect";
import { decode, oneOf, schemaOf, str } from "./narrow.ts";
import {
  ACTIVITY_KINDS,
  INBOX_SECTIONS,
  type ActivityEvent,
  type Device,
  type Head,
  type Item,
  type ItemState,
  type Job,
} from "./types.ts";

export interface ItemMeta {
  node_id: string;
  kind: Item["kind"];
  author: string;
  author_bot: boolean;
  updated_at: string;
  detail_at: string;
  last_hit_at: string; // the last time a search returned it
  lacks: boolean; // a PR stored before the desk asked for what stacks and dependencies need (head_ref, default_branch, retargeted, requires)
  quiet: boolean; // stored without events (a stack's member no board listed) since its events were last logged
}

export interface StateRow extends ItemState {
  snoozed_at: string | null;
  acked_at: string | null; // latest activity you had seen when you marked done/snoozed
}

export interface ActionEvent {
  seq: number;
  at: string;
  item_id: string;
  action: string;
  before: StateRow;
  undone: boolean;
  agent: string | null; // an agent's hand-back, or the old desk-run coordinator's; null: you, from the UI, the CLI or your own agent
}

export const emptyState = (id: string): StateRow => ({
  id,
  done_at: null,
  snooze_until: null,
  snooze_on_activity: false,
  snooze_when: null,
  snoozed_at: null,
  acked_at: null,
  muted: false,
  pinned: false,
  seen_at: null,
  inflight_at: null,
  section: null,
});

// Undo entries logged before in-flight, snoozing until something happens, or sections existed don't carry them.
const since = Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null)));
const StateRowSchema = schemaOf<StateRow>()(
  Schema.Struct({
    id: Schema.String,
    done_at: Schema.NullOr(Schema.String),
    snooze_until: Schema.NullOr(Schema.String),
    snooze_on_activity: Schema.Boolean,
    snooze_when: since,
    muted: Schema.Boolean,
    pinned: Schema.Boolean,
    seen_at: Schema.NullOr(Schema.String),
    inflight_at: since,
    section: Schema.NullOr(Schema.Literals(INBOX_SECTIONS)).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
    snoozed_at: Schema.NullOr(Schema.String),
    acked_at: Schema.NullOr(Schema.String),
  }),
);
const ActivityData = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean]));

// A column's value, as the table declares it: anything else is a broken database, not data to skip.
function text(v: unknown): string {
  if (typeof v !== "string") throw new Error(`desk.db: expected text, got ${typeof v}`);
  return v;
}
function int(v: unknown): number {
  if (typeof v !== "number") throw new Error(`desk.db: expected an integer, got ${typeof v}`);
  return v;
}
const textOrNull = (v: unknown): string | null => (v === null ? null : text(v));
function lit<const T extends string>(values: readonly T[], v: unknown): T {
  const x = oneOf(values, v);
  if (x === undefined) throw new Error(`desk.db: unexpected ${String(v)}`);
  return x;
}
// Stored JSON checked against its schema; undefined when it doesn't hold one.
function json<S extends Schema.ConstraintDecoder<unknown>>(schema: S, v: unknown): S["Type"] | undefined {
  const r = decode(schema, JSON.parse(text(v)));
  return Result.isSuccess(r) ? r.success : undefined;
}

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, node_id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, detail_at TEXT NOT NULL, last_hit_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hits (query TEXT NOT NULL, item_id TEXT NOT NULL, PRIMARY KEY (query, item_id));
      CREATE TABLE IF NOT EXISTS queries (query TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, total INTEGER NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS state (id TEXT PRIMARY KEY, done_at TEXT, snooze_until TEXT, snooze_on_activity INTEGER NOT NULL DEFAULT 0, snoozed_at TEXT, muted INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, seen_at TEXT);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, item_id TEXT NOT NULL, action TEXT NOT NULL, before TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (kind TEXT NOT NULL, key TEXT NOT NULL, item TEXT, head TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, queued_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, retry_at TEXT, error TEXT, PRIMARY KEY (kind, key));
      CREATE TABLE IF NOT EXISTS activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, source TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS activity_item ON activity (item_id, seq);
      -- The desk-run coordinator's log, no longer written; the events.agent migration below still reads it.
      -- Your other devices paired over Tailscale (src/remote.ts): a token's sha256, never the token.
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT);
      CREATE TABLE IF NOT EXISTS coordinator_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, run INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, item_id TEXT, action TEXT, bucket TEXT, undo_seq INTEGER);
    `);
    const columns = (table: string) =>
      this.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name);
    const cols = new Set(columns("state"));
    if (!cols.has("acked_at")) this.db.exec("ALTER TABLE state ADD COLUMN acked_at TEXT");
    if (!cols.has("inflight_at")) this.db.exec("ALTER TABLE state ADD COLUMN inflight_at TEXT");
    if (!cols.has("snooze_when")) this.db.exec("ALTER TABLE state ADD COLUMN snooze_when TEXT");
    if (!cols.has("section")) this.db.exec("ALTER TABLE state ADD COLUMN section TEXT");
    if (!columns("hits").includes("kept")) this.db.exec("ALTER TABLE hits ADD COLUMN kept INTEGER NOT NULL DEFAULT 0");
    // kept() runs once per board a recompute places: this reads only the few kept rows.
    this.db.exec("CREATE INDEX IF NOT EXISTS hits_kept ON hits (item_id) WHERE kept = 1");
    // The snapshot an item's events were last logged against, while it's stored quietly since ('null': never); else NULL.
    if (!columns("items").includes("said")) this.db.exec("ALTER TABLE items ADD COLUMN said TEXT");
    if (!columns("events").includes("agent")) {
      this.db.exec("ALTER TABLE events ADD COLUMN agent TEXT");
      this.db.exec(
        "UPDATE events SET agent = 'coordinator' WHERE seq IN (SELECT undo_seq FROM coordinator_log WHERE undo_seq IS NOT NULL)",
      );
    }
  }

  close(): void {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // --- items

  items(): Item[] {
    return (
      this.db
        .prepare("SELECT data FROM items")
        .all()
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the desk wrote it (putItems); plugins' items carry fields of their own
        .map((r) => JSON.parse(text(r.data)) as Item)
    );
  }

  itemsById(ids: string[]): Map<string, Item> {
    const stmt = this.db.prepare("SELECT data FROM items WHERE id = ?");
    const out = new Map<string, Item>();
    for (const id of ids) {
      const r = stmt.get(id);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the desk wrote it (putItems)
      if (r) out.set(id, JSON.parse(text(r.data)) as Item);
    }
    return out;
  }

  itemMeta(): Map<string, ItemMeta> {
    const rows = this.db
      .prepare(
        `SELECT id, node_id, json_extract(data, '$.kind') AS kind, json_extract(data, '$.author') AS author, json_extract(data, '$.author_bot') AS author_bot, updated_at, detail_at, last_hit_at,
          json_extract(data, '$.kind') = 'pr' AND (json_type(data, '$.head_ref') IS NULL OR json_type(data, '$.default_branch') IS NULL
            OR json_type(data, '$.retargeted') IS NULL OR json_type(data, '$.requires') IS NULL) AS lacks, said IS NOT NULL AS quiet FROM items`,
      )
      .all();
    return new Map(
      rows.map((r) => {
        const meta: ItemMeta = {
          node_id: text(r.node_id),
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- read from the item the desk wrote
          kind: r.kind as Item["kind"],
          author: str(r.author) ?? "",
          author_bot: r.author_bot === 1,
          updated_at: text(r.updated_at),
          detail_at: text(r.detail_at),
          last_hit_at: text(r.last_hit_at),
          lacks: r.lacks === 1,
          quiet: r.quiet === 1,
        };
        return [text(r.id), meta];
      }),
    );
  }

  // last_hit_at is set on insert and by touchItems: refreshing an item no search returns doesn't renew it. `quiet`: stored
  // without logging its events, which keeps what they were last logged against in `said`.
  putItems(items: readonly (Head & Partial<Item>)[], now: string, quiet = false): void {
    const stmt = this.db.prepare(
      `INSERT INTO items (id, node_id, data, updated_at, detail_at, last_hit_at, said) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET node_id = excluded.node_id, data = excluded.data, updated_at = excluded.updated_at, detail_at = excluded.detail_at,
         said = ${quiet ? "COALESCE(items.said, items.data)" : "NULL"}`,
    );
    this.tx(() => {
      for (const it of items)
        stmt.run(it.id, it.node_id ?? "", JSON.stringify(it), it.updated_at, it.detail_at ?? now, now, quiet ? "null" : null);
    });
  }

  // Of these, the ones stored quietly, with the snapshot their events were last logged against (null: never).
  said(ids: string[]): Map<string, Item | null> {
    const stmt = this.db.prepare("SELECT said FROM items WHERE id = ? AND said IS NOT NULL");
    const out = new Map<string, Item | null>();
    for (const id of ids) {
      const r = stmt.get(id);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the desk wrote it (putItems, quietly)
      if (r) out.set(id, JSON.parse(text(r.said)) as Item | null);
    }
    return out;
  }

  touchItems(ids: string[], now: string): void {
    const stmt = this.db.prepare("UPDATE items SET last_hit_at = ? WHERE id = ?");
    this.tx(() => {
      for (const id of ids) stmt.run(now, id);
    });
  }

  // Only `source`'s rows: an id's source is its prefix ("notes:1"), and a bare id is GitHub's.
  pruneItems(source: string, before: string, keep: Set<string> = new Set()): void {
    this.db
      .prepare(
        `DELETE FROM items WHERE last_hit_at < ? AND id NOT IN (SELECT value FROM json_each(?))
           AND (CASE instr(id, ':') WHEN 0 THEN 'github' ELSE substr(id, 1, instr(id, ':') - 1) END) = ?`,
      )
      .run(before, JSON.stringify([...keep]), source);
  }

  // --- query results

  // `kept`: items the search no longer returns, held on its boards for a while to show as resolved.
  setHits(query: string, ids: string[], total: number, now: string, kept: string[] = []): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM hits WHERE query = ?").run(query);
      const stmt = this.db.prepare("INSERT OR IGNORE INTO hits (query, item_id, kept) VALUES (?, ?, ?)");
      for (const id of ids) stmt.run(query, id, 0);
      for (const id of kept) stmt.run(query, id, 1);
      this.db
        .prepare(
          "INSERT INTO queries (query, fetched_at, total, error) VALUES (?, ?, ?, NULL) ON CONFLICT(query) DO UPDATE SET fetched_at = excluded.fetched_at, total = excluded.total, error = NULL",
        )
        .run(query, now, total);
    });
  }

  setQueryError(query: string, error: string, now: string): void {
    this.db
      .prepare(
        "INSERT INTO queries (query, fetched_at, total, error) VALUES (?, ?, 0, ?) ON CONFLICT(query) DO UPDATE SET error = excluded.error",
      )
      .run(query, now, error);
  }

  hits(queries?: readonly string[]): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    const rows = queries
      ? this.db.prepare("SELECT query, item_id FROM hits WHERE query IN (SELECT value FROM json_each(?))").all(JSON.stringify(queries))
      : this.db.prepare("SELECT query, item_id FROM hits").all();
    for (const r of rows) {
      const q = text(r.query);
      if (!out.has(q)) out.set(q, new Set());
      out.get(q)!.add(text(r.item_id));
    }
    return out;
  }

  kept(): Set<string> {
    return new Set(
      this.db
        .prepare("SELECT DISTINCT item_id FROM hits WHERE kept = 1")
        .all()
        .map((r) => text(r.item_id)),
    );
  }

  queries(queries?: readonly string[]): Map<string, { fetched_at: string; total: number; error: string | null }> {
    const rows = queries
      ? this.db
          .prepare("SELECT query, fetched_at, total, error FROM queries WHERE query IN (SELECT value FROM json_each(?))")
          .all(JSON.stringify(queries))
      : this.db.prepare("SELECT query, fetched_at, total, error FROM queries").all();
    return new Map(rows.map((r) => [text(r.query), { fetched_at: text(r.fetched_at), total: int(r.total), error: textOrNull(r.error) }]));
  }

  // --- local state

  states(): Map<string, StateRow> {
    return new Map(
      this.db
        .prepare("SELECT * FROM state")
        .all()
        .map((r) => [text(r.id), rowToState(r)]),
    );
  }

  state(id: string): StateRow {
    const r = this.db.prepare("SELECT * FROM state WHERE id = ?").get(id);
    return r ? rowToState(r) : emptyState(id);
  }

  putState(s: StateRow): void {
    this.db
      .prepare(
        `INSERT INTO state (id, done_at, snooze_until, snooze_on_activity, snoozed_at, acked_at, muted, pinned, seen_at, inflight_at, snooze_when, section) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET done_at = excluded.done_at, snooze_until = excluded.snooze_until, snooze_on_activity = excluded.snooze_on_activity,
           snoozed_at = excluded.snoozed_at, acked_at = excluded.acked_at, muted = excluded.muted, pinned = excluded.pinned, seen_at = excluded.seen_at,
           inflight_at = excluded.inflight_at, snooze_when = excluded.snooze_when, section = excluded.section`,
      )
      .run(
        s.id,
        s.done_at,
        s.snooze_until,
        s.snooze_on_activity ? 1 : 0,
        s.snoozed_at,
        s.acked_at,
        s.muted ? 1 : 0,
        s.pinned ? 1 : 0,
        s.seen_at,
        s.inflight_at ?? null, // undo entries logged before in-flight existed don't carry it
        s.snooze_when ?? null, // nor, from before snoozing until something happens, this
        s.section ?? null, // nor, from before moving between sections, this
      );
  }

  // --- undo log

  logAction(itemId: string, action: string, before: StateRow, at: string, agent?: string): number {
    const r = this.db
      .prepare("INSERT INTO events (at, item_id, action, before, agent) VALUES (?, ?, ?, ?, ?)")
      .run(at, itemId, action, JSON.stringify(before), agent ?? null);
    return Number(r.lastInsertRowid);
  }

  // What can't be undone goes in the same log, stored as undone: GitHub writes (approve, ready).
  logWrite(itemId: string, action: string, at: string): number {
    const r = this.db
      .prepare("INSERT INTO events (at, item_id, action, before, undone) VALUES (?, ?, ?, ?, 1)")
      .run(at, itemId, action, JSON.stringify(this.state(itemId)));
    return Number(r.lastInsertRowid);
  }

  lastAction(seq?: number): ActionEvent | null {
    const r =
      seq === undefined
        ? this.db.prepare("SELECT * FROM events WHERE undone = 0 ORDER BY seq DESC LIMIT 1").get()
        : this.db.prepare("SELECT * FROM events WHERE seq = ? AND undone = 0").get(seq);
    return r ? rowToAction(r) : null;
  }

  hasLaterAction(itemId: string, seq: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM events WHERE item_id = ? AND seq > ? AND undone = 0").get(itemId, seq);
  }

  lastActionFor(itemId: string): ActionEvent | null {
    const r = this.db.prepare("SELECT seq FROM events WHERE item_id = ? AND undone = 0 ORDER BY seq DESC LIMIT 1").get(itemId);
    return r ? this.lastAction(int(r.seq)) : null;
  }

  // Its latest pin still in effect: the agent behind it (null for you) and its seq.
  lastPin(itemId: string): { agent: string | null; seq: number } | null {
    const r = this.db
      .prepare("SELECT agent, seq FROM events WHERE item_id = ? AND action = 'pin' AND undone = 0 ORDER BY seq DESC LIMIT 1")
      .get(itemId);
    return r ? { agent: textOrNull(r.agent), seq: Number(r.seq) } : null;
  }

  markUndone(seq: number): void {
    this.db.prepare("UPDATE events SET undone = 1 WHERE seq = ?").run(seq);
  }

  // --- activity (the event log)

  addActivity(events: Omit<ActivityEvent, "seq">[]): void {
    const stmt = this.db.prepare("INSERT INTO activity (at, source, item_id, kind, actor, data) VALUES (?, ?, ?, ?, ?, ?)");
    this.tx(() => {
      for (const e of events) stmt.run(e.at, e.source, e.item_id, e.kind, e.actor, JSON.stringify(e.data));
    });
  }

  // Oldest first, after `after`; or the newest `limit` for one item with `latest`.
  activity(q: { after: number; limit: number; item?: string; latest?: boolean }): ActivityEvent[] {
    const where = q.item === undefined ? "seq > ?" : "seq > ? AND item_id = ?";
    const args = q.item === undefined ? [q.after, q.limit] : [q.after, q.item, q.limit];
    return this.db
      .prepare(`SELECT * FROM activity WHERE ${where} ORDER BY seq ${q.latest ? "DESC" : "ASC"} LIMIT ?`)
      .all(...args)
      .flatMap((r) => {
        const data = json(ActivityData, r.data);
        if (!data) return [];
        return [
          {
            seq: int(r.seq),
            at: text(r.at),
            source: text(r.source),
            item_id: text(r.item_id),
            kind: lit(ACTIVITY_KINDS, r.kind),
            actor: text(r.actor),
            data,
          },
        ];
      });
  }

  lastSeq(): number {
    const seq = this.db.prepare("SELECT MAX(seq) AS seq FROM activity").get()?.seq;
    return seq === null || seq === undefined ? 0 : int(seq);
  }

  // --- jobs (the work Claude owes the owner: src/jobs.ts)

  jobs(): Job[] {
    return this.db
      .prepare("SELECT * FROM jobs ORDER BY rowid")
      .all()
      .map((r) => ({
        kind: lit(["ai_review", "ask", "answer"], r.kind),
        key: text(r.key),
        item: textOrNull(r.item),
        head: textOrNull(r.head),
        state: lit(["queued", "running", "done", "failed"], r.state),
        attempts: int(r.attempts),
        queued_at: text(r.queued_at),
        started_at: textOrNull(r.started_at),
        finished_at: textOrNull(r.finished_at),
        retry_at: textOrNull(r.retry_at),
        error: textOrNull(r.error),
      }));
  }

  putJob(j: Job): void {
    this.db
      .prepare(
        `INSERT INTO jobs (kind, key, item, head, state, attempts, queued_at, started_at, finished_at, retry_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, key) DO UPDATE SET item = excluded.item, head = excluded.head, state = excluded.state, attempts = excluded.attempts,
           queued_at = excluded.queued_at, started_at = excluded.started_at, finished_at = excluded.finished_at, retry_at = excluded.retry_at, error = excluded.error`,
      )
      .run(j.kind, j.key, j.item, j.head, j.state, j.attempts, j.queued_at, j.started_at, j.finished_at, j.retry_at, j.error);
  }

  dropJob(kind: Job["kind"], key: string): void {
    this.db.prepare("DELETE FROM jobs WHERE kind = ? AND key = ?").run(kind, key);
  }

  // --- paired devices

  devices(): (Device & { hash: string })[] {
    const rows = this.db.prepare("SELECT id, name, kind, hash, created_at, last_used_at FROM devices ORDER BY created_at").all();
    return rows.map((r) => ({
      id: text(r.id),
      name: text(r.name),
      kind: lit(["browser", "device"], r.kind),
      hash: text(r.hash),
      created_at: text(r.created_at),
      last_used_at: textOrNull(r.last_used_at),
    }));
  }

  addDevice(d: Device & { hash: string }): void {
    this.db
      .prepare("INSERT INTO devices (id, name, kind, hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(d.id, d.name, d.kind, d.hash, d.created_at, d.last_used_at);
  }

  usedDevice(id: string, at: string): void {
    this.db.prepare("UPDATE devices SET last_used_at = ? WHERE id = ?").run(at, id);
  }

  removeDevice(id: string): boolean {
    return this.db.prepare("DELETE FROM devices WHERE id = ?").run(id).changes > 0;
  }

  // --- key/value

  get(key: string): unknown {
    const r = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
    return r ? JSON.parse(text(r.value)) : null;
  }

  // A value checked against its schema: null when absent, or stored in a shape it no longer has.
  read<S extends Schema.ConstraintDecoder<unknown>>(key: string, schema: S): S["Type"] | null {
    const r = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
    return (r && json(schema, r.value)) ?? null;
  }

  // Each `prefix<id>` value by id, leaving out those not in the schema's shape.
  prefixed<S extends Schema.ConstraintDecoder<unknown>>(prefix: string, schema: S): Map<string, S["Type"]> {
    const rows = this.db.prepare("SELECT key, value FROM kv WHERE key >= ? AND key < ?").all(prefix, prefix + "\uffff");
    const out = new Map<string, S["Type"]>();
    for (const r of rows) {
      const v = json(schema, r.value);
      if (v !== undefined) out.set(text(r.key).slice(prefix.length), v);
    }
    return out;
  }

  // Drops `prefix<id>` rows whose id isn't in `keep`.
  pruneKv(prefix: string, keep: Set<string>): void {
    const rows = this.db.prepare("SELECT key FROM kv WHERE key >= ? AND key < ?").all(prefix, `${prefix}\uffff`);
    const del = this.db.prepare("DELETE FROM kv WHERE key = ?");
    for (const r of rows) {
      const key = text(r.key);
      if (!keep.has(key.slice(prefix.length))) del.run(key);
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }
}

// null when `before` isn't a state any more: there's nothing it could restore.
function rowToAction(r: Record<string, unknown>): ActionEvent | null {
  const before = json(StateRowSchema, r.before);
  if (!before) return null;
  return {
    seq: int(r.seq),
    at: text(r.at),
    item_id: text(r.item_id),
    action: text(r.action),
    before,
    undone: r.undone === 1,
    agent: textOrNull(r.agent),
  };
}

function rowToState(r: Record<string, unknown>): StateRow {
  return {
    id: text(r.id),
    done_at: textOrNull(r.done_at),
    snooze_until: textOrNull(r.snooze_until),
    snooze_on_activity: r.snooze_on_activity === 1,
    snooze_when: textOrNull(r.snooze_when),
    snoozed_at: textOrNull(r.snoozed_at),
    acked_at: textOrNull(r.acked_at),
    muted: r.muted === 1,
    pinned: r.pinned === 1,
    seen_at: textOrNull(r.seen_at),
    inflight_at: textOrNull(r.inflight_at),
    section: r.section === null ? null : lit(INBOX_SECTIONS, r.section),
  };
}
