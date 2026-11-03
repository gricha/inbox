// The desk: runs the connectors, keeps the event log, and serves the classified views and local actions.
import fs from "node:fs";
import path from "node:path";
import { stopAll } from "./children.ts";
import type { GitHub } from "./github/index.ts";
import type { GitHubWriter } from "./github/write.ts";
import type { Connector, NewEvent } from "./connectors/connector.ts";
import { GitHubConnector, KEEP_RESOLVED } from "./connectors/github.ts";
import { resolution, type Resolution } from "./resolve.ts";
import { buildStacks, grouped, oneLinePerStack, stackRef, stackView, type Seat, type Stacks } from "./stacks.ts";
import type {
  Action,
  ActivityPage,
  AgentStatus,
  AiReview,
  BoardConfig,
  BoardSummary,
  BoardView,
  Bucket,
  Card,
  ConfigDoc,
  ConfigError,
  Context,
  FocusView,
  InflightRow,
  InflightView,
  Item,
  ItemDetail,
  ItemState,
  JudgeAnswer,
  JudgeStep,
  Overview,
  Paused,
  Placement,
  PolicyDoc,
  Preflight,
  PreviewResult,
  QueueView,
  ReviewFile,
  ReviewView,
  SettingsView,
  SettingValue,
  Signals,
  Stack,
  Status,
} from "./types.ts";
import { defaultConfigText, migrateBotAsk, migrateDrafts, migrateHard, parseConfig, type LoadedConfig } from "./config.ts";
import { analyze, FIELDS, type Analysis } from "./signals.ts";
import { classify, placedBy, queueOrder, type BoardResult } from "./rules.ts";
import { renderTemplate } from "./expr.ts";
import { emptyState, Store, type StateRow } from "./store.ts";
import { inQuietHours, notify } from "./notify.ts";
import { agentDir, CLAUDE_PAUSED, NOT_LOGGED_IN, reviewOrder, type PrText } from "./review.ts";
import * as agents from "./agents.ts";
import { DEFAULT_POLICY, Judge, judgeKey, textHash } from "./judge.ts";
import { Conversations, owesReply } from "./conversation.ts";
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
const AI_PAUSE_AFTER = 2; // failures in a row (an expired login fails every PR) that pause AI reviews nobody asked for, for AI_RETRY
const agentKey = (s: Settings) => JSON.stringify([s["review.auto_ai"]]);
const searchKey = (s: Settings) => JSON.stringify([s["github.bots"], s["github.close_collaborator_min"]]); // {close_authors}
const LANDED = 3 * 24 * HOUR; // a PR in Merging that merged or closed stays there this long
const RESOLVED_SHOWN = 24 * HOUR; // Resolved lists the last day
const MAX_LINE = 300; // a hand-back's why, a note
const MAX_REPLY = 5_000;

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
  inflight: boolean; // your open PR, handed off for merge: Merging has it, not the queue's buckets
}

interface Snapshot {
  rev: number;
  at: number;
  entries: Map<string, Entry>;
  reviews: Map<string, AiReview>;
  boards: Map<string, { result: BoardResult; queries: string[]; unfetched: string[]; error?: string }>;
  best: Map<string, Placement>; // best placement across boards, active items only
  needs: Map<string, string>; // PRs the coordinator handed back: why, at the top of the queue
  pins: Map<string, string>; // who pinned each pinned item: "them", or "the coordinator"
  stacks: Stacks;
}

// In Merging rather than anywhere in the queue: handed off, and not snoozed, muted or done.
const laneOwned = (e: Entry) => e.inflight && e.status === "active";

export interface DeskOptions {
  home: string;
  github: GitHub;
  now?: () => Date;
  notify?: (title: string, body: string) => void;
  log?: (msg: string) => void;
  review?: ReviewDeps; // diffs and AI reviews; without it the review view has no diff and no AI
  writer?: GitHubWriter; // approve and ready for review; without it they're off
}

// A PR's Merging record, in kv under the babysitters' old `sitter:` prefix so hand-backs made before survive.
interface Merging {
  handback?: { reason: string; at: string };
  note?: { text: string; at: string };
}

const MAX_POLICY = 20_000; // it goes with every judge call

export interface ReviewDeps {
  fetchPr(item: Item, since?: string): Promise<PrText>;
  generate(item: Item, s: Signals, why: string, pr: PrText, dir: string): Promise<AiReview>;
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
  policyPath: string;
  policy = { text: "", hash: textHash(DEFAULT_POLICY) }; // the file's text; the hash is of what's in effect
  judge: Judge;
  convos: Conversations;

