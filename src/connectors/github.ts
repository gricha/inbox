// GitHub as a connector: board searches plus details (reconcile), the notifications feed, and the snapshot diff.
import type { LoadedConfig } from "../config.ts";
import type { Desk } from "../desk.ts";
import { pool, type GitHub, type SearchHit } from "../github/index.ts";
import type { CompiledBoard } from "../rules.ts";
import { buildStacks, probeKey, toFetch, type Probe } from "../stacks.ts";
import type { ConnectorStatus, Item } from "../types.ts";
import type { Connector, NewEvent } from "./connector.ts";
import { itemEvents } from "./github-events.ts";

const HOUR = 3_600_000;
const MAX_QUERY = 256; // GitHub search rejects longer queries
export const KEEP_RESOLVED = 3 * 24 * HOUR; // an item that left every search stays on its boards this long, under Resolved
const FEED_RETRY = 10 * 60_000;
// Notification reasons that mean an item the desk doesn't have yet may belong on it.
const FRESH_REASONS = new Set(["review_requested", "mention", "team_mention", "assign", "author"]);
const MENTIONS = new Set(["mention", "team_mention"]);
const BACKFILL = 40; // stored PRs a pass refetches for fields stacks need that they were stored without
const PROBE_TTL = 30 * 60_000; // a stack probe isn't asked again before this; an off-board open member is refreshed after it
const MAX_PROBES = 120; // stack probes a pass
const RESERVE = 40; // of those, kept from probes that only look for a stack, for the rounds that follow a chain up
const STACK_ROUNDS = 3; // probe, fetch, probe again: a chain a few PRs deep fills in one pass

interface Feed {
  since: string | null; // ask for threads updated after this
  last_modified: string | null; // GitHub's Last-Modified, sent back as If-Modified-Since
  interval: number; // seconds, from X-Poll-Interval
  seen: Record<string, { at: string; reason: string }>; // thread id → the update already handled
}

function isRateLimited(e: unknown): boolean {
  return (e as Error)?.name === "RateLimitedError" || (typeof e === "object" && e !== null && "resetAt" in e);
}

const hitOf = (id: string, m: { node_id: string; kind: Item["kind"]; updated_at: string; author: string }): SearchHit => ({
  node_id: m.node_id,
  id,
  kind: m.kind,
  updated_at: m.updated_at,
  author: m.author,
});

export class GitHubConnector implements Connector {
  readonly id = "github";
  readonly name = "GitHub";
  desk: Desk;
  api: GitHub;
  syncing = false;
  syncAgain = false;
  polling = false;
  started = false;
  stopped = false;
  syncedAt: string | null;
  error: string | null = null;
  contextError: string | null = null;
  feedError: string | null = null;
  pausedUntil = 0;
  timer: NodeJS.Timeout | null = null;
  feedTimer: NodeJS.Timeout | null = null;
  feed: Feed;

  constructor(desk: Desk, api: GitHub) {
    this.desk = desk;
    this.api = api;
    this.syncedAt = desk.store.get("synced_at") as string | null;
    this.feed = { since: null, last_modified: null, interval: 60, seen: {}, ...(desk.store.get("github.feed") as Partial<Feed> | null) };
  }

  // ---------------------------------------------------------------- loops

  start(): void {
    this.started = true;
    void this.tick();
    this.armFeed(this.feed.interval * 1000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.feedTimer) clearTimeout(this.feedTimer);
  }

  reschedule(): void {
    if (this.started && !this.stopped) this.arm();
  }

  async tick(): Promise<void> {
    await this.reconcile();
    if (!this.stopped) this.arm();
  }

  arm(): void {
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(this.desk.settings["github.poll_seconds"] * 1000, this.pausedUntil - Date.now());
    this.timer = setTimeout(() => void this.tick(), wait);
  }

  async feedTick(): Promise<void> {
    await this.poll();
    if (!this.stopped) this.armFeed(this.feedError ? FEED_RETRY : this.feed.interval * 1000);
  }

