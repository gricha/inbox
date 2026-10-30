// The desk: runs the connectors, keeps the event log, and serves the classified views and local actions.
import fs from "node:fs";
import path from "node:path";
import type { GitHub } from "./github/index.ts";
import type { GitHubWriter } from "./github/write.ts";
import type { Connector, NewEvent } from "./connectors/connector.ts";
import { GitHubConnector } from "./connectors/github.ts";
import { resolution, type Resolution } from "./resolve.ts";
import type {
  Action,
  ActivityPage,
  AgentStatus,
  AiReview,
  BoardSummary,
  BoardView,
  Bucket,
  Card,
  ConfigDoc,
  ConfigError,
  Context,
  CoordinatorView,
  FocusView,
  Item,
  ItemDetail,
  ItemState,
  JudgeAnswer,
  JudgeStep,
  Overview,
  Placement,
  PolicyDoc,
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
import { classify, type BoardResult } from "./rules.ts";
import { renderTemplate } from "./expr.ts";
import { emptyState, Store, type StateRow } from "./store.ts";
import { inQuietHours, notify } from "./notify.ts";
import type { AgentOpts, PrText } from "./review.ts";
import * as agents from "./agents.ts";
import { Judge, textHash } from "./judge.ts";
import { Coordinator } from "./coordinator.ts";
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
const ITEM_ACTIVITY = 8;
const NO_CONTEXT: Context = { me: "", teams: [], affinity: {}, repo_prs: {}, orgs: {}, refreshed_at: "" };
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
  resolved: Resolution | null;
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
  mcpUrl?: string; // the desk's own MCP endpoint, for the coordinator; without it the coordinator is off
}

const MAX_POLICY = 20_000; // it goes with every judge call

export interface ReviewDeps {
  fetchPr(item: Item): Promise<PrText>;
  generate(item: Item, s: Signals, why: string, pr: PrText, opts: AgentOpts): Promise<AiReview>;
}

export class Desk {
  store: Store;
  gh: GitHubConnector;
  connectors: Connector[];
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
  mcpUrl: string | null;
  policyPath: string;
  policy = { text: "", hash: textHash("") };
  judge: Judge;
  coordinator: Coordinator;

  loaded: LoadedConfig | null = null;
  configText = "";
  configErrors: ConfigError[] = [];
  configWarnings: ConfigError[] = [];
  ctx: Context | null = null;
  rev = 0;
  listeners = new Set<(rev: number) => void>();
  waiters = new Set<() => void>(); // long-polls on the event log
  snap: Snapshot | null = null;
  stopped = false;
  generating = new Map<string, Promise<AiReview>>();
  aiErrors = new Map<string, { head_oid: string; message: string; at: number }>();
  fetching = new Map<string, Promise<PrText>>();
  approving = new Set<string>();

  constructor(opts: DeskOptions) {
    this.home = opts.home;
    this.now = opts.now ?? (() => new Date());
    this.notifyFn = opts.notify ?? notify;
    this.log =
      opts.log ??
      ((m) => {
        console.error(`[desk] ${m}`);
      });
    this.review = opts.review ?? null;
    this.writer = opts.writer ?? null;
    this.mcpUrl = opts.mcpUrl ?? null;
    fs.mkdirSync(this.home, { recursive: true });
    this.configPath = path.join(this.home, "config.toml");
    this.policyPath = path.join(this.home, "policy.md");
    this.settingsPath = settingsPath(this.home);
    this.settings = this.readSettings();
    this.store = new Store(path.join(this.home, "desk.db"));
    this.ctx = this.store.get("context") as Context | null;
    this.gh = new GitHubConnector(this, opts.github);
    this.connectors = [this.gh];
    this.judge = new Judge(this);
    this.coordinator = new Coordinator(this);
  }

  // Sync state across connectors: busy if any is, the first error, the oldest finished pass.
  get syncing(): boolean {
    return this.connectors.some((c) => c.status().status === "syncing");
  }

  get syncError(): string | null {
    return this.connectors.map((c) => c.status().error).find((e) => e !== null) ?? null;
  }

  get syncedAt(): string | null {
    let oldest: string | null = null;
    for (const c of this.connectors) {
      const t = c.status().synced_at;
      if (t === null) return null;
      if (oldest === null || t < oldest) oldest = t;
    }
    return oldest;
  }

  // ---------------------------------------------------------------- lifecycle

