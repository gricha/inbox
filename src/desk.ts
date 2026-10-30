// The desk: sync loop, classification snapshot, views, and local actions.
import fs from "node:fs";
import path from "node:path";
import type { GitHub, SearchHit } from "./github/index.ts";
import type { GitHubWriter } from "./github/write.ts";
import type {
  Action,
  AgentStatus,
  AiReview,
  BoardSummary,
  BoardView,
  Bucket,
  Card,
  ConfigDoc,
  ConfigError,
  Context,
  FocusView,
  Item,
  ItemDetail,
  ItemState,
  Overview,
  Placement,
  PreviewResult,
  QueueView,
  ReviewFile,
  ReviewView,
  SettingsView,
  SettingValue,
  Signals,
  Status,
} from "./types.ts";
import { defaultConfigText, parseConfig, type LoadedConfig } from "./config.ts";
import { analyze, type Analysis } from "./signals.ts";
import { classify, type BoardResult, type CompiledBoard } from "./rules.ts";
import { renderTemplate } from "./expr.ts";
import { emptyState, Store, type StateRow } from "./store.ts";
import { inQuietHours, notify } from "./notify.ts";
import type { AgentOpts, PrText } from "./review.ts";
import * as agents from "./agents.ts";
import {
  checkSetting,
  effective,
  migrateLegacy,
  readSettings,
  SECTIONS,
  SETTINGS,
  settingDef,
  settingsPath,
  writeSettings,
  type Settings,
} from "./settings.ts";

const HOUR = 3_600_000;
const RANK: Record<Bucket, number> = { now: 0, today: 1, later: 2, fyi: 3, hide: 4 };
const MAX_QUERY = 256; // GitHub search rejects longer queries
const AI_AT_ONCE = 2;
const AI_RETRY = 30 * 60_000; // a failed AI review isn't retried on the same commit before this, unless you ask

export class DeskError extends Error {
  status: number;
  candidates?: string[];
  constructor(status: number, message: string, candidates?: string[]) {
    super(message);
    this.status = status;
    this.candidates = candidates;
  }
}

interface Entry {
  item: Item;
  analysis: Analysis;
  state: StateRow;
  status: Status;
  isNew: boolean;
}

interface Snapshot {
  rev: number;
  at: number;
  entries: Map<string, Entry>;
  reviews: Map<string, AiReview>;
  boards: Map<string, { result: BoardResult; queries: string[]; unfetched: string[]; error?: string }>;
  best: Map<string, Placement>; // best placement across boards, active items only
}

export interface DeskOptions {
  home: string;
  github: GitHub;
  now?: () => Date;
  notify?: (title: string, body: string) => void;
  log?: (msg: string) => void;
  review?: ReviewDeps; // diffs and AI reviews; without it the review view has no diff and no AI
  writer?: GitHubWriter; // approve; without it approving is off
}

export interface ReviewDeps {
  fetchPr(item: Item): Promise<PrText>;
  generate(item: Item, s: Signals, why: string, pr: PrText, opts: AgentOpts): Promise<AiReview>;
}

export class Desk {
  store: Store;
  github: GitHub;
  home: string;
  configPath: string;
  settingsPath: string;
  settings: Settings;
  settingsOverrides: Record<string, SettingValue> = {};
  settingsRaw: Record<string, unknown> | null = {};
  settingsErrors: ConfigError[] = [];
  settingsText = "";
  now: () => Date;
  notifyFn: (title: string, body: string) => void;
  log: (msg: string) => void;
  review: ReviewDeps | null;
  writer: GitHubWriter | null;

  loaded: LoadedConfig | null = null;
  configText = "";
  configErrors: ConfigError[] = [];
  configWarnings: ConfigError[] = [];
  ctx: Context | null = null;
  rev = 0;
  syncing = false;
  syncAgain = false;
  syncedAt: string | null = null;
  syncError: string | null = null;
  pausedUntil = 0;
  listeners = new Set<(rev: number) => void>();
  timer: NodeJS.Timeout | null = null;
  tick: (() => Promise<void>) | null = null;
  snap: Snapshot | null = null;
  stopped = false;
  generating = new Map<string, Promise<AiReview>>();
  aiErrors = new Map<string, { head_oid: string; message: string; at: number }>();
  fetching = new Map<string, Promise<PrText>>();
  approving = new Set<string>();
  contextError: string | null = null;

  constructor(opts: DeskOptions) {
    this.home = opts.home;
    this.github = opts.github;
    this.now = opts.now ?? (() => new Date());
    this.notifyFn = opts.notify ?? notify;
    this.log =
      opts.log ??
      ((m) => {
        console.error(`[desk] ${m}`);
      });
    this.review = opts.review ?? null;
    this.writer = opts.writer ?? null;
    fs.mkdirSync(this.home, { recursive: true });
    this.configPath = path.join(this.home, "config.toml");
    this.settingsPath = settingsPath(this.home);
    this.settings = this.readSettings();
    this.store = new Store(path.join(this.home, "desk.db"));
    this.ctx = this.store.get("context") as Context | null;
    this.syncedAt = this.store.get("synced_at") as string | null;
  }

  // ---------------------------------------------------------------- lifecycle

