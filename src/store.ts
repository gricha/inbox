// SQLite cache of GitHub items, your local triage state, and the event log.
import { DatabaseSync } from "node:sqlite";
import type { ActivityEvent, ActivityKind, Item, ItemState } from "./types.ts";

export interface ItemMeta {
  node_id: string;
  kind: Item["kind"];
  author: string;
  updated_at: string;
  detail_at: string;
  last_hit_at: string; // the last time a search returned it
  lacks: boolean; // a PR stored before the desk asked for what stacks need (head_ref, default_branch, retargeted)
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
});

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
      CREATE TABLE IF NOT EXISTS activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, source TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS activity_item ON activity (item_id, seq);
      -- The desk-run coordinator's log, no longer written; the events.agent migration below still reads it.
      CREATE TABLE IF NOT EXISTS coordinator_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, run INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, item_id TEXT, action TEXT, bucket TEXT, undo_seq INTEGER);
    `);
    const cols = new Set(
      this.db
        .prepare("PRAGMA table_info(state)")
        .all()
        .map((c) => c.name),
    );
    if (!cols.has("acked_at")) this.db.exec("ALTER TABLE state ADD COLUMN acked_at TEXT");
    if (!cols.has("inflight_at")) this.db.exec("ALTER TABLE state ADD COLUMN inflight_at TEXT");
    if (!cols.has("snooze_when")) this.db.exec("ALTER TABLE state ADD COLUMN snooze_when TEXT");
    const hitCols = this.db
      .prepare("PRAGMA table_info(hits)")
      .all()
      .map((c) => c.name);
    if (!hitCols.includes("kept")) this.db.exec("ALTER TABLE hits ADD COLUMN kept INTEGER NOT NULL DEFAULT 0");
    const itemCols = this.db
      .prepare("PRAGMA table_info(items)")
      .all()
      .map((c) => c.name);
    // The snapshot an item's events were last logged against, while it's stored quietly since ('null': never); else NULL.
    if (!itemCols.includes("said")) this.db.exec("ALTER TABLE items ADD COLUMN said TEXT");
    const eventCols = this.db
      .prepare("PRAGMA table_info(events)")
      .all()
      .map((c) => c.name);
    if (!eventCols.includes("agent")) {
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
    return this.db
      .prepare("SELECT data FROM items")
      .all()
      .map((r) => JSON.parse(r.data as string) as Item);
  }

  itemsById(ids: string[]): Map<string, Item> {
    const stmt = this.db.prepare("SELECT data FROM items WHERE id = ?");
    const out = new Map<string, Item>();
    for (const id of ids) {
      const r = stmt.get(id);
      if (r) out.set(id, JSON.parse(r.data as string) as Item);
    }
    return out;
  }

  itemMeta(): Map<string, ItemMeta> {
    const rows = this.db
      .prepare(
        `SELECT id, node_id, json_extract(data, '$.kind') AS kind, json_extract(data, '$.author') AS author, updated_at, detail_at, last_hit_at,
          json_extract(data, '$.kind') = 'pr' AND (json_type(data, '$.head_ref') IS NULL OR json_type(data, '$.default_branch') IS NULL
            OR json_type(data, '$.retargeted') IS NULL) AS lacks, said IS NOT NULL AS quiet FROM items`,
      )
      .all();
    return new Map(
      rows.map((r) => {
        const meta: ItemMeta = {
          node_id: r.node_id as string,
          kind: r.kind as Item["kind"],
          author: r.author as string,
          updated_at: r.updated_at as string,
          detail_at: r.detail_at as string,
          last_hit_at: r.last_hit_at as string,
          lacks: r.lacks === 1,
          quiet: r.quiet === 1,
        };
        return [r.id as string, meta];
      }),
    );
  }

  // last_hit_at is set on insert and by touchItems: refreshing an item no search returns doesn't renew it. `quiet`: stored
  // without logging its events, which keeps what they were last logged against in `said`.
  putItems(items: Item[], now: string, quiet = false): void {
    const stmt = this.db.prepare(
      `INSERT INTO items (id, node_id, data, updated_at, detail_at, last_hit_at, said) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET node_id = excluded.node_id, data = excluded.data, updated_at = excluded.updated_at, detail_at = excluded.detail_at,
         said = ${quiet ? "COALESCE(items.said, items.data)" : "NULL"}`,
    );
    this.tx(() => {
      for (const it of items) stmt.run(it.id, it.node_id, JSON.stringify(it), it.updated_at, it.detail_at, now, quiet ? "null" : null);
    });
  }

  // Of these, the ones stored quietly, with the snapshot their events were last logged against (null: never).
  said(ids: string[]): Map<string, Item | null> {
    const stmt = this.db.prepare("SELECT said FROM items WHERE id = ? AND said IS NOT NULL");
    const out = new Map<string, Item | null>();
    for (const id of ids) {
      const r = stmt.get(id);
      if (r) out.set(id, JSON.parse(r.said as string) as Item | null);
    }
    return out;
  }

  touchItems(ids: string[], now: string): void {
    const stmt = this.db.prepare("UPDATE items SET last_hit_at = ? WHERE id = ?");
    this.tx(() => {
      for (const id of ids) stmt.run(now, id);
    });
  }

  pruneItems(before: string, keep: Set<string> = new Set()): void {
    this.db
      .prepare("DELETE FROM items WHERE last_hit_at < ? AND id NOT IN (SELECT value FROM json_each(?))")
      .run(before, JSON.stringify([...keep]));
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

  hits(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const r of this.db.prepare("SELECT query, item_id FROM hits").all()) {
      const q = r.query as string;
      if (!out.has(q)) out.set(q, new Set());
      out.get(q)!.add(r.item_id as string);
    }
    return out;
  }

  kept(): Set<string> {
    return new Set(
      this.db
        .prepare("SELECT DISTINCT item_id FROM hits WHERE kept = 1")
        .all()
        .map((r) => r.item_id as string),
    );
  }

  queries(): Map<string, { fetched_at: string; total: number; error: string | null }> {
    const rows = this.db.prepare("SELECT query, fetched_at, total, error FROM queries").all();
    return new Map(
      rows.map((r) => [
        r.query as string,
        { fetched_at: r.fetched_at as string, total: r.total as number, error: (r.error as string) ?? null },
      ]),
    );
  }

  // --- local state

  states(): Map<string, StateRow> {
    return new Map(
      this.db
        .prepare("SELECT * FROM state")
        .all()
        .map((r) => [r.id as string, rowToState(r)]),
    );
  }

  state(id: string): StateRow {
    const r = this.db.prepare("SELECT * FROM state WHERE id = ?").get(id);
    return r ? rowToState(r) : emptyState(id);
  }

  putState(s: StateRow): void {
    this.db
      .prepare(
        `INSERT INTO state (id, done_at, snooze_until, snooze_on_activity, snoozed_at, acked_at, muted, pinned, seen_at, inflight_at, snooze_when) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET done_at = excluded.done_at, snooze_until = excluded.snooze_until, snooze_on_activity = excluded.snooze_on_activity,
           snoozed_at = excluded.snoozed_at, acked_at = excluded.acked_at, muted = excluded.muted, pinned = excluded.pinned, seen_at = excluded.seen_at,
           inflight_at = excluded.inflight_at, snooze_when = excluded.snooze_when`,
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
    return r ? this.lastAction(r.seq as number) : null;
  }

  // Its latest pin still in effect: the agent behind it (null for you) and its seq.
  lastPin(itemId: string): { agent: string | null; seq: number } | null {
    const r = this.db
      .prepare("SELECT agent, seq FROM events WHERE item_id = ? AND action = 'pin' AND undone = 0 ORDER BY seq DESC LIMIT 1")
      .get(itemId);
    return r ? { agent: (r.agent as string | null) ?? null, seq: Number(r.seq) } : null;
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
      .map((r) => ({
        seq: r.seq as number,
        at: r.at as string,
        source: r.source as string,
        item_id: r.item_id as string,
        kind: r.kind as ActivityKind,
        actor: r.actor as string,
        data: JSON.parse(r.data as string) as ActivityEvent["data"],
      }));
  }

  lastSeq(): number {
    return (this.db.prepare("SELECT MAX(seq) AS seq FROM activity").get()?.seq as number | null) ?? 0;
  }

  // --- key/value

  get(key: string): unknown {
    const r = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
    return r ? JSON.parse(r.value as string) : null;
  }

  prefixed<T>(prefix: string): Map<string, T> {
    const rows = this.db.prepare("SELECT key, value FROM kv WHERE key >= ? AND key < ?").all(prefix, prefix + "\uffff");
    return new Map(rows.map((r) => [(r.key as string).slice(prefix.length), JSON.parse(r.value as string) as T]));
  }

  // Drops `prefix<id>` rows whose id isn't in `keep`.
  pruneKv(prefix: string, keep: Set<string>): void {
    const rows = this.db.prepare("SELECT key FROM kv WHERE key >= ? AND key < ?").all(prefix, `${prefix}\uffff`);
    const del = this.db.prepare("DELETE FROM kv WHERE key = ?");
    for (const r of rows) {
      const key = r.key as string;
      if (!keep.has(key.slice(prefix.length))) del.run(key);
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }
}

function rowToAction(r: Record<string, unknown>): ActionEvent {
  return {
    seq: r.seq as number,
    at: r.at as string,
    item_id: r.item_id as string,
    action: r.action as string,
    before: JSON.parse(r.before as string) as StateRow,
    undone: r.undone === 1,
    agent: (r.agent as string | null) ?? null,
  };
}

function rowToState(r: Record<string, unknown>): StateRow {
  return {
    id: r.id as string,
    done_at: (r.done_at as string) ?? null,
    snooze_until: (r.snooze_until as string) ?? null,
    snooze_on_activity: r.snooze_on_activity === 1,
    snooze_when: (r.snooze_when as string | null) ?? null,
    snoozed_at: (r.snoozed_at as string) ?? null,
    acked_at: (r.acked_at as string) ?? null,
    muted: r.muted === 1,
    pinned: r.pinned === 1,
    seen_at: (r.seen_at as string) ?? null,
    inflight_at: (r.inflight_at as string) ?? null,
  };
}