  armFeed(wait: number): void {
    if (this.feedTimer) clearTimeout(this.feedTimer);
    this.feedTimer = setTimeout(() => void this.feedTick(), Math.max(wait, this.pausedUntil - Date.now()));
  }

  status(): ConnectorStatus {
    const status = this.syncing ? "syncing" : Date.now() < this.pausedUntil ? "paused" : this.error ? "error" : "ok";
    return { id: this.id, name: this.name, status, synced_at: this.syncedAt, error: this.error };
  }

  // ---------------------------------------------------------------- context and searches

  async refreshContext(): Promise<void> {
    const desk = this.desk;
    const me = desk.ctx?.me ?? (await this.api.viewer());
    try {
      const c = await this.api.context(me);
      desk.ctx = { ...desk.ctx, ...c, me, refreshed_at: desk.now().toISOString() };
      this.contextError = null;
    } catch (e) {
      this.contextError = (e as Error).message;
      desk.log(`context refresh failed: ${this.contextError}`);
      // Retry in about an hour rather than on every poll.
      const retry = new Date(desk.now().getTime() - 23 * HOUR).toISOString();
      desk.ctx = desk.ctx
        ? { ...desk.ctx, refreshed_at: retry }
        : { me, teams: [], affinity: {}, repo_prs: {}, orgs: {}, refreshed_at: new Date(0).toISOString() };
    }
    desk.store.set("context", desk.ctx);
  }

  // Daily, apart from the context: a failure keeps the last areas and tries again in about an hour.
  async refreshAreas(): Promise<void> {
    const desk = this.desk;
    try {
      const areas = await this.api.areas();
      if (desk.ctx) desk.ctx = { ...desk.ctx, areas, areas_at: desk.now().toISOString() };
    } catch (e) {
      desk.log(`areas refresh failed: ${(e as Error).message}`);
      if (desk.ctx) desk.ctx = { ...desk.ctx, areas_at: new Date(desk.now().getTime() - 23 * HOUR).toISOString() };
    }
    desk.store.set("context", desk.ctx);
  }

  // Board query → expanded GitHub search string (null when it can't run, e.g. no collaborators yet).
  expandQuery(q: string, scope: string, loaded = this.desk.loaded): string | null {
    const me = this.desk.me();
    let base = `${q} ${scope}`.replaceAll("{me}", me).replaceAll(/\s+/g, " ").trim();
    if (!base.includes("{close_authors}")) return base;
    base = base.replace("{close_authors}", "").replaceAll(/\s+/g, " ").trim();
    const min = loaded?.config.signals.close_collaborator_min ?? 3;
    const bots = new Set((loaded?.config.signals.bots ?? []).map((b) => b.toLowerCase()));
    const authors = Object.entries(this.desk.ctx?.affinity ?? {})
      .filter(([a, n]) => n >= min && a.toLowerCase() !== me.toLowerCase() && !bots.has(a.toLowerCase()) && !a.endsWith("[bot]"))
      .sort((a, b) => b[1] - a[1]);
    let out = base;
    for (const [a] of authors) {
      if (out.length + ` author:${a}`.length > MAX_QUERY) break;
      out += ` author:${a}`;
    }
    return out === base ? null : out;
  }

  queriesFor(loaded: LoadedConfig, board: CompiledBoard): string[] {
    const scope = loaded.config.spaces.find((s) => s.id === board.config.space)?.scope ?? "";
    return board.config.queries.map((q) => this.expandQuery(q, scope, loaded)).filter((q): q is string => q !== null);
  }

  // ---------------------------------------------------------------- reconcile: every board search, then details