  async init(): Promise<void> {
    if (!this.ctx) await this.refreshContext();
    if (!fs.existsSync(this.configPath)) {
      // The default spaces come from where your work is; don't guess them from a failed fetch.
      if (!this.ctx || Date.parse(this.ctx.refreshed_at) < this.now().getTime() - 24 * HOUR)
        throw new Error(`couldn't read your GitHub context to write a first config: ${this.contextError ?? "unknown error"}`);
      const orgs = Object.entries(this.ctx?.orgs ?? {})
        .filter(([o, n]) => o.toLowerCase() !== this.me().toLowerCase() && n >= 5)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 1)
        .map(([o]) => o);
      fs.writeFileSync(this.configPath, defaultConfigText({ workOrgs: orgs }));
      this.log(`wrote ${this.configPath}`);
    }
    this.migrateSettings();
    this.reloadConfig();
    fs.watchFile(this.settingsPath, { interval: 2000 }, () => {
      const text = fs.existsSync(this.settingsPath) ? fs.readFileSync(this.settingsPath, "utf8") : "";
      if (text !== this.settingsText) this.reloadSettings();
    });
    fs.watchFile(this.configPath, { interval: 2000 }, (cur) => {
      if (cur.nlink === 0) return; // deleted or mid-rename; keep the loaded config
      if (fs.readFileSync(this.configPath, "utf8") !== this.configText) this.reloadConfig(true);
    });
  }

  start(): void {
    this.tick = async () => {
      await this.sync();
      if (!this.stopped) this.arm();
    };
    void this.tick();
  }

  arm(): void {
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(this.settings["github.poll_seconds"] * 1000, this.pausedUntil - Date.now());
    this.timer = setTimeout(() => void this.tick!(), wait);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    fs.unwatchFile(this.configPath);
    fs.unwatchFile(this.settingsPath);
    this.store.close();
  }

  onChange(fn: (rev: number) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  changed(): void {
    this.rev++;
    this.snap = null;
    for (const fn of this.listeners) fn(this.rev);
  }

  me(): string {
    return this.ctx?.me ?? "";
  }

  reloadConfig(sync = false): void {
    const text = fs.readFileSync(this.configPath, "utf8");
    const { loaded, errors, warnings } = parseConfig(text, this.settings);
    this.configText = text;
    this.configErrors = errors;
    this.configWarnings = warnings;
    if (loaded) this.loaded = loaded;
    else this.log(`config has ${errors.length} error(s); keeping the last good config`);
    this.changed();
    if (sync && loaded) void this.sync();
  }

  // ---------------------------------------------------------------- settings

  readSettings(): Settings {
    this.settingsText = fs.existsSync(this.settingsPath) ? fs.readFileSync(this.settingsPath, "utf8") : "";
    const { overrides, errors, raw } = readSettings(this.settingsPath);
    this.settingsOverrides = overrides;
    this.settingsRaw = raw;
    this.settingsErrors = errors;
    if (errors.length) this.log(`settings.json has ${errors.length} problem(s); using defaults for those`);
    return effective(overrides);
  }

  reloadSettings(): void {
    const poll = this.settings["github.poll_seconds"];
    this.settings = this.readSettings();
    // Sync now: bots and close_collaborator_min change the {close_authors} searches.
    if (this.configText) this.reloadConfig(true);
    else this.changed();
    if (this.tick && this.settings["github.poll_seconds"] !== poll) this.arm();
    this.pumpAi();
  }

  // Settings used to live in config.toml; move them to settings.json once.
  migrateSettings(): void {
    if (this.store.get("settings_migrated") || !fs.existsSync(this.configPath)) return;
    const text = fs.readFileSync(this.configPath, "utf8");
    const m = migrateLegacy(text);
    if (!m) return;
    if (this.settingsErrors.some((e) => e.path === "settings.json")) {
      this.log("settings.json can't be read; not moving settings out of config.toml until it's fixed");
      return;
    }
    const merged = { ...m.moved, ...this.settingsRaw };
    if (Object.keys(merged).length) writeSettings(this.settingsPath, merged);
    this.store.set("settings_migrated", this.now().toISOString());
    this.settings = this.readSettings();
    if (m.text === null) {
      this.log("config.toml still has settings sections; delete them (they now live in settings.json)");
      return;
    }
    const real = fs.realpathSync(this.configPath);
    fs.copyFileSync(real, `${real}.bak`);
    fs.writeFileSync(`${real}.tmp`, m.text);
    fs.renameSync(`${real}.tmp`, real);
    this.log(`moved settings from config.toml to ${this.settingsPath} (backup: config.toml.bak)`);
  }

  getSettings(): SettingsView {
    const ctx = this.ctx;
    const spaces = this.loaded?.config.spaces ?? [];
    return {
      path: this.settingsPath,
      sections: SECTIONS,
      defs: [...SETTINGS],
      values: this.settings,
      overridden: Object.keys(this.settingsOverrides),
      errors: this.settingsErrors,
      github: {
        login: this.me() || null,
        auth: process.env.GITHUB_TOKEN ? "GITHUB_TOKEN" : "gh CLI",
        error: this.syncError ?? this.contextError,
        synced_at: this.syncedAt,
        rate_limit: this.github.rateLimit(),
        teams: ctx?.teams ?? [],
        orgs: Object.entries(ctx?.orgs ?? {})
          .sort((a, b) => b[1] - a[1])
          .map(([org, items]) => ({ org, items, space: spaces.find((s) => s.scope.split(/\s+/).includes(`org:${org}`))?.name ?? null })),
      },
    };
  }

  // `set` changes values; `reset` drops keys back to their defaults. Nothing is written if any value is invalid.
  putSettings(patch: { set?: Record<string, unknown>; reset?: string[] }): { ok: boolean; errors: ConfigError[]; settings: SettingsView } {
    if (this.settingsErrors.some((e) => e.path === "settings.json")) {
      const message = "settings.json can't be read, so saving now would overwrite it. Fix or delete the file first.";
      return { ok: false, errors: [{ path: "settings.json", message }], settings: this.getSettings() };
    }
    const errors: ConfigError[] = [];
    for (const [k, v] of Object.entries(patch.set ?? {})) {
      const e = checkSetting(k, v);
      if (e) errors.push({ path: k, message: e });
    }
    for (const k of patch.reset ?? []) if (!settingDef(k)) errors.push({ path: k, message: `unknown setting "${k}"` });
    if (errors.length) return { ok: false, errors, settings: this.getSettings() };
    // Start from the file as written, so entries that are invalid or unknown survive the save.
    const next = { ...this.settingsRaw };
    for (const [k, v] of Object.entries(patch.set ?? {})) {
      if (JSON.stringify(v) === JSON.stringify(settingDef(k)!.default)) delete next[k];
      else next[k] = v;
    }
    for (const k of patch.reset ?? []) delete next[k];
    writeSettings(this.settingsPath, next);
    this.reloadSettings();
    return { ok: true, errors: [], settings: this.getSettings() };
  }

  // ---------------------------------------------------------------- agents

  agentStatus(mcpUrl: string): AgentStatus {
    return agents.status(this.settings["agent.driver"], mcpUrl);
  }

  async connectAgent(mcpUrl: string): Promise<AgentStatus> {
    try {
      return await agents.connect(this.settings["agent.driver"], mcpUrl);
    } catch (e) {
      throw new DeskError(502, (e as Error).message);
    }
  }

  // ---------------------------------------------------------------- sync

  async refreshContext(): Promise<void> {
    const me = this.ctx?.me ?? (await this.github.viewer());
    try {
      const c = await this.github.context(me);
      this.ctx = { ...c, me, refreshed_at: this.now().toISOString() };
      this.contextError = null;
    } catch (e) {
      this.contextError = (e as Error).message;
      this.log(`context refresh failed: ${this.contextError}`);
      // Retry in about an hour rather than on every poll.
      const retry = new Date(this.now().getTime() - 23 * HOUR).toISOString();
      this.ctx = this.ctx
        ? { ...this.ctx, refreshed_at: retry }
        : { me, teams: [], affinity: {}, repo_prs: {}, orgs: {}, refreshed_at: new Date(0).toISOString() };
    }
    this.store.set("context", this.ctx);
  }

  // Board query → expanded GitHub search strings (null when it can't run, e.g. no collaborators yet).
  expandQuery(q: string, scope: string, loaded = this.loaded): string | null {
    let base = `${q} ${scope}`.replaceAll("{me}", this.me()).replaceAll(/\s+/g, " ").trim();
    if (!base.includes("{close_authors}")) return base;
    base = base.replace("{close_authors}", "").replaceAll(/\s+/g, " ").trim();
    const min = loaded?.config.signals.close_collaborator_min ?? 3;
    const bots = new Set((loaded?.config.signals.bots ?? []).map((b) => b.toLowerCase()));
    const authors = Object.entries(this.ctx?.affinity ?? {})
      .filter(([a, n]) => n >= min && a.toLowerCase() !== this.me().toLowerCase() && !bots.has(a.toLowerCase()) && !a.endsWith("[bot]"))
      .sort((a, b) => b[1] - a[1]);
    let out = base;
    for (const [a] of authors) {
      if (out.length + ` author:${a}`.length > MAX_QUERY) break;
      out += ` author:${a}`;
    }
    return out === base ? null : out;
  }

  async sync(): Promise<void> {
    if (!this.loaded || this.stopped) return;
    if (this.syncing) {
      this.syncAgain = true;
      return;
    }
    if (Date.now() < this.pausedUntil) return;
    this.syncing = true;
    this.changed();
    try {
      const now = this.now();
      if (!this.ctx || now.getTime() - Date.parse(this.ctx.refreshed_at) > 24 * HOUR) await this.refreshContext();
      const me = this.me().toLowerCase();
      const loaded = this.loaded;
      const queries = [...new Set(loaded.boards.flatMap((b) => this.boardQueriesFor(loaded, b)))];
      const hits = new Map<string, SearchHit>();
      const errors: string[] = [];
      for (const q of queries) {
        try {
          const r = await this.github.search(q, 300);
          this.store.setHits(
            q,
            r.hits.map((h) => h.id),
            r.total,
            now.toISOString(),
          );
          for (const h of r.hits) hits.set(h.id, h);
        } catch (e) {
          if (isRateLimited(e)) throw e;
          this.store.setQueryError(q, (e as Error).message, now.toISOString());
          errors.push(`${q}: ${(e as Error).message}`);
        }
      }
      const meta = this.store.itemMeta();
      const need = [...hits.values()].filter((h) => {
        const m = meta.get(h.id);
        if (!m || m.updated_at !== h.updated_at) return true;
        const ttl = h.author.toLowerCase() === me ? 3 * 60_000 : 30 * 60_000;
        return now.getTime() - Date.parse(m.detail_at) > ttl;
      });
      const items = need.length ? await this.github.details(need, this.me()) : [];
      this.store.putItems(items, now.toISOString());
      this.store.touchItems([...hits.keys()], now.toISOString());
      this.store.pruneItems(new Date(now.getTime() - 14 * 24 * HOUR).toISOString());
      const kept = new Set(this.store.itemMeta().keys());
      this.store.pruneKv("review:", kept);
      this.store.pruneKv("pr:", kept);
      this.store.pruneKv("brief:", new Set()); // the AI review replaced briefs
      if (!this.store.get("baseline_at")) this.store.set("baseline_at", now.toISOString());
      const [firstError] = errors;
      if (errors.length === queries.length && firstError !== undefined) throw new Error(firstError.replace(/^.*?: (?=GitHub)/, ""));
      this.syncedAt = this.now().toISOString(); // when it finished: "Synced 12s ago" means fresh data
      this.store.set("synced_at", this.syncedAt);
      this.syncError = errors.length ? `${errors.length} search(es) failed: ${errors[0]}` : null;
      this.log(`synced ${queries.length} searches, ${hits.size} items, ${items.length} refreshed`);
    } catch (e) {
      if (this.stopped) return;
      this.syncError = (e as Error).message;
      if (isRateLimited(e)) this.pausedUntil = Date.parse((e as { resetAt: string }).resetAt) || Date.now() + 15 * 60_000;
      this.log(`sync failed: ${this.syncError}`);
    } finally {
      this.syncing = false;
      if (!this.stopped) this.afterSync();
    }
  }

  afterSync(): void {
    this.changed();
    this.notifyNewNow();
    this.pumpAi();
    if (this.syncAgain) {
      this.syncAgain = false;
      void this.sync();
    }
  }

  notifyNewNow(): void {
    const cfg = this.loaded?.config;
    if (!cfg || !this.syncedAt) return;
    const now = this.focus().sections.now;
    const prev = this.store.get("notified_now") as string[] | null;
    this.store.set(
      "notified_now",
      now.map((c) => c.id),
    );
    if (prev === null || !cfg.notify.enabled || inQuietHours(cfg.notify.quiet, this.now())) return;
    const fresh = now.filter((c) => !prev.includes(c.id));
    if (!fresh.length) return;
    const [only] = fresh;
    const body =
      fresh.length === 1 && only ? `${shortRef(only)} · ${only.why}` : `${fresh.length} new in Now: ${fresh.map(shortRef).join(", ")}`;
    this.notifyFn("Review Desk", body);
  }

  // ---------------------------------------------------------------- classification

  snapshot(): Snapshot {
    const nowMs = this.now().getTime();
    if (this.snap && this.snap.rev === this.rev && nowMs - this.snap.at < 30_000) return this.snap;
    this.snap = this.compute(this.loaded!, this.rev);
    return this.snap;
  }

  compute(loaded: LoadedConfig, rev: number): Snapshot {
    const now = this.now();
    const ctx = this.ctx ?? { me: "", teams: [], affinity: {}, repo_prs: {}, orgs: {}, refreshed_at: "" };
    const states = this.store.states();
    const baseline = (this.store.get("baseline_at") as string | null) ?? now.toISOString();
    const entries = new Map<string, Entry>();
    for (const item of this.store.items()) {
      const analysis = analyze(item, ctx, loaded.config, now);
      const state = states.get(item.id) ?? emptyState(item.id);
      const isNew = analysis.others_at !== null && analysis.others_at > (state.seen_at ?? baseline);
      entries.set(item.id, { item, analysis, state, status: statusOf(state, analysis.activity_at, now), isNew });
    }

    const hits = this.store.hits();
    const fetched = this.store.queries();
    const boards: Snapshot["boards"] = new Map();
    const best = new Map<string, Placement>();
    for (const board of loaded.boards) {
      const queries = this.boardQueriesFor(loaded, board);
      const ids = new Set<string>();
      for (const q of queries) for (const id of hits.get(q) ?? []) ids.add(id);
      const list = [...ids].map((id) => entries.get(id)).filter((e): e is Entry => e !== undefined);
      const result = classify(
        board,
        list.map((e) => ({
          id: e.item.id,
          signals: e.analysis.signals,
          waiting_since: e.analysis.waiting_since,
          updated_at: e.item.updated_at,
          created_at: e.item.created_at,
          activity_at: e.analysis.activity_at,
          pinned: e.state.pinned,
          active: e.status === "active",
        })),
      );
      const error = queries.map((q) => fetched.get(q)?.error).find(Boolean) ?? undefined;
      boards.set(board.config.id, { result, queries, unfetched: queries.filter((q) => !fetched.has(q)), error });
      for (const [id, p] of result.placements) {
        if (entries.get(id)!.status !== "active") continue;
        const cur = best.get(id);
        if (!cur || RANK[p.bucket] < RANK[cur.bucket]) best.set(id, p);
      }
    }
    return { rev, at: now.getTime(), entries, reviews: this.store.prefixed<AiReview>("review:"), boards, best };
  }

  boardQueriesFor(loaded: LoadedConfig, board: CompiledBoard): string[] {
    const scope = loaded.config.spaces.find((s) => s.id === board.config.space)?.scope ?? "";
    return board.config.queries.map((q) => this.expandQuery(q, scope, loaded)).filter((q): q is string => q !== null);
  }

  card(e: Entry, p: Placement | null, snap: Snapshot): Card {
    const it = e.item;
    const boards = [...snap.boards].filter(([, b]) => b.result.placements.has(it.id)).map(([id]) => id);
    const chips: string[] = [];
    if (it.kind === "issue") chips.push("issue");
    if (it.draft) chips.push("draft");
    if (it.ci === "red") chips.push("CI red");
    if (it.mergeable === "conflict") chips.push("conflict");
    if (it.review_decision === "changes_requested") chips.push("changes requested");
    if (it.review_decision === "approved") chips.push("approved");
    if (it.threads_unresolved > 0) chips.push(`${it.threads_unresolved} unresolved`);
    if (it.kind === "pr") chips.push(`+${it.additions} −${it.deletions}`);
    return {
      id: it.id,
      kind: it.kind,
      repo: it.repo,
      number: it.number,
      title: it.title,
      url: it.url,
      author: it.author,
      author_bot: e.analysis.signals.author.bot,
      bucket: p?.bucket ?? "fyi",
      why: p?.why ?? "",
      demoted: p?.demoted,
      board: p?.board ?? "",
      boards,
      chips,
      ci: it.ci,
      review: it.review_decision,
      draft: it.draft,
      size: it.additions + it.deletions,
      created_at: it.created_at,
      updated_at: it.updated_at,
      activity_at: e.analysis.activity_at,
      waiting_since: e.analysis.waiting_since,
      new: e.isNew,
      pinned: e.state.pinned,
      status: e.status,
      snooze_until: e.status === "snoozed" ? e.state.snooze_until : null,
      verdict: snap.reviews.get(it.id)?.head_oid === it.head_oid ? snap.reviews.get(it.id)!.verdict : null,
    };
  }

  // ---------------------------------------------------------------- views

  requireConfig(): LoadedConfig {
    if (!this.loaded) throw new DeskError(503, `config has errors: ${this.configErrors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
    return this.loaded;
  }

  summary(id: string, snap: Snapshot): BoardSummary {
    const cfg = this.requireConfig().config.boards.find((b) => b.id === id)!;
    const b = snap.boards.get(id)!;
    const counts = { now: 0, today: 0, later: 0, fyi: 0, hide: 0, cleared: b.result.inactive.length };
    let fresh = 0;
    for (const bucket of Object.keys(b.result.order) as Bucket[]) {
      counts[bucket] = b.result.order[bucket].length;
      if (bucket !== "hide") fresh += b.result.order[bucket].filter((x) => snap.entries.get(x)!.isNew).length;
    }
    return { id, name: cfg.name, space: cfg.space, counts, new: fresh, error: b.error };
  }

  overview(): Overview {
    const loaded = this.requireConfig();
    const snap = this.snapshot();
    const focus = this.focus();
    return {
      me: this.me(),
      synced_at: this.syncedAt,
      syncing: this.syncing,
      sync_error: this.syncError,
      config_errors: this.configErrors,
      spaces: loaded.config.spaces.map((s) => ({
        id: s.id,
        name: s.name,
        boards: loaded.config.boards.filter((b) => b.space === s.id).map((b) => this.summary(b.id, snap)),
      })),
      focus: {
        now: focus.sections.now.length,
        today: focus.sections.today.length,
        new: [...focus.sections.now, ...focus.sections.today].filter((c) => c.new).length,
      },
      rate_limit: this.github.rateLimit(),
    };
  }

  focus(): FocusView {
    const loaded = this.requireConfig();
    const snap = this.snapshot();
    const seen = new Set<string>();
    const sections: FocusView["sections"] = { now: [], today: [] };
    for (const bucket of ["now", "today"] as const) {
      for (const board of loaded.boards) {
        for (const id of snap.boards.get(board.config.id)!.result.order[bucket]) {
          const p = snap.best.get(id);
          if (seen.has(id) || !p || p.bucket !== bucket || p.board !== board.config.id) continue;
          seen.add(id);
          sections[bucket].push(this.card(snap.entries.get(id)!, p, snap));
        }
      }
    }
    return { sections };
  }

  // The single surface: every item once, at its best placement across boards.
  queue(): QueueView {
    const loaded = this.requireConfig();
    const snap = this.snapshot();
    const seen = new Set<string>();
    const sections: QueueView["sections"] = { now: [], today: [], later: [], fyi: [] };
    const hidden: Card[] = [];
    for (const bucket of ["now", "today", "later", "fyi", "hide"] as const) {
      for (const board of loaded.boards) {
        for (const id of snap.boards.get(board.config.id)!.result.order[bucket]) {
          const p = snap.best.get(id);
          if (seen.has(id) || !p || p.bucket !== bucket || p.board !== board.config.id) continue;
          seen.add(id);
          (bucket === "hide" ? hidden : sections[bucket]).push(this.card(snap.entries.get(id)!, p, snap));
        }
      }
    }
    const cleared: Card[] = [];
    for (const board of loaded.boards) {
      const b = snap.boards.get(board.config.id)!;
      for (const id of b.result.inactive) {
        if (seen.has(id)) continue;
        seen.add(id);
        cleared.push(this.card(snap.entries.get(id)!, b.result.placements.get(id)!, snap));
      }
    }
    return { sections, hidden, cleared };
  }

  board(id: string): BoardView {
    const loaded = this.requireConfig();
    if (!loaded.config.boards.some((b) => b.id === id)) throw new DeskError(404, `no board "${id}"`);
    const snap = this.snapshot();
    const b = snap.boards.get(id)!;
    const cards = (ids: string[]) => ids.map((x) => this.card(snap.entries.get(x)!, b.result.placements.get(x)!, snap));
    return {
      board: { ...this.summary(id, snap), queries: b.queries },
      sections: {
        now: cards(b.result.order.now),
        today: cards(b.result.order.today),
        later: cards(b.result.order.later),
        fyi: cards(b.result.order.fyi),
      },
      hidden: cards(b.result.order.hide),
      cleared: cards(b.result.inactive),
    };
  }

  resolve(ref: string): string {
    this.requireConfig();
    const ids = [...this.snapshot().entries.keys()];
    if (ids.includes(ref)) return ref;
    const r = ref.trim().replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+).*$/, "$1/$2#$3");
    const m = /^(?:(?:([\w.-]+)\/)?([\w.-]+)#|#)?(\d+)$/.exec(r);
    if (!m) throw new DeskError(404, `can't read "${ref}"; use owner/repo#123, repo#123 or a GitHub URL`);
    const [, owner, name, num] = m;
    const found = ids.filter((id) => {
      const [repo = "", n] = id.split("#");
      const [o = "", repoName = ""] = repo.split("/");
      return n === num && (!name || repoName.toLowerCase() === name.toLowerCase()) && (!owner || o.toLowerCase() === owner.toLowerCase());
    });
    const [first] = found;
    if (found.length === 1 && first !== undefined) return first;
    if (found.length === 0) throw new DeskError(404, `no item "${ref}" on the desk`);
    throw new DeskError(409, `"${ref}" matches ${found.length} items`, found);
  }

  item(ref: string): ItemDetail {
    const loaded = this.requireConfig();
    const snap = this.snapshot();
    const id = this.resolve(ref);
    const e = snap.entries.get(id)!;
    const placements = loaded.boards
      .map((b) => snap.boards.get(b.config.id)!.result.placements.get(id))
      .filter((p): p is Placement => p !== undefined);
    const best = snap.best.get(id) ?? placements.slice().sort((a, b) => RANK[a.bucket] - RANK[b.bucket])[0] ?? null;
    const { snoozed_at: _, acked_at: __, ...state } = e.state;
    return {
      card: this.card(e, best, snap),
      item: e.item,
      signals: e.analysis.signals,
      placements,
      state,
      handoff_prompt: renderTemplate(
        e.item.kind === "issue"
          ? loaded.config.handoff.issue
          : e.analysis.signals.me.author
            ? loaded.config.handoff.mine
            : loaded.config.handoff.prompt,
        e.analysis.signals,
      ),
      ai: snap.reviews.get(id) ?? null,
      ai_stale: (snap.reviews.get(id)?.head_oid ?? e.item.head_oid) !== e.item.head_oid,
      generating: this.generating.has(id),
    };
  }

  // ---------------------------------------------------------------- review

  pr(ref: string): Entry {
    this.requireConfig();
    const e = this.snapshot().entries.get(this.resolve(ref))!;
    if (e.item.kind !== "pr") throw new DeskError(400, `${e.item.id} is an issue; reviews are for pull requests`);
    return e;
  }

  // GET /api/review/:id. Opening a PR asks for its AI review when auto_ai is on and there's none for this commit.
  async reviewView(ref: string): Promise<ReviewView> {
    const id = this.pr(ref).item.id;
    let files: ReviewFile[] = [];
    let filesError: string | null = null;
    try {
      files = (await this.prText(id)).files;
    } catch (err) {
      filesError = (err as Error).message;
    }
    const snap = this.snapshot();
    const e = snap.entries.get(id)!;
    if (this.settings["review.auto_ai"] && this.wantsAi(e, snap)) void this.generate(id).catch(() => {});
    const d = this.item(id);
    const err = this.aiErrors.get(id);
    return {
      card: d.card,
      item: d.item,
      handoff_prompt: d.handoff_prompt,
      files,
      files_error: filesError,
      ai: d.ai,
      ai_stale: d.ai_stale,
      ai_error: err?.head_oid === e.item.head_oid && !this.generating.has(id) ? err.message : null,
      generating: this.generating.has(id),
      approve: this.canApprove(e),
    };
  }

  // The changed files and description, kept per head commit.
  prText(id: string): Promise<PrText> {
    const review = this.review;
    if (!review) return Promise.reject(new Error("diffs aren't available in this desk"));
    const item = this.snapshot().entries.get(id)!.item;
    const cached = this.store.get(`pr:${id}`) as (PrText & { head_oid: string }) | null;
    if (cached?.head_oid === item.head_oid) return Promise.resolve(cached);
    const running = this.fetching.get(id);
    if (running) return running;
    const p = review
      .fetchPr(item)
      .then((t) => {
        if (!this.stopped) this.store.set(`pr:${id}`, { ...t, head_oid: item.head_oid });
        return t;
      })
      .finally(() => {
        this.fetching.delete(id);
      });
    this.fetching.set(id, p);
    return p;
  }

  // POST /api/review/:id/ai (and desk_brief, `desk brief`): the cached review for this commit unless `force`.
  async aiReview(ref: string, force = false): Promise<AiReview> {
    const e = this.pr(ref);
    const cached = this.snapshot().reviews.get(e.item.id);
    if (cached && cached.head_oid === e.item.head_oid && !force) return cached;
    try {
      return await this.generate(e.item.id);
    } catch (err) {
      throw new DeskError(502, (err as Error).message);
    }
  }

  // One run per PR at a time; asking again joins it.
  generate(id: string): Promise<AiReview> {
    const running = this.generating.get(id);
    if (running) return running;
    const p = this.runAi(id);
    this.generating.set(id, p);
    this.changed();
    // Awaits p before any caller can, so the slot is free by the time they resume.
    void (async () => {
      let ok = true;
      try {
        await p;
      } catch {
        ok = false;
      }
      this.generating.delete(id);
      if (this.stopped) return;
      this.changed();
      if (ok) this.pumpAi(); // after a failure, wait for the next sync
    })();
    return p;
  }

  async runAi(id: string): Promise<AiReview> {
    const snap = this.snapshot();
    const e = snap.entries.get(id)!;
    try {
      if (!this.review) throw new Error("AI review isn't available in this desk");
      const pr = await this.prText(id);
      const s = this.settings;
      const ai = await this.review.generate(e.item, e.analysis.signals, snap.best.get(id)?.why ?? "", pr, {
        driver: s["agent.driver"],
        command: s["analyze.command"],
        model: s["analyze.model"],
      });
      if (this.stopped) return ai;
      this.store.set(`review:${id}`, ai);
      this.aiErrors.delete(id);
      this.log(`AI review of ${id}: ${ai.verdict}, ${ai.concerns.length} concerns, ${ai.notes.length} notes`);
      return ai;
    } catch (err) {
      this.aiErrors.set(id, { head_oid: e.item.head_oid, message: (err as Error).message, at: Date.now() });
      this.log(`AI review of ${id} failed: ${(err as Error).message}`);
      throw err;
    }
  }

  // Someone else's open PR with no AI review of its head yet, and no recent failure on it.
  wantsAi(e: Entry, snap: Snapshot): boolean {
    const it = e.item;
    if (it.kind !== "pr" || it.state !== "open" || e.analysis.signals.me.author || this.generating.has(it.id)) return false;
    if (snap.reviews.get(it.id)?.head_oid === it.head_oid) return false;
    const err = this.aiErrors.get(it.id);
    return !(err && err.head_oid === it.head_oid && Date.now() - err.at < AI_RETRY);
  }

  // Background AI reviews for what's in Now and Today, a couple at a time. After a failure it waits for the next sync.
  pumpAi(): void {
    if (!this.review || this.stopped || !this.loaded || !this.settings["review.auto_ai"] || this.settings["agent.driver"] === "none")
      return;
    if (this.generating.size >= AI_AT_ONCE) return;
    const f = this.focus();
    const snap = this.snapshot();
    for (const c of [...f.sections.now, ...f.sections.today]) {
      if (this.generating.size >= AI_AT_ONCE) return;
      const e = snap.entries.get(c.id);
      if (e && this.wantsAi(e, snap)) void this.generate(c.id).catch(() => {});
    }
  }

  canApprove(e: Entry): ReviewView["approve"] {
    const it = e.item;
    const me = this.me().toLowerCase();
    const no = (reason: string) => ({ ok: false, reason });
    if (e.analysis.signals.me.author) return no("it's your PR");
    if (it.state !== "open") return no(`it's ${it.state}`);
    const mine = it.reviews.findLast((r) => r.author.toLowerCase() === me);
    if (mine?.state === "approved" && mine.commit === it.head_oid) return no("you approved this commit");
    if (!this.writer) return no("approving isn't available in this desk");
    return { ok: true, reason: null };
  }

  // POST /api/review/:id/approve: the desk's one GitHub write, on your keypress in the review view.
  async approve(ref: string, body?: string): Promise<{ url: string }> {
    const e = this.pr(ref);
    const id = e.item.id;
    const can = this.canApprove(e);
    if (!can.ok) throw new DeskError(409, `can't approve ${id}: ${can.reason}`);
    if (this.approving.has(id)) throw new DeskError(409, `already approving ${id}`);
    this.approving.add(id);
    let url: string;
    try {
      ({ url } = await this.writer!.approve(e.item.node_id, body));
    } catch (err) {
      throw new DeskError(502, `GitHub didn't take the approval: ${(err as Error).message}`);
    } finally {
      this.approving.delete(id);
    }
    this.store.logWrite(id, "approve", this.now().toISOString());
    this.log(`approved ${id} on GitHub${url ? ` (${url})` : ""}`);
    this.changed();
    void this.sync(); // so the approval shows and the item can resolve
    return { url };
  }

  // ---------------------------------------------------------------- actions

  act(ref: string, action: Action, until?: string): { state: ItemState; undo_seq: number } {
    const id = this.resolve(ref);
    if (action === "undo") {
      const ev = this.store.lastActionFor(id);
      if (!ev) throw new DeskError(404, `nothing to undo for ${id}`);
      return { state: this.undo(ev.seq).state, undo_seq: 0 };
    }
    const now = this.now();
    const before = this.store.state(id);
    const s: StateRow = { ...before };
    // Resurface on activity newer than what you saw, not newer than the click: a sync may land just after it.
    const seen = this.snapshot().entries.get(id)!.analysis.activity_at;
    switch (action) {
      case "done":
        s.done_at = now.toISOString();
        s.acked_at = seen;
        s.snooze_until = null;
        s.snoozed_at = null;
        break;
      case "snooze": {
        const u = until ?? "tomorrow";
        if (u === "activity") {
          s.done_at = now.toISOString();
          s.acked_at = seen;
          s.snooze_until = null;
          break;
        }
        s.snooze_until = parseUntil(u, now).toISOString();
        s.snoozed_at = now.toISOString();
        s.acked_at = seen;
        s.snooze_on_activity = true;
        s.done_at = null;
        break;
      }
      case "mute":
        s.muted = true;
        break;
      case "unmute":
        s.muted = false;
        break;
      case "pin":
        s.pinned = true;
        break;
      case "unpin":
        s.pinned = false;
        break;
      case "seen":
        s.seen_at = now.toISOString();
        break;
      case "restore":
        s.done_at = null;
        s.snooze_until = null;
        s.snoozed_at = null;
        s.muted = false;
        break;
      default:
        throw new DeskError(400, `unknown action "${action as string}"`); // reachable: the HTTP body isn't checked against Action
    }
    this.store.putState(s);
    const seq = action === "seen" ? 0 : this.store.logAction(id, action, before, now.toISOString());
    this.changed();
    const { snoozed_at: _, acked_at: __, ...state } = s;
    return { state, undo_seq: seq };
  }

  undo(seq?: number): { id: string; state: ItemState; action: Action } {
    const ev = this.store.lastAction(seq);
    if (!ev) throw new DeskError(404, "nothing to undo");
    if (this.store.hasLaterAction(ev.item_id, ev.seq)) throw new DeskError(409, `undo the later action on ${ev.item_id} first`);
    const cur = this.store.state(ev.item_id);
    this.store.putState({ ...ev.before, seen_at: cur.seen_at });
    this.store.markUndone(ev.seq);
    this.changed();
    const { snoozed_at: _, acked_at: __, ...state } = ev.before;
    return { id: ev.item_id, state, action: ev.action as Action };
  }

  // ---------------------------------------------------------------- config

  getConfig(): ConfigDoc {
    return { path: this.configPath, text: this.configText, errors: this.configErrors, warnings: this.configWarnings };
  }

  preview(text: string): PreviewResult {
    const { loaded, errors, warnings } = parseConfig(text, this.settings);
    if (!loaded) return { errors, warnings, boards: [] };
    const cur = this.loaded ? this.snapshot() : null;
    const next = this.compute(loaded, -1);
    const fetched = this.store.queries();
    return {
      errors,
      warnings,
      boards: loaded.boards.map((b) => {
        const id = b.config.id;
        const after = next.boards.get(id)!;
        const before = cur?.boards.get(id);
        const counts = countsOf(after.result);
        const moved: PreviewResult["boards"][number]["moved"] = [];
        for (const bucket of Object.keys(after.result.order) as Bucket[]) {
          for (const x of after.result.order[bucket]) {
            const prev = before?.result.placements.get(x)?.bucket ?? null;
            if (prev !== bucket) moved.push({ id: x, title: next.entries.get(x)!.item.title, from: prev, to: bucket });
          }
        }
        return {
          id,
          name: b.config.name,
          counts,
          before: before ? countsOf(before.result) : null,
          moved: moved.slice(0, 50),
          unfetched: after.queries.filter((q) => !fetched.has(q)),
        };
      }),
    };
  }

  putConfig(text: string, base?: string): { ok: boolean; errors: ConfigError[]; warnings: ConfigError[] } {
    if (base !== undefined && base !== this.configText)
      throw new DeskError(409, "config.toml changed on disk since you opened it; reload to see it, then reapply your edit");
    const { loaded, errors, warnings } = parseConfig(text, this.settings);
    if (!loaded) return { ok: false, errors, warnings };
    const real = fs.realpathSync(this.configPath); // keep a symlinked config a symlink
    fs.writeFileSync(`${real}.tmp`, text);
    fs.renameSync(`${real}.tmp`, real);
    this.reloadConfig(true);
    return { ok: true, errors: [], warnings };
  }

  status(): { now: number; today: number; new: number; text: string } {
    const f = this.overview().focus;
    const parts = [f.now ? `●${f.now}` : "", f.today ? `◐${f.today}` : "", f.new ? `+${f.new}` : ""].filter(Boolean);
    return { ...f, text: f.now || f.today ? `desk ${parts.join(" ")}` : "" };
  }
}

function countsOf(r: BoardResult): Record<Bucket, number> {
  return {
    now: r.order.now.length,
    today: r.order.today.length,
    later: r.order.later.length,
    fyi: r.order.fyi.length,
    hide: r.order.hide.length,
  };
}

function statusOf(s: StateRow, activityAt: string, now: Date): Status {
  if (s.muted) return "muted";
  if (s.done_at && activityAt <= (s.acked_at ?? s.done_at)) return "done";
  if (s.snooze_until && now.toISOString() < s.snooze_until && !(s.snooze_on_activity && activityAt > (s.acked_at ?? s.snoozed_at ?? "")))
    return "snoozed";
  return "active";
}

function isRateLimited(e: unknown): boolean {
  return (e as Error)?.name === "RateLimitedError" || (typeof e === "object" && e !== null && "resetAt" in e);
}

function shortRef(c: { repo: string; number: number }): string {
  return `${c.repo.split("/")[1]}#${c.number}`;
}

export function parseUntil(until: string, now: Date): Date {
  const rel = /^(\d+)([hd])$/.exec(until);
  if (rel && Number(rel[1]) > 0) return new Date(now.getTime() + Number(rel[1]) * (rel[2] === "h" ? HOUR : 24 * HOUR));
  if (until === "tomorrow" || until === "monday") {
    const d = new Date(now);
    d.setHours(9, 0, 0, 0);
    // After midnight, "tomorrow" still means the coming morning; on a Monday before 09:00, "monday" means today.
    if (until === "tomorrow" && now.getHours() >= 5) d.setDate(d.getDate() + 1);
    if (until === "monday" && !(now.getDay() === 1 && now.getHours() < 9)) d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
    return d;
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(until);
  const t = day
    ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 9).getTime()
    : /^\d{4}-\d{2}-\d{2}T/.test(until)
      ? Date.parse(until)
      : NaN;
  if (Number.isNaN(t) || t <= now.getTime())
    throw new DeskError(400, `can't read snooze time "${until}"; use 1h, 3h, 2d, tomorrow, monday, activity or a future ISO time`);
  return new Date(t);
}
