// The desk: runs the connectors, keeps the event log, and serves the classified views and local actions.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stopAll } from "./children.ts";
import { DeskError } from "./errors.ts";
import { Automations } from "./automations.ts";
import type { GitHub } from "./github/index.ts";
import type { GitHubWriter } from "./github/write.ts";
import type { Connector, NewEvent } from "./connectors/connector.ts";
import { GitHubConnector, KEEP_RESOLVED } from "./connectors/github.ts";
import { resolution, type Resolution } from "./resolve.ts";
import { buildStacks, grouped, oneLinePerStack, stackRef, stackView, type Seat, type Stacks } from "./stacks.ts";
import { askedAt, owesReply, stage, verdicts } from "./stage.ts";
import { blockedOrder, dependencies, type DepFacts } from "./deps.ts";
import type {
  InlineAt,
  Action,
  ActivityPage,
  AgentStatus,
  AiReview,
  Ask,
  AskAbout,
  AskLines,
  AskPlace,
  Automation,
  AutomationRun,
  Inquiry,
  InquiryLink,
  InquiryOption,
  InquiryView,
  BoardConfig,
  BoardSummary,
  BoardView,
  Bucket,
  Card,
  ConfigDoc,
  ConfigError,
  Context,
  FocusView,
  GitHubAction,
  Handoff,
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
  Reviewer,
  ReviewView,
  SettingsView,
  SettingValue,
  Signals,
  Stack,
  Status,
  Until,
} from "./types.ts";
import { byPart, RANK, UNTIL } from "./types.ts";
import { report, webSentry } from "./sentry.ts";
import { defaultConfigText, migrateBotAsk, migrateConflict, migrateDrafts, migrateHard, parseConfig, type LoadedConfig } from "./config.ts";
import { analyze, happened, plainWhy, waitable, type Analysis } from "./signals.ts";
import { classify, placedBy, queueOrder, type BoardResult, type CompiledBoard } from "./rules.ts";
import { renderTemplate } from "./expr.ts";
import { emptyState, Store, type StateRow } from "./store.ts";
import { inQuietHours, notify } from "./notify.ts";
import { agentDir, CLAUDE_PAUSED, NOT_LOGGED_IN, reviewOrder, type PrText } from "./review.ts";
import * as agents from "./agents.ts";
import { DEFAULT_POLICY, Judge, judgeKey, textHash } from "./judge.ts";
import { Conversations } from "./conversation.ts";
import { askLine, Coordinator, NAME as COORDINATOR, REBASE, wakeFor } from "./coordinator.ts";
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
const ITEM_ACTIVITY = 8;
const NO_CONTEXT: Context = { me: "", teams: [], affinity: {}, repo_prs: {}, orgs: {}, refreshed_at: "" };
const ACTIVE = { done_at: null, snooze_until: null, snooze_when: null, snoozed_at: null, muted: false } satisfies Partial<StateRow>; // what statusOf() calls active
const AI_AT_ONCE = 2;
const WARM_AT_ONCE = 3; // the main page's diffs and conversations fetched ahead after a sync, this many at a time
const AI_RETRY = 30 * 60_000; // a failed AI review isn't retried on the same commit before this, unless you ask
const AI_PAUSE_AFTER = 2; // failures in a row (an expired login fails every PR) that pause AI reviews nobody asked for, for AI_RETRY
const agentKey = (s: Settings) => JSON.stringify([s["review.auto_ai"]]);
const searchKey = (s: Settings) => JSON.stringify([s["github.bots"], s["github.close_collaborator_min"]]); // {close_authors}
const LANDED = 3 * 24 * HOUR; // a PR in Merging that merged or closed stays there this long
const RESOLVED_SHOWN = 24 * HOUR; // Resolved lists the last day
const MAX_LINE = 300; // a hand-back's why, a note, a hand-off's why
const UNASKED = "nobody's asked to review it: add reviewers";
const UNASKED_AFTER = 10 / 60; // hours: a workflow or CODEOWNERS asks someone within moments of a PR opening or going ready
const MAX_FROM = 60; // which task sends it, as an inquiry's from
const MAX_REPLY = 5_000;
// What each More menu write does to % (the item), and what it did.
const GITHUB_VERB: Record<GitHubAction, [string, string]> = {
  close: ["close %", "closed %"],
  draft: ["convert % to a draft", "converted % to a draft"],
  ready: ["mark % ready for review", "marked % ready for review"],
  merge: ["merge %", "merged %"],
  reopen: ["reopen %", "reopened %"],
  request_changes: ["request changes on %", "requested changes on %"],
};
const MAX_ASK = 2_000; // your words to the coordinator, and your answer to an agent's question
const MAX_ANSWER = 6_000; // the coordinator's answer: room for a list and a few lines of code, as an inquiry's context
const ASKS_KEPT = 200;
const INQUIRIES_KEPT = 100;
const MAX_CONTEXT = 6_000; // an inquiry's context
const MIN_CONTEXT = 200; // a few sentences: the owner decides from its page alone
const MAX_LINKS = 12;
// what can't be seen or reorders what can: C0 but tab and newline, DEL, C1, bidi marks, zero-width marks, invisible operators, tags
const INVISIBLE =
  // oxlint-disable-next-line no-control-regex -- paragraphs stay; anything else invisible goes, bidi marks too
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu;

export { DeskError };

interface Entry {
  item: Item;
  analysis: Analysis;
  state: StateRow;
  status: Status;
  isNew: boolean;
  resolved: Resolution | null;
  inflight: boolean; // your open PR, handed off for merge: Merging has it, not the queue's buckets
  activityAt: string; // its activity, or a later merge of a PR it needs: what done and snoozes compare with
}

interface Snapshot {
  rev: number;
  at: number;
  entries: Map<string, Entry>;
  reviews: Map<string, AiReview>;
  boards: Map<string, { result: BoardResult; queries: string[]; unfetched: string[]; error?: string }>;
  best: Map<string, Placement>; // best placement across boards, active items only
  needs: Map<string, string>; // PRs the coordinator handed back, or ready ones nobody's asked to review: why, at the top
  unasked: Set<string>; // your ready PRs nobody's asked to review: their call to action is Add reviewers
  pins: Map<string, string>; // who pinned each pinned item: "them", or "the coordinator"
  auto: Map<string, string>; // an automation's pin: "<its name>: <its why>"
  handed: Map<string, Handoff>; // an agent's hand-off: why it's on your desk, until you act on it
  stacks: Stacks;
  deps: Map<string, DepFacts>; // open PRs' dependency facts (src/deps.ts)
}

// Without it a pin no board places (desk_add's, or one a board's search dropped) would be on no page at all.
const ADDED: CompiledBoard = {
  config: { id: "added", space: "", name: "Added", queries: [], rules: [], default: "today", default_why: "you added it", sort: "updated" },
  filter: null,
  priority: null,
  rules: [],
};
const boardsOf = (loaded: LoadedConfig) => [...loaded.boards, ADDED];

