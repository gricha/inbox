// GitHub as a connector: board searches plus details (reconcile), the notifications feed, and the snapshot diff.
import { defaultConfigText, type LoadedConfig } from "../config.ts";
import type { Desk } from "../desk.ts";
import { Cause, Effect, Result } from "effect";
import {
  GitHubNotFetched,
  GitHubRateLimited,
  GitHubSearchesFailed,
  messageOf,
  NotFound,
  Upstream,
  type GitHubReadError,
} from "../errors.ts";
import type { GitHub, SearchHit } from "../github/index.ts";
import type { CompiledBoard } from "../rules.ts";
import { buildStacks, probeKey, toFetch, type Probe } from "../stacks.ts";
import type { ConnectorStatus, Context, Item } from "../types.ts";
import { KEEP_RESOLVED, type Connector, type Members, type NewEvent } from "./connector.ts";
import { itemEvents } from "./github-events.ts";
import { botCheck } from "../signals.ts";
import { report } from "../sentry.ts";

const HOUR = 3_600_000;
const MAX_QUERY = 256; // GitHub search rejects longer queries
const FEED_RETRY = 10 * 60_000;
// Notification reasons that mean an item the desk doesn't have yet may belong on it.
const FRESH_REASONS = new Set(["review_requested", "mention", "team_mention", "assign", "author"]);
const MENTIONS = new Set(["mention", "team_mention"]);
const BACKFILL = 40; // stored PRs a pass refetches for fields stacks and dependencies need that they were stored without
const PROBE_TTL = 30 * 60_000; // a stack probe isn't asked again before this; an off-board open member is refreshed after it
const MAX_PROBES = 120; // stack probes a pass
const RESERVE = 40; // of those, kept from probes that only look for a stack, for the rounds that follow a chain up
const STACK_ROUNDS = 3; // probe, fetch, probe again: a chain a few PRs deep fills in one pass
const DEP_TTL = 10 * 60_000; // a stored PR another one needs is refreshed after this
const MAX_DEP_PROBES = 20; // probes a pass for PRs a listed one needs that the desk doesn't hold, apart from the stacks'
const DEP_MISS_TTL = 24 * HOUR; // a number that's no PR (an issue, gone, no access) isn't asked again before this