  async reconcile(): Promise<void> {
    const desk = this.desk;
    if (!desk.loaded || this.stopped) return;
    if (this.syncing) {
      this.syncAgain = true;
      return;
    }
    if (Date.now() < this.pausedUntil) return;
    this.syncing = true;
    desk.changed();
    try {
      const now = desk.now();
      const iso = now.toISOString();
      if (!desk.ctx || now.getTime() - Date.parse(desk.ctx.refreshed_at) > 24 * HOUR) await this.refreshContext();
      if (now.getTime() - (Date.parse(desk.ctx?.areas_at ?? "") || 0) > 24 * HOUR) await this.refreshAreas();
      const me = desk.me().toLowerCase();
      const loaded = desk.loaded;
      const queries = [...new Set(loaded.boards.flatMap((b) => this.queriesFor(loaded, b)))];
      const listed = desk.store.hits(); // what each search returned last time
      const found = new Map<string, { ids: string[]; total: number }>();
      const hits = new Map<string, SearchHit>();
      const errors: string[] = [];
      for (const q of queries) {
        try {
          const r = await this.api.search(q, 300);
          found.set(q, { ids: r.hits.map((h) => h.id), total: r.total });
          for (const h of r.hits) hits.set(h.id, h);
        } catch (e) {
          if (isRateLimited(e)) throw e;
          desk.store.setQueryError(q, (e as Error).message, iso);
          errors.push(`${q}: ${(e as Error).message}`);
        }
      }
      const meta = desk.store.itemMeta();
      // An open pin no search returns (desk_add's) would go stale and be pruned in 14 days; nothing says when it changed, so 3 min.
      const off = [...desk.store.states().values()].filter((s) => s.pinned && !hits.has(s.id) && meta.has(s.id)).map((s) => s.id);
      const pinned = [...desk.store.itemsById(off).values()].filter((i) => i.state === "open").map((i) => hitOf(i.id, meta.get(i.id)!));
      const need = [...hits.values(), ...pinned].filter((h) => {
        const m = meta.get(h.id);
        if (!m || m.quiet || m.updated_at !== h.updated_at) return true;
        const ttl = h.author.toLowerCase() === me || pinned.includes(h) ? 3 * 60_000 : 30 * 60_000;
        return now.getTime() - Date.parse(m.detail_at) > ttl;
      });
      const backfill = [...hits.values()].filter((h) => meta.get(h.id)?.lacks && !need.includes(h)).slice(0, BACKFILL);
      need.push(...backfill);
      // An item that left every search gets one refresh, so the desk learns it merged, closed or stopped asking you.
      // A failed search keeps what it had.
      const still = new Set(hits.keys());
      for (const q of queries) if (!found.has(q)) for (const id of listed.get(q) ?? []) still.add(id);
      const gone = new Set(queries.flatMap((q) => [...(listed.get(q) ?? [])]).filter((id) => !still.has(id)));
      const last = desk.store.get("reconciled_at") as string | null;
      const drops = [...gone].flatMap((id) => {
        const m = meta.get(id);
        // Only on the pass it left: an item kept to show as resolved was last listed before that.
        return m && (last === null || m.last_hit_at >= last) ? [hitOf(id, m)] : [];
      });
      const items = need.length || drops.length ? await this.api.details([...need, ...drops], desk.me()) : [];
      desk.ingest(this, items);
      const keep = (id: string) => {
        const m = meta.get(id);
        return !!m && Date.parse(m.last_hit_at) > now.getTime() - KEEP_RESOLVED && desk.isResolved(id);
      };
      for (const [q, r] of found) {
        const kept = [...(listed.get(q) ?? [])].filter((id) => gone.has(id) && keep(id));
        desk.store.setHits(q, r.ids, r.total, iso, kept);
      }
      const listedIds = new Set([...hits.keys(), ...pinned.map((h) => h.id)]);
      desk.store.touchItems([...listedIds], iso);
      if (!desk.store.get("baseline_at")) desk.store.set("baseline_at", iso);
      const [firstError] = errors;
      if (errors.length === queries.length && firstError !== undefined) throw new Error(firstError.replace(/^.*?: (?=GitHub)/, ""));
      desk.store.set("reconciled_at", iso);
      const { fetched: filled, members } = await this.fillStacks(listedIds);
      desk.store.pruneItems(new Date(now.getTime() - 14 * 24 * HOUR).toISOString(), members);
      this.syncedAt = desk.now().toISOString(); // when it finished: "Synced 12s ago" means fresh data
      desk.store.set("synced_at", this.syncedAt);
      this.error = errors.length ? `${errors.length} search(es) failed: ${errors[0]}` : null;
      const left = drops.length ? `, ${drops.length} left the searches` : "";
      const stacked = filled ? `, ${filled} for stacks` : "";
      desk.log(`synced ${queries.length} searches, ${hits.size} items, ${items.length} refreshed${left}${stacked}`);
    } catch (e) {
      if (this.stopped) return;
      this.error = (e as Error).message;
      if (isRateLimited(e)) this.pausedUntil = Date.parse((e as { resetAt: string }).resetAt) || Date.now() + 15 * 60_000;
      desk.log(`sync failed: ${this.error}`);
    } finally {
      this.syncing = false;
      if (!this.stopped) {
        desk.synced();
        if (this.syncAgain) {
          this.syncAgain = false;
          void this.reconcile();
        }
      }
    }
  }

