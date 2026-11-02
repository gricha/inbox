// SQLite cache of GitHub items, your local triage state, and the event log.
import { DatabaseSync } from "node:sqlite";
import type { ActivityEvent, ActivityKind, Bucket, CoordinatorLogEntry, Item, ItemState } from "./types.ts";

export interface ItemMeta {
  node_id: string;
  kind: Item["kind"];
  author: string;
  updated_at: string;
  detail_at: string;
  last_hit_at: string; // the last time a search returned it
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
}

export const emptyState = (id: string): StateRow => ({
  id,
  done_at: null,
  snooze_until: null,
  snooze_on_activity: false,
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
    const hitCols = this.db
      .prepare("PRAGMA table_info(hits)")
      .all()
      .map((c) => c.name);
    if (!hitCols.includes("kept")) this.db.exec("ALTER TABLE hits ADD COLUMN kept INTEGER NOT NULL DEFAULT 0");
    const logCols = this.db
      .prepare("PRAGMA table_info(coordinator_log)")
      .all()
      .map((c) => c.name);
    if (!logCols.includes("version")) this.db.exec("ALTER TABLE coordinator_log ADD COLUMN version INTEGER");
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
        "SELECT id, node_id, json_extract(data, '$.kind') AS kind, json_extract(data, '$.author') AS author, updated_at, detail_at, last_hit_at FROM items",
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
        };
        return [r.id as string, meta];
      }),
    );
  }

  // last_hit_at is set on insert and by touchItems: refreshing an item no search returns doesn't renew it.
  putItems(items: Item[], now: string): void {
    const stmt = this.db.prepare(
      `INSERT INTO items (id, node_id, data, updated_at, detail_at, last_hit_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET node_id = excluded.node_id, data = excluded.data, updated_at = excluded.updated_at, detail_at = excluded.detail_at`,
    );
    this.tx(() => {
      for (const it of items) stmt.run(it.id, it.node_id, JSON.stringify(it), it.updated_at, it.detail_at, now);
    });
  }

  touchItems(ids: string[], now: string): void {
    const stmt = this.db.prepare("UPDATE items SET last_hit_at = ? WHERE id = ?");
    this.tx(() => {
      for (const id of ids) stmt.run(now, id);
    });
  }

  pruneItems(before: string): void {
    this.db.prepare("DELETE FROM items WHERE last_hit_at < ?").run(before);
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
        `INSERT INTO state (id, done_at, snooze_until, snooze_on_activity, snoozed_at, acked_at, muted, pinned, seen_at, inflight_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET done_at = excluded.done_at, snooze_until = excluded.snooze_until, snooze_on_activity = excluded.snooze_on_activity,
           snoozed_at = excluded.snoozed_at, acked_at = excluded.acked_at, muted = excluded.muted, pinned = excluded.pinned, seen_at = excluded.seen_at,
           inflight_at = excluded.inflight_at`,
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
      );
  }

  // --- undo log

  logAction(itemId: string, action: string, before: StateRow, at: string): number {
    const r = this.db
      .prepare("INSERT INTO events (at, item_id, action, before) VALUES (?, ?, ?, ?)")
      .run(at, itemId, action, JSON.stringify(before));
    return Number(r.lastInsertRowid);
  }

  // GitHub writes (approve) go in the same log, stored as undone: the desk can't take them back.
  logWrite(itemId: string, action: string, at: string): number {
    const r = this.db
      .prepare("INSERT INTO events (at, item_id, action, before, undone) VALUES (?, ?, ?, ?, 1)")
      .run(at, itemId, action, JSON.stringify(this.state(itemId)));
    return Number(r.lastInsertRowid);
  }

  // The item's latest action still in effect: whose it was is in the coordinator's log, by its undo seq.
  lastActionSeq(itemId: string): number | null {
    const r = this.db.prepare("SELECT MAX(seq) AS seq FROM events WHERE item_id = ? AND undone = 0").get(itemId);
    return (r?.seq as number | null) ?? null;
  }

  lastAction(seq?: number): ActionEvent | null {
    const r =
      seq === undefined
        ? this.db.prepare("SELECT * FROM events WHERE undone = 0 ORDER BY seq DESC LIMIT 1").get()
        : this.db.prepare("SELECT * FROM events WHERE seq = ? AND undone = 0").get(seq);
    return r ? rowToAction(r) : null;
  }

  // Actions after `seq` and at or after `since` still in effect, oldest first.
  actionsAfter(seq: number, since: string, limit: number): ActionEvent[] {
    return this.db
      .prepare("SELECT * FROM events WHERE seq > ? AND at >= ? AND undone = 0 ORDER BY seq ASC LIMIT ?")
      .all(seq, since, limit)
      .map(rowToAction);
  }

  hasLaterAction(itemId: string, seq: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM events WHERE item_id = ? AND seq > ? AND undone = 0").get(itemId, seq);
  }

  lastActionFor(itemId: string): ActionEvent | null {
    const r = this.db.prepare("SELECT seq FROM events WHERE item_id = ? AND undone = 0 ORDER BY seq DESC LIMIT 1").get(itemId);
    return r ? this.lastAction(r.seq as number) : null;
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

  // --- the coordinator's log: its runs, its actions (with their reasons) and its notes

  addLog(e: Omit<CoordinatorLogEntry, "seq" | "undone">): void {
    this.db
      .prepare(
        "INSERT INTO coordinator_log (at, run, kind, text, item_id, action, bucket, undo_seq, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(e.at, e.run, e.kind, e.text, e.item_id, e.action, e.bucket, e.undo_seq, e.version);
    this.db.prepare("DELETE FROM coordinator_log WHERE seq <= (SELECT MAX(seq) FROM coordinator_log) - 1000").run();
  }

  // Newest first; an action shows as undone once its undo-log entry is.
  log(q: { limit: number; since?: string; kind?: string }): CoordinatorLogEntry[] {
    const where = [q.since === undefined ? "1" : "c.at >= ?", q.kind === undefined ? "1" : "c.kind = ?"].join(" AND ");
    const args = [q.since, q.kind, q.limit].filter((a): a is string | number => a !== undefined);
    return this.db
      .prepare(
        `SELECT c.*, e.undone AS undone FROM coordinator_log c LEFT JOIN events e ON e.seq = c.undo_seq WHERE ${where} ORDER BY c.seq DESC LIMIT ?`,
      )
      .all(...args)
      .map((r) => ({
        seq: r.seq as number,
        at: r.at as string,
        run: r.run as number,
        kind: r.kind as CoordinatorLogEntry["kind"],
        text: r.text as string,
        item_id: (r.item_id as string | null) ?? null,
        action: (r.action as string | null) ?? null,
        bucket: (r.bucket as Bucket | null) ?? null,
        undo_seq: (r.undo_seq as number | null) ?? null,
        version: (r.version as number | null) ?? null,
        undone: r.undone === 1,
      }));
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
    undone: false,
  };
}

function rowToState(r: Record<string, unknown>): StateRow {
  return {
    id: r.id as string,
    done_at: (r.done_at as string) ?? null,
    snooze_until: (r.snooze_until as string) ?? null,
    snooze_on_activity: r.snooze_on_activity === 1,
    snoozed_at: (r.snoozed_at as string) ?? null,
    acked_at: (r.acked_at as string) ?? null,
    muted: r.muted === 1,
    pinned: r.pinned === 1,
    seen_at: (r.seen_at as string) ?? null,
    inflight_at: (r.inflight_at as string) ?? null,
  };
}