  loaded: LoadedConfig | null = null;
  configText = "";
  configErrors: ConfigError[] = [];
  configWarnings: ConfigError[] = [];
  ctx: Context | null = null;
  rev = 0;
  listeners = new Set<(rev: number) => void>();
  notifyListeners = new Set<(title: string, body: string) => void>();
  waiters = new Set<() => void>(); // long-polls on the event log
  snap: Snapshot | null = null;
  stopped = false;
  generating = new Map<string, Promise<AiReview>>();
  aiErrors = new Map<string, { head_oid: string; message: string; at: number }>();
  aiFailures = 0; // in a row, across PRs
  aiPaused: { why: string; until: number } | null = null;
  fetching = new Map<string, Promise<PrText>>();
  approving = new Set<string>(); // PRs on their way to an approval or ready for review
  sending = new Set<string>(); // conversations a reply is on its way to

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
    this.convos = new Conversations(this);
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
    this.migrateRules();
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
  }

  // Kills a judge call in progress.
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const c of this.connectors) c.stop();
    this.judge.stop();
    this.convos.stop();
    for (const wake of this.waiters) wake();
    fs.unwatchFile(this.configPath);
    fs.unwatchFile(this.settingsPath);
    fs.unwatchFile(this.policyPath);
    this.store.close();
  }

  // stop(), and back once every agent process is gone: an AI review's too, and a SIGKILL for what ignores SIGTERM.
  async close(): Promise<void> {
    this.stop();
    await stopAll();
  }

  onChange(fn: (rev: number) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  // A desktop app attached to this desk (GET /api/events?notify=1) shows the notifications; with none, the desk does.
  onNotify(fn: (title: string, body: string) => void): () => void {
    this.notifyListeners.add(fn);
    return () => {
      this.notifyListeners.delete(fn);
    };
  }

  notify(title: string, body: string): void {
    if (!this.notifyListeners.size) this.notifyFn(title, body);
    for (const fn of this.notifyListeners) fn(title, body);
  }

  changed(): void {
    this.rev++;
    this.snap = null;
    for (const fn of this.listeners) fn(this.rev);
  }

  me(): string {
    return this.ctx?.me ?? "";
  }

  // Where the tool-less agent calls run (the AI review, the judge, login checks).
  agentDir(): string {
    return agentDir(this.home);
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
    this.policy = { text, hash: textHash(text.trim() ? text : DEFAULT_POLICY) };
  }

  // What the judge follows: policy.md, or the starter while it's empty.
  policyText(): string {
    return this.policy.text.trim() ? this.policy.text : DEFAULT_POLICY;
  }

  policyChanged(): void {
    this.readPolicy();
    this.changed();
    this.judge.pump();
  }

  getPolicy(): PolicyDoc {
    return { path: this.policyPath, text: this.policy.text, starter: DEFAULT_POLICY, hash: this.policy.hash, judge: this.judge.status() };
  }

  writePolicy(text: string): void {
    const real = fs.existsSync(this.policyPath) ? fs.realpathSync(this.policyPath) : this.policyPath;
    fs.writeFileSync(`${real}.tmp`, text);
    fs.renameSync(`${real}.tmp`, real);
  }

  // `base` is the hash from GET: a stale one means it changed since (an agent, an editor) and nothing is written.
  putPolicy(text: string, base?: string): { ok: true; hash: string } {
    if (base !== undefined && base !== this.policy.hash)
      throw new DeskError(409, "policy.md changed since you opened it; reload to see it, then reapply your edit");
    if (text.length > MAX_POLICY) throw new DeskError(400, `the policy is ${text.length} characters; keep it under ${MAX_POLICY}`);
    this.writePolicy(text);
    this.policyChanged();
    return { ok: true, hash: this.policy.hash };
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
    const agent = agentKey(this.settings);
    const searches = searchKey(this.settings);
    this.settings = this.readSettings();
    // Sync now only when the searches change; other settings apply to what the desk already has.
    if (this.configText) this.reloadConfig(searchKey(this.settings) !== searches);
    else this.changed();
    if (this.settings["github.poll_seconds"] !== poll) for (const c of this.connectors) c.reschedule();
    // A changed agent starts afresh: whatever failed on the old one tries again now.
    if (agentKey(this.settings) !== agent) this.retryAgents();
    this.pumpAi();
    this.judge.pump();
  }

  // What failed on the agent (AI reviews, the judge) tries again now instead of after its
  // backoff. `only`: just what failed with this error, e.g. NOT_LOGGED_IN once another call shows the login works again.
  retryAgents(only?: string): void {
    const hit = (m: string | null | undefined) => !only || !!m?.endsWith(only);
    let any = false;
    for (const [id, e] of this.aiErrors)
      if (hit(e.message)) {
        this.aiErrors.delete(id);
        any = true;
      }
    if (this.aiPaused && hit(this.aiPaused.why)) {
      this.aiPaused = null;
      this.aiFailures = 0;
      any = true;
    }
    if (!only) this.aiFailures = 0;
    if ((this.judge.error || this.judge.retryAt) && hit(this.judge.error)) {
      this.judge.retry();
      any = true;
    }
    if (!any || !only) return; // a settings change pumps everything itself
    this.log("the agent works again: retrying what failed on its login");
    this.changed();
    this.pumpAi();
    this.judge.pump();
  }

  // Settings used to live in config.toml; move them to settings.json once.
  migrateSettings(): void {
    if (this.store.get("settings_migrated") || !fs.existsSync(this.configPath)) return;
    const text = fs.readFileSync(this.configPath, "utf8");
    const m = migrateLegacy(text);
    if (!m) {
      // Nothing to move, so it's done: legacy keys saved later (desk_config save, an agent) only warn, never become settings.
      if (parseConfig(text, this.settings).loaded) this.store.set("settings_migrated", this.now().toISOString());
      return;
    }
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

  // Once each: the direct-ask rule of a config written before hard rules becomes hard (migrateHard), a direct ask a bot
  // added gets a hard rule too (migrateBotAsk), and the old rule sending all your drafts to later puts a draft you touched
  // lately on the desk (migrateDrafts).
  migrateRules(): void {
    const due = [
      { key: "hard_migrated", migrate: migrateHard, did: "made the rule for reviews asked of you by name hard" },
      { key: "bot_ask_migrated", migrate: migrateBotAsk, did: "added a hard rule for reviews a bot asked of you by name" },
      { key: "drafts_migrated", migrate: migrateDrafts, did: "put your drafts touched in the last 14 days on the desk" },
    ].filter((m) => !this.store.get(m.key));
    if (!due.length) return;
    const before = fs.readFileSync(this.configPath, "utf8");
    let text = before;
    const did: string[] = [];
    for (const m of due) {
      const next = m.migrate(text);
      if (next === null) continue;
      text = next;
      did.push(m.did);
    }
    if (text !== before) {
      const real = fs.realpathSync(this.configPath);
      fs.copyFileSync(real, `${real}.bak`);
      fs.writeFileSync(`${real}.tmp`, text);
      fs.renameSync(`${real}.tmp`, real);
      this.log(`${did.join("; ")} (backup: config.toml.bak)`);
    }
    for (const m of due) this.store.set(m.key, this.now().toISOString());
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
      paused: {
        ai: this.aiPausedNow() ? { why: this.aiPaused!.why, until: new Date(this.aiPaused!.until).toISOString() } : null,
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
    return agents.status("claude-code", mcpUrl);
  }

  async connectAgent(mcpUrl: string): Promise<AgentStatus> {
    try {
      return await agents.connect("claude-code", mcpUrl);
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
    this.notifyNew();
    this.pumpAi();
    const kept = new Set(this.store.itemMeta().keys());
    this.store.pruneKv("review:", kept);
    this.store.pruneKv("pr:", kept);
    this.store.pruneKv("judge:", kept);
    this.store.pruneKv("sitter:", kept);
    this.store.pruneKv("take:", kept);
    this.store.pruneKv("brief:", new Set()); // the AI review replaced briefs
    if (this.loaded) {
      const top = this.top(this.snapshot(), new Set());
      void this.convos.warm([...top.now, ...top.today].filter((c) => c.cta === "reply").map((c) => c.id));
    }
    this.judge.pump();
  }

  // Stores fresh snapshots and logs what changed: the connector's own events, plus resolved and unresolved flips. `quiet`:
  // only stores them (a stack's members no board lists: context, not news); the next ingest that isn't logs what changed.
  ingest(from: Connector, all: Item[], quiet = false): void {
    const prev = this.store.itemsById(all.map((i) => i.id));
    // The feed and the full pass can fetch the same item at once; an older answer landing last would replay changes backwards.
    const items = all.filter((i) => !(i.updated_at < (prev.get(i.id)?.updated_at ?? "")));
    if (!items.length) return;
    const now = this.now().toISOString();
    if (quiet) {
      this.store.putItems(items, now, true);
      return;
    }
    const said = this.store.said(items.map((i) => i.id));
    const events: NewEvent[] = [];
    for (const next of items) {
      const before = (said.has(next.id) ? said.get(next.id) : prev.get(next.id)) ?? null;
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

  // New on the queue once placed (not while Claude hasn't sorted it, nor by your own pin); a hand-back is on it, in Now.
  // Per PR, not the queue's one line per stack: a member that comes to stand for its stack isn't news.
  notifyNew(): void {
    const cfg = this.loaded?.config;
    if (!cfg || !this.syncedAt) return;
    const snap = this.snapshot();
    const { now, today } = this.top(snap, new Set());
    const queued = [...now, ...today]
      .filter((c) => c.placed_by !== "pending" && c.placed_by !== "pin")
      .map((c) => ({ id: c.id, ref: shortRef(c), why: c.why }));
    const fresh = this.freshSince("notified_queue", queued);
    if (!fresh.length || !cfg.notify.enabled || inQuietHours(cfg.notify.quiet, this.now())) return;
    const [only] = fresh;
    const body =
      fresh.length === 1 && only ? `${only.ref} · ${only.why}` : `${fresh.length} need you: ${fresh.map((x) => x.ref).join(", ")}`;
    this.notify("Review Desk", body);
  }

  // What isn't in the last pass's list under `key` (nothing on the first pass), keeping this pass's.
  freshSince<T extends { id: string }>(key: string, list: T[]): T[] {
    const prev = this.store.get(key) as string[] | null;
    this.store.set(
      key,
      list.map((x) => x.id),
    );
    return prev === null ? [] : list.filter((x) => !prev.includes(x.id));
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
    const items = this.store.items();
    for (const item of items) {
      const analysis = analyze(item, ctx, loaded.config, now);
      const state = states.get(item.id) ?? emptyState(item.id);
      const isNew = analysis.others_at !== null && analysis.others_at > (state.seen_at ?? baseline);
      const resolved = resolution(item, analysis.signals, this.settings, ctx.teams);
      const inflight = !!state.inflight_at && item.kind === "pr" && item.state === "open" && analysis.signals.me.author;
      entries.set(item.id, { item, analysis, state, status: statusOf(state, analysis.activity_at, now), isNew, resolved, inflight });
    }

    const hits = this.store.hits();
    const kept = this.store.kept();
    const fetched = this.store.queries();
    // A recently resolved item still in a search (you approved: reviewed-by:@me) passes its board's filter, to show under Resolved.
    // Only one that says when: updated_at moves with every bot or CI touch, so it would never age out.
    const keepSince = new Date(now.getTime() - KEEP_RESOLVED).toISOString();
    const recent = (e: Entry) => !!e.resolved?.at && e.resolved.at > keepSince;
    const boards: Snapshot["boards"] = new Map();
    const best = new Map<string, Placement>();
    const reviews = this.store.prefixed<AiReview>("review:");
    const pins = new Map<string, string>();
    for (const e of entries.values())
      if (e.state.pinned) pins.set(e.item.id, this.store.pinnedBy(e.item.id) === "coordinator" ? "the coordinator" : "them");
    // The AI's call on this commit: over a cap, the lightest gives up its slot first, so a close look keeps one.
    const call = (e: Entry) => {
      const ai = reviews.get(e.item.id);
      const current = ai?.head_oid === e.item.head_oid ? ai : null;
      return current?.risk === "high" ? "look" : current?.verdict;
    };
    // An answer for what the item was (judgeKey: its activity, commit, reviews, files, AI review) or an older policy stays
    // until a fresh one lands, so the queue doesn't jump back to the rules' placements each time the policy changes.
    const answers = this.judge.offReason() ? null : this.store.prefixed<JudgeAnswer>("judge:");
    const judge = answers
      ? (id: string): JudgeStep => {
          const a = answers.get(id);
          if (!a) return { bucket: null, why: "", pending: true };
          const e = entries.get(id);
          const stale =
            !e || a.policy !== this.policy.hash || a.key !== judgeKey(e.item, e.analysis.activity_at, reviews.get(id), pins.get(id));
          return { bucket: a.bucket, why: a.why, pending: stale };
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
          // Your pin keeps it on your desk; the coordinator's is an opinion Claude weighs.
          floor: pins.get(e.item.id) === "them" ? "today" : undefined,
          // Resolved and in-flight items leave the buckets (and the caps) like cleared ones.
          active: e.status === "active" && !e.resolved && !e.inflight,
          kept: kept.has(e.item.id) || recent(e),
          ai: call(e),
        })),
        judge,
        this.settings["queue.quiet_days"],
      );
      const error = queries.map((q) => fetched.get(q)?.error).find(Boolean) ?? undefined;
      boards.set(board.config.id, { result, queries, unfetched: queries.filter((q) => !fetched.has(q)), error });
      for (const [id, p] of result.placements) {
        const e = entries.get(id)!;
        if (e.status !== "active" || e.resolved || e.inflight) continue;
        const cur = best.get(id);
        // On a tie, a hard rule's placement speaks for the card.
        if (!cur || RANK[p.bucket] < RANK[cur.bucket] || (p.bucket === cur.bucket && p.hard && !cur.hard)) best.set(id, p);
      }
    }
    // A PR in Merging stays there; one the coordinator handed back tops your desk until done or m again.
    const needs = new Map<string, string>();
    const merging = this.store.prefixed<Merging>("sitter:");
    for (const e of entries.values()) {
      const back = merging.get(e.item.id)?.handback;
      if (!back || e.inflight || e.status !== "active" || e.item.state !== "open" || (e.state.done_at ?? "") > back.at) continue;
      const why = `handed back: ${back.reason}`;
      needs.set(e.item.id, why);
      const board = [...boards.values()].map((b) => b.result.placements.get(e.item.id)?.board).find(Boolean) ?? "";
      best.set(e.item.id, { board, bucket: "now", rule_bucket: "now", rule: null, why, trace: [] });
    }
    return { rev, at: now.getTime(), entries, reviews, boards, best, needs, pins, stacks: buildStacks(items) };
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
    if (it.auto_merge && it.state === "open") chips.push("auto-merge on");
    if (it.kind === "pr") chips.push(`+${it.additions} −${it.deletions}`);
    const me = e.analysis.signals.me;
    const team = me.requested && !me.requested_direct && me.requested_team ? me.requested_team : "";
    const by = p && !e.inflight ? placedBy(p) : undefined; // your PR in Merging is the coordinator's
    const stack = stackRef(snap.stacks, it.id);
    return {
      ...(team && { team_ask: me.requested_codeowner ? `CODEOWNERS ping to @${team}` : `asked @${team}` }),
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
      new: e.isNew && !e.resolved && e.status === "active", // a resolved or cleared row needs nobody, so no dot
      pinned: e.state.pinned,
      status: e.status,
      snooze_until: e.status === "snoozed" ? e.state.snooze_until : null,
      verdict: snap.reviews.get(it.id)?.head_oid === it.head_oid ? snap.reviews.get(it.id)!.verdict : null,
      resolved: e.resolved?.reason ?? null,
      resolved_at: e.resolved ? (e.resolved.at ?? it.updated_at) : null,
      inflight: e.inflight,
      ...(!e.inflight && snap.needs.has(it.id) && { handed_back: true }),
      ...(it.kind === "pr" && it.draft && it.state === "open" && me.author && this.writer && { cta: "ready" as const }),
      ...(by && { placed_by: by }),
      ...(stack && { stack }),
    };
  }

  // A stack member's place on the queue, for the stack's views.
  seat(id: string, snap: Snapshot): Seat {
    const e = snap.entries.get(id)!;
    const p = snap.best.get(id);
    return {
      bucket: p?.bucket ?? null,
      why: e.resolved?.reason ?? p?.why ?? "",
      new: e.isNew && !e.resolved && e.status === "active",
      inflight: e.inflight,
    };
  }

  stack(id: string, snap: Snapshot): Stack | null {
    return stackView(snap.stacks, id, (x) => this.seat(x, snap));
  }

  // By id, each stack of these cards, with the first of its cards current.
  stacksOf(cards: Card[], snap: Snapshot): Record<string, Stack> {
    const out: Record<string, Stack> = {};
    for (const c of cards) if (c.stack && !out[c.stack.id]) out[c.stack.id] = this.stack(c.id, snap)!;
    return out;
  }

  // ---------------------------------------------------------------- views

  requireConfig(): LoadedConfig {
    if (!this.loaded) throw new DeskError(503, `config has errors: ${this.configErrors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
    return this.loaded;
  }

  summary(id: string, snap: Snapshot): BoardSummary {
    const cfg = this.requireConfig().config.boards.find((b) => b.id === id)!;
    const b = snap.boards.get(id)!;
    const cleared = b.result.inactive.filter((x) => !snap.entries.get(x)!.resolved && !laneOwned(snap.entries.get(x)!)).length;
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
      inflight: { total: [...snap.entries.values()].filter((e) => e.inflight).length },
      rate_limit: this.gh.api.rateLimit(),
    };
  }

  // Your PRs the coordinator handed back, at the top of Now.
  needsCards(snap: Snapshot, seen: Set<string>): Card[] {
    const out: Card[] = [];
    for (const id of snap.needs.keys()) {
      seen.add(id);
      out.push(this.queueCard(snap.entries.get(id)!, snap.best.get(id)!, snap));
    }
    return out;
  }

  // A Now or Today card carries what to skim before opening it: its AI review, or for your own PR what to do next.
  queueCard(e: Entry, p: Placement, snap: Snapshot): Card {
    const c = this.card(e, p, snap);
    const it = e.item;
    c.preflight = this.preflight(e, snap);
    if (it.kind === "pr" && e.analysis.signals.me.author) {
      const next = this.nextStep(e);
      if (next) c.next = next;
      if (it.checks_failed?.length) c.checks_failed = it.checks_failed;
      if (it.checks_optional?.length) c.checks_optional = it.checks_optional;
      // Who last spoke on it: a reviewer's comment or review is the context its threads and next step don't give.
      const said = this.store
        .activity({ after: 0, limit: 20, item: it.id, latest: true })
        .find((x) => x.kind === "commented" || x.kind === "reviewed");
      if (said) c.last_event = said;
      if (this.replyOnly(e)) c.cta = "reply";
    }
    if (it.kind === "issue") {
      const recent = this.store.activity({ after: 0, limit: 20, item: it.id, latest: true });
      const last = recent.find((x) => x.kind !== "new");
      if (last) c.last_event = last;
      const me = e.analysis.signals.me;
      const involved = me.assignee
        ? "assigned to you"
        : me.author
          ? "your issue"
          : recent.some((x) => x.kind === "mentioned")
            ? "you were mentioned"
            : me.commented
              ? "you commented"
              : "";
      if (involved) c.involved = involved;
    }
    return c;
  }

  // The latest AI review's outcome (for an older head unless it's ready), and what happens next.
  preflight(e: Entry, snap: Snapshot): Preflight {
    const it = e.item;
    if (it.kind !== "pr" || it.state !== "open" || e.analysis.signals.me.author) return { state: "none" };
    const ai = snap.reviews.get(it.id);
    const got = ai
      ? {
          verdict: ai.verdict,
          risk: ai.risk,
          summary: ai.summary,
          ...(ai.since && { since: ai.since }),
          concerns: ai.concerns.slice(0, 2),
          notes: ai.notes.length,
          ...(ai.chunks && {
            chunks: {
              look: ai.chunks.ranked.filter((c) => c.level === "look").length,
              skim: ai.chunks.ranked.filter((c) => c.level === "skim").length,
              total: ai.chunks.total,
            },
          }),
          at: ai.at,
        }
      : {};
    const state = (): Preflight["state"] => {
      if (ai?.head_oid === it.head_oid) return "ready";
      if (this.generating.has(it.id)) return ai ? "stale" : "running";
      if (!this.autoAiOn()) return "off";
      if (this.aiPausedNow()) return "paused";
      return ai ? "stale" : "queued";
    };
    return { state: state(), ...got };
  }

  // Your own open PR: what's up with it, and the key that deals with it. Nothing when its why and the card's keys say it all
  // (in Merging: Enter opens it there; approved and green: o merges it on GitHub).
  nextStep(e: Entry): string | undefined {
    const it = e.item;
    const ready = it.review_decision === "approved" && it.ci === "green" && it.mergeable === "clean" && !it.draft;
    if (e.inflight || ready) return undefined;
    const hand = "m hands it off for merge";
    if (it.mergeable === "conflict") return `merge conflict with ${it.base}: ${hand}`;
    if (it.ci === "red") return `CI failing: ${hand}`;
    if (it.review_decision === "changes_requested") return `changes requested: ${hand}`;
    const n = it.threads_unresolved;
    if (n) return `${n} unresolved ${n === 1 ? "thread" : "threads"}: ${hand}`;
    if (it.draft) return "a draft: mark it ready for review when it is";
    return `waiting on review: ${hand}`;
  }

  // Your own open PR whose only action is answering someone: nothing to fix, nothing to merge yet.
  replyOnly(e: Entry): boolean {
    const it = e.item;
    if (it.state !== "open" || e.inflight || it.draft || it.ci === "red" || it.mergeable === "conflict") return false;
    if (it.review_decision === "changes_requested" || (it.review_decision === "approved" && it.ci === "green")) return false;
    return owesReply(it, this.me());
  }

  // Said once above the queue, not on every card: a failed login stops every agent, so it's Claude as a whole.
  paused(): Paused | null {
    const login = (why: string | null | undefined) => !!why?.endsWith(NOT_LOGGED_IN);
    const ai = this.autoAiOn() && this.aiPausedNow() ? this.aiPaused!.why : null;
    if (login(ai) || (!this.judge.offReason() && login(this.judge.error))) return { who: "claude", why: CLAUDE_PAUSED };
    return ai ? { who: "ai", why: ai } : null;
  }

  // A stack is one line here, as in the queue.
  focus(): FocusView {
    const snap = this.snapshot();
    const sections = this.top(snap, new Set());
    oneLinePerStack(sections, ["now", "today"], snap.stacks);
    return {
      sections,
      cards: this.settings["queue.cards"],
      paused: this.paused(),
    };
  }

  // Now and Today in the queue's order, which the AI reviews run in too: what was handed back, then each board's.
  top(snap: Snapshot, seen: Set<string>): FocusView["sections"] {
    const loaded = this.requireConfig();
    const sections: FocusView["sections"] = { now: this.needsCards(snap, seen), today: [] };
    for (const bucket of ["now", "today"] as const) {
      for (const board of loaded.boards) {
        for (const id of snap.boards.get(board.config.id)!.result.order[bucket]) {
          const p = snap.best.get(id);
          if (seen.has(id) || !p || p.bucket !== bucket || p.board !== board.config.id) continue;
          seen.add(id);
          sections[bucket].push(this.queueCard(snap.entries.get(id)!, p, snap));
        }
      }
    }
    return { now: queueOrder(sections.now, this.me()), today: queueOrder(sections.today, this.me()) };
  }

  // The single surface: every item once, at its best placement across boards.
  queue(): QueueView {
    const loaded = this.requireConfig();
    const snap = this.snapshot();
    const seen = new Set<string>();
    const sections: QueueView["sections"] = { ...this.top(snap, seen), later: [], fyi: [] };
    const hidden: Card[] = [];
    for (const bucket of ["later", "fyi", "hide"] as const) {
      for (const board of loaded.boards) {
        for (const id of snap.boards.get(board.config.id)!.result.order[bucket]) {
          const p = snap.best.get(id);
          if (seen.has(id) || !p || p.bucket !== bucket || p.board !== board.config.id) continue;
          seen.add(id);
          (bucket === "hide" ? hidden : sections[bucket]).push(this.card(snap.entries.get(id)!, p, snap));
        }
      }
    }
    const leads = oneLinePerStack(sections, ["now", "today", "later", "fyi"], snap.stacks);
    const cleared: Card[] = [];
    const resolved: Card[] = [];
    // Resolved is what was in front of you (Now, Today), asked of you, or what you touched, from the last day: FYI and hidden
    // items, and the rest of Later, resolve silently.
    const since = new Date(this.now().getTime() - RESOLVED_SHOWN).toISOString();
    const yours = (e: Entry, p: Placement | null) =>
      (e.resolved?.at ?? e.item.updated_at) >= since &&
      (p?.bucket === "now" ||
        p?.bucket === "today" ||
        !!e.state.seen_at ||
        e.resolved?.reason === "no longer requested" ||
        e.resolved?.actor.toLowerCase() === this.me().toLowerCase());
    for (const board of loaded.boards) {
      const b = snap.boards.get(board.config.id)!;
      for (const id of b.result.inactive) {
        if (seen.has(id)) continue;
        seen.add(id);
        const e = snap.entries.get(id)!;
        if (laneOwned(e)) continue; // Merging shows it
        if (e.resolved) {
          const p = this.placementOf(id, snap);
          if (yours(e, p)) resolved.push(this.card(e, p, snap));
        } else cleared.push(this.card(e, b.result.placements.get(id)!, snap));
      }
    }
    return {
      sections,
      hidden,
      cleared,
      resolved: resolved.sort((a, b) => (b.resolved_at ?? "").localeCompare(a.resolved_at ?? "")),
      cards: this.settings["queue.cards"],
      paused: this.paused(),
      stacks: this.stacksOf([...leads, ...hidden, ...cleared, ...resolved], snap),
    };
  }

  // The most urgent board placement, for items that have no active one (resolved, cleared).
  placementOf(id: string, snap: Snapshot): Placement | null {
    const all = [...snap.boards.values()].map((b) => b.result.placements.get(id)).filter((p): p is Placement => p !== undefined);
    return all.sort((a, b) => RANK[a.bucket] - RANK[b.bucket])[0] ?? null;
  }

  // Where an item's card says it is; a PR in Merging is Merging's whatever its boards say.
  shownAt(e: Entry, snap: Snapshot): Placement | null {
    const p = snap.best.get(e.item.id) ?? this.placementOf(e.item.id, snap);
    return p && laneOwned(e) ? { ...p, bucket: "fyi", why: "merging" } : p;
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
      cleared: cards(b.result.inactive.filter((x) => !snap.entries.get(x)!.resolved && !laneOwned(snap.entries.get(x)!))),
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
    const { snoozed_at: _, acked_at: __, ...state } = e.state;
    return {
      card: this.card(e, this.shownAt(e, snap), snap),
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
      stack: this.stack(id, snap),
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
    const talk = this.convos.view(id);
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
    const own = err?.head_oid === e.item.head_oid ? err.message : null;
    // A PR the desk would have reviewed on its own says why it didn't.
    const paused = this.autoAiOn() && this.aiPausedNow() && this.wantsAi(e, snap) ? `AI reviews are paused: ${this.aiPaused!.why}` : null;
    return {
      card: d.card,
      item: d.item,
      handoff_prompt: d.handoff_prompt,
      files,
      files_error: filesError,
      order: reviewOrder(files, d.ai, d.ai_stale),
      ai: d.ai,
      ai_stale: d.ai_stale,
      ai_error: this.generating.has(id) ? null : (own ?? paused),
      generating: this.generating.has(id),
      approve: this.canApprove(e),
      activity: d.activity,
      stack: d.stack,
      ...(await talk),
    };
  }

  // The changed files and description, kept per head commit.
  prText(id: string): Promise<PrText> {
    const review = this.review;
    if (!review) return Promise.reject(new Error("diffs aren't available in this desk"));
    const e = this.snapshot().entries.get(id)!;
    const item = e.item;
    // Pushed since you reviewed it: the diff since your review's commit too, for a "since your review" line.
    const me = e.analysis.signals.me;
    const since = me.pushed_since_review
      ? item.reviews.findLast((r) => r.author.toLowerCase() === me.login.toLowerCase() && !!r.commit)?.commit
      : undefined;
    const cached = this.store.get(`pr:${id}`) as (PrText & { head_oid: string }) | null;
    if (cached?.head_oid === item.head_oid) return Promise.resolve(cached);
    const running = this.fetching.get(id);
    if (running) return running;
    const p = review
      .fetchPr(item, since)
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
      if (this.stopped) throw new Error("stopped"); // close() has stopped the agents already: don't start one it misses
      const ai = await this.review.generate(e.item, e.analysis.signals, snap.best.get(id)?.why ?? "", pr, this.agentDir());
      if (this.stopped) return ai;
      this.store.set(`review:${id}`, ai);
      this.aiErrors.delete(id);
      this.aiFailures = 0;
      if (this.aiPaused) this.log("AI reviews resume");
      this.aiPaused = null;
      this.log(
        `AI review of ${id}: ${ai.verdict}, ${ai.concerns.length} concerns, ${ai.notes.length} notes, ${ai.chunks ? `${ai.chunks.ranked.length} of ${ai.chunks.total} chunks ranked` : "no ranking"}`,
      );
      this.retryAgents(NOT_LOGGED_IN);
      return ai;
    } catch (err) {
      if (this.stopped) throw err; // killed with the desk
      const message = (err as Error).message;
      this.aiErrors.set(id, { head_oid: e.item.head_oid, message, at: Date.now() });
      const cause = (err as Error).cause;
      this.log(`AI review of ${id} failed: ${message}${typeof cause === "string" ? ` (${cause})` : ""}`);
      if (++this.aiFailures >= AI_PAUSE_AFTER) {
        if (!this.aiPausedNow()) this.log(`AI reviews nobody asked for are paused for ${AI_RETRY / 60_000} min`);
        this.aiPaused = { why: message, until: Date.now() + AI_RETRY };
      }
      throw err;
    }
  }

  aiPausedNow(): boolean {
    return !!this.aiPaused && Date.now() < this.aiPaused.until;
  }

  // Someone else's open PR with no AI review of its head yet, and no recent failure on it.
  wantsAi(e: Entry, snap: Snapshot): boolean {
    const it = e.item;
    if (it.kind !== "pr" || it.state !== "open" || e.analysis.signals.me.author || this.generating.has(it.id)) return false;
    if (snap.reviews.get(it.id)?.head_oid === it.head_oid) return false;
    const err = this.aiErrors.get(it.id);
    return !(err && err.head_oid === it.head_oid && Date.now() - err.at < AI_RETRY);
  }

  // AI reviews nobody asked for: on unless review.auto_ai is off...
  autoAiOn(): boolean {
    return !!this.review && this.settings["review.auto_ai"];
  }

  // ...and not paused because they keep failing.
  autoAi(): boolean {
    return this.autoAiOn() && !this.aiPausedNow();
  }

  // Background AI reviews, a couple at a time, in the queue's order: Now, then Today from the top, so the cards on screen
  // are ready first. After a failure it waits for the next sync.
  pumpAi(): void {
    if (this.stopped || !this.loaded || !this.autoAi() || this.generating.size >= AI_AT_ONCE) return;
    const snap = this.snapshot();
    const top = this.top(snap, new Set());
    for (const c of [...top.now, ...top.today]) {
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

  // POST /api/review/:id/approve: one of the desk's GitHub writes (with Send), on your keypress; `head` is the commit the view showed, so a newer push isn't approved unread.
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
    // The PR itself first, so it resolves as "you approved" within seconds; the search index lags, so a full pass alone wouldn't see it.
    void this.gh.refresh(id).then(() => this.sync());
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
    const entry = this.snapshot().entries.get(id)!;
    // The coordinator keeps working on it whatever its status, so it comes back to the desk first.
    if (entry.inflight && (action === "done" || action === "snooze" || action === "mute"))
      throw new DeskError(409, `${id} is in Merging, so the coordinator has it; bring it back to the desk (b) first`);
    // Resurface on activity newer than what you saw, not newer than the click: a sync may land just after it.
    const seen = entry.analysis.activity_at;
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
      case "inflight":
        // Handed off for merge: only your own open PR, and the coordinator takes it from here.
        if (entry.item.kind !== "pr" || !entry.analysis.signals.me.author || entry.item.state !== "open")
          throw new DeskError(409, `only your own open PRs are handed off for merge; ${id} isn't one`);
        if (s.inflight_at) throw new DeskError(409, `${id} is in Merging already`);
        s.inflight_at = now.toISOString();
        // Merging has it now, so it isn't done, snoozed or muted in the queue any more (undo brings that back).
        Object.assign(s, { done_at: null, snooze_until: null, snoozed_at: null, muted: false });
        this.store.set(`sitter:${id}`, null); // a fresh start: no hand-back or note from last time
        break;
      case "takeback":
        if (!s.inflight_at) throw new DeskError(409, `${id} isn't in Merging`);
        s.inflight_at = null;
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

  // `agent`: an agent asks, not you. Hand-offs are yours.
  undo(seq?: number, agent?: string): { id: string; state: ItemState; action: Action } {
    const ev = this.store.lastAction(seq);
    if (!ev) throw new DeskError(404, "nothing to undo");
    if (agent && (ev.action === "inflight" || ev.action === "takeback"))
      throw new DeskError(
        409,
        `only the user undoes ${ev.action === "inflight" ? "a hand-off for merge" : "bringing a PR back to the desk"}`,
      );
    if (this.store.hasLaterAction(ev.item_id, ev.seq)) throw new DeskError(409, `undo the later action on ${ev.item_id} first`);
    const cur = this.store.state(ev.item_id);
    const restored = { ...ev.before, inflight_at: ev.before.inflight_at ?? null, seen_at: cur.seen_at };
    this.store.putState(restored);
    this.store.markUndone(ev.seq);
    this.changed();
    const { snoozed_at: _, acked_at: __, ...state } = restored;
    return { id: ev.item_id, state, action: ev.action as Action };
  }

  // ---------------------------------------------------------------- merging (in flight)

  // GET /api/inflight: your PRs in Merging, open ones first (latest activity on top), then any that merged or closed in the last 3 days.
  inflight(): InflightView {
    this.requireConfig();
    const snap = this.snapshot();
    const me = this.me().toLowerCase();
    const cutoff = new Date(this.now().getTime() - LANDED).toISOString();
    const rows: InflightRow[] = [];
    for (const e of snap.entries.values()) {
      const it = e.item;
      if (!e.state.inflight_at || it.kind !== "pr" || !e.analysis.signals.me.author) continue;
      if (it.state !== "open" && (it.closed_at ?? it.updated_at) < cutoff) continue;
      const verdicts = new Map<string, Item["reviews"][number]>();
      for (const r of it.reviews)
        if (
          !r.author_bot &&
          r.author.toLowerCase() !== me &&
          (r.state === "approved" || r.state === "changes_requested" || r.state === "dismissed")
        )
          verdicts.set(r.author.toLowerCase(), r);
      const by = (state: string) => [...verdicts.values()].filter((r) => r.state === state).map((r) => r.author);
      const row = {
        state: it.state,
        base: it.base,
        stacked: e.analysis.signals.pr.stacked,
        merge_method: it.merge_method ?? null,
        ci: it.ci,
        failing: it.checks_failed ?? [],
        approved_by: by("approved"),
        changes_by: by("changes_requested"),
        waiting_on: it.review_requests.map((r) => (r.type === "team" ? `@${r.reviewer}` : r.reviewer)),
        threads_unresolved: it.threads_unresolved,
        mergeable: it.mergeable,
        draft: it.draft,
      };
      rows.push({
        card: this.card(e, this.shownAt(e, snap), snap),
        ...row,
        waits_on: waitsOn(row),
        note: this.merging(it.id).note ?? null,
      });
    }
    rows.sort(
      (a, b) =>
        Number(a.state !== "open") - Number(b.state !== "open") ||
        (a.state === "open"
          ? (b.card.updated_at ?? "").localeCompare(a.card.updated_at ?? "")
          : (b.card.resolved_at ?? "").localeCompare(a.card.resolved_at ?? "")),
    );
    const lane = grouped(rows, (r) => r.card.id, snap.stacks);
    return {
      rows: lane,
      stacks: this.stacksOf(
        lane.map((r) => r.card),
        snap,
      ),
    };
  }

  merging(id: string): Merging {
    return (this.store.get(`sitter:${id}`) as Merging | null) ?? {};
  }

  // Your own open PR in Merging: what the coordinator's tools may touch.
  inflightEntry(ref: string): Entry {
    const e = this.pr(ref);
    if (!e.inflight) throw new DeskError(409, `${e.item.id} isn't one of your open PRs in Merging`);
    return e;
  }

  // One plain line from an agent, whatever it sent.
  line(text: string, what: string): string {
    // oxlint-disable-next-line no-control-regex -- one plain line, whatever the agent sent
    const t = text.replaceAll(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
    if (!t) throw new DeskError(400, `the ${what} is empty`);
    return t.length > MAX_LINE ? `${t.slice(0, MAX_LINE - 1)}…` : t;
  }

  // desk_note: the coordinator's latest status line on a PR in Merging, shown on its row.
  note(ref: string, text: string): { text: string } {
    const e = this.inflightEntry(ref);
    const note = { text: this.line(text, "note"), at: this.now().toISOString() };
    this.store.set(`sitter:${e.item.id}`, { ...this.merging(e.item.id), note });
    this.changed();
    return { text: note.text };
  }

  // desk_hand_back: the coordinator can't realistically get it merged. The PR leaves Merging for your desk with the line as its
  // why, on top. Nothing goes to GitHub.
  handBack(ref: string, why: string): { reason: string } {
    const e = this.inflightEntry(ref);
    const id = e.item.id;
    const reason = this.line(why, "reason");
    const before = this.store.state(id);
    const at = this.now().toISOString();
    this.store.putState({ ...before, inflight_at: null });
    this.store.logAction(id, "takeback", before, at, "agent");
    this.store.set(`sitter:${id}`, { ...this.merging(id), handback: { reason, at } });
    this.log(`an agent handed ${id} back: ${reason}`);
    this.changed();
    this.notifyNew();
    return { reason };
  }

  // POST /api/review/:id/reply: your reply to one of the PR's conversations, on your keypress. One of the desk's GitHub writes.
  async reply(ref: string, convoId: string, body: string): Promise<{ url: string }> {
    const e = this.pr(ref);
    const id = e.item.id;
    const text = body.trim();
    if (e.item.state !== "open") throw new DeskError(409, `can't reply on ${id}: it's ${e.item.state}`);
    if (!text) throw new DeskError(400, "the reply is empty");
    if (text.length > MAX_REPLY) throw new DeskError(400, `keep a reply under ${MAX_REPLY} characters`);
    if (!this.writer) throw new DeskError(409, "replying isn't available in this desk");
    const list = await this.convos.list(id).catch((err: unknown) => {
      throw new DeskError(502, `couldn't read the PR's conversations: ${(err as Error).message}`);
    });
    const c = list.find((x) => x.id === convoId);
    if (!c) throw new DeskError(404, `no conversation "${convoId}" on ${id}`);
    if (this.sending.has(convoId)) throw new DeskError(409, "already sending that reply");
    this.sending.add(convoId);
    let url: string;
    try {
      ({ url } = c.kind === "thread" ? await this.writer.reply(c.id, text) : await this.writer.comment(e.item.node_id, text));
    } catch (err) {
      throw new DeskError(502, `GitHub didn't take the reply: ${(err as Error).message}`);
    } finally {
      this.sending.delete(convoId);
    }
    this.store.logWrite(id, c.kind === "thread" ? "reply" : "comment", this.now().toISOString());
    this.log(`replied on ${id} to ${c.comments.at(-1)?.author ?? ""}${url ? ` (${url})` : ""}`);
    this.convos.forget(id);
    this.changed();
    void this.gh.refresh(id).then(() => this.sync());
    return { url };
  }

  // POST /api/review/:id/ready: your own draft's "Ready for review" (a a), one of the desk's GitHub writes, on your keypress.
  async markReady(ref: string): Promise<void> {
    const e = this.pr(ref);
    const id = e.item.id;
    if (!e.analysis.signals.me.author) throw new DeskError(409, `${id} isn't your PR`);
    if (e.item.state !== "open" || !e.item.draft) throw new DeskError(409, `${id} isn't an open draft`);
    if (!this.writer) throw new DeskError(409, "marking ready isn't available in this desk");
    if (this.approving.has(id)) throw new DeskError(409, `already marking ${id} ready`);
    this.approving.add(id);
    try {
      await this.writer.ready(e.item.node_id);
    } catch (err) {
      throw new DeskError(502, `GitHub didn't mark it ready: ${(err as Error).message}`);
    } finally {
      this.approving.delete(id);
    }
    this.store.logWrite(id, "ready", this.now().toISOString());
    this.log(`marked ${id} ready for review on GitHub`);
    void this.gh.refresh(id);
  }

  // ---------------------------------------------------------------- config

  // The hard rules in plain words: a board named in two spaces says which, and a why's fields read as "someone" or "some".
  getConfig(): ConfigDoc {
    const text = this.configText;
    const cfg = this.loaded?.config;
    const boards = cfg?.boards ?? [];
    const label = (b: BoardConfig) =>
      boards.filter((x) => x.name === b.name).length > 1
        ? `${b.name} (${cfg!.spaces.find((x) => x.id === b.space)?.name ?? b.space})`
        : b.name;
    const plain = (why: string) =>
      why.replaceAll(/\{([a-z_]+(?:\.[a-z_0-9]+)+)\}/g, (whole, field: string) => {
        const type = FIELDS.find((f) => f.path === field)?.type;
        return type === "number" ? "some" : type === "string" ? "someone" : whole;
      });
    const hard = boards.flatMap((b) =>
      b.rules.flatMap((r) =>
        r.hard && r.bucket !== "judge" ? [{ board: label(b), bucket: r.bucket, when: r.when, why: plain(r.why ?? "") }] : [],
      ),
    );
    return { path: this.configPath, text, hash: textHash(text), errors: this.configErrors, warnings: this.configWarnings, hard };
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
  putConfig(text: string, base?: string): { ok: boolean; errors: ConfigError[]; warnings: ConfigError[] } {
    if (base !== undefined && base !== this.configText && base !== textHash(this.configText))
      throw new DeskError(409, "config.toml changed on disk since you opened it; reload to see it, then reapply your edit");
    const { loaded, errors, warnings } = parseConfig(text, this.settings);
    if (!loaded) return { ok: false, errors, warnings };
    // A save never brings settings back into config.toml: an unmigrated desk would move them to settings.json on its next start.
    if (warnings.length) return { ok: false, errors: warnings, warnings: [] };
    const real = fs.realpathSync(this.configPath); // keep a symlinked config a symlink
    fs.writeFileSync(`${real}.tmp`, text);
    fs.renameSync(`${real}.tmp`, real);
    this.reloadConfig(true);
    return { ok: true, errors: [], warnings };
  }

  status(): { now: number; today: number; new: number; text: string } {
    const f = this.overview().focus;
    const parts = [`${f.now + f.today}`, f.now ? `●${f.now}` : "", f.new ? `+${f.new}` : ""].filter(Boolean);
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

// What a PR in Merging waits on, the first thing between it and a merge.
function waitsOn(r: Omit<InflightRow, "card" | "waits_on" | "note">): string | null {
  const names = (xs: string[]) => (xs.length > 2 ? `${xs.slice(0, 2).join(", ")} and ${xs.length - 2} more` : xs.join(", "));
  const threads = r.threads_unresolved;
  if (r.state !== "open") return null;
  if (r.draft) return "waits on ready for review";
  if (r.ci === "red") return "waits on a CI fix";
  if (r.mergeable === "conflict") return "waits on a merge conflict fix";
  if (r.changes_by.length) return `waits on a second look from ${names(r.changes_by)}`;
  if (r.ci === "pending") return "waits on CI";
  if (threads) return `waits on ${threads} unresolved ${threads === 1 ? "thread" : "threads"}`;
  if (!r.approved_by.length) return r.waiting_on.length ? `waits on a review from ${names(r.waiting_on)}` : "waits on a review";
  if (r.stacked) return `waits on ${r.base} to merge first`;
  return "ready to merge";
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