  // Stack members no board search returns (the PR below a stack's bottom, PRs stacked on one on the desk) and stored ones
  // gone stale, fetched read only and stored without events: they're context for a stack, not news. Returns how many, and
  // the members of the listed PRs' stacks.
  async fillStacks(listed: Set<string>): Promise<{ fetched: number; members: Set<string> }> {
    const desk = this.desk;
    const at = desk.now();
    const asked = Object.fromEntries(
      Object.entries((desk.store.get("stack_probes") as Record<string, string> | null) ?? {}).filter(
        ([, t]) => at.getTime() - Date.parse(t) < PROBE_TTL,
      ),
    );
    let budget = MAX_PROBES;
    let fetched = 0;
    const members = new Set<string>();
    try {
      for (let round = 0; round < STACK_ROUNDS; round++) {
        const stored = desk.store.items();
        const before = new Date(at.getTime() - PROBE_TTL).toISOString();
        const got = toFetch(stored, buildStacks(stored), listed, before);
        for (const id of got.members) members.add(id);
        const due = got.probes.filter((p) => !asked[probeKey(p)]);
        const stacked = due.filter((p) => p.stacked).slice(0, budget);
        const scan = due.filter((p) => !p.stacked).slice(0, Math.max(0, budget - stacked.length - RESERVE));
        const old = round === 0 ? got.stale : [];
        if (!stacked.length && !scan.length && !old.length) break;
        budget -= stacked.length + scan.length;
        const repos = new Map<string, Probe[]>();
        for (const p of [...stacked, ...scan]) {
          asked[probeKey(p)] = at.toISOString();
          repos.set(p.repo, [...(repos.get(p.repo) ?? []), p]);
        }
        const answers = await pool([...repos], 3, async ([repo, ps]) => {
          try {
            return await this.api.branchPrs(repo, ps);
          } catch (e) {
            if (isRateLimited(e)) throw e;
            desk.log(`stack probes in ${repo} failed: ${(e as Error).message}`);
            return [];
          }
        });
        const meta = desk.store.itemMeta();
        const want = new Map<string, SearchHit>();
        for (const h of answers.flat()) {
          const m = meta.get(h.id);
          if (!listed.has(h.id) && (m?.updated_at !== h.updated_at || m.lacks)) want.set(h.id, h);
        }
        for (const it of old) want.set(it.id, hitOf(it.id, it));
        if (!want.size) continue;
        const items = await this.api.details([...want.values()], desk.me());
        desk.ingest(this, items, true);
        fetched += items.length;
      }
    } finally {
      desk.store.set("stack_probes", asked);
    }
    return { fetched, members };
  }

  // Not stored quietly like a stack's members: you added it, so its events count and the notifications feed follows it.
  async fetchOne(repo: string, number: number): Promise<string | null> {
    const hit = await this.api.lookup(repo, number);
    if (!hit) return null;
    const [item] = await this.api.details([hit], this.desk.me());
    if (!item) throw new Error(`couldn't fetch ${hit.id} from GitHub; try again`); // details skips a batch that failed
    this.desk.ingest(this, [item]);
    return item.id;
  }

