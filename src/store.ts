// SQLite cache of GitHub items and your local triage state.
import { DatabaseSync } from "node:sqlite";
import type { Item, ItemState } from "./types.ts";

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
    `);
    const cols = this.db.prepare("PRAGMA table_info(state)").all().map((c) => c.name);
    if (!cols.includes("acked_at")) this.db.exec("ALTER TABLE state ADD COLUMN acked_at TEXT");
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
    return this.db.prepare("SELECT data FROM items").all().map((r) => JSON.parse(r.data as string) as Item);
  }

  itemMeta(): Map<string, { node_id: string; updated_at: string; detail_at: string }> {
    const rows = this.db.prepare("SELECT id, node_id, updated_at, detail_at FROM items").all();
    return new Map(rows.map((r) => [r.id as string, { node_id: r.node_id as string, updated_at: r.updated_at as string, detail_at: r.detail_at as string }]));
  }

  putItems(items: Item[], now: string): void {
    const stmt = this.db.prepare(
      `INSERT INTO items (id, node_id, data, updated_at, detail_at, last_hit_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET node_id = excluded.node_id, data = excluded.data, updated_at = excluded.updated_at, detail_at = excluded.detail_at, last_hit_at = excluded.last_hit_at`,
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

  setHits(query: string, ids: string[], total: number, now: string): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM hits WHERE query = ?").run(query);
      const stmt = this.db.prepare("INSERT OR IGNORE INTO hits (query, item_id) VALUES (?, ?)");
      for (const id of ids) stmt.run(query, id);
      this.db
        .prepare("INSERT INTO queries (query, fetched_at, total, error) VALUES (?, ?, ?, NULL) ON CONFLICT(query) DO UPDATE SET fetched_at = excluded.fetched_at, total = excluded.total, error = NULL")
        .run(query, now, total);
    });
  }

  setQueryError(query: string, error: string, now: string): void {
    this.db
      .prepare("INSERT INTO queries (query, fetched_at, total, error) VALUES (?, ?, 0, ?) ON CONFLICT(query) DO UPDATE SET error = excluded.error")
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

  queries(): Map<string, { fetched_at: string; total: number; error: string | null }> {
    const rows = this.db.prepare("SELECT query, fetched_at, total, error FROM queries").all();
    return new Map(rows.map((r) => [r.query as string, { fetched_at: r.fetched_at as string, total: r.total as number, error: (r.error as string) ?? null }]));
  }

  // --- local state

  states(): Map<string, StateRow> {
    return new Map(this.db.prepare("SELECT * FROM state").all().map((r) => [r.id as string, rowToState(r)]));
  }

  state(id: string): StateRow {
    const r = this.db.prepare("SELECT * FROM state WHERE id = ?").get(id);
    return r ? rowToState(r) : emptyState(id);
  }

  putState(s: StateRow): void {
    this.db
      .prepare(
        `INSERT INTO state (id, done_at, snooze_until, snooze_on_activity, snoozed_at, acked_at, muted, pinned, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET done_at = excluded.done_at, snooze_until = excluded.snooze_until, snooze_on_activity = excluded.snooze_on_activity,
           snoozed_at = excluded.snoozed_at, acked_at = excluded.acked_at, muted = excluded.muted, pinned = excluded.pinned, seen_at = excluded.seen_at`,
      )
      .run(s.id, s.done_at, s.snooze_until, s.snooze_on_activity ? 1 : 0, s.snoozed_at, s.acked_at, s.muted ? 1 : 0, s.pinned ? 1 : 0, s.seen_at);
  }

  // --- undo log

  logAction(itemId: string, action: string, before: StateRow, at: string): number {
    const r = this.db.prepare("INSERT INTO events (at, item_id, action, before) VALUES (?, ?, ?, ?)").run(at, itemId, action, JSON.stringify(before));
    return Number(r.lastInsertRowid);
  }

  lastAction(seq?: number): ActionEvent | null {
    const r = seq === undefined
      ? this.db.prepare("SELECT * FROM events WHERE undone = 0 ORDER BY seq DESC LIMIT 1").get()
      : this.db.prepare("SELECT * FROM events WHERE seq = ? AND undone = 0").get(seq);
    if (!r) return null;
    return { seq: r.seq as number, at: r.at as string, item_id: r.item_id as string, action: r.action as string, before: JSON.parse(r.before as string), undone: false };
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

  // --- key/value

  get<T>(key: string): T | null {
    const r = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
    return r ? (JSON.parse(r.value as string) as T) : null;
  }

  prefixed<T>(prefix: string): Map<string, T> {
    const rows = this.db.prepare("SELECT key, value FROM kv WHERE key >= ? AND key < ?").all(prefix, prefix + "\uffff");
    return new Map(rows.map((r) => [(r.key as string).slice(prefix.length), JSON.parse(r.value as string) as T]));
  }

  set(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }
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
  };
}