  async init(): Promise<void> {
    if (!this.ctx) await this.gh.refreshContext();
    if (!fs.existsSync(this.configPath)) {
      // The default spaces come from where your work is; don't guess them from a failed fetch.
      if (!this.ctx || Date.parse(this.ctx.refreshed_at) < this.now().getTime() - 24 * HOUR)
        throw new Error(`couldn't read your GitHub context to write a first config: ${this.gh.contextError ?? "unknown error"}`);
      const orgs = Object.entries(this.ctx?.orgs ?? {})
        .filter(([o, n]) => o.toLowerCase() !== this.me().toLowerCase() && n >= 5)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 1)
        .map(([o]) => o);
      fs.writeFileSync(this.configPath, defaultConfigText({ workOrgs: orgs }));
      this.log(`wrote ${this.configPath}`);
    }
    this.migrateSettings();
    this.readPolicy();
    this.reloadConfig();
    fs.watchFile(this.policyPath, { interval: 2000 }, () => {
      const text = fs.existsSync(this.policyPath) ? fs.readFileSync(this.policyPath, "utf8") : "";
      if (text !== this.policy.text) this.policyChanged();
    });
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
    for (const c of this.connectors) c.start();
    this.coordinator.wake();
  }

  // Kills a judge call or coordinator run in progress.
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const c of this.connectors) c.stop();
    this.judge.stop();
    this.coordinator.stop();
    for (const wake of this.waiters) wake();
    fs.unwatchFile(this.configPath);
    fs.unwatchFile(this.settingsPath);
    fs.unwatchFile(this.policyPath);
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
    this.judge.pump();
    if (sync && loaded) void this.sync();
  }

  // ---------------------------------------------------------------- policy

  readPolicy(): void {
    const text = fs.existsSync(this.policyPath) ? fs.readFileSync(this.policyPath, "utf8") : "";
    this.policy = { text, hash: textHash(text) };
  }

  policyChanged(): void {
    this.readPolicy();
    this.changed();
    this.judge.pump();
    this.coordinator.wake();
  }

  getPolicy(): PolicyDoc {
    return { path: this.policyPath, text: this.policy.text, hash: this.policy.hash, judge: this.judge.status() };
  }

  // `base` is the hash from GET: a stale one means it changed since (the coordinator, an editor) and nothing is written.
  putPolicy(text: string, base?: string, agent?: string): { ok: true; hash: string } {
    if (base !== undefined && base !== this.policy.hash)
      throw new DeskError(409, "policy.md changed since you opened it; reload to see it, then reapply your edit");
    if (text.length > MAX_POLICY) throw new DeskError(400, `the policy is ${text.length} characters; keep it under ${MAX_POLICY}`);
    const real = fs.existsSync(this.policyPath) ? fs.realpathSync(this.policyPath) : this.policyPath;
    fs.writeFileSync(`${real}.tmp`, text);
    fs.renameSync(`${real}.tmp`, real);
    if (agent === "coordinator") this.coordinator.log(this.coordinator.running?.n ?? 0, "policy", "Updated the policy");
    this.policyChanged();
    return { ok: true, hash: this.policy.hash };
  }

  // ---------------------------------------------------------------- the coordinator

  coordinatorView(): CoordinatorView {
    return this.coordinator.view();
  }

  note(text: string): void {
    const line = text.trim();
    if (!line) throw new DeskError(400, "need { text }");
    this.coordinator.note(line.slice(0, 500));
    this.changed();
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
    if (this.settings["github.poll_seconds"] !== poll) for (const c of this.connectors) c.reschedule();
    this.pumpAi();
    this.judge.pump();
    this.coordinator.wake();
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
        error: this.gh.error ?? this.gh.contextError,
        synced_at: this.gh.syncedAt,
        rate_limit: this.gh.api.rateLimit(),
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

  // ---------------------------------------------------------------- sync and the event log

  // A full pass on every connector; their own loops also run it on github.poll_seconds.
  async sync(): Promise<void> {
    await Promise.all(this.connectors.map((c) => c.reconcile()));
  }

  // A connector brought in something new.
  synced(): void {
    this.changed();
    this.notifyNewNow();
    this.pumpAi();
    const kept = new Set(this.store.itemMeta().keys());
    this.store.pruneKv("review:", kept);
    this.store.pruneKv("pr:", kept);
    this.store.pruneKv("judge:", kept);
    this.store.pruneKv("brief:", new Set()); // the AI review replaced briefs
    this.judge.pump();
    this.coordinator.wake();
  }

  // Stores fresh snapshots and logs what changed: the connector's own events, plus resolved and unresolved flips.
  ingest(from: Connector, all: Item[]): void {
    const prev = this.store.itemsById(all.map((i) => i.id));
    // The feed and the full pass can fetch the same item at once; an older answer landing last would replay changes backwards.
    const items = all.filter((i) => !(i.updated_at < (prev.get(i.id)?.updated_at ?? "")));
    if (!items.length) return;
    const now = this.now().toISOString();
    const events: NewEvent[] = [];
    for (const next of items) {
      const before = prev.get(next.id) ?? null;
      events.push(...from.events(before, next));
      const was = before && this.resolutionOf(before);
      const is = this.resolutionOf(next);
      if (!was && is) {
        const at = is.at && is.at < now ? is.at : now;
        events.push({ at, item_id: next.id, kind: "resolved", actor: is.actor, data: { reason: is.reason } });
      } else if (was && !is) events.push({ at: now, item_id: next.id, kind: "unresolved", actor: "", data: { was: was.reason } });
    }
    this.store.putItems(items, now);
    this.record(from.id, events);
  }

  // Appends to the event log and wakes the long-polls.
  record(source: string, events: NewEvent[]): void {
    if (!events.length) return;
    this.store.addActivity(events.map((e) => ({ ...e, source })));
    for (const wake of this.waiters) wake();
    this.coordinator.wake();
  }

  resolutionOf(item: Item): Resolution | null {
    if (!this.loaded) return null;
    const ctx = this.ctx ?? NO_CONTEXT;
    return resolution(item, analyze(item, ctx, this.loaded.config, this.now()).signals, this.settings, ctx.teams);
  }

  isResolved(id: string): boolean {
    const item = this.store.itemsById([id]).get(id);
    return !!item && this.resolutionOf(item) !== null;
  }

  // Events after `after`, oldest first. With `wait` (seconds, up to 60) it answers as soon as one arrives.
  async activity(q: { after?: number; limit?: number; item?: string; wait?: number; signal?: AbortSignal }): Promise<ActivityPage> {
    const after = q.after ?? 0;
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
    const item = q.item ? this.itemId(q.item) : undefined;
    const deadline = Date.now() + Math.min(q.wait ?? 0, 60) * 1000;
    for (;;) {
      if (this.stopped) return { events: [], last_seq: after };
      const events = this.store.activity({ after, limit, item });
      const left = deadline - Date.now();
      if (events.length || left <= 0 || q.signal?.aborted) return { events, last_seq: events.at(-1)?.seq ?? this.store.lastSeq() };
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          q.signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, left);
        this.waiters.add(done);
        q.signal?.addEventListener("abort", done);
      });
    }
  }

  // A ref on the desk, or an exact id the desk no longer holds (its events outlive it).
  itemId(ref: string): string {
    try {
      return this.resolve(ref);
    } catch (e) {
      if (e instanceof DeskError && e.status === 404 && /^[\w.-]+\/[\w.-]+#\d+$/.test(ref)) return ref;
      throw e;
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
    const ctx = this.ctx ?? NO_CONTEXT;
    const states = this.store.states();
    const baseline = (this.store.get("baseline_at") as string | null) ?? now.toISOString();
    const entries = new Map<string, Entry>();
    for (const item of this.store.items()) {
      const analysis = analyze(item, ctx, loaded.config, now);
      const state = states.get(item.id) ?? emptyState(item.id);
      const isNew = analysis.others_at !== null && analysis.others_at > (state.seen_at ?? baseline);
      const resolved = resolution(item, analysis.signals, this.settings, ctx.teams);
      entries.set(item.id, { item, analysis, state, status: statusOf(state, analysis.activity_at, now), isNew, resolved });
    }

    const hits = this.store.hits();
    const kept = this.store.kept();
    const fetched = this.store.queries();
    const boards: Snapshot["boards"] = new Map();
    const best = new Map<string, Placement>();
    // An answer for an older version of the item stays until a fresh one lands, so the queue doesn't jump back and forth.
    const answers = this.judge.offReason() ? null : this.store.prefixed<JudgeAnswer>("judge:");
    const judge = answers
      ? (id: string): JudgeStep => {
          const a = answers.get(id);
          if (!a || a.policy !== this.policy.hash) return { bucket: null, why: "", pending: true };
          return { bucket: a.bucket, why: a.why, pending: a.updated_at !== entries.get(id)?.item.updated_at };
        }
      : undefined;
    for (const board of loaded.boards) {
      const queries = this.gh.queriesFor(loaded, board);
      const ids = new Set<string>();
      for (const q of queries) for (const id of hits.get(q) ?? []) ids.add(id);
      // A kept item is only there to show as resolved.
      const list = [...ids]
        .map((id) => entries.get(id))
        .filter((e): e is Entry => e !== undefined && (!kept.has(e.item.id) || e.resolved !== null));
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
          // Resolved items leave the buckets (and the caps) like cleared ones.
          active: e.status === "active" && !e.resolved,
          kept: kept.has(e.item.id),
        })),
        judge,
      );
      const error = queries.map((q) => fetched.get(q)?.error).find(Boolean) ?? undefined;
      boards.set(board.config.id, { result, queries, unfetched: queries.filter((q) => !fetched.has(q)), error });
      for (const [id, p] of result.placements) {
        const e = entries.get(id)!;
        if (e.status !== "active" || e.resolved) continue;
        const cur = best.get(id);
        if (!cur || RANK[p.bucket] < RANK[cur.bucket]) best.set(id, p);
      }
    }
    return { rev, at: now.getTime(), entries, reviews: this.store.prefixed<AiReview>("review:"), boards, best };
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
      why: e.resolved?.reason ?? p?.why ?? "",
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
      resolved: e.resolved?.reason ?? null,
      resolved_at: e.resolved ? (e.resolved.at ?? it.updated_at) : null,
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
    const cleared = b.result.inactive.filter((x) => !snap.entries.get(x)!.resolved).length;
    const counts = { now: 0, today: 0, later: 0, fyi: 0, hide: 0, cleared };
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
      connectors: this.connectors.map((c) => c.status()),
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
      rate_limit: this.gh.api.rateLimit(),
      coordinator: { state: this.coordinator.state(), acted: this.coordinator.acted() },
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
    const resolved: Card[] = [];
    for (const board of loaded.boards) {
      const b = snap.boards.get(board.config.id)!;
      for (const id of b.result.inactive) {
        if (seen.has(id)) continue;
        seen.add(id);
        const e = snap.entries.get(id)!;
        if (e.resolved) resolved.push(this.card(e, this.placementOf(id, snap), snap));
        else cleared.push(this.card(e, b.result.placements.get(id)!, snap));
      }
    }
    return { sections, hidden, cleared, resolved: resolved.sort((a, b) => (b.resolved_at ?? "").localeCompare(a.resolved_at ?? "")) };
  }

  // The most urgent board placement, for items that have no active one (resolved, cleared).
  placementOf(id: string, snap: Snapshot): Placement | null {
    const all = [...snap.boards.values()].map((b) => b.result.placements.get(id)).filter((p): p is Placement => p !== undefined);
    return all.sort((a, b) => RANK[a.bucket] - RANK[b.bucket])[0] ?? null;
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
      cleared: cards(b.result.inactive.filter((x) => !snap.entries.get(x)!.resolved)),
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
    const best = snap.best.get(id) ?? this.placementOf(id, snap);
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
      activity: this.store.activity({ after: 0, limit: ITEM_ACTIVITY, item: id, latest: true }),
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
    if (this.autoAi() && this.wantsAi(e, snap)) void this.generate(id).catch(() => {});
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
  // AI reviews nobody asked for: on unless review.auto_ai is off or there's no agent to write them.
  autoAi(): boolean {
    return !!this.review && this.settings["review.auto_ai"] && this.settings["agent.driver"] !== "none";
  }

  pumpAi(): void {
    if (this.stopped || !this.loaded || !this.autoAi() || this.generating.size >= AI_AT_ONCE) return;
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

  // POST /api/review/:id/approve: the desk's one GitHub write, on your keypress; `head` is the commit the view showed, so a newer push isn't approved unread.
  async approve(ref: string, head: string, body?: string): Promise<{ url: string }> {
    const e = this.pr(ref);
    const id = e.item.id;
    const can = this.canApprove(e);
    if (!can.ok) throw new DeskError(409, `can't approve ${id}: ${can.reason}`);
    if (head !== e.item.head_oid) throw new DeskError(409, `can't approve ${id}: it has new commits since you opened it`);
    if (this.approving.has(id)) throw new DeskError(409, `already approving ${id}`);
    this.approving.add(id);
    let url: string;
    try {
      ({ url } = await this.writer!.approve(e.item.node_id, head, body));
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

  // `by`: the agent behind it (the coordinator marks its calls) and its reason, kept in the coordinator's log.
  act(ref: string, action: Action, until?: string, by?: { agent?: string; reason?: string }): { state: ItemState; undo_seq: number } {
    const id = this.resolve(ref);
    const bucket = this.snapshot().best.get(id)?.bucket ?? null;
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
    if (by?.agent === "coordinator" && seq)
      this.coordinator.logAct({ item_id: id, action, bucket, undo_seq: seq }, (by.reason ?? "").trim().slice(0, 300));
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
    const text = this.configText;
    return { path: this.configPath, text, hash: textHash(text), errors: this.configErrors, warnings: this.configWarnings };
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

  // `base`: the text you started from, or its hash from GET /api/config.
  putConfig(text: string, base?: string, agent?: string): { ok: boolean; errors: ConfigError[]; warnings: ConfigError[] } {
    if (base !== undefined && base !== this.configText && base !== textHash(this.configText))
      throw new DeskError(409, "config.toml changed on disk since you opened it; reload to see it, then reapply your edit");
    const { loaded, errors, warnings } = parseConfig(text, this.settings);
    if (!loaded) return { ok: false, errors, warnings };
    const real = fs.realpathSync(this.configPath); // keep a symlinked config a symlink
    fs.writeFileSync(`${real}.tmp`, text);
    fs.renameSync(`${real}.tmp`, real);
    if (agent === "coordinator") this.coordinator.log(this.coordinator.running?.n ?? 0, "config", "Saved the rules");
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