  // One item's details now, outside the loops: after you approve it, so it resolves in seconds, not at the next pass.
  async refresh(id: string): Promise<void> {
    const desk = this.desk;
    const m = desk.store.itemMeta().get(id);
    if (!m || this.stopped || Date.now() < this.pausedUntil) return;
    try {
      const items = await this.api.details([hitOf(id, m)], desk.me());
      if (this.stopped) return;
      desk.ingest(this, items);
      desk.synced();
    } catch (e) {
      if (isRateLimited(e)) this.pausedUntil = Date.parse((e as { resetAt: string }).resetAt) || Date.now() + 15 * 60_000;
      desk.log(`refresh of ${id} failed: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- the change feed: notifications

  async poll(): Promise<void> {
    const desk = this.desk;
    if (this.stopped || this.polling || !desk.loaded || !desk.ctx || Date.now() < this.pausedUntil) return;
    this.polling = true;
    const started = desk.now().getTime();
    // The first poll only learns where the feed stands; a thread's old mention isn't news.
    const first = this.feed.since === null;
    try {
      const since = this.feed.since ?? new Date(started - HOUR).toISOString();
      const page = await this.api.notifications({ since, last_modified: this.feed.last_modified });
      this.feed.interval = page.poll_interval;
      this.feedError = null;
      if (!page.modified) return;
      // A stack's member stored quietly isn't the desk's until a board lists it, as if it weren't held.
      const tracked = new Map([...desk.store.itemMeta()].filter(([, m]) => !m.quiet).map(([id, m]) => [id.toLowerCase(), { id, m }]));
      const refresh = new Map<string, SearchHit>();
      const mentions: NewEvent[] = [];
      const seen = { ...this.feed.seen };
      let unknown = 0;
      for (const t of page.threads) {
        const before = seen[t.thread];
        if (before?.at === t.updated_at) continue;
        seen[t.thread] = { at: t.updated_at, reason: t.reason };
        if (!t.item) continue;
        const known = tracked.get(t.item.toLowerCase());
        if (!known) {
          if (FRESH_REASONS.has(t.reason)) unknown++;
          continue;
        }
        if (t.updated_at > known.m.updated_at) refresh.set(known.id, hitOf(known.id, known.m));
        // The reason stays "mention" while the thread goes on; only a change to it is a new mention.
        if (!first && MENTIONS.has(t.reason) && before?.reason !== t.reason) {
          const at = t.updated_at < new Date(started).toISOString() ? t.updated_at : new Date(started).toISOString();
          mentions.push({ at, item_id: known.id, kind: "mentioned", actor: "", data: { reason: t.reason } });
        }
      }
      // Before the cursor moves: if this fails, the next poll sees these threads again.
      const items = refresh.size ? await this.api.details([...refresh.values()], desk.me()) : [];
      // A minute before GitHub's clock: threads updated meanwhile come back, and `seen` skips them.
      const now = Date.parse(page.date ?? "") || started;
      this.feed.since = new Date(now - 60_000).toISOString();
      this.feed.last_modified = page.last_modified;
      const horizon = new Date(now - 2 * 24 * HOUR).toISOString();
      this.feed.seen = Object.fromEntries(Object.entries(seen).filter(([, s]) => s.at >= horizon));
      desk.ingest(this, items);
      desk.record(this.id, mentions);
      if (items.length || mentions.length) desk.synced();
      if (page.threads.length)
        desk.log(
          `notifications: ${page.threads.length} updated, ${items.length} refreshed${unknown ? `, ${unknown} new to the desk` : ""}`,
        );
      if (unknown) void this.reconcile();
    } catch (e) {
      if (isRateLimited(e)) this.pausedUntil = Date.parse((e as { resetAt: string }).resetAt) || Date.now() + 15 * 60_000;
      else this.feedError = (e as Error).message;
      desk.log(`notifications failed: ${(e as Error).message}`);
    } finally {
      this.polling = false;
      if (!this.stopped) desk.store.set("github.feed", this.feed);
    }
  }

  events(prev: Item | null, next: Item): NewEvent[] {
    const d = this.desk;
    return itemEvents(prev, next, { me: d.me(), teams: d.ctx?.teams ?? [], bots: d.settings["github.bots"], now: d.now().toISOString() });
  }
}