const normRef = (ref: string) => ref.trim().replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+).*$/, "$1/$2#$3");
const REF = /^(?:(?:([\w.-]+)\/)?([\w.-]+)#|#)?(\d+)$/;

interface Feed {
  since: string | null; // ask for threads updated after this
  last_modified: string | null; // GitHub's Last-Modified, sent back as If-Modified-Since
  interval: number; // seconds, from X-Poll-Interval
  seen: Record<string, { at: string; reason: string }>; // thread id → the update already handled
}

const hitOf = (id: string, m: { node_id: string; kind: Item["kind"]; updated_at: string; author: string }): SearchHit => ({
  node_id: m.node_id,
  id,
  kind: m.kind,
  updated_at: m.updated_at,
  author: m.author,
});

// A pass's boundary: a failure or a bug goes to `handle`; the desk stopping never gets here, an inner interrupt records nothing.
const settle =
  (handle: (e: unknown) => void) =>
  <A, E>(self: Effect.Effect<A, E>): Effect.Effect<A | void> =>
    self.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.sync(() => {
              handle(Cause.squash(cause));
            }),
      ),
    );

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
  ctx: Context | null; // who you are, your teams, orgs and areas: kv `context`

  constructor(desk: Desk, api: GitHub) {
    this.desk = desk;
    this.api = api;
    this.ctx = desk.store.get("context") as Context | null;
    this.syncedAt = desk.store.get("synced_at") as string | null;
    this.feed = { since: null, last_modified: null, interval: 60, seen: {}, ...(desk.store.get("github.feed") as Partial<Feed> | null) };
  }

  // ---------------------------------------------------------------- loops

  start(): void {
    this.started = true;
    this.tick();
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

  tick(): void {
    this.loop("sync", this.reconcile(), () => {
      this.arm();
    });
  }

  arm(): void {
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(this.desk.settings["github.poll_seconds"] * 1000, this.pausedUntil - Date.now());
    this.timer = setTimeout(() => {
      this.tick();
    }, wait);
    this.timer.unref();
  }

  feedTick(): void {
    this.loop("notifications", this.poll(), () => {
      this.armFeed(this.feedError ? FEED_RETRY : this.feed.interval * 1000);
    });
  }

  armFeed(wait: number): void {
    if (this.feedTimer) clearTimeout(this.feedTimer);
    this.feedTimer = setTimeout(
      () => {
        this.feedTick();
      },
      Math.max(wait, this.pausedUntil - Date.now()),
    );
    this.feedTimer.unref();
  }

  // A loop's pass in the runner: a bug past its own boundary (the desk's hooks) is logged and reported, and it re-arms, as after an inner interrupt.
  loop(what: string, once: Effect.Effect<void>, again: () => void): void {
    this.desk.runner.fork(
      what,
      once.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.sync(() => {
                this.desk.log(`${what} failed: ${Cause.pretty(cause)}`);
                report(Cause.squash(cause), what);
              }),
        ),
        Effect.andThen(
          Effect.sync(() => {
            if (!this.stopped) again();
          }),
        ),
      ),
    );
  }

  pause(e: { resetAt: string }): void {
    this.pausedUntil = Date.parse(e.resetAt) || Date.now() + 15 * 60_000;
  }

  status(): ConnectorStatus {
    const status = this.syncing ? "syncing" : Date.now() < this.pausedUntil ? "paused" : this.error ? "error" : "ok";
    return { id: this.id, name: this.name, status, synced_at: this.syncedAt, error: this.error };
  }

  // ---------------------------------------------------------------- context and searches

  me(): string {
    return this.ctx?.me ?? "";
  }

  // Your context, when the desk has none; first: the first config.toml, its spaces from where your work is.
  init(first: boolean): Effect.Effect<string | null, GitHubReadError | Upstream> {
    return Effect.gen({ self: this }, function* () {
      if (!this.ctx) yield* this.refreshContext();
      if (!first) return null;
      // Don't guess the spaces from a failed fetch.
      if (!this.ctx || Date.parse(this.ctx.refreshed_at) < this.desk.now().getTime() - 24 * HOUR)
        return yield* new Upstream({
          message: `couldn't read your GitHub context to write a first config: ${this.contextError ?? "unknown error"}`,
        });
      const orgs = Object.entries(this.ctx.orgs)
        .filter(([o, n]) => o.toLowerCase() !== this.me().toLowerCase() && n >= 5)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 1)
        .map(([o]) => o);
      return defaultConfigText({ workOrgs: orgs });
    });
  }

  // Fails only when there's no context yet and GitHub won't say who you are; the rest falls back to what the desk had.
  refreshContext(): Effect.Effect<void, GitHubReadError> {
    return Effect.gen({ self: this }, function* () {
      const desk = this.desk;
      const me = this.ctx?.me ?? (yield* this.api.viewer());
      const got = yield* Effect.result(this.api.context(me));
      if (Result.isSuccess(got)) {
        this.ctx = { ...this.ctx, ...got.success, me, refreshed_at: desk.now().toISOString() };
        this.contextError = null;
      } else {
        this.contextError = got.failure.message;
        desk.log(`context refresh failed: ${this.contextError}`);
        // Retry in about an hour rather than on every poll.
        const retry = new Date(desk.now().getTime() - 23 * HOUR).toISOString();
        this.ctx = this.ctx
          ? { ...this.ctx, refreshed_at: retry }
          : { me, teams: [], affinity: {}, repo_prs: {}, orgs: {}, refreshed_at: new Date(0).toISOString() };
      }
      desk.store.set("context", this.ctx);
    });
  }

  // Daily, apart from the context: a failure keeps the last areas and tries again in about an hour.
  refreshAreas(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const desk = this.desk;
      const got = yield* Effect.result(this.api.areas());
      if (Result.isSuccess(got)) {
        if (this.ctx) this.ctx = { ...this.ctx, areas: got.success, areas_at: desk.now().toISOString() };
      } else {
        desk.log(`areas refresh failed: ${got.failure.message}`);
        if (this.ctx) this.ctx = { ...this.ctx, areas_at: new Date(desk.now().getTime() - 23 * HOUR).toISOString() };
      }
      desk.store.set("context", this.ctx);
    });
  }

  // Board query → expanded GitHub search string (null when it can't run, e.g. no collaborators yet).
  expandQuery(q: string, scope: string, loaded: LoadedConfig): string | null {
    const me = this.me();
    let base = `${q} ${scope}`.replaceAll("{me}", me).replaceAll(/\s+/g, " ").trim();
    if (!base.includes("{close_authors}")) return base;
    base = base.replace("{close_authors}", "").replaceAll(/\s+/g, " ").trim();
    const min = loaded.config.signals.close_collaborator_min;
    const isBot = botCheck(loaded.config.signals.bots);
    const authors = Object.entries(this.ctx?.affinity ?? {})
      .filter(([a, n]) => n >= min && a.toLowerCase() !== me.toLowerCase() && !isBot(a))
      .sort((a, b) => b[1] - a[1]);
    let out = base;
    for (const [a] of authors) {
      if (out.length + ` author:${a}`.length > MAX_QUERY) break;
      out += ` author:${a}`;
    }
    return out === base ? null : out;
  }

  queriesFor(
    loaded: LoadedConfig,
    board: CompiledBoard,
    scope = loaded.config.spaces.find((s) => s.id === board.config.space)?.scope ?? "",
  ): string[] {
    return board.config.queries.map((q) => this.expandQuery(q, scope, loaded)).filter((q): q is string => q !== null);
  }

  // Its searches' last hits. `kept` is every search's, not this board's: an unresolved item one keeps is on no board, Added's included.
  boardIds(board: CompiledBoard, scope: string, loaded: LoadedConfig): Members {
    const queries = this.queriesFor(loaded, board, scope);
    const hits = this.desk.store.hits(queries);
    const fetched = this.desk.store.queries();
    return {
      ids: new Set(queries.flatMap((q) => [...(hits.get(q) ?? [])])),
      kept: this.desk.store.kept(),
      queries,
      unfetched: queries.filter((q) => !fetched.has(q)),
      error: queries.map((q) => fetched.get(q)?.error).find(Boolean) ?? undefined,
    };
  }

  // ---------------------------------------------------------------- reconcile: every board search, then details

  // Never fails: what failed the pass is in status(), and a rate limit pauses both loops. One already running runs again after.
  reconcile(): Effect.Effect<void> {
    return Effect.suspend((): Effect.Effect<void> => {
      const desk = this.desk;
      if (!desk.loaded || this.stopped) return Effect.void;
      if (this.syncing) {
        this.syncAgain = true;
        return Effect.void;
      }
      if (Date.now() < this.pausedUntil) return Effect.void;
      this.syncing = true;
      desk.changed();
      return this.pass().pipe(
        settle((e) => {
          if (this.stopped) return;
          this.error = messageOf(e);
          if (e instanceof GitHubRateLimited) this.pause(e);
          else report(e, "sync");
          desk.log(`sync failed: ${this.error}`);
        }),
        Effect.ensuring(
          Effect.sync(() => {
            this.syncing = false;
          }),
        ),
        Effect.andThen(
          Effect.sync(() => {
            if (this.stopped) return;
            desk.synced();
            if (this.syncAgain) {
              this.syncAgain = false;
              desk.runner.fork("sync", this.reconcile());
            }
          }),
        ),
      );
    });
  }

  // The pass itself. Every search failing fails it, but only after what it could do (pinned items, the hits it kept) is stored.
  pass(): Effect.Effect<void, GitHubReadError | GitHubSearchesFailed> {
    return Effect.gen({ self: this }, function* () {
      const desk = this.desk;
      const now = desk.now();
      const iso = now.toISOString();
      if (!this.ctx || now.getTime() - Date.parse(this.ctx.refreshed_at) > 24 * HOUR) yield* this.refreshContext();
      if (now.getTime() - (Date.parse(this.ctx?.areas_at ?? "") || 0) > 24 * HOUR) yield* this.refreshAreas();
      const loaded = desk.loaded!; // reconcile checked it, and a reload never unsets it
      const me = this.me().toLowerCase();
      const own = loaded.boards.filter((b) => (b.config.source ?? this.id) === this.id);
      const queries = [...new Set(own.flatMap((b) => this.queriesFor(loaded, b)))];
      const listed = desk.store.hits(); // what each search returned last time
      const found = new Map<string, { ids: string[]; total: number }>();
      const hits = new Map<string, SearchHit>();
      const errors: { why: string; e: GitHubReadError }[] = []; // why: "<query>: <its words>"
      for (const q of queries) {
        const r = yield* this.api.search(q, 300).pipe(
          Effect.catch((e) =>
            e._tag === "GitHubRateLimited"
              ? Effect.fail(e)
              : Effect.sync(() => {
                  desk.store.setQueryError(q, e.message, iso);
                  errors.push({ why: `${q}: ${e.message}`, e });
                  return null;
                }),
          ),
        );
        if (!r) continue;
        found.set(q, { ids: r.hits.map((h) => h.id), total: r.total });
        for (const h of r.hits) hits.set(h.id, h);
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
      const items = need.length || drops.length ? yield* this.api.details([...need, ...drops], this.me()) : [];
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
      const [first] = errors;
      if (first && errors.length === queries.length)
        return yield* new GitHubSearchesFailed({ message: first.why.replace(/^.*?: (?=GitHub)/, ""), cause: first.e });
      desk.store.set("reconciled_at", iso);
      return yield* this.fillStacks(listedIds).pipe(
        Effect.andThen(({ fetched: filled, members }) =>
          Effect.sync(() => {
            desk.store.pruneItems(this.id, new Date(now.getTime() - 14 * 24 * HOUR).toISOString(), members);
            this.syncedAt = desk.now().toISOString(); // when it finished: "Synced 12s ago" means fresh data
            desk.store.set("synced_at", this.syncedAt);
            this.error = first ? `${errors.length} search(es) failed: ${first.why}` : null;
            const left = drops.length ? `, ${drops.length} left the searches` : "";
            const stacked = filled ? `, ${filled} for stacks` : "";
            desk.log(`synced ${queries.length} searches, ${hits.size} items, ${items.length} refreshed${left}${stacked}`);
          }),
        ),
      );
    });
  }

  // Stack members no board search returns (the PR below a stack's bottom, PRs stacked on one on the desk) and stored ones
  // gone stale, with the PRs listed ones need, fetched read only and stored without events: they're context, not news.
  // Returns how many, and the members of the listed PRs' stacks with the PRs they need, which pruning keeps.
  fillStacks(listed: Set<string>): Effect.Effect<{ fetched: number; members: Set<string> }, GitHubRateLimited> {
    const desk = this.desk;
    const at = desk.now();
    const since = (key: string, ttl: number) =>
      Object.fromEntries(
        Object.entries((desk.store.get(key) as Record<string, string> | null) ?? {}).filter(([, t]) => at.getTime() - Date.parse(t) < ttl),
      );
    const asked = since("stack_probes", PROBE_TTL);
    const misses = since("dep_misses", DEP_MISS_TTL);
    // What was asked counts even when a rate limit stops the rounds; the desk stopping keeps nothing.
    const persist = Effect.sync(() => {
      desk.store.set("stack_probes", asked);
      desk.store.set("dep_misses", misses);
    });
    const probe = (repo: string, ps: Probe[]) =>
      this.api.branchPrs(repo, ps).pipe(
        Effect.map((hits) => ({ ps, hits })),
        Effect.catch((e) =>
          e._tag === "GitHubRateLimited"
            ? Effect.fail(e)
            : Effect.sync(() => {
                desk.log(`stack probes in ${repo} failed: ${e.message}`);
                return { ps: [] as Probe[], hits: [] as SearchHit[] }; // nothing learned, so no misses
              }),
        ),
      );
    return Effect.gen({ self: this }, function* () {
      let budget = MAX_PROBES;
      let depBudget = MAX_DEP_PROBES;
      let fetched = 0;
      const members = new Set<string>();
      for (let round = 0; round < STACK_ROUNDS; round++) {
        const stored = desk.store.items();
        const before = new Date(at.getTime() - PROBE_TTL).toISOString();
        const depBefore = new Date(at.getTime() - DEP_TTL).toISOString();
        const got = toFetch(stored, buildStacks(stored), listed, before, depBefore, new Set(Object.keys(misses)));
        for (const id of got.members) members.add(id);
        const due = got.probes.filter((p) => !asked[probeKey(p)]);
        const deps = due.filter((p) => p.dir === "pr").slice(0, depBudget);
        const stacked = due.filter((p) => p.dir !== "pr" && p.stacked).slice(0, budget);
        const scan = due.filter((p) => p.dir !== "pr" && !p.stacked).slice(0, Math.max(0, budget - stacked.length - RESERVE));
        const old = round === 0 ? got.stale : [];
        if (!deps.length && !stacked.length && !scan.length && !old.length) break;
        budget -= stacked.length + scan.length;
        depBudget -= deps.length;
        const repos = new Map<string, Probe[]>();
        for (const p of [...deps, ...stacked, ...scan]) {
          asked[probeKey(p)] = at.toISOString();
          repos.set(p.repo, [...(repos.get(p.repo) ?? []), p]);
        }
        // 3 repos at a time; only a rate limit gets out, and stops the rest.
        const answers = yield* Effect.forEach([...repos], ([repo, ps]) => probe(repo, ps), { concurrency: 3 });
        const hits = answers.flatMap((a) => a.hits);
        const found = new Set(hits.map((h) => h.id.toLowerCase()));
        for (const p of answers.flatMap((a) => a.ps))
          if (p.dir === "pr" && !found.has(`${p.repo}#${p.branch}`.toLowerCase())) misses[probeKey(p)] = at.toISOString();
        const meta = desk.store.itemMeta();
        const want = new Map<string, SearchHit>();
        for (const h of hits) {
          const m = meta.get(h.id);
          if (!listed.has(h.id) && (m?.updated_at !== h.updated_at || m.lacks)) want.set(h.id, h);
        }
        for (const it of old) want.set(it.id, hitOf(it.id, it));
        if (!want.size) continue;
        const items = yield* this.api.details([...want.values()], this.me());
        desk.ingest(this, items, true);
        fetched += items.length;
      }
      return { fetched, members };
    }).pipe(
      Effect.tapCause(() => persist),
      Effect.tap(() => persist),
    );
  }

  // owner/repo#123, repo#123, #123, 123 or a GitHub URL; owner/repo#123 and a URL name one exactly, which fetchOne reads.
  refOf(text: string, held: readonly string[]): { held: string[]; id?: string } | null {
    const r = normRef(text);
    const m = REF.exec(r);
    if (!m) return null;
    const [, owner, name, num] = m;
    const found = held.filter((id) => {
      const [repo = "", n] = id.split("#");
      const [o = "", repoName = ""] = repo.split("/");
      return n === num && (!name || repoName.toLowerCase() === name.toLowerCase()) && (!owner || o.toLowerCase() === owner.toLowerCase());
    });
    return owner ? { held: found, id: r } : { held: found };
  }

  // Not stored quietly like a stack's members: you added it, so its events count and the notifications feed follows it.
  fetchOne(id: string): Effect.Effect<string, Upstream | NotFound> {
    const upstream = (e: GitHubReadError | GitHubNotFetched) => new Upstream({ message: e.message, cause: e });
    return Effect.gen({ self: this }, function* () {
      const at = id.lastIndexOf("#");
      const hit = yield* this.api.lookup(id.slice(0, at), Number(id.slice(at + 1))).pipe(Effect.mapError(upstream));
      if (!hit) return yield* new NotFound({ message: `GitHub has no PR or issue ${id}` });
      const [item] = yield* this.api.details([hit], this.me()).pipe(Effect.mapError(upstream));
      if (!item) return yield* upstream(new GitHubNotFetched({ id: hit.id })); // details skips a batch that failed
      this.desk.ingest(this, [item]);
      return item.id;
    });
  }

  // One item's details now, outside the loops: after you approve it, so it resolves in seconds, not at the next pass.
  // Never fails: a rate limit pauses the loops, anything else is logged and reported.
  refresh(id: string): Effect.Effect<void> {
    return Effect.suspend((): Effect.Effect<void> => {
      const desk = this.desk;
      const m = desk.store.itemMeta().get(id);
      if (!m || this.stopped || Date.now() < this.pausedUntil) return Effect.void;
      return Effect.gen({ self: this }, function* () {
        const items = yield* this.api.details([hitOf(id, m)], this.me());
        if (this.stopped) return;
        desk.ingest(this, items);
        desk.synced();
      }).pipe(
        settle((e) => {
          if (e instanceof GitHubRateLimited) this.pause(e);
          else report(e, "refresh", id);
          desk.log(`refresh of ${id} failed: ${messageOf(e)}`);
        }),
      );
    });
  }

  // ---------------------------------------------------------------- the change feed: notifications

  // Never fails: what failed is feedError (the next poll comes sooner), and a rate limit pauses both loops.
  poll(): Effect.Effect<void> {
    return Effect.suspend((): Effect.Effect<void> => {
      const desk = this.desk;
      if (this.stopped || this.polling || !desk.loaded || !this.ctx || Date.now() < this.pausedUntil) return Effect.void;
      this.polling = true;
      const started = desk.now().getTime();
      // The first poll only learns where the feed stands; a thread's old mention isn't news.
      const first = this.feed.since === null;
      return Effect.gen({ self: this }, function* () {
        const since = this.feed.since ?? new Date(started - HOUR).toISOString();
        const page = yield* this.api.notifications({ since, last_modified: this.feed.last_modified });
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
        const items = refresh.size ? yield* this.api.details([...refresh.values()], this.me()) : [];
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
        if (unknown) desk.runner.fork("sync", this.reconcile());
      }).pipe(
        settle((e) => {
          if (e instanceof GitHubRateLimited) this.pause(e);
          else {
            this.feedError = messageOf(e);
            report(e, "notifications");
          }
          desk.log(`notifications failed: ${messageOf(e)}`);
        }),
        Effect.ensuring(
          Effect.sync(() => {
            this.polling = false;
          }),
        ),
        Effect.andThen(
          Effect.sync(() => {
            if (!this.stopped) desk.store.set("github.feed", this.feed);
          }),
        ),
      );
    });
  }

  events(prev: Item | null, next: Item): NewEvent[] {
    const d = this.desk;
    return itemEvents(prev, next, {
      me: this.me(),
      teams: this.ctx?.teams ?? [],
      bots: d.settings["github.bots"],
      now: d.now().toISOString(),
    });
  }
}