const normRef = (ref: string) => ref.trim().replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+).*$/, "$1/$2#$3");
const REF = /^(?:(?:([\w.-]+)\/)?([\w.-]+)#|#)?(\d+)$/;

// In Merging rather than anywhere in the queue: handed off, and not snoozed, muted or done.
const laneOwned = (e: Entry) => e.inflight && e.status === "active";

export interface DeskOptions {
  home: string;
  github: GitHub;
  now?: () => Date;
  notify?: (title: string, body: string) => void;
  log?: (msg: string) => void;
  review?: ReviewDeps; // diffs and AI reviews; without it the review view has no diff and no AI
  writer?: GitHubWriter; // the desk's GitHub writes; without it they're off
}

// Agents' hand-offs (desk_add) of an item, by the seq of the pin each made.
type Added = Record<string, Handoff>;

// A PR's Merging record, in kv under the babysitters' old `sitter:` prefix so hand-backs made before survive.
interface Merging {
  handback?: { reason: string; at: string };
  note?: { text: string; at: string };
  rebase?: string; // when the desk gave it to the coordinator to rebase, ready to merge but for a conflict
  back?: string; // when you brought it back with b
}

const MAX_POLICY = 20_000; // it goes with every judge call

// Through a symlink to the real file, swapped in whole so a watcher never reads half of it.
function replaceFile(file: string, text: string, backup = false): void {
  const real = fs.existsSync(file) ? fs.realpathSync(file) : file;
  if (backup) fs.copyFileSync(real, `${real}.bak`);
  fs.writeFileSync(`${real}.tmp`, text);
  fs.renameSync(`${real}.tmp`, real);
}

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
  coordinator: Coordinator;
  automations: Automations;

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
  warming = false;
  warmAgain = false; // a sync landed while warming: go round once more
  approving = new Set<string>(); // items with a GitHub write on its way (approve, ready, the More menu's)
  wrote = new Map<string, string>(); // a More menu write's item → its updated_at then: nothing more till a read shows the change
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
    this.coordinator = new Coordinator(this);
    this.automations = new Automations(this);
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
    this.coordinator.start();
    this.automations.start();
  }

  // Kills a judge call in progress.
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const c of this.connectors) c.stop();
    this.judge.stop();
    this.convos.stop();
    this.coordinator.close();
    this.automations.stop();
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

  mayNotify(): boolean {
    return this.settings["notify.enabled"] && !inQuietHours(this.settings["notify.quiet"], this.now());
  }

  changed(): void {
    this.rev++;
    this.snap = null;
    for (const fn of this.listeners) fn(this.rev);
  }

  me(): string {
    return this.ctx?.me ?? "";
  }

  // Where the tool-less agent calls run (the AI review, the judge, the read of conversations).
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

  // `base` is the hash from GET: a stale one means it changed since (an agent, an editor) and nothing is written.
  putPolicy(text: string, base?: string): { ok: true; hash: string } {
    if (base !== undefined && base !== this.policy.hash)
      throw new DeskError(409, "policy.md changed since you opened it; reload to see it, then reapply your edit");
    if (text.length > MAX_POLICY) throw new DeskError(400, `the policy is ${text.length} characters; keep it under ${MAX_POLICY}`);
    replaceFile(this.policyPath, text);
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
    const coordinator = this.settings["agent.coordinator"];
    const bypass = this.settings["agent.coordinator_bypass"];
    this.settings = this.readSettings();
    if (coordinator && !this.settings["agent.coordinator"]) void this.coordinator.stop();
    if (!coordinator && this.settings["agent.coordinator"]) void this.coordinator.flush();
    else if (bypass !== this.settings["agent.coordinator_bypass"] && this.settings["agent.coordinator"]) void this.coordinator.again();
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
    replaceFile(this.configPath, m.text, true);
    this.log(`moved settings from config.toml to ${this.settingsPath} (backup: config.toml.bak)`);
  }

  // Once each: the direct-ask rule of a config written before hard rules becomes hard (migrateHard), a direct ask a bot
  // added gets a hard rule too (migrateBotAsk), and the old rule sending all your drafts to later puts a draft you touched lately
  // on the desk (migrateDrafts), and the rule putting a merge conflict on the desk goes (migrateConflict).
  migrateRules(): void {
    const due = [
      { key: "hard_migrated", migrate: migrateHard, did: "made the rule for reviews asked of you by name hard" },
      { key: "bot_ask_migrated", migrate: migrateBotAsk, did: "added a hard rule for reviews a bot asked of you by name" },
      { key: "drafts_migrated", migrate: migrateDrafts, did: "put your drafts touched in the last 14 days on the desk" },
      { key: "conflict_migrated", migrate: migrateConflict, did: "removed the rule putting a merge conflict on your desk" },
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
      replaceFile(this.configPath, text, true);
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
    this.rebaseConflicts();
    this.handBackUnasked();
    this.trackBlocked();
    this.notifyNew();
    this.pumpAi();
    const kept = new Set(this.store.itemMeta().keys());
    this.store.pruneKv("review:", kept);
    this.store.pruneKv("pr:", kept);
    this.store.pruneKv("judge:", kept);
    this.store.pruneKv("sitter:", kept);
    this.store.pruneKv("added:", kept);
    this.store.pruneKv("shown:", kept);
    this.store.pruneKv("take:", kept);
    this.store.pruneKv("brief:", new Set()); // the AI review replaced briefs
    if (this.loaded) {
      const top = this.top(this.snapshot(), new Set());
      void this.convos.warm([...top.now, ...top.today].filter((c) => c.cta === "reply").map((c) => c.id));
    }
    void this.warmReviews();
    this.judge.pump();
  }

  // The main page's PRs' diffs and conversations, fetched ahead (only what changed: both are kept) so opening one doesn't wait.
  async warmReviews(): Promise<void> {
    if (this.warming) {
      this.warmAgain = true;
      return;
    }
    this.warming = true;
    try {
      do {
        this.warmAgain = false;
        if (this.stopped || !this.loaded || !this.review) return;
        const top = this.top(this.snapshot(), new Set());
        const ids = [...top.now, ...top.today]
          .filter((c) => c.kind === "pr")
          .map((c) => c.id)
          .values();
        const next = async () => {
          for (const id of ids) {
            if (this.stopped) return;
            if (!this.snapshot().entries.has(id)) continue; // gone since: both would throw on it
            await Promise.all([this.prText(id).catch(() => {}), this.convos.context(id).catch(() => {})]);
          }
        };
        await Promise.all(Array.from({ length: WARM_AT_ONCE }, next));
      } while (this.warmAgain);
    } finally {
      this.warming = false;
    }
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
    for (const e of events) {
      const what = wakeFor(e);
      if (what && this.store.state(e.item_id).inflight_at && this.store.itemsById([e.item_id]).get(e.item_id)?.state === "open")
        this.coordinator.wake(e.item_id, what);
    }
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

  // New on the queue once placed (not while Claude hasn't sorted it, nor what you pinned or added, nor your own draft: you just
  // opened it); a hand-back is on it, in Now. Per PR, not the one line per stack: a member coming to stand for it isn't news.
  notifyNew(): void {
    if (!this.loaded || !this.syncedAt) return;
    const snap = this.snapshot();
    const { now, today } = this.top(snap, new Set());
    const all = this.top(snap, new Set(), true);
    const shown = new Set([...now, ...today].map((c) => c.id));
    // Once on your desk it stays: a PR shown without its review (paused, or it failed) isn't held again.
    for (const c of [...now, ...today])
      if (c.kind === "pr" && !snap.reviews.has(c.id) && !this.store.get(`shown:${c.id}`)) this.store.set(`shown:${c.id}`, true);
    const held = [...all.now, ...all.today].map((c) => c.id).filter((id) => !shown.has(id));
    const me = this.me().toLowerCase();
    const queued = [...now, ...today]
      .filter(
        (c) =>
          c.placed_by !== "pending" &&
          c.placed_by !== "pin" &&
          c.board !== ADDED.config.id &&
          !(c.draft && c.author.toLowerCase() === me) &&
          !snap.auto.has(c.id), // its automation's run told you
      )
      .map((c) => ({ id: c.id, ref: shortRef(c), why: c.why }));
    // Held on the first pass, they were there before you looked, as the rest were.
    const prev = this.store.get("notified_queue") as string[] | null;
    const keep = prev === null ? held : held.filter((id) => prev.includes(id));
    this.store.set("notified_queue", [...queued.map((x) => x.id), ...keep]);
    const fresh = prev === null ? [] : queued.filter((x) => !prev.includes(x.id));
    if (!fresh.length || !this.mayNotify()) return;
    const [only] = fresh;
    const body =
      fresh.length === 1 && only ? `${only.ref} · ${only.why}` : `${fresh.length} need you: ${fresh.map((x) => x.ref).join(", ")}`;
    this.notify("Review Desk", body);
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
    // Who blocks whom, before any status: a PR it needs merging is news for it, and the rules read the facts as fields.
    const stacks = buildStacks(items);
    const deps = dependencies(items, stacks);
    for (const item of items) {
      const analysis = analyze(item, ctx, loaded.config, now);
      let state = states.get(item.id) ?? emptyState(item.id);
      // Once it happens the snooze is over, so CI going red again later doesn't snooze it again.
      if (state.snooze_when && happened(state.snooze_when, analysis.signals, item, ctx.me)) {
        state = { ...state, snooze_when: null, snoozed_at: null };
        this.store.putState(state);
      }
      const isNew = analysis.others_at !== null && analysis.others_at > (state.seen_at ?? baseline);
      const resolved = resolution(item, analysis.signals, this.settings, ctx.teams);
      const inflight = !!state.inflight_at && item.kind === "pr" && item.state === "open" && analysis.signals.me.author;
      const freed = deps.get(item.id)?.merged.at(-1)?.at ?? "";
      const activityAt = freed > analysis.activity_at ? freed : analysis.activity_at;
      entries.set(item.id, { item, analysis, state, status: statusOf(state, activityAt, now), isNew, resolved, inflight, activityAt });
    }
    for (const [id, f] of deps) {
      const pr = entries.get(id)!.analysis.signals.pr;
      const root = f.root ? entries.get(f.root) : undefined;
      Object.assign(pr, { requires: f.requires, blocked_by: f.open, requires_closed: f.closed, blocks: f.blocks });
      if (root) {
        pr.blocked = true;
        pr.blocker = `${shortRef(root.item)}${f.through ? ` (through ${f.through})` : ""}`;
        pr.blocker_waits = root.inflight ? "is in Merging" : root.analysis.signals.pr.waits;
      }
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
    const pushed = this.store.prefixed<{ name: string; why: string }>("pushed:");
    const added = this.store.prefixed<Added>("added:");
    const auto = new Map<string, string>();
    const handed = new Map<string, Handoff>();
    const coordinatorAdded = new Set<string>();
    for (const e of entries.values()) {
      if (!e.state.pinned) continue;
      const pin = this.store.lastPin(e.item.id);
      const by = pin?.agent;
      // An automation's pin is yours: you wrote what it does.
      pins.set(e.item.id, by === "coordinator" ? "the coordinator" : "them");
      const pu = by?.startsWith("automation:") ? pushed.get(e.item.id) : undefined;
      if (pu) auto.set(e.item.id, `${pu.name}: ${pu.why}`);
      // The why goes with the pin that brought it, until you act on the item: then it's yours, as an automation's pin is.
      const ad = pin && added.get(e.item.id)?.[pin.seq];
      if (ad && by === "coordinator") coordinatorAdded.add(e.item.id);
      if (ad && !this.store.hasLaterAction(e.item.id, pin.seq)) handed.set(e.item.id, ad);
    }
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
            !e ||
            a.policy !== this.policy.hash ||
            a.key !== judgeKey(e.item, e.analysis.activity_at, reviews.get(id), pins.get(id), e.analysis.signals.pr.blocker);
          return { bucket: a.bucket, why: a.why, pending: stale };
        }
      : undefined;
    for (const board of boardsOf(loaded)) {
      const queries = this.gh.queriesFor(loaded, board);
      const ids = new Set<string>();
      for (const q of queries) for (const id of hits.get(q) ?? []) ids.add(id);
      // A coordinator's desk_add too, after you act on it, so it doesn't vanish once its pin stops counting as yours.
      if (board === ADDED)
        for (const [id, by] of pins)
          if ((by === "them" || coordinatorAdded.has(id)) && ![...boards.values()].some((b) => b.result.placements.has(id))) ids.add(id);
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
          created_at: e.item.created_at,
          activity_at: e.analysis.activity_at,
          pinned: e.state.pinned,
          // Your pin keeps it on your desk; the coordinator's is an opinion Claude weighs.
          floor: pins.get(e.item.id) === "them" ? "today" : undefined,
          floor_why: auto.get(e.item.id),
          // Resolved and in-flight items leave the buckets (and the caps) like cleared ones.
          active: e.status === "active" && !e.resolved && !e.inflight,
          kept: kept.has(e.item.id) || recent(e),
          ai: call(e),
        })),
        judge,
        this.settings["queue.quiet_days"],
      );
      if (board === ADDED) for (const [id, p] of result.placements) p.why = auto.get(id) ?? p.why;
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
      // Another PR blocks it and your rules keep it in Blocked: the hand-back waits there until that PR merges.
      if (e.analysis.signals.pr.blocked && best.get(e.item.id)?.bucket === "blocked") continue;
      // Held until it unblocked: trackBlocked() logged when, and which PR merged.
      const freed = this.store.activity({ after: 0, limit: 20, item: e.item.id, latest: true }).find((x) => x.kind === "unblocked");
      const merged = freed && freed.at >= back.at ? wakeFor(freed) : "";
      const why = `${merged ? `${merged} \u00b7 ` : ""}handed back: ${back.reason}`;
      needs.set(e.item.id, why);
      const board = [...boards.values()].map((b) => b.result.placements.get(e.item.id)?.board).find(Boolean) ?? "";
      best.set(e.item.id, { board, bucket: "now", rule_bucket: "now", rule: null, why, trace: [] });
    }
    // Your ready PR nobody's asked to review: Add reviewers is its call to action, as m refuses it. Past the moments a
    // workflow takes, while a board lists it and it isn't quiet as Later counts it, it's back on top of your desk too.
    const asking = new Set<string>();
    const quietHours = this.settings["queue.quiet_days"] * 24;
    for (const e of entries.values()) {
      const it = e.item;
      const sig = e.analysis.signals;
      if (!sig.me.author || !sig.pr.unasked || e.inflight || e.status !== "active" || e.resolved) continue;
      asking.add(it.id);
      if (sig.pr.blocked && best.get(it.id)?.bucket === "blocked") continue;
      if (needs.has(it.id) || !this.stuckUnasked(e)) continue; // handed back: its reason says so
      const quiet = quietHours > 0 && !e.state.pinned && sig.item.updated_hours >= quietHours;
      if (quiet || ![...boards.values()].some((b) => b.result.placements.has(it.id))) continue;
      needs.set(it.id, UNASKED);
      const board = [...boards.values()].map((b) => b.result.placements.get(it.id)?.board).find(Boolean) ?? "";
      best.set(it.id, { board, bucket: "now", rule_bucket: "now", rule: null, why: UNASKED, trace: [] });
    }
    return {
      rev,
      at: now.getTime(),
      entries,
      reviews,
      boards,
      best,
      needs,
      unasked: asking,
      pins,
      auto,
      handed,
      stacks,
      deps,
    };
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
    const me = e.analysis.signals.me;
    const wake = e.inflight ? [] : waitable(e.analysis.signals, it, this.me());
    const team = me.requested && !me.requested_direct && me.requested_team ? me.requested_team : "";
    const by = p && !e.inflight ? placedBy(p) : undefined; // your PR in Merging is the coordinator's
    const stack = stackRef(snap.stacks, it.id);
    const actions = this.actions(e);
    const via = e.analysis.signals.author.via.replace(/^@/, "");
    const sig = e.analysis.signals.pr;
    const st = stage(it, me.author ? this.me() : it.author);
    const shown = sig.blocked && (st === "approved" || st === "waiting for review") ? "blocked" : st;
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
      by: me.author ? "you" : via || it.author,
      ...(shown && { stage: shown }),
      bucket: p?.bucket ?? "fyi",
      why: e.resolved?.reason ?? p?.why ?? "",
      ...(snap.handed.has(it.id) && { handoff: snap.handed.get(it.id) }),
      demoted: p?.demoted,
      board: p?.board ?? "",
      boards,
      chips,
      ci: it.ci,
      review: it.review_decision,
      draft: it.draft,
      created_at: it.created_at,
      updated_at: it.updated_at,
      activity_at: e.analysis.activity_at,
      waiting_since: e.analysis.waiting_since,
      new: e.isNew && !e.resolved && e.status === "active", // a resolved or cleared row needs nobody, so no dot
      pinned: e.state.pinned,
      status: e.status,
      snooze_until: e.status === "snoozed" ? e.state.snooze_until : null,
      snooze_when: e.status === "snoozed" && e.state.snooze_when ? (e.state.snooze_when.split(":")[0] as Until) : null,
      ...(wake.length > 0 && { wake_on: wake }),
      ...(e.status === "done" && e.state.done_at ? { done_at: e.state.done_at } : {}),
      verdict: snap.reviews.get(it.id)?.head_oid === it.head_oid ? snap.reviews.get(it.id)!.verdict : null,
      resolved: e.resolved?.reason ?? null,
      resolved_at: e.resolved ? (e.resolved.at ?? it.updated_at) : null,
      inflight: e.inflight,
      ...(!e.inflight && snap.needs.has(it.id) && { handed_back: true }),
      // Even with red CI: getting it green is the coordinator's once it's ready, so the desk never holds this back.
      ...(it.kind === "pr" && it.draft && it.state === "open" && me.author && this.writer && { cta: "ready" as const }),
      ...(snap.unasked.has(it.id) && this.writer && { cta: "reviewers" as const }),
      ...(actions.length > 0 && { actions }),
      ...(by && { placed_by: by }),
      ...(stack && { stack }),
      ...(sig.blocked && { blocker: { id: snap.deps.get(it.id)!.root!, ref: sig.blocker, waits: sig.blocker_waits } }),
      ...(sig.blocks.length > 0 && { blocks: sig.blocks }),
    };
  }

  // A stack member's place on the queue, for the stack's views.
  seat(id: string, snap: Snapshot): Seat {
    const e = snap.entries.get(id)!;
    const p = snap.best.get(id);
    return { bucket: p?.bucket ?? null, why: e.resolved?.reason ?? p?.why ?? "" };
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
    const counts = { now: 0, today: 0, blocked: 0, later: 0, fyi: 0, hide: 0, cleared };
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
      sentry: webSentry(),
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
        asks: this.inquiries().filter((q) => !q.answer).length,
      },
      inflight: { total: [...snap.entries.values()].filter((e) => e.inflight).length },
      agent: this.settings["agent.coordinator"],
      rate_limit: this.gh.api.rateLimit(),
    };
  }

  // Your PRs back on top of the queue: handed back, or ready and nobody's asked to review them.
  needsCards(snap: Snapshot, seen: Set<string>): Card[] {
    const out: Card[] = [];
    for (const id of snap.needs.keys()) {
      seen.add(id);
      out.push(this.queueCard(snap.entries.get(id)!, snap.best.get(id)!, snap));
    }
    return out;
  }

  // A Now or Today card carries its AI review, to skim before opening it.
  queueCard(e: Entry, p: Placement, snap: Snapshot): Card {
    const c = this.card(e, p, snap);
    const it = e.item;
    c.preflight = this.preflight(e, snap);
    const sig = e.analysis.signals.me;
    // Waiting on your review: asked of you, or pushed to since your review; not a draft, which nobody waits on yet.
    const asked = it.kind === "pr" && !it.draft && (sig.requested || sig.pushed_since_review);
    c.group = c.handed_back ? "back" : it.kind === "pr" && sig.author ? "mine" : asked ? "review" : "other";
    if (it.kind === "pr" && sig.author && this.replyOnly(e) && c.cta !== "reviewers") c.cta = "reply"; // asking someone comes first
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
      reviewing: this.reviewing(snap),
      cards: this.settings["queue.cards"],
      paused: this.paused(),
    };
  }

  // Someone else's open PR reaches your desk once Claude has reviewed it: until its first AI review is written it waits,
  // unless AI reviews are off or paused, or this commit's failed. Once shown (`shown:<id>`, or you put it there) it stays.
  awaitsAi(e: Entry, snap: Snapshot): boolean {
    const it = e.item;
    if (!this.autoAi() || it.kind !== "pr" || it.state !== "open" || e.analysis.signals.me.author) return false;
    if (snap.reviews.has(it.id) || this.store.get(`shown:${it.id}`)) return false;
    return this.aiErrors.get(it.id)?.head_oid !== it.head_oid;
  }

  // How many would be in Now or Today but for Claude's review.
  reviewing(snap: Snapshot): number {
    return [...snap.best].filter(([id, p]) => (p.bucket === "now" || p.bucket === "today") && this.awaitsAi(snap.entries.get(id)!, snap))
      .length;
  }

  // Now and Today in the queue's order, which the AI reviews run in too: what was handed back, then each board's. `all` keeps
  // what waits on Claude's first review (awaitsAi), for the AI reviews and the notifications.
  top(snap: Snapshot, seen: Set<string>, all = false): FocusView["sections"] {
    const loaded = this.requireConfig();
    const sections: FocusView["sections"] = { now: this.needsCards(snap, seen), today: [] };
    for (const bucket of ["now", "today"] as const) {
      for (const board of boardsOf(loaded)) {
        for (const id of snap.boards.get(board.config.id)!.result.order[bucket]) {
          const p = snap.best.get(id);
          if (seen.has(id) || !p || p.bucket !== bucket || p.board !== board.config.id) continue;
          seen.add(id);
          const e = snap.entries.get(id)!;
          if (!all && this.awaitsAi(e, snap)) continue;
          sections[bucket].push(this.queueCard(e, p, snap));
        }
      }
    }
    return { now: byPart(queueOrder(sections.now, this.me())), today: byPart(queueOrder(sections.today, this.me())) };
  }

  // The single surface: every item once, at its best placement across boards.
  queue(): QueueView {
    const loaded = this.requireConfig();
    const snap = this.snapshot();
    const seen = new Set<string>();
    const sections: QueueView["sections"] = { ...this.top(snap, seen), blocked: [], later: [], fyi: [] };
    const reviewing = this.reviewing(snap);
    const hidden: Card[] = [];
    for (const bucket of ["blocked", "later", "fyi", "hide"] as const) {
      for (const board of boardsOf(loaded)) {
        for (const id of snap.boards.get(board.config.id)!.result.order[bucket]) {
          const p = snap.best.get(id);
          if (seen.has(id) || !p || p.bucket !== bucket || p.board !== board.config.id) continue;
          seen.add(id);
          (bucket === "hide" ? hidden : sections[bucket]).push(this.card(snap.entries.get(id)!, p, snap));
        }
      }
    }
    const leads = oneLinePerStack(sections, ["now", "today", "blocked", "later", "fyi"], snap.stacks);
    const blockedSince = (this.store.get("blocked") as Record<string, { since: string }> | null) ?? {};
    const aged = (c: Card): Card => {
      const e = snap.entries.get(c.id)!;
      const asked = e.analysis.signals.me.author && e.analysis.signals.pr.waiting_on.length > 0;
      return { ...c, waiting_since: blockedSince[c.id]?.since ?? (asked ? askedAt(e.item, this.me()) : c.waiting_since) };
    };
    // Your PRs in Merging that another PR blocks: Merging has them, and Blocked lists them in their chain too.
    const merging = [...snap.entries.values()]
      .filter((e) => laneOwned(e) && e.analysis.signals.pr.blocked)
      .map((e) => {
        const pr = e.analysis.signals.pr;
        const c = this.card(e, this.shownAt(e, snap), snap);
        c.why = `in Merging \u00b7 blocked by ${pr.blocker}, which ${pr.blocker_waits}`;
        return c;
      });
    sections.blocked = blockedOrder([...sections.blocked, ...merging].map(aged));
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
    for (const board of boardsOf(loaded)) {
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
      inquiries: this.inquiries().filter((q) => !q.answer),
      sections,
      reviewing,
      hidden,
      cleared,
      resolved: resolved.sort((a, b) => (b.resolved_at ?? "").localeCompare(a.resolved_at ?? "")),
      cards: this.settings["queue.cards"],
      paused: this.paused(),
      stacks: this.stacksOf([...leads, ...merging, ...hidden, ...cleared, ...resolved], snap),
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
        blocked: cards(b.result.order.blocked),
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
    const m = REF.exec(normRef(ref));
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
    const placements = boardsOf(loaded)
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
      held: this.awaitsAi(e, snap) && ["now", "today"].includes(snap.best.get(id)?.bucket ?? ""),
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

  // GET /api/review/:id. Opening a PR starts its AI review (auto_ai, none for this commit) and Claude's read; `ahead` neither.
  async reviewView(ref: string, ahead = false): Promise<ReviewView> {
    const id = this.pr(ref).item.id;
    let files: ReviewFile[] = [];
    let diffHead: string | null = null;
    let filesError: string | null = null;
    const talk = this.convos.view(id, !ahead);
    try {
      const t = await this.prText(id);
      files = t.files;
      diffHead = t.head ?? null;
    } catch (err) {
      filesError = (err as Error).message;
      report(err, "diff", id);
    }
    const snap = this.snapshot();
    const e = snap.entries.get(id)!;
    if (!ahead && this.autoAi() && this.wantsAi(e, snap)) void this.generate(id).catch(() => {});
    const d = this.item(id);
    const err = this.aiErrors.get(id);
    const own = err?.head_oid === e.item.head_oid ? err.message : null;
    // A PR the desk would have reviewed on its own says why it didn't.
    const paused = this.autoAiOn() && this.aiPausedNow() && this.wantsAi(e, snap) ? `AI reviews are paused: ${this.aiPaused!.why}` : null;
    return {
      card: this.replyOnly(e) && d.card.cta !== "reviewers" ? { ...d.card, cta: "reply" } : d.card,
      item: d.item,
      handoff_prompt: d.handoff_prompt,
      files,
      diff_head: diffHead ?? e.item.head_oid,
      files_error: filesError,
      order: reviewOrder(files, d.ai, d.ai_stale),
      ai: d.ai,
      ai_stale: d.ai_stale,
      ai_error: this.generating.has(id) ? null : (own ?? paused),
      generating: this.generating.has(id),
      approve: this.canApprove(e),
      activity: d.activity,
      stack: d.stack,
      asks: this.asks(id),
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
      throw Object.assign(new DeskError(502, (err as Error).message), { cause: err });
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
      this.notifyNew(); // a PR that waited on this review is on your desk now
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
        `AI review of ${id}: ${ai.verdict}, ${ai.concerns.length} concerns, ${ai.notes.length} notes${ai.dropped ? ` (${ai.dropped} the check dropped)` : ""}, ${ai.chunks ? `${ai.chunks.ranked.length} of ${ai.chunks.total} chunks ranked` : "no ranking"}`,
      );
      this.retryAgents(NOT_LOGGED_IN);
      return ai;
    } catch (err) {
      if (this.stopped) throw err; // killed with the desk
      const message = (err as Error).message;
      report(err, "ai_review", id);
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
    const top = this.top(snap, new Set(), true);
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

  // POST /api/review/:id/approve: one of the desk's GitHub writes (with Send), on your click; `head` is the commit the view showed, so a newer push isn't approved unread.
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
    this.doneAfterWrite(id);
    // The PR itself first, so it resolves as "you approved" within seconds; the search index lags, so a full pass alone wouldn't see it.
    void this.gh.refresh(id).then(() => this.sync());
    return { url };
  }

  // The More menu's GitHub writes this item allows now. A PR in Merging is the coordinator's: Back to desk brings it back first.
  actions(e: Entry): GitHubAction[] {
    const it = e.item;
    const me = e.analysis.signals.me;
    if (!this.writer || e.inflight || this.wrote.get(it.id) === it.updated_at) return [];
    // The real author: a bot's "via" line is anyone's to edit, so it never unlocks a write.
    const mine = it.author.toLowerCase() === this.me().toLowerCase();
    if (it.kind === "issue") return it.state === "open" && (mine || me.assignee) ? ["close"] : [];
    if (!me.author) return it.state === "open" ? ["request_changes"] : [];
    if (!mine) return [];
    if (it.state === "closed") return ["reopen"];
    if (it.state !== "open") return [];
    return [
      "close",
      ...(it.draft ? (["ready"] as const) : (["draft"] as const)),
      // Stacked: it would merge into the PR below, which Merging says it waits on.
      ...(readyToMerge(it) && !e.analysis.signals.pr.stacked && it.merge_method && it.head_oid ? (["merge"] as const) : []),
    ];
  }

  // POST /api/github: a More menu write, on your click in the desk's window. A change request needs `head`
  // (the commit its review showed), as approve does; a merge given one must match it, and is pinned to the desk's head either way.
  async githubAct(ref: string, action: GitHubAction, opts: { head?: string; body?: string } = {}): Promise<{ url: string }> {
    this.requireConfig();
    const e = this.snapshot().entries.get(this.resolve(ref))!;
    const it = e.item;
    const id = it.id;
    const [verb, done] = GITHUB_VERB[action].map((x) => x.replace("%", id));
    if (!this.actions(e).includes(action)) throw new DeskError(409, `can't ${verb} now`);
    if (action === "request_changes" && opts.head === undefined) throw new DeskError(400, "need head_oid");
    const pinned = action === "merge" || action === "request_changes";
    if (pinned && opts.head !== undefined && opts.head !== it.head_oid)
      throw new DeskError(409, `can't ${verb}: it has new commits since you opened it`);
    const body = opts.body?.trim() ?? "";
    if (action === "request_changes" && !body) throw new DeskError(400, "say what needs to change");
    if (body.length > MAX_REPLY) throw new DeskError(400, `keep it under ${MAX_REPLY} characters`);
    if (this.approving.has(id)) throw new DeskError(409, `already writing to ${id} on GitHub`);
    const w = this.writer!;
    this.approving.add(id);
    try {
      let url = "";
      try {
        if (action === "close") await (it.kind === "issue" ? w.closeIssue(it.node_id) : w.close(it.node_id));
        else if (action === "draft") await w.draft(it.node_id);
        else if (action === "ready") await w.ready(it.node_id);
        else if (action === "merge") await w.merge(it.node_id, it.head_oid, it.merge_method!);
        else if (action === "reopen") await w.reopen(it.node_id);
        else ({ url } = await w.requestChanges(it.node_id, it.head_oid, body));
      } catch (err) {
        throw new DeskError(502, `couldn't ${verb} on GitHub: ${(err as Error).message}`);
      }
      this.store.logWrite(id, action, this.now().toISOString());
      this.log(`${done} on GitHub${url ? ` (${url})` : ""}`);
      // Closed, merged or changes asked for: yours is done. Reopened: it's back on the desk. A draft is still yours to finish.
      if (action === "reopen") {
        // The done its close put on it goes, and what it was before (snoozed, muted) comes back with it.
        const ev = this.store.lastActionFor(id);
        if (ev?.action === "done") this.undo(ev.seq);
        else if (this.store.state(id).done_at) this.act(id, "restore");
      } else if (action !== "draft") this.doneAfterWrite(id);
      this.changed();
      // Before answering, so the window shows it closed (or a draft) at once and its u finds it so; held till then,
      // since actions() reads the snapshot this refresh replaces.
      await this.gh.refresh(id);
      // A refresh that failed or was skipped (rate limit) leaves the old state, which would offer the same write again.
      if (action !== "request_changes") this.wrote.set(id, it.updated_at);
      return { url };
    } finally {
      this.approving.delete(id);
    }
  }

  // ---------------------------------------------------------------- actions

  // You acted on it in the desk, so your part is done: it leaves the desk at once, as Done does, and comes back when someone
  // else acts. A PR in Merging stays the coordinator's.
  private doneAfterWrite(id: string): void {
    if (this.snapshot().entries.get(id)?.inflight) return;
    this.act(id, "done");
  }

  // `agent`: not the desk's own window. Hand-offs are yours.
  act(ref: string, action: Action, until?: string, agent?: string): { state: ItemState; undo_seq: number } {
    const id = this.resolve(ref);
    if (action === "undo") {
      const ev = this.store.lastActionFor(id);
      if (!ev) throw new DeskError(404, `nothing to undo for ${id}`);
      return { state: this.undo(ev.seq, agent).state, undo_seq: 0 };
    }
    // The coordinator merges what's in Merging, so only you put a PR there.
    if (agent && action === "inflight") throw new DeskError(403, "hand a PR off for merge from the desk's window");
    const now = this.now();
    const before = this.store.state(id);
    const s: StateRow = { ...before };
    const entry = this.snapshot().entries.get(id)!;
    // The coordinator keeps working on it whatever its status, so it comes back to the desk first.
    if (entry.inflight && (action === "done" || action === "snooze" || action === "mute"))
      throw new DeskError(409, `${id} is in Merging, so your agent has it; bring it back to the desk first`);
    // Resurface on activity newer than what you saw, not newer than the click: a sync may land just after it.
    const seen = entry.activityAt;
    switch (action) {
      case "done":
        s.done_at = now.toISOString();
        s.acked_at = seen;
        s.snooze_until = null;
        s.snooze_when = null;
        s.snoozed_at = null;
        break;
      case "snooze": {
        const u = until ?? "tomorrow";
        if (u === "activity") {
          s.done_at = now.toISOString();
          s.acked_at = seen;
          s.snooze_until = null;
          s.snooze_when = null;
          break;
        }
        if (Object.hasOwn(UNTIL, u)) {
          const can = waitable(entry.analysis.signals, entry.item, this.me());
          if (!can.includes(u as Until))
            throw new DeskError(
              409,
              `${id} can't wait until ${UNTIL[u as Until]}${can.length ? `; it can until ${can.map((x) => UNTIL[x]).join(", ")}` : ""}`,
            );
          s.snooze_when = u === "push" ? `push:${entry.item.head_oid}` : u;
          s.snooze_until = null;
          s.snoozed_at = now.toISOString();
          s.acked_at = seen;
          s.snooze_on_activity = false;
          s.done_at = null;
          break;
        }
        s.snooze_when = null;
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
        Object.assign(s, ACTIVE);
        break;
      case "inflight":
        // Handed off for merge: only your own open PR, and the coordinator takes it from here.
        if (entry.item.kind !== "pr" || !entry.analysis.signals.me.author || entry.item.state !== "open")
          throw new DeskError(409, `only your own open PRs are handed off for merge; ${id} isn't one`);
        if (s.inflight_at) throw new DeskError(409, `${id} is in Merging already`);
        // Ready for review is yours, so a draft in Merging would wait on you there.
        if (entry.item.draft) throw new DeskError(409, `${id} is a draft: mark it ready for review first`);
        // Nobody would review it, so the coordinator would wait on nothing.
        if (entry.analysis.signals.pr.unasked) throw new DeskError(409, `nobody's asked to review ${id}: add reviewers first`);
        s.inflight_at = now.toISOString();
        // Merging has it now, so it isn't done, snoozed or muted in the queue any more (undo brings that back).
        Object.assign(s, ACTIVE);
        this.store.set(`sitter:${id}`, null); // a fresh start: no hand-back or note from last time
        break;
      case "takeback":
        if (!s.inflight_at) throw new DeskError(409, `${id} isn't in Merging`);
        s.inflight_at = null;
        this.store.set(`sitter:${id}`, { ...this.merging(id), back: now.toISOString() }); // yours now: not sent to rebase
        break;
      default:
        throw new DeskError(400, `unknown action "${action as string}"`); // reachable: the HTTP body isn't checked against Action
    }
    // An automation's pin was its opinion; once you deal with the item it's yours, and undo brings the pin back.
    if (["done", "snooze", "mute", "inflight"].includes(action) && s.pinned && this.store.lastPin(id)?.agent?.startsWith("automation:"))
      s.pinned = false;
    this.store.putState(s);
    const seq = action === "seen" ? 0 : this.store.logAction(id, action, before, now.toISOString());
    // What you bring onto your desk is there now, reviewed or not.
    if (action === "pin" || action === "restore" || action === "unmute") this.store.set(`shown:${id}`, true);
    this.changed();
    if (action === "inflight") this.coordinator.wake(id, "handed off");
    const { snoozed_at: _, acked_at: __, ...state } = s;
    return { state, undo_seq: seq };
  }

  // `agent`: not the desk's own window. Hand-offs are yours.
  undo(seq?: number, agent?: string): { id: string; state: ItemState; action: Action } {
    const ev = this.store.lastAction(seq);
    if (!ev) throw new DeskError(404, "nothing to undo");
    if (agent && (ev.action === "inflight" || ev.action === "takeback"))
      throw new DeskError(
        409,
        `undo ${ev.action === "inflight" ? "a hand-off for merge" : "bringing a PR back to the desk"} in the desk's window`,
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

  // `why` and `from`: an agent's hand-off, what needs you and which task sends it; the item's why while this pin stays.
  async add(ref: string, why?: string, from?: string): Promise<{ item: ItemDetail; undo_seq: number }> {
    const note = why === undefined ? null : this.line(why, "why");
    const who = note === null || !from?.trim() ? "" : this.line(from, "from", MAX_FROM);
    const id = await this.hold(ref);
    // A pin alone leaves a done, snoozed or muted item hidden; one undo seq takes back both.
    const before = this.store.state(id);
    this.store.putState({ ...before, ...ACTIVE, pinned: true });
    // The coordinator's desk_add is its opinion, which Claude weighs: no floor, as the old desk-run coordinator's pins.
    const undo_seq = this.store.logAction(id, "pin", before, this.now().toISOString(), who === COORDINATOR ? "coordinator" : undefined);
    if (note !== null)
      this.store.set(`added:${id}`, { ...(this.store.get(`added:${id}`) as Added | null), [undo_seq]: { why: note, from: who } });
    this.changed();
    this.warmAdded(id);
    return { item: this.item(id), undo_seq };
  }

  // An automation's find: on your desk as desk_add puts it, with its why. One that's on your queue already stays as it is;
  // one you dealt with (done, snoozed, muted, handed off for merge), or that nobody needs now, stays that way too.
  async push(ref: string, why: string, a: Automation): Promise<AutomationRun["items"][number]> {
    const id = await this.hold(ref);
    const note = this.line(why, "why", 300);
    this.store.set(`pushed:${id}`, { automation: a.id, name: a.name, why: note, at: this.now().toISOString() });
    const snap = this.snapshot();
    const e = snap.entries.get(id)!;
    const queued = ["now", "today"].includes(snap.best.get(id)?.bucket ?? "");
    let outcome: AutomationRun["items"][number]["outcome"] = "kept";
    if (e.resolved) outcome = "resolved";
    else if (e.status !== "active" || e.inflight) outcome = "left";
    else if (!e.state.pinned && !queued) {
      this.store.putState({ ...e.state, pinned: true });
      this.store.logAction(id, "pin", e.state, this.now().toISOString(), `automation:${a.id}`);
      outcome = "added";
      this.changed(); // the pump reads the snapshot: it must have the pin
      this.warmAdded(id);
    }
    this.changed();
    return { item_id: id, why: note, outcome };
  }

  // A PR's pre-review starts as opening it would, not generate(): an agent may add many at once, and the pump keeps to AI_AT_ONCE.
  warmAdded(id: string): void {
    if (this.snapshot().entries.get(id)!.item.kind === "pr") {
      void this.prText(id).catch(() => {});
      void this.convos.warm([id]);
    }
    this.pumpAi();
    this.judge.pump();
  }

  // The item's id, fetched read only if the desk doesn't hold it.
  async hold(ref: string): Promise<string> {
    this.requireConfig();
    const r = normRef(ref);
    if (!REF.test(r)) throw new DeskError(400, `can't read "${ref}"; use owner/repo#123 or a GitHub URL`);
    let id: string;
    try {
      id = this.resolve(r);
    } catch (e) {
      if (!(e instanceof DeskError) || e.status !== 404) throw e;
      const [, repo, num] = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(r) ?? [];
      if (repo === undefined || num === undefined)
        throw new DeskError(400, `"${ref}" isn't on the desk; give owner/repo#123 or its URL so the desk can fetch it`);
      const got = await this.gh.fetchOne(repo, Number(num)).catch((err: unknown) => {
        throw new DeskError(502, (err as Error).message);
      });
      if (got === null) throw new DeskError(404, `GitHub has no PR or issue ${r}`);
      this.changed();
      id = got;
    }
    return id;
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
      const m = this.merging(it.id);
      const { approved_by, changes_by } = verdicts(it, me);
      const row = {
        state: it.state,
        base: it.base,
        stacked: e.analysis.signals.pr.stacked,
        merge_method: it.merge_method ?? null,
        ci: it.ci,
        failing: it.checks_failed ?? [],
        approved_by,
        changes_by,
        waiting_on: it.review_requests.map((r) => (r.type === "team" ? `@${r.reviewer}` : r.reviewer)),
        threads_unresolved: it.threads_unresolved,
        mergeable: it.mergeable,
        draft: it.draft,
        rebase: !!m.rebase,
        blocked_by: e.analysis.signals.pr.blocked
          ? { ref: e.analysis.signals.pr.blocker, waits: e.analysis.signals.pr.blocker_waits }
          : null,
        requires_closed: e.analysis.signals.pr.requires_closed,
      };
      rows.push({ card: this.card(e, this.shownAt(e, snap), snap), ...row, waits_on: waitsOn(row), note: m.note ?? null });
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
      coordinator: this.coordinator.view(),
    };
  }

  // POST /api/coordinator/wake: Wake it (or Start it now) in Merging has it look now (and starts it, if it isn't running).
  // w, or Wake it under an ask it stopped without answering: that ask goes to it again, your words as you wrote them.
  async wakeCoordinator(askId?: string): Promise<void> {
    if (!this.settings["agent.coordinator"]) throw new DeskError(409, "your agent is off: Settings \u2192 Agents");
    const a = askId ? this.asks().find((x) => x.id === askId && !x.answer) : undefined;
    if (a) await this.coordinator.tell(askLine(a, this.askAbout(a.item_id)));
    else await this.coordinator.now();
    if (!this.coordinator.saved())
      throw Object.assign(new DeskError(502, "your agent didn't start; the desk's log says why"), { cause: this.coordinator.failure });
  }

  merging(id: string): Merging {
    return (this.store.get(`sitter:${id}`) as Merging | null) ?? {};
  }

  // Your own PR on your desk, ready to merge but for a conflict, goes to your coordinator to rebase until GitHub sees it mergeable.
  rebaseConflicts(): void {
    if (!this.loaded) return;
    const on = this.settings["agent.coordinator"];
    const snap = this.snapshot();
    const merging = this.store.prefixed<Merging>("sitter:");
    let moved = false;
    for (const e of snap.entries.values()) {
      const it = e.item;
      const m = merging.get(it.id);
      const bucket = snap.best.get(it.id)?.bucket;
      if (m?.rebase) {
        if (on && it.state === "open" && it.mergeable !== "clean") continue;
        if (e.state.inflight_at) this.store.putState({ ...e.state, inflight_at: null });
        this.store.set(`sitter:${it.id}`, null);
        moved = true;
      } else if (
        on &&
        !m && // handed back or brought back with b: yours
        this.coordinator.saved() && // a scratch desk's would be a second one, on your real branches
        (bucket === "now" || bucket === "today") &&
        e.analysis.signals.me.author &&
        !e.analysis.signals.pr.blocked && // a blocked PR isn't ready to merge
        !it.draft &&
        it.review_decision === "approved" &&
        it.ci !== "red" && // GitHub runs no pull_request CI on a conflicting PR
        it.mergeable === "conflict"
      ) {
        const at = this.now().toISOString();
        this.store.putState({ ...e.state, inflight_at: at });
        this.store.set(`sitter:${it.id}`, { rebase: at });
        this.coordinator.wake(it.id, REBASE);
        this.log(`gave ${it.id} to the coordinator to rebase: ready to merge but conflicts`);
        moved = true;
      }
    }
    if (moved) this.changed();
  }

  // Your own open PR in Merging: what the coordinator's tools may touch.
  inflightEntry(ref: string): Entry {
    const e = this.pr(ref);
    if (!e.inflight) throw new DeskError(409, `${e.item.id} isn't one of your open PRs in Merging`);
    return e;
  }

  // One plain line from an agent, whatever it sent.
  line(text: string, what: string, max = MAX_LINE): string {
    const t = text
      .replaceAll(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "") // bidi marks, which make text read as something else
      // oxlint-disable-next-line no-control-regex -- one plain line, whatever the agent sent
      .replaceAll(/[\u0000-\u001f\u007f\s]+/g, " ")
      .trim();
    if (!t) throw new DeskError(400, `the ${what} is empty`);
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  }

  // Words in paragraphs, yours or an agent's: refused, not cut, over max; newlines and tabs stay, at most one blank line in a row.
  paragraphs(text: string, what: string, max: number): string {
    if (text.length > max) throw new DeskError(400, `keep the ${what} under ${max} characters`);
    const t = text
      .replaceAll(/\r\n?|[\u0085\u2028\u2029]/g, "\n")
      .replaceAll(INVISIBLE, "")
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n")
      .replaceAll(/\n{3,}/g, "\n\n")
      .trim();
    if (!t) throw new DeskError(400, `the ${what} is empty`);
    return t;
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
  // `by`: the desk itself hands back a PR nobody's asked to review (handBackUnasked).
  handBack(ref: string, why: string, by: "agent" | "desk" = "agent"): { reason: string } {
    const e = this.inflightEntry(ref);
    const id = e.item.id;
    const reason = this.line(why, "reason");
    const before = this.store.state(id);
    const at = this.now().toISOString();
    this.store.putState({ ...before, inflight_at: null });
    this.store.logAction(id, "takeback", before, at, by);
    this.store.set(`sitter:${id}`, { ...this.merging(id), handback: { reason, at } });
    this.log(`${by === "desk" ? "the desk" : "an agent"} handed ${id} back: ${reason}`);
    this.changed();
    this.notifyNew();
    return { reason };
  }

  // A PR in Merging nobody's asked to review (its request taken back, say): the coordinator can't get it reviewed, so it
  // comes back to you to ask someone.
  handBackUnasked(): void {
    if (!this.loaded) return;
    for (const e of this.snapshot().entries.values())
      if (e.inflight && e.status === "active" && this.stuckUnasked(e) && !e.analysis.signals.pr.blocked)
        this.handBack(e.item.id, UNASKED, "desk");
  }

  // Your PRs a board lists or Merging has: log when one becomes blocked by another PR or stops being, which wakes the
  // coordinator for Merging's ("unblocked: sentry#129460 merged") and words a held hand-back. The first run only fills kv `blocked`.
  trackBlocked(): void {
    if (!this.loaded) return;
    const snap = this.snapshot();
    const prev = this.store.get("blocked") as Record<string, { since: string; by: string }> | null;
    const listed = new Set<string>();
    for (const b of snap.boards.values()) for (const id of b.result.placements.keys()) listed.add(id);
    const now = this.now().toISOString();
    const next: Record<string, { since: string; by: string }> = {};
    const events: NewEvent[] = [];
    for (const e of snap.entries.values()) {
      const it = e.item;
      const pr = e.analysis.signals.pr;
      if (it.kind !== "pr" || it.state !== "open" || !e.analysis.signals.me.author || !(listed.has(it.id) || e.inflight)) continue;
      const was = prev?.[it.id];
      if (pr.blocked) {
        next[it.id] = { since: was?.since ?? (prev ? now : it.created_at), by: pr.blocker };
        if (prev && !was) events.push({ at: now, item_id: it.id, kind: "blocked", actor: "", data: { by: pr.blocker } });
      } else if (was) {
        const merged = snap.deps.get(it.id)?.merged.findLast((m) => m.at > was.since)?.ref ?? "";
        const closed = pr.requires_closed.join(", ");
        events.push({ at: now, item_id: it.id, kind: "unblocked", actor: "", data: { was: was.by, merged, closed } });
      }
    }
    this.store.set("blocked", next);
    if (!events.length) return;
    this.record("desk", events);
    this.changed(); // a held hand-back's why reads the unblocked event
  }

  // Your PR nobody's asked to review, past the moments a workflow or CODEOWNERS takes to ask someone.
  stuckUnasked(e: Entry): boolean {
    const sig = e.analysis.signals;
    return sig.me.author && sig.pr.unasked && sig.item.updated_hours >= UNASKED_AFTER;
  }

  // POST /api/review/:id/reviewers: who reviews your ready PR nobody's asked (Ask reviewers in its review), one of the desk's
  // GitHub writes, on your click. Your part is done, so it leaves your desk until someone reviews.
  async askReviewers(ref: string, ask: { users: string[]; teams: string[] }): Promise<void> {
    const e = this.pr(ref);
    const id = e.item.id;
    if (!e.analysis.signals.me.author) throw new DeskError(409, `${id} isn't your PR`);
    if (e.item.state !== "open" || e.item.draft) throw new DeskError(409, `${id} isn't open and ready for review`);
    if (!ask.users.length && !ask.teams.length) throw new DeskError(400, "pick someone to ask");
    if (!this.writer) throw new DeskError(409, "asking for reviews isn't available in this desk");
    if (this.approving.has(id)) throw new DeskError(409, `already asking on ${id}`);
    this.approving.add(id);
    try {
      try {
        await this.writer.requestReviews(e.item.node_id, ask.users, ask.teams);
      } catch (err) {
        throw new DeskError(502, `GitHub didn't ask for the reviews: ${(err as Error).message}`);
      }
      this.store.logWrite(id, "request_reviews", this.now().toISOString());
      const n = ask.users.length + ask.teams.length;
      this.log(`asked ${n} reviewer${n === 1 ? "" : "s"} on ${id} on GitHub`);
      this.doneAfterWrite(id);
    } finally {
      this.approving.delete(id);
      void this.gh.refresh(id);
    }
  }

  asks(item?: string): Ask[] {
    const all = (this.store.get("asks") as Ask[] | null) ?? [];
    return item === undefined ? all : all.filter((a) => a.item_id === item);
  }

  // What an ask is about, in the desk's words; without GitHub context every PR reads someone else's, which fails closed.
  askAbout(id: string | null): AskAbout | null {
    const e = id ? this.snapshot().entries.get(id) : undefined;
    if (!e) return null;
    const it = e.item;
    const me = this.me().toLowerCase();
    // Only your own hand-off puts a PR in Merging, a bot's opened for you included; elsewhere it's the real author, never a bot's via.
    const whose = it.kind === "issue" ? "issue" : e.inflight || (me && it.author.toLowerCase() === me) ? "mine" : "theirs";
    return { url: it.url, whose, merging: e.inflight, state: it.state };
  }

  // GET /api/asks/:id (desk_ask): where an ask is, and the only branch a change it asks for may be pushed to.
  askPlace(id: string): AskPlace {
    this.requireConfig();
    const ask = this.asks().find((x) => x.id === id);
    if (!ask) throw new DeskError(404, `no ask "${id}"`);
    const about = this.askAbout(ask.item_id);
    const it = about && ask.item_id ? this.snapshot().entries.get(ask.item_id)?.item : undefined;
    const pr = it?.kind === "pr" ? it : null;
    const mayPush = !!pr && about?.whose === "mine" && pr.state === "open" && !!pr.head_ref && !!pr.head_repo;
    return {
      ask,
      about,
      head: pr ? pr.head_oid || null : null,
      base: pr ? pr.base || null : null,
      push: mayPush ? { repo: pr.head_repo!, branch: pr.head_ref! } : null,
    };
  }

  // POST /api/ask, from the desk's window: your words to the coordinator, about the item (and thread or lines) you were on.
  async ask(b: { text: string; item_id?: string; thread_id?: string; thread_url?: string; lines?: AskLines }): Promise<Ask> {
    if (!this.settings["agent.coordinator"]) throw new DeskError(409, "your agent is off: Settings \u2192 Agents");
    const item = b.item_id ? this.snapshot().entries.get(this.resolve(b.item_id))!.item : null;
    const l = b.lines;
    if (l) {
      if (!item) throw new DeskError(400, "lines are on a PR's diff: send its item_id");
      if (item.kind !== "pr") throw new DeskError(400, "lines are on a PR's diff");
      if (b.thread_id || b.thread_url) throw new DeskError(400, "an ask is on a thread or on lines, not both");
      if (!/^[0-9a-f]{40}$/.test(l.head)) throw new DeskError(400, "lines need head: the 40-character commit they were read at");
      // desk_ask hands the name to a shell, quoted: what could break a line or read as something else is refused, not stripped.
      // oxlint-disable-next-line no-control-regex -- control characters are what it refuses
      const bad = /[\u0000-\u001f\u2028\u2029]/.test(l.path) || l.path.replaceAll(INVISIBLE, "") !== l.path;
      if (!l.path || l.path.length > 1000 || bad) throw new DeskError(400, "lines need path: a file name with no control characters");
    }
    if (b.thread_url && !/^https:\/\/github\.com\/\S+$/.test(b.thread_url)) throw new DeskError(400, "thread_url must be a GitHub URL");
    const a: Ask = {
      id: randomBytes(4).toString("hex"),
      at: this.now().toISOString(),
      text: this.paragraphs(b.text, "ask", MAX_ASK),
      item_id: item?.id ?? null,
      thread_id: item && b.thread_id ? b.thread_id : null,
      thread_url: item && b.thread_url ? b.thread_url : null,
      // Rebuilt, so keys the window didn't mean to send never reach the store.
      lines: l
        ? {
            path: l.path,
            line: l.line,
            side: l.side,
            ...(l.start && { start: { line: l.start.line, side: l.start.side } }),
            head: l.head,
            ...(l.note && { note: true }),
          }
        : null,
      answer: null,
    };
    const line = askLine(a, this.askAbout(a.item_id));
    const started = !!this.coordinator.saved();
    let told: Promise<void>;
    try {
      told = this.coordinator.tell(line);
    } catch (err) {
      throw new DeskError(400, (err as Error).message);
    }
    this.store.set("asks", [...this.asks(), a].slice(-ASKS_KEPT));
    this.changed();
    // Like Wake it: a coordinator that won't start says so now, rather than the ask waiting for an answer that never comes.
    if (!started) {
      await told;
      if (!this.coordinator.saved()) {
        this.coordinator.untell(line);
        this.store.set(
          "asks",
          this.asks().filter((x) => x.id !== a.id),
        );
        this.changed();
        throw Object.assign(new DeskError(502, "your agent didn't start; the desk's log says why"), {
          cause: this.coordinator.failure,
        });
      }
    }
    return a;
  }

  // Questions asked before options said what follows had plain options and no links.
  inquiries(): Inquiry[] {
    const all =
      (this.store.get("inquiries") as
        (Omit<Inquiry, "options" | "links"> & { options: (string | InquiryOption)[]; links?: InquiryLink[] })[] | null) ?? [];
    return all.map((q) =>
      Object.assign(q, { options: q.options.map((o) => (typeof o === "string" ? { answer: o, next: "" } : o)), links: q.links ?? [] }),
    );
  }

  inquiry(id: string): Inquiry {
    const q = this.inquiries().find((x) => x.id === id);
    if (!q) throw new DeskError(404, `no inquiry "${id}"`);
    return q;
  }

  // GET /api/inquiries/:id: the question, with its item's card wherever the desk shows it (the queue, Merging, a stack).
  inquiryView(id: string): InquiryView {
    const q = this.inquiry(id);
    let card: Card | null = null;
    try {
      card = q.item_id ? this.item(q.item_id).card : null;
    } catch (e) {
      if (!(e instanceof DeskError)) throw e; // not on the desk: its ref still links to GitHub
    }
    return { ...q, card };
  }

  // desk_inquire: an agent session's question for you, a row on your main page and a notification, until you answer it. You
  // decide from its page alone, so it's refused without the context, what each answer leads to, and a link to what it's about.
  inquire(b: {
    question: string;
    from: string;
    context: string;
    options?: InquiryOption[];
    links?: InquiryLink[];
    item?: string;
  }): Inquiry {
    // Refused, not cut: what's past the limit is often what an answer costs.
    const one = (text: string, what: string, max: number) => {
      const t = this.line(text, what, Infinity);
      if (t.length > max) throw new DeskError(400, `keep the ${what} under ${max} characters`);
      return t;
    };
    const from = one(b.from, "from", 60);
    const question = one(b.question, "question", 300);
    // oxlint-disable-next-line no-control-regex -- paragraphs stay, anything else invisible goes, bidi marks too
    const context = b.context.replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
    if (context.length < MIN_CONTEXT)
      throw new DeskError(
        400,
        `context is too thin to decide from (${context.length} of at least ${MIN_CONTEXT} characters): say what you're doing, what you found, what the choice turns on, and why your pick`,
      );
    if (context.length > MAX_CONTEXT) throw new DeskError(400, `keep the context under ${MAX_CONTEXT} characters`);
    const options = b.options ?? [];
    if (options.length > 6) throw new DeskError(400, "at most 6 options");
    const links = b.links ?? [];
    if (links.length > MAX_LINKS) throw new DeskError(400, `at most ${MAX_LINKS} links`);
    if (!b.item && !links.length) throw new DeskError(400, "link what it's about: the PR or issue as item, or links to what you read");
    const q: Inquiry = {
      id: randomBytes(4).toString("hex"),
      at: this.now().toISOString(),
      from,
      question,
      context,
      options: options.map((o) => ({ answer: one(o.answer, "option", 80), next: one(o.next, `"next" of "${o.answer}"`, 400) })),
      links: links.map((l) => ({ label: one(l.label, "link's label", 80), url: linkUrl(l.url) })),
      item_id: b.item ? this.itemId(b.item) : null,
      answer: null,
    };
    // Only answered ones age out: a question still waiting on you never goes unseen.
    const all = [...this.inquiries(), q];
    const answered = all.filter((x) => x.answer);
    const drop = new Set(answered.slice(0, Math.max(0, all.length - INQUIRIES_KEPT)));
    this.store.set(
      "inquiries",
      all.filter((x) => !drop.has(x)),
    );
    this.log(`${q.from} asks: ${q.question}`);
    this.changed();
    if (this.mayNotify()) this.notify(q.from === COORDINATOR ? "Your agent asks" : `${q.from} asks`, q.question);
    return q;
  }

  // POST /api/inquiries/:id/answer, from the desk's window: your answer, for the agent to read; it leaves your desk.
  answerInquiry(id: string, text: string, dismissed = false): Inquiry {
    const q = this.inquiry(id);
    if (q.answer) throw new DeskError(409, "already answered");
    const answer = dismissed ? "" : text.trim();
    if (!dismissed && !answer) throw new DeskError(400, "the answer is empty");
    if (answer.length > MAX_ASK) throw new DeskError(400, `keep an answer under ${MAX_ASK} characters`);
    const done: Inquiry = { ...q, answer: { text: answer, at: this.now().toISOString(), dismissed } };
    this.store.set(
      "inquiries",
      this.inquiries().map((x) => (x.id === id ? done : x)),
    );
    this.changed();
    // The coordinator ends its turn once it asks; your answer is what wakes it.
    if (q.from === COORDINATOR && this.settings["agent.coordinator"]) {
      const asked = `your question ${q.id} ("${q.question}")`;
      const line = dismissed ? `I dismissed ${asked}: decide yourself.` : `My answer to ${asked}: "${answer.replaceAll(/\s+/g, " ")}"`;
      try {
        this.coordinator.tell(line).catch((e: unknown) => {
          this.log(`coordinator: ${(e as Error).message}`);
        });
      } catch (e) {
        this.log(`coordinator: couldn't pass on your answer to ${q.id}: ${(e as Error).message}`);
      }
    }
    return done;
  }

  // desk_answer: the coordinator's answer to one of your asks, in your chat with it in the desk, and a notification.
  answer(id: string, text: string): Ask {
    const all = this.asks();
    const a = all.find((x) => x.id === id);
    if (!a) throw new DeskError(404, `no ask "${id}"`);
    const done: Ask = { ...a, answer: { text: this.paragraphs(text, "answer", MAX_ANSWER), at: this.now().toISOString() } };
    this.store.set(
      "asks",
      all.map((x) => (x === a ? done : x)),
    );
    this.changed();
    const said = lead(done.answer!.text);
    if (!a.answer && this.mayNotify())
      this.notify("Your agent", `${a.item_id ? `${a.item_id}: ` : ""}${said ? this.line(said, "answer") : "It answered your ask."}`);
    return done;
  }

  // POST /api/review/:id/reply: your reply to one of the PR's conversations, on your click. One of the desk's GitHub writes.
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
    // Answering was all it asked of you, and nobody else waits on you there: it's done.
    const last = !list.some((x) => x.waiting_on_you && x.id !== convoId);
    const only = this.replyOnly(e) && !this.snapshot().unasked.has(id); // with nobody asked, Add reviewers still waits
    this.convos.forget(id);
    if (only && last) this.doneAfterWrite(id);
    this.changed();
    void this.gh.refresh(id).then(() => this.sync());
    return { url };
  }

  // POST /api/review/:id/comment: your comment on the PR (Comment in its review) or the issue (Comment on it opened
  // in place), on your click. One of the desk's GitHub writes; it's yours done, so it leaves your desk until someone answers.
  async comment(ref: string, body: string): Promise<{ url: string }> {
    this.requireConfig();
    const e = this.snapshot().entries.get(this.resolve(ref))!;
    const id = e.item.id;
    const text = body.trim();
    if (e.item.state !== "open") throw new DeskError(409, `can't comment on ${id}: it's ${e.item.state}`);
    if (!text) throw new DeskError(400, "the comment is empty");
    if (text.length > MAX_REPLY) throw new DeskError(400, `keep a comment under ${MAX_REPLY} characters`);
    if (!this.writer) throw new DeskError(409, "commenting isn't available in this desk");
    if (this.sending.has(id)) throw new DeskError(409, "already sending a comment there");
    this.sending.add(id);
    let url: string;
    try {
      ({ url } = await this.writer.comment(e.item.node_id, text));
    } catch (err) {
      throw new DeskError(502, `GitHub didn't take the comment: ${(err as Error).message}`);
    } finally {
      this.sending.delete(id);
    }
    this.store.logWrite(id, "comment", this.now().toISOString());
    this.log(`commented on ${id}${url ? ` (${url})` : ""}`);
    this.convos.forget(id);
    this.doneAfterWrite(id);
    void this.gh.refresh(id).then(() => this.sync());
    return { url };
  }

  // POST /api/review/:id/inline: your comment on a line (or a range ending at it) of the diff, on your press, pinned to the
  // commit the review showed so its line numbers are the ones you read. Part of reviewing, not its end: the PR stays put.
  async inlineComment(ref: string, at: InlineAt, body: string, head: string): Promise<{ url: string }> {
    const e = this.pr(ref);
    const id = e.item.id;
    const text = body.trim();
    if (e.item.state !== "open") throw new DeskError(409, `can't comment on ${id}: it's ${e.item.state}`);
    if (!text) throw new DeskError(400, "the comment is empty");
    if (text.length > MAX_REPLY) throw new DeskError(400, `keep a comment under ${MAX_REPLY} characters`);
    if (!this.writer) throw new DeskError(409, "commenting isn't available in this desk");
    const key = `${id} ${at.path}:${at.line}`;
    if (this.sending.has(key)) throw new DeskError(409, "already sending a comment there");
    this.sending.add(key);
    const side = (s: "new" | "old") => (s === "old" ? "LEFT" : "RIGHT");
    let url: string;
    try {
      ({ url } = await this.writer.inlineComment(e.item.node_id, head, {
        path: at.path,
        line: at.line,
        side: side(at.side),
        ...(at.start &&
          !(at.start.line === at.line && at.start.side === at.side) && { startLine: at.start.line, startSide: side(at.start.side) }),
        body: text,
      }));
    } catch (err) {
      throw new DeskError(502, `GitHub didn't take the comment: ${(err as Error).message}`);
    } finally {
      this.sending.delete(key);
    }
    this.store.logWrite(id, "inline_comment", this.now().toISOString());
    this.log(`commented on ${id} at ${at.path}:${at.line}${url ? ` (${url})` : ""}`);
    this.convos.forget(id);
    this.changed();
    void this.gh.refresh(id).then(() => this.sync());
    return { url };
  }

  // POST /api/review/:id/ready: your own draft's "Ready for review", one of the desk's GitHub writes, on your click,
  // then a review request to whoever you picked with it (node ids from reviewers()).
  async markReady(ref: string, ask?: { users: string[]; teams: string[] }): Promise<void> {
    const e = this.pr(ref);
    const id = e.item.id;
    if (!e.analysis.signals.me.author) throw new DeskError(409, `${id} isn't your PR`);
    if (e.item.state !== "open" || !e.item.draft) throw new DeskError(409, `${id} isn't an open draft`);
    if (!this.writer) throw new DeskError(409, "marking ready isn't available in this desk");
    if (this.approving.has(id)) throw new DeskError(409, `already marking ${id} ready`);
    this.approving.add(id);
    try {
      try {
        await this.writer.ready(e.item.node_id);
      } catch (err) {
        throw new DeskError(502, `GitHub didn't mark it ready: ${(err as Error).message}`);
      }
      this.store.logWrite(id, "ready", this.now().toISOString());
      this.log(`marked ${id} ready for review on GitHub`);
      this.doneAfterWrite(id);
      const users = ask?.users ?? [];
      const teams = ask?.teams ?? [];
      const n = users.length + teams.length;
      if (n > 0) {
        try {
          await this.writer.requestReviews(e.item.node_id, users, teams);
        } catch (err) {
          throw new DeskError(502, `Marked it ready, but GitHub didn't ask for the reviews: ${(err as Error).message}`);
        }
        this.store.logWrite(id, "request_reviews", this.now().toISOString());
        this.log(`asked ${n} reviewer${n === 1 ? "" : "s"} on ${id} on GitHub`);
      }
    } finally {
      this.approving.delete(id);
      void this.gh.refresh(id);
    }
  }

  // GET /api/reviewers/:id?q=: who you can ask to review your PR, GitHub's suggestions first. Read only.
  async reviewers(ref: string, q: string): Promise<Reviewer[]> {
    const e = this.pr(ref);
    if (!e.analysis.signals.me.author) throw new DeskError(409, `${e.item.id} isn't your PR`);
    const me = this.me().toLowerCase();
    const list = await this.gh.api.reviewers(e.item.repo, e.item.number, q.trim());
    return list.filter((r) => r.team || r.login.toLowerCase() !== me);
  }

  // ---------------------------------------------------------------- config

  // The hard and final rules in plain words (plainWhy): a board named in two spaces says which.
  getConfig(): ConfigDoc {
    const text = this.configText;
    const cfg = this.loaded?.config;
    const boards = cfg?.boards ?? [];
    const label = (b: BoardConfig) =>
      boards.filter((x) => x.name === b.name).length > 1
        ? `${b.name} (${cfg!.spaces.find((x) => x.id === b.space)?.name ?? b.space})`
        : b.name;
    const hard = boards.flatMap((b) =>
      b.rules.flatMap((r) =>
        (r.hard || r.final) && r.bucket !== "judge"
          ? [{ board: label(b), bucket: r.bucket, when: r.when, why: plainWhy(r.why ?? ""), ...(r.final && { final: true }) }]
          : [],
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
    replaceFile(this.configPath, text);
    this.reloadConfig(true);
    return { ok: true, errors: [], warnings };
  }

  // The tray's and the dock's count: an agent's question waiting on you counts as now.
  status(): { now: number; today: number; new: number; text: string } {
    const f = this.overview().focus;
    const now = f.now + f.asks;
    const parts = [`${now + f.today}`, f.new ? `+${f.new}` : ""].filter(Boolean);
    return { now, today: f.today, new: f.new, text: now || f.today ? `desk ${parts.join(" ")}` : "" };
  }
}

// The desk's ready rule: what o merges on GitHub, and what the More menu's merge needs.
function readyToMerge(it: Item): boolean {
  return it.review_decision === "approved" && it.ci === "green" && it.mergeable === "clean" && !it.draft;
}

function countsOf(r: BoardResult): Record<Bucket, number> {
  return {
    now: r.order.now.length,
    today: r.order.today.length,
    blocked: r.order.blocked.length,
    later: r.order.later.length,
    fyi: r.order.fyi.length,
    hide: r.order.hide.length,
  };
}

function statusOf(s: StateRow, activityAt: string, now: Date): Status {
  if (s.muted) return "muted";
  if (s.done_at && activityAt <= (s.acked_at ?? s.done_at)) return "done";
  if (s.snooze_when) return "snoozed"; // compute() ends it once it happens
  if (s.snooze_until && now.toISOString() < s.snooze_until && !(s.snooze_on_activity && activityAt > (s.acked_at ?? s.snoozed_at ?? "")))
    return "snoozed";
  return "active";
}

// What a PR in Merging waits on, the first thing between it and a merge.
function waitsOn(r: Omit<InflightRow, "card" | "waits_on" | "note">): string | null {
  const names = (xs: string[]) => (xs.length > 2 ? `${xs.slice(0, 2).join(", ")} and ${xs.length - 2} more` : xs.join(", "));
  const threads = r.threads_unresolved;
  if (r.state !== "open") return null;
  if (r.rebase) return "rebasing";
  if (r.blocked_by) return `waits on ${r.blocked_by.ref} to merge first`;
  if (r.requires_closed.length) return `needs ${r.requires_closed.join(", ")}, closed without merging`;
  if (r.ci === "red") return "waits on a CI fix";
  if (r.mergeable === "conflict") return "waits on a merge conflict fix";
  if (r.changes_by.length) return `waits on a second look from ${names(r.changes_by)}`;
  if (r.ci === "pending") return "waits on CI";
  if (threads) return `waits on ${threads} unresolved ${threads === 1 ? "thread" : "threads"}`;
  if (!r.approved_by.length) return r.waiting_on.length ? `waits on a review from ${names(r.waiting_on)}` : "waits on a review";
  if (r.stacked) return `waits on ${r.base} to merge first`;
  return "ready to merge";
}

// A question's link: https, the one scheme the desktop app's window opens; nothing a click would run.
function linkUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new DeskError(400, `not a link: ${url.slice(0, 80)}`);
  }
  if (u.protocol !== "https:") throw new DeskError(400, `a link is https, not ${u.protocol}`);
  if (u.href.length > 2_000) throw new DeskError(400, "keep a link under 2000 characters");
  return u.href;
}

// A notification's words: the answer's first paragraph outside a ``` block, without ** or backticks.
function lead(text: string): string {
  const out: string[] = [];
  let fence = false;
  for (const l of text.split("\n")) {
    // The chat's rule: any ``` line opens a block, only a bare ``` closes it.
    if (fence ? l.trim() === "```" : l.trimStart().startsWith("```")) {
      if (out.length) break;
      fence = !fence;
    } else if (!fence && l.trim()) out.push(l);
    else if (!fence && out.length) break;
  }
  return out
    .join(" ")
    .replaceAll(/\*\*|`/g, "")
    .trim();
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
