// The desk: runs the connectors, keeps the event log, and serves the classified views and local actions.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Cache, Cause, Deferred, Duration, Effect, Exit, Fiber } from "effect";
import { stopAll } from "./children.ts";
import {
  AmbiguousRef,
  BadRequest,
  Busy,
  ClaudeNotLoggedIn,
  Conflict,
  Forbidden,
  fsError,
  messageOf,
  NotFound,
  ReviewersNotAsked,
  Stale,
  Unavailable,
  Upstream,
  type ClaudeError,
  type CommandError,
  type CommandTimeout,
  type FsError,
  type GitHubError,
  type GitHubReadError,
  type GitHubWriteError,
} from "./errors.ts";
import { Automations, canOf } from "./automations.ts";
import { GONE, Jobs } from "./jobs.ts";
import type { GitHub } from "./github/index.ts";
import type { GitHubWriter, InlineThread } from "./github/write.ts";
import { KEEP_RESOLVED, type Connector, type NewEvent } from "./connectors/connector.ts";
import { GitHubConnector } from "./connectors/github.ts";
import { openLink, Sessions, type Roots } from "./connectors/sessions.ts";
import { linkRef } from "./links.ts";
import { resolution, type Resolution } from "./resolve.ts";
import { buildStacks, grouped, oneLinePerStack, stackRef, stackView, type Seat, type Stacks } from "./stacks.ts";
import { askedAt, mergeLine, owesReply, stage, standings, verdicts } from "./stage.ts";
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
  AutomationItem,
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
  SessionCard,
  Job,
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
  Work,
} from "./types.ts";
import { byPart, isCoordinator, isSessionRef, RANK, SECRET_SET, UNTIL } from "./types.ts";
import { detached, report, webSentry } from "./sentry.ts";
import { Runner } from "./runner.ts";
import {
  catchAllOf,
  migrateBotAsk,
  migrateConflict,
  migrateOnBehalf,
  migrateWaitsConflict,
  migrateDrafts,
  migrateHard,
  parseConfig,
  spaceOf,
  type LoadedConfig,
} from "./config.ts";
import { analyze, happened, plainWhy, waitable, type Analysis } from "./signals.ts";
import { classify, placedBy, queueOrder, type BoardResult, type CompiledBoard } from "./rules.ts";
import { renderTemplate } from "./expr.ts";
import { emptyState, Store, type StateRow } from "./store.ts";
import { inQuietHours, notify } from "./notify.ts";
import {
  agentDir,
  agentDown,
  CLAUDE_PAUSED,
  CODEX_PAUSED,
  forgetCodexServers,
  notLoggedIn,
  reviewOrder,
  type FetchPrError,
  type PrText,
} from "./review.ts";
import * as agents from "./agents.ts";
import { DEFAULT_POLICY, Judge, judgeKey, sortKey, textHash } from "./judge.ts";
import { Conversations, talked } from "./conversation.ts";
import { checksView } from "./checks.ts";
import { askLine, Coordinator, REBASE, wakeFor } from "./coordinator.ts";
import {
  checkSetting,
  effective,
  migrateLegacy,
  isSecret,
  readSecrets,
  readSettings,
  SECTIONS,
  secretsPath,
  secretsRefused,
  agentDefs,
  agentName,
  settingDef,
  masked,
  settingsPath,
  writeSecrets,
  writeSettings,
  type Settings,
  type SettingsFile,
} from "./settings.ts";

const HOUR = 3_600_000;
const ITEM_ACTIVITY = 8;
const NO_CONTEXT: Context = { me: "", teams: [], affinity: {}, repo_prs: {}, orgs: {}, refreshed_at: "" };
const stateOf = (s: StateRow): ItemState => {
  const { snoozed_at: _, acked_at: __, ...state } = s;
  return state;
};
const ACTIVE = { done_at: null, snooze_until: null, snooze_when: null, snoozed_at: null, muted: false } satisfies Partial<StateRow>; // what statusOf() calls active
const AI_AT_ONCE = 2;
const WARM_AT_ONCE = 3; // the main page's diffs and conversations fetched ahead after a sync, this many at a time
const CHECKS_KEPT = 200; // PRs whose checks are kept, the least recently asked for going first
const AI_RETRY = 30 * 60_000; // how long failures in a row pause AI reviews nobody asked for
const AI_PAUSE_AFTER = 2; // failures in a row (an expired login fails every PR) that pause AI reviews nobody asked for, for AI_RETRY
const agentKey = (s: Settings) => JSON.stringify([s["review.auto_ai"], agents.driverOf(s["agent.harness"])]);
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

export interface Entry {
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
  acted: Map<string, string>; // an automation's snooze, done or mute, while it stands: "<its name>: <its why>"
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

// An automation's sort of an item (kv `sorted:<id>`): good while the item is what it sorted (sortKey) and you haven't acted
// on it.
interface Sorted {
  automation: string;
  name: string;
  bucket: Bucket;
  why: string;
  key: string;
  at: string;
}
// An automation's snooze, done or mute of an item (kv `acted:<id>`): its why, while that action is the item's latest.
interface Acted {
  name: string;
  why: string;
  seq: number;
}

// What a sort of the item holds for: the item as it is (sortKey), with its pin.
const sortKeyOf = (e: Entry, pin?: string) => sortKey(e.item, e.analysis.activity_at, pin, e.analysis.signals.pr.blocker);
const AT: Record<Bucket, string> = { now: "Now", today: "Today", blocked: "Blocked", later: "Later", fyi: "FYI", hide: "Hidden" };

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
  decisions?: string; // the Decisions API's URL, in place of OpenRouter's: tests point it at a local server
  mcpUrl?: string; // its /mcp, which a Codex run is given as the desk's own MCP server
  sessions?: Roots; // where the Sessions source reads; tests point it at fixtures
  open?: (url: string) => Effect.Effect<void, CommandError>; // opens a session's link on this computer; tests record it
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
const replaceFile = Effect.fnUntraced(function* (file: string, text: string, backup = false): Effect.fn.Return<void, FsError> {
  const real = fs.existsSync(file) ? yield* Effect.try({ try: () => fs.realpathSync(file), catch: fsError("realpath", file) }) : file;
  if (backup)
    yield* Effect.try({
      try: () => {
        fs.copyFileSync(real, `${real}.bak`);
      },
      catch: fsError("copy", real),
    });
  yield* Effect.try({
    try: () => {
      fs.writeFileSync(`${real}.tmp`, text);
    },
    catch: fsError("write", `${real}.tmp`),
  });
  yield* Effect.try({
    try: () => {
      fs.renameSync(`${real}.tmp`, real);
    },
    catch: fsError("rename", real),
  });
}, Effect.uninterruptible);

// What resolving a ref fails with: the rules have errors, no such item, or several.
type RefError = Unavailable | NotFound | AmbiguousRef;
// What act fails with, and so what a write's done after it can: the item went, or the rules broke, since it was checked.
type ActError = RefError | Forbidden | Conflict | BadRequest;
// What a GitHub write the desk sends fails with, besides its own checks: the same write on its way, or GitHub refused it.
type WriteError = ActError | Stale | Busy | Upstream;
// What GitHub said, passed on after the desk's words. Its own error is the cause, which nothing reported: Sentry sees it.
const upstream =
  (said: string) =>
  (err: GitHubError): Upstream =>
    new Upstream({ message: `${said}${err.message}`, cause: err });

export interface ReviewDeps {
  fetchPr(item: Item, since?: string): Effect.Effect<PrText, FetchPrError>;
  generate(
    item: Item,
    s: Signals,
    why: string,
    pr: PrText,
    dir: string,
    agent: agents.DriverId,
  ): Effect.Effect<AiReview, CommandError | ClaudeError>;
  loggedIn?(agent: agents.DriverId): Effect.Effect<boolean>; // the CLI's own status command; absent: nothing checks it
}

// What a PR's diff fails with: a desk without diffs, or the fetch. And an AI review: that, or claude.
type PrTextError = Conflict | FetchPrError;
type AiError = PrTextError | CommandError | ClaudeError;

export class Desk {
  store: Store;
  gh: GitHubConnector;
  connectors: Connector[];
  home: string;
  mcpUrl: string | null;
  configPath: string;
  settingsPath: string;
  settings: Settings;
  settingsOverrides: Record<string, SettingValue> = {};
  settingsRaw: Record<string, unknown> | null = {};
  secretsRaw: Record<string, unknown> | null = {}; // secrets.json as last read; null for one that couldn't be
  settingsErrors: ConfigError[] = [];
  settingsText: string | null = ""; // as last read: "" for none, null for one that couldn't be read
  now: () => Date;
  notifyFn: (title: string, body: string) => void;
  log: (msg: string) => void;
  review: ReviewDeps | null;
  writer: GitHubWriter | null;
  decisions: string | undefined;
  policyPath: string;
  policy = { text: "", hash: textHash(DEFAULT_POLICY) }; // the file's text; the hash is of what's in effect
  judge: Judge;
  convos: Conversations;
  coordinator: Coordinator;
  sessions: Sessions;
  opener: (url: string) => Effect.Effect<void, CommandError>;
  automations: Automations;
  jobs: Jobs; // the work Claude owes the owner

  loaded: LoadedConfig | null = null;
  configText = "";
  configErrors: ConfigError[] = [];
  configWarnings: ConfigError[] = [];
  rev = 0;
  listeners = new Set<(rev: number) => void>();
  notifyListeners = new Set<(title: string, body: string) => void>();
  waiters = new Set<() => void>(); // long-polls on the event log
  snap: Snapshot | null = null;
  stopped = false;
  generating = new Map<string, Deferred.Deferred<AiReview, AiError>>(); // the AI reviews on their way (see shared()), each a running job
  aiFailures = 0; // in a row, across PRs
  aiLastFailed: string | null = null; // the PR of the latest: its retries aren't more in a row
  aiPaused: { why: string; until: number } | null = null;
  fetching = new Map<string, Deferred.Deferred<PrText, FetchPrError>>(); // the diffs on their way
  // PRs' checks one by one, by `<id> <node id> <detail_at>`: kept until a sync next refreshes the PR, so a review's list
  // is no older than its "CI passing"; a failed fetch isn't kept, and callers asking at once share one.
  checkRuns = Effect.runSync(
    Cache.makeWith((key: string) => this.gh.api.checks(key.split(" ")[1]!), {
      capacity: CHECKS_KEPT,
      timeToLive: (exit) => (Exit.isFailure(exit) ? Duration.zero : Duration.infinity),
    }),
  );
  warming = false;
  warmAgain = false; // a sync landed while warming: go round once more
  approving = new Set<string>(); // items with a GitHub write on its way (approve, ready, the More menu's)
  wrote = new Map<string, string>(); // a More menu write's item → its updated_at then: nothing more till a read shows the change
  sending = new Set<string>(); // conversations a reply is on its way to
  private readonly fibers = new WeakMap<object, Fiber.Fiber<unknown, unknown>>(); // shared work's, by its Deferred
  private readonly storeClosed = Deferred.makeUnsafe<void>(); // by stop(), or the last write in flight then (closeIfIdle)
  readonly runner: Runner; // the work nobody waits on: see runner.ts

  constructor(opts: DeskOptions) {
    this.home = opts.home;
    this.mcpUrl = opts.mcpUrl ?? null;
    this.now = opts.now ?? (() => new Date());
    this.notifyFn = opts.notify ?? notify;
    this.log =
      opts.log ??
      ((m) => {
        console.error(`[desk] ${m}`);
      });
    this.runner = new Runner(
      (m) => {
        this.log(m);
      },
      report,
      detached,
    );
    this.review = opts.review ?? null;
    this.writer = opts.writer ?? null;
    this.decisions = opts.decisions;
    fs.mkdirSync(this.home, { recursive: true });
    this.configPath = path.join(this.home, "config.toml");
    this.policyPath = path.join(this.home, "policy.md");
    this.settingsPath = settingsPath(this.home);
    this.settings = this.readSettings();
    this.store = new Store(path.join(this.home, "desk.db"));
    this.jobs = new Jobs(this);
    this.gh = new GitHubConnector(this, opts.github);
    this.connectors = [this.gh];
    this.judge = new Judge(this);
    this.convos = new Conversations(this);
    this.coordinator = new Coordinator(this);
    this.sessions = new Sessions(this, opts.sessions);
    this.opener = opts.open ?? openLink;
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

  // A connector's init failing (GitHub's viewer, no context yet) or a file it can't read or write fails it: startServer's caller shows why.
  init(): Effect.Effect<void, GitHubReadError | Upstream | FsError> {
    return Effect.gen({ self: this }, function* () {
      const first = !fs.existsSync(this.configPath);
      const parts = yield* Effect.forEach(this.connectors, (c) => c.init(first));
      if (first) yield* this.firstConfig(parts.filter((p) => p !== null).join("\n"));
      yield* this.migrateSettings();
      yield* this.migrateSecrets();
      yield* this.migrateRules();
      yield* this.readPolicy();
      yield* this.reloadConfig();
      fs.watchFile(this.policyPath, { interval: 2000 }, () => {
        this.edited("policy.md");
      });
      fs.watchFile(this.settingsPath, { interval: 2000 }, () => {
        this.edited("settings.json");
      });
      fs.watchFile(this.configPath, { interval: 2000 }, (cur) => {
        if (cur.nlink !== 0) this.edited("config.toml"); // deleted or mid-rename: keep the loaded config
      });
    });
  }

  private firstConfig(text: string): Effect.Effect<void, FsError> {
    const write = Effect.try({
      try: () => {
        fs.writeFileSync(this.configPath, text);
      },
      catch: fsError("write", this.configPath),
    });
    return Effect.map(write, () => {
      this.log(`wrote ${this.configPath}`);
    });
  }

  // One of the desk's files changed on disk (an editor, an agent): read again through the runner, so one it can't read is
  // logged and reported and the desk keeps what it had. Unchanged, nothing happens.
  edited(file: "policy.md" | "settings.json" | "config.toml"): void {
    const reread = Effect.suspend((): Effect.Effect<void, FsError> => {
      if (file === "policy.md")
        return Effect.flatMap(this.policyFile(), (text) => (text === this.policy.text ? Effect.void : this.policyChanged()));
      if (file === "settings.json") {
        // One read: one it can't read is a problem on the Settings page, as at the start.
        const read = readSettings(this.settingsPath);
        return read.text === this.settingsText ? Effect.void : this.reloadSettings(read);
      }
      return Effect.flatMap(this.readConfig(), (text) => (text === this.configText ? Effect.void : this.reloadConfig(true)));
    });
    this.runner.fork(file, reread);
  }

  start(): void {
    this.automations.start(); // before the first sync, whose events are a fresh desk's first news for what GitHub comes with
    for (const c of this.connectors) c.start();
    this.coordinator.start();
    this.sessions.start();
    this.jobs.start();
  }

  // Kills a judge call in progress.
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.runner.stop();
    for (const c of this.connectors) c.stop();
    this.judge.stop();
    this.convos.stop();
    this.coordinator.close();
    this.sessions.stop();
    this.automations.stop();
    this.jobs.stop();
    for (const wake of this.waiters) wake();
    fs.unwatchFile(this.configPath);
    fs.unwatchFile(this.settingsPath);
    fs.unwatchFile(this.policyPath);
    this.closeIfIdle();
  }

  // A GitHub write in flight keeps the store open, so what landed is still logged and recorded: the last one closes it.
  private closeIfIdle(): void {
    if (this.approving.size || this.sending.size || Deferred.isDoneUnsafe(this.storeClosed)) return;
    this.store.close();
    Deferred.doneUnsafe(this.storeClosed, Exit.void);
  }

  // stop() at once; back once every agent process is gone (SIGKILL for what ignores SIGTERM) and every write in flight is recorded.
  close(): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.stop();
      const gone = Effect.promise(() => stopAll()); // it never rejects
      return Effect.all([gone, Deferred.await(this.storeClosed)], { concurrency: 2, discard: true });
    });
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

  get ctx(): Context | null {
    return this.gh.ctx;
  }

  me(): string {
    return this.gh.me();
  }

  // Where the tool-less agent calls run (the AI review, the judge, the read of conversations).
  agentDir(): string {
    return agentDir(this.home);
  }

  // The agent the tool-less calls run on (Settings → Agent): Claude Code unless it's Codex.
  agent(): agents.DriverId {
    return agents.driverOf(this.settings["agent.harness"]);
  }

  // config.toml as it is now, in Node's words when it can't be read.
  readConfig(): Effect.Effect<string, FsError> {
    return Effect.try({ try: () => fs.readFileSync(this.configPath, "utf8"), catch: fsError("read", this.configPath) });
  }

  reloadConfig(sync = false): Effect.Effect<void, FsError> {
    return Effect.map(this.readConfig(), (text) => {
      const { loaded, errors, warnings } = parseConfig(text, this.settings, this.connectors);
      this.configText = text;
      this.configErrors = errors;
      this.configWarnings = warnings;
      if (loaded) this.loaded = loaded;
      else this.log(`config has ${errors.length} error(s); keeping the last good config`);
      this.changed();
      this.judge.pump();
      if (sync && loaded) this.runner.fork("sync", this.sync());
    });
  }

  // ---------------------------------------------------------------- policy

  // policy.md as it is now, "" for none.
  policyFile(): Effect.Effect<string, FsError> {
    return Effect.try({
      try: () => (fs.existsSync(this.policyPath) ? fs.readFileSync(this.policyPath, "utf8") : ""),
      catch: fsError("read", this.policyPath),
    });
  }

  readPolicy(): Effect.Effect<void, FsError> {
    return Effect.map(this.policyFile(), (text) => {
      this.policy = { text, hash: textHash(text.trim() ? text : DEFAULT_POLICY) };
    });
  }

  // What the judge follows: policy.md, or the starter while it's empty.
  policyText(): string {
    return this.policy.text.trim() ? this.policy.text : DEFAULT_POLICY;
  }

  policyChanged(): Effect.Effect<void, FsError> {
    return Effect.map(this.readPolicy(), () => {
      this.changed();
      this.judge.pump();
    });
  }

  getPolicy(): PolicyDoc {
    return { path: this.policyPath, text: this.policy.text, starter: DEFAULT_POLICY, hash: this.policy.hash, judge: this.judge.status() };
  }

  // `base` is the hash from GET: a stale one means it changed since (an agent, an editor) and nothing is written.
  putPolicy(text: string, base?: string): Effect.Effect<{ ok: true; hash: string }, Stale | BadRequest | FsError> {
    return Effect.gen({ self: this }, function* () {
      if (base !== undefined && base !== this.policy.hash)
        return yield* new Stale({ message: "policy.md changed since you opened it; reload to see it, then reapply your edit" });
      if (text.length > MAX_POLICY)
        return yield* new BadRequest({ message: `the policy is ${text.length} characters; keep it under ${MAX_POLICY}` });
      yield* replaceFile(this.policyPath, text);
      yield* this.policyChanged();
      return { ok: true as const, hash: this.policy.hash };
    });
  }

  // ---------------------------------------------------------------- settings

  // From one read of settings.json (`file`: the caller's) and secrets.json, what they say and what's wrong with them.
  readSettings(file: SettingsFile = readSettings(this.settingsPath)): Settings {
    const { overrides, errors, raw, text } = file;
    const secrets = readSecrets(secretsPath(this.home));
    this.settingsText = text;
    this.settingsOverrides = { ...overrides, ...secrets.overrides };
    this.settingsRaw = raw;
    this.secretsRaw = secrets.raw;
    this.settingsErrors = [...errors, ...secrets.errors];
    if (this.settingsErrors.length) this.log(`settings have ${this.settingsErrors.length} problem(s); using defaults for those`);
    return effective(this.settingsOverrides);
  }

  // The secret settings go to secrets.json, and only when they change; the rest to settings.json. A secrets.json the desk
  // couldn't read, or one that's a link, is refused before anything is written: the problem, as data.
  saveSettings(next: Record<string, unknown>): Effect.Effect<ConfigError[], FsError> {
    return Effect.gen({ self: this }, function* () {
      const split = (o: Record<string, unknown>, secret: boolean) =>
        Object.fromEntries(Object.entries(o).filter(([k]) => isSecret(k) === secret));
      const secrets = split(next, true);
      const was = split(this.secretsRaw ?? {}, true);
      if (Object.keys({ ...secrets, ...was }).some((k) => secrets[k] !== was[k])) {
        const file = secretsPath(this.home);
        const refused =
          this.secretsRaw === null
            ? "secrets.json can't be read, so saving a key now would overwrite it. Fix or delete it first."
            : secretsRefused(file);
        if (refused) return [{ path: "secrets.json", message: refused }];
        yield* writeSecrets(file, { ...split(this.secretsRaw ?? {}, false), ...secrets });
      }
      yield* writeSettings(this.settingsPath, split(next, false));
      return [];
    });
  }

  // A key saved in settings.json before secrets.json moves there once: settings.json is often a link into a dotfiles repo.
  migrateSecrets(): Effect.Effect<void, FsError> {
    return Effect.gen({ self: this }, function* () {
      const raw = this.settingsRaw;
      if (!raw || !Object.keys(raw).some(isSecret)) return;
      const kept = Object.fromEntries(Object.entries(this.secretsRaw ?? {}).filter(([k]) => isSecret(k)));
      const problems = yield* this.saveSettings({ ...raw, ...kept });
      if (problems.length) {
        this.log(`a key stays in settings.json for now: ${problems[0]!.message}`);
        return;
      }
      this.settings = this.readSettings();
      this.log(`moved secret settings from settings.json to ${secretsPath(this.home)}`);
    });
  }

  reloadSettings(file?: SettingsFile): Effect.Effect<void, FsError> {
    return Effect.gen({ self: this }, function* () {
      const poll = this.settings["github.poll_seconds"];
      const agent = agentKey(this.settings);
      const searches = searchKey(this.settings);
      const coordinator = this.settings["agent.coordinator"];
      const bypass = this.settings["agent.coordinator_bypass"];
      const decider = this.settings["agent.decision_key"] + this.settings["agent.decision_model"];
      const sessions = this.settings["sessions.enabled"];
      this.settings = this.readSettings(file);
      if (this.settings["sessions.enabled"] !== sessions && !this.stopped) this.sessions.reschedule();
      // A question waiting on its model asks again at once with another key or model.
      if (this.settings["agent.decision_key"] + this.settings["agent.decision_model"] !== decider) this.automations.held.clear();
      if (coordinator && !this.settings["agent.coordinator"]) this.coordinator.stop();
      if (!coordinator && this.settings["agent.coordinator"]) this.coordinator.flush();
      else if (bypass !== this.settings["agent.coordinator_bypass"] && this.settings["agent.coordinator"])
        this.runner.fork(
          "coordinator",
          Effect.promise(() => this.coordinator.again()),
        );
      // Sync now only when the searches change; other settings apply to what the desk already has.
      if (this.configText) yield* this.reloadConfig(searchKey(this.settings) !== searches);
      else this.changed();
      if (this.settings["github.poll_seconds"] !== poll) for (const c of this.connectors) c.reschedule();
      // A changed agent starts afresh: whatever failed on the old one tries again now.
      if (agentKey(this.settings) !== agent) {
        forgetCodexServers();
        this.retryAgents();
      }
      this.pumpAi();
      this.judge.pump();
    });
  }

  // What failed on the agent (AI reviews, the judge) tries again now instead of after its
  // backoff. `only`: just what failed with this error, e.g. NOT_LOGGED_IN once another call shows the login works again.
  retryAgents(only?: string): void {
    const hit = (m: string | null | undefined) => !only || !!m?.endsWith(only);
    let any = false;
    for (const j of this.jobs.list())
      if (j.kind === "ai_review" && j.error && j.state !== "running" && j.state !== "done" && hit(j.error)) {
        this.jobs.queue(j.kind, j.key, j.item, true);
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

  // While anything waits on the agent's login (an AI review, the judge, a conversation's read), each sync asks its CLI whether
  // it's logged in now, so logging in shows at once instead of after the pause; a yes retries what waited.
  private checkingLogin = false;
  recheckLogin(): void {
    const agent = this.agent();
    const why = notLoggedIn(agent);
    const waits =
      !!this.aiPaused?.why.endsWith(why) ||
      !!this.judge.error?.endsWith(why) ||
      this.jobs.list().some((j) => j.state !== "running" && j.state !== "done" && !!j.error?.endsWith(why));
    const review = this.review;
    if (!review?.loggedIn || !waits || this.checkingLogin || this.stopped) return;
    this.checkingLogin = true;
    this.runner.fork(
      "login check",
      review.loggedIn(agent).pipe(
        Effect.tap((yes) =>
          Effect.sync(() => {
            if (yes && agent === this.agent()) this.retryAgents(why);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            this.checkingLogin = false;
          }),
        ),
      ),
    );
  }

  // Settings used to live in config.toml; move them to settings.json once.
  migrateSettings(): Effect.Effect<void, FsError> {
    return Effect.gen({ self: this }, function* () {
      if (this.store.get("settings_migrated") || !fs.existsSync(this.configPath)) return;
      const text = yield* this.readConfig();
      const m = migrateLegacy(text);
      if (!m) {
        // Nothing to move, so it's done: legacy keys saved later (desk_config save, an agent) only warn, never become settings.
        if (parseConfig(text, this.settings, this.connectors).loaded) this.store.set("settings_migrated", this.now().toISOString());
        return;
      }
      if (this.settingsErrors.some((e) => e.path === "settings.json")) {
        this.log("settings.json can't be read; not moving settings out of config.toml until it's fixed");
        return;
      }
      const merged = { ...m.moved, ...this.settingsRaw };
      if (Object.keys(merged).length) yield* writeSettings(this.settingsPath, merged);
      this.store.set("settings_migrated", this.now().toISOString());
      this.settings = this.readSettings();
      if (m.text === null) {
        this.log("config.toml still has settings sections; delete them (they now live in settings.json)");
        return;
      }
      yield* replaceFile(this.configPath, m.text, true);
      this.log(`moved settings from config.toml to ${this.settingsPath} (backup: config.toml.bak)`);
    });
  }

  // Once each: the direct-ask rule of a config written before hard rules becomes hard (migrateHard), a direct ask a bot
  // added gets a hard rule too (migrateBotAsk), and the old rule sending all your drafts to later puts a draft you touched lately
  // on the desk (migrateDrafts), the rule putting a merge conflict on the desk goes (migrateConflict), and your PR waiting on
  // reviewers stays in Blocked with a conflict (migrateWaitsConflict), and My PRs lists a bot's PR opened for you (migrateOnBehalf).
  migrateRules(): Effect.Effect<void, FsError> {
    return Effect.gen({ self: this }, function* () {
      const due = [
        { key: "hard_migrated", migrate: migrateHard, did: "made the rule for reviews asked of you by name hard" },
        { key: "bot_ask_migrated", migrate: migrateBotAsk, did: "added a hard rule for reviews a bot asked of you by name" },
        { key: "drafts_migrated", migrate: migrateDrafts, did: "put your drafts touched in the last 14 days on the desk" },
        { key: "conflict_migrated", migrate: migrateConflict, did: "removed the rule putting a merge conflict on your desk" },
        {
          key: "waits_conflict_migrated",
          migrate: migrateWaitsConflict,
          did: "kept your PRs waiting on reviewers in Blocked when they have a merge conflict",
        },
        { key: "on_behalf_migrated", migrate: migrateOnBehalf, did: "listed bots' PRs opened for you under My PRs" },
      ].filter((m) => !this.store.get(m.key));
      if (!due.length) return;
      const before = yield* this.readConfig();
      let text = before;
      const did: string[] = [];
      for (const m of due) {
        const next = m.migrate(text);
        if (next === null) continue;
        text = next;
        did.push(m.did);
      }
      if (text !== before) {
        yield* replaceFile(this.configPath, text, true);
        this.log(`${did.join("; ")} (backup: config.toml.bak)`);
      }
      for (const m of due) this.store.set(m.key, this.now().toISOString());
    });
  }

  getSettings(): SettingsView {
    const ctx = this.ctx;
    const spaces = this.loaded?.config.spaces ?? [];
    return {
      path: this.settingsPath,
      sections: SECTIONS,
      defs: agentDefs(this.settings["agent.harness"]),
      values: masked(this.settings),
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
          .map(([org, items]) => ({ org, items, space: spaceOf(org, spaces) })),
        catch_all: catchAllOf(spaces),
      },
      paused: {
        ai: this.aiPausedNow() ? { why: this.aiPaused!.why, until: new Date(this.aiPaused!.until).toISOString() } : null,
      },
    };
  }

  // `set` changes values; `reset` drops keys back to their defaults. Nothing is written if any value is invalid.
  putSettings(patch: {
    set?: Record<string, unknown>;
    reset?: string[];
  }): Effect.Effect<{ ok: boolean; errors: ConfigError[]; settings: SettingsView }, FsError> {
    return Effect.gen({ self: this }, function* () {
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
      // Start from the files as written, so entries that are invalid or unknown survive the save.
      const next = { ...this.settingsRaw, ...Object.fromEntries(Object.entries(this.secretsRaw ?? {}).filter(([k]) => isSecret(k))) };
      for (const [k, v] of Object.entries(patch.set ?? {})) {
        if (settingDef(k)!.type === "secret" && v === SECRET_SET) continue; // a client sent back what it was shown: unchanged
        if (JSON.stringify(v) === JSON.stringify(settingDef(k)!.default)) delete next[k];
        else next[k] = v;
      }
      for (const k of patch.reset ?? []) delete next[k];
      const problems = yield* this.saveSettings(next);
      if (problems.length) return { ok: false, errors: problems, settings: this.getSettings() };
      yield* this.reloadSettings();
      return { ok: true, errors: [], settings: this.getSettings() };
    });
  }

  // ---------------------------------------------------------------- agents

  // A file it can't read fails it, in Node's words: a 500, as before.
  agentStatus(mcpUrl: string): Effect.Effect<AgentStatus, FsError> {
    return agents.status(agents.driverOf(this.settings["agent.harness"]), mcpUrl);
  }

  // What stops your agent being connected is passed on in its CLI's words ("… Run it yourself: …"), its error the cause; a
  // name another skill or server of yours has is a 409 that says what to move.
  connectAgent(mcpUrl: string): Effect.Effect<AgentStatus, Upstream | Conflict> {
    const log = (line: string) => {
      this.log(line);
    };
    return agents
      .connect(agents.driverOf(this.settings["agent.harness"]), mcpUrl, { log })
      .pipe(Effect.mapError((e) => (e._tag === "Conflict" ? e : new Upstream({ message: e.message, cause: e }))));
  }

  // ---------------------------------------------------------------- sync and the event log

  // A full pass on every connector at once, in its caller's fiber; their own loops also run it on github.poll_seconds. Never
  // fails: what fails a pass is in its status().
  sync(): Effect.Effect<void> {
    return Effect.forEach(this.connectors, (c) => c.reconcile(), { concurrency: "unbounded", discard: true });
  }

  // A connector brought in something new.
  synced(): void {
    this.changed();
    this.rebaseConflicts();
    this.handBackUnasked();
    this.trackBlocked();
    this.dropStaleSorts();
    // After trackBlocked, whose events are this pass's too, and before notifyNew: a rule that clears what this pass brought
    // runs at once, so you aren't told about it. A question's or an agent's run ends later, and may come after.
    this.automations.pump();
    this.notifyNew();
    this.pumpAi();
    this.recheckLogin();
    const kept = new Set(this.store.itemMeta().keys());
    this.store.pruneKv("review:", kept);
    this.store.pruneKv("pr:", kept);
    this.store.pruneKv("judge:", kept);
    this.store.pruneKv("sitter:", kept);
    this.store.pruneKv("added:", kept);
    this.store.pruneKv("sorted:", kept);
    this.store.pruneKv("acted:", kept);
    this.store.pruneKv("shown:", kept);
    this.store.pruneKv("take:", kept);
    this.store.pruneKv("brief:", new Set()); // the AI review replaced briefs
    if (this.loaded) {
      const top = this.top(this.snapshot(), new Set());
      const replies = [...top.now, ...top.today].filter((c) => c.cta === "reply").map((c) => c.id);
      this.runner.fork("conversations", this.convos.warm(replies));
    }
    this.runner.fork("warm", this.warmReviews());
    this.judge.pump();
  }

  // The main page's PRs' diffs and conversations, fetched ahead (only what changed: both are kept) so opening one doesn't
  // wait. One pass at a time: a sync landing meanwhile has it go round once more.
  warmReviews(): Effect.Effect<void> {
    const warm = Effect.gen({ self: this }, function* () {
      do {
        this.warmAgain = false;
        if (!this.loaded || !this.review) return;
        const top = this.top(this.snapshot(), new Set());
        const ids = [...top.now, ...top.today]
          .filter((c) => c.kind === "pr")
          .map((c) => c.id)
          .values();
        const quietly = (fx: Effect.Effect<unknown, unknown>, id: string) =>
          Effect.catchCause(fx, (cause) =>
            Effect.sync(() => {
              if (!Cause.hasDies(cause)) return;
              this.log(`warm failed: ${Cause.pretty(cause)}`);
              report(Cause.squash(cause), "warm", id);
            }),
          );
        // WARM_AT_ONCE of these share the one list. A failure is ignored (opening it says what failed), a bug logged and reported.
        const next = Effect.gen({ self: this }, function* () {
          for (const id of ids) {
            if (!this.snapshot().entries.has(id)) continue; // gone since: both would fail on it
            yield* Effect.all([quietly(this.prText(id), id), quietly(this.convos.context(id), id)], {
              concurrency: "unbounded",
              discard: true,
            });
          }
        });
        yield* Effect.all(
          Array.from({ length: WARM_AT_ONCE }, () => next),
          { concurrency: "unbounded", discard: true },
        );
      } while (this.warmAgain);
    });
    return Effect.suspend(() => {
      if (this.warming) {
        this.warmAgain = true;
        return Effect.void;
      }
      this.warming = true;
      return Effect.ensuring(
        warm,
        Effect.sync(() => {
          this.warming = false;
        }),
      );
    });
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

  // Events after `after`, oldest first. With `wait` (seconds, up to 60) it answers as soon as one arrives; interrupted (the
  // client went away), it stops waiting.
  activity(q: { after?: number; limit?: number; item?: string; wait?: number }): Effect.Effect<ActivityPage, RefError> {
    return Effect.gen({ self: this }, function* () {
      const after = q.after ?? 0;
      const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
      const item = q.item ? yield* this.itemId(q.item) : undefined;
      const deadline = Date.now() + Math.min(q.wait ?? 0, 60) * 1000;
      for (;;) {
        if (this.stopped) return { events: [], last_seq: after };
        const events = this.store.activity({ after, limit, item });
        const left = deadline - Date.now();
        if (events.length || left <= 0) return { events, last_seq: events.at(-1)?.seq ?? this.store.lastSeq() };
        yield* this.nextEvent(left);
      }
    });
  }

  // Until an event lands (record() wakes it), the desk stops, or `ms` is up.
  private nextEvent(ms: number): Effect.Effect<void> {
    return Effect.callback<void>((resume) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resume(Effect.void);
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      return Effect.sync(() => {
        clearTimeout(timer);
        this.waiters.delete(done);
      });
    });
  }

  // A ref on the desk, or an exact id the desk no longer holds (its events outlive it).
  itemId(ref: string): Effect.Effect<string, RefError> {
    return Effect.catchTag(this.resolve(ref), "NotFound", (e) => {
      const link = linkRef(ref);
      const id = link && "id" in link ? link.id : ref;
      return this.connectors.some((c) => c.refOf(id, [])?.id === id) ? Effect.succeed(id) : Effect.fail(e);
    });
  }

  // An automation's sort of an item that's changed since is over, so the item turning back into what it was doesn't bring it back.
  dropStaleSorts(): void {
    if (!this.loaded) return;
    const snap = this.snapshot();
    for (const [id, s] of this.store.prefixed<Sorted | null>("sorted:")) {
      const e = snap.entries.get(id);
      if (s && e && s.key !== sortKeyOf(e, snap.pins.get(id))) this.store.set(`sorted:${id}`, null);
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
          c.placed_by !== "automation" && // its run told you, as for its pin
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
    this.notify("Inbox", body);
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
    // An open PR waits on you: asked of you or your team, your reply, or your own outside Merging with its next step yours.
    const onYou = (e: Entry) => {
      const s = e.analysis.signals;
      const yours = s.me.author && !e.inflight;
      const next = s.item.draft || s.pr.ci === "red" || s.pr.mergeable === "conflict" || s.pr.review === "changes_requested";
      return s.me.requested || s.me.owes_reply || (yours && (next || (s.pr.review === "approved" && s.pr.ci === "green")));
    };
    const chain = (id: string): string[] => {
      const seen = new Set<string>();
      const todo = [...deps.get(id)!.needs];
      for (let y = todo.pop(); y !== undefined; y = todo.pop()) {
        if (seen.has(y)) continue;
        seen.add(y);
        todo.push(...deps.get(y)!.needs);
      }
      return [...seen];
    };
    for (const [id, f] of deps) {
      const pr = entries.get(id)!.analysis.signals.pr;
      const root = f.root ? entries.get(f.root) : undefined;
      Object.assign(pr, { requires: f.requires, blocked_by: f.open, requires_closed: f.closed, blocks: f.blocks });
      if (root) {
        pr.blocked = true;
        pr.blocker = `${shortRef(root.item)}${f.through ? ` (through ${f.through})` : ""}`;
        pr.blocker_waits = root.inflight ? "is in Merging" : root.analysis.signals.pr.waits;
        pr.blocker_mine = chain(id).some((y) => onYou(entries.get(y)!));
      }
    }

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
    const keyOf = (e: Entry) =>
      judgeKey(e.item, e.analysis.activity_at, reviews.get(e.item.id), pins.get(e.item.id), e.analysis.signals.pr.blocker);
    // An automation's sort stands in for Claude's answer while the item is what it sorted, and while the automation is on
    // and may still sort there; else Claude's again.
    const sorts = this.store.prefixed<Sorted | null>("sorted:");
    const automations = new Map(this.automations.all().map((a) => [a.id, a]));
    const sorted = (id: string): JudgeStep | null => {
      const s = sorts.get(id);
      const e = entries.get(id);
      const a = s && automations.get(s.automation);
      const holds = s && e && a?.on && canOf(a).some((v) => v === s.bucket) && s.key === sortKeyOf(e, pins.get(id));
      return holds ? { bucket: s.bucket, why: s.why, pending: false, by: s.name } : null;
    };
    const claude = (id: string): JudgeStep => {
      const a = answers?.get(id);
      if (!a) return { bucket: null, why: "", pending: true };
      const e = entries.get(id);
      return { bucket: a.bucket, why: a.why, pending: !e || a.policy !== this.policy.hash || a.key !== keyOf(e) };
    };
    const judge = answers ? (id: string) => sorted(id) ?? claude(id) : sorts.size ? sorted : undefined;
    // What an automation snoozed, marked done or muted says why, while that's still the last thing done to it.
    const acted = new Map<string, string>();
    for (const [id, a] of this.store.prefixed<Acted | null>("acted:")) {
      const e = entries.get(id);
      if (a && e && e.status !== "active" && this.store.lastActionFor(id)?.seq === a.seq) acted.set(id, `${a.name}: ${a.why}`);
    }
    for (const board of boardsOf(loaded)) {
      const scope = loaded.config.spaces.find((s) => s.id === board.config.space)?.scope ?? "";
      // config.ts refuses a board whose source the desk doesn't run.
      const m = this.connectors.find((c) => c.id === (board.config.source ?? "github"))!.boardIds(board, scope, loaded);
      const ids = new Set(m.ids);
      // A coordinator's desk_add too, after you act on it, so it doesn't vanish once its pin stops counting as yours.
      if (board === ADDED)
        for (const [id, by] of pins)
          if ((by === "them" || coordinatorAdded.has(id)) && ![...boards.values()].some((b) => b.result.placements.has(id))) ids.add(id);
      // A kept item is only there to show as resolved.
      const list = [...ids]
        .map((id) => entries.get(id))
        .filter((e): e is Entry => e !== undefined && (!m.kept.has(e.item.id) || e.resolved !== null));
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
          kept: m.kept.has(e.item.id) || recent(e),
          ai: call(e),
        })),
        judge,
        this.settings["queue.quiet_days"],
      );
      if (board === ADDED) for (const [id, p] of result.placements) p.why = auto.get(id) ?? p.why;
      boards.set(board.config.id, { result, queries: m.queries, unfetched: m.unfetched, error: m.error });
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
      acted,
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
    // Back on top of your desk; your agent's hand-back says so where its stage would be, as no heading over its row does.
    const back = !e.inflight && snap.needs.has(it.id);
    const handed = back && snap.needs.get(it.id) !== UNASKED;
    const shown = handed ? "handed back" : sig.blocked && (st === "approved" || st === "waiting for review") ? "blocked" : st;
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
      why: e.resolved?.reason ?? snap.acted.get(it.id) ?? p?.why ?? "",
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
      ...(back && { handed_back: true }),
      // Even with red CI: getting it green is the coordinator's once it's ready, so the desk never holds this back.
      ...(it.kind === "pr" && it.draft && it.state === "open" && me.author && this.writer && { cta: "ready" as const }),
      ...(snap.unasked.has(it.id) && this.writer && { cta: "reviewers" as const }),
      ...(talked(it, this.me()) && { talk: true as const }),
      ...(actions.length > 0 && { actions }),
      ...(by && { placed_by: by }),
      ...(stack && { stack }),
      ...(sig.blocked && {
        blocker: { id: snap.deps.get(it.id)!.root!, ref: sig.blocker, waits: sig.blocker_waits },
        needs: sig.blocked_by,
      }),
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

  // What an entry point checks first; what runs after a snapshot asserts it (this.loaded!).
  requireConfig(): Effect.Effect<LoadedConfig, Unavailable> {
    return Effect.suspend((): Effect.Effect<LoadedConfig, Unavailable> => {
      if (this.loaded) return Effect.succeed(this.loaded);
      const errors = this.configErrors.map((e) => `${e.path}: ${e.message}`).join("; ");
      return Effect.fail(new Unavailable({ message: `config has errors: ${errors}`, reason: "config" }));
    });
  }

  summary(id: string, snap: Snapshot): BoardSummary {
    const cfg = this.loaded!.config.boards.find((b) => b.id === id)!;
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

  overview(): Effect.Effect<Overview, Unavailable> {
    return Effect.gen({ self: this }, function* () {
      const loaded = yield* this.requireConfig();
      const snap = this.snapshot();
      const focus = yield* this.focus();
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
          sessions: this.sessions.active().length,
        },
        inflight: { total: [...snap.entries.values()].filter((e) => e.inflight).length },
        agent: this.settings["agent.coordinator"],
        ai_agent: agentName(this.settings["agent.harness"]),
        rate_limit: this.gh.api.rateLimit(),
      };
    });
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
      if (this.aiRunning(it.id)) return ai ? "stale" : "running";
      const tried = this.aiFailedOn(it); // opening it doesn't start one: its review says why
      if (tried && this.jobs.get("ai_review", it.id)?.state === "failed") return "failed";
      if (!this.autoAiOn()) return "off";
      if (this.aiPausedNow()) return "paused"; // a try to come waits out the pause too
      if (tried) return "failed";
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
    const login = (why: string | null | undefined) => !!why?.endsWith(notLoggedIn(this.agent()));
    const ai = this.autoAiOn() && this.aiPausedNow() ? this.aiPaused!.why : null;
    if (login(ai) || (!this.judge.offReason() && login(this.judge.error)))
      return { who: "claude", why: this.agent() === "codex" ? CODEX_PAUSED : CLAUDE_PAUSED };
    return ai ? { who: "ai", why: ai } : null;
  }

  // A stack is one line here, as in the queue.
  focus(): Effect.Effect<FocusView, Unavailable> {
    return Effect.map(this.requireConfig(), () => {
      const snap = this.snapshot();
      const sections = this.top(snap, new Set());
      oneLinePerStack(sections, ["now", "today"], snap.stacks);
      return {
        sessions: this.sessions.active(),
        sections,
        reviewing: this.reviewing(snap),
        cards: this.settings["queue.cards"],
        paused: this.paused(),
      };
    });
  }

  // Someone else's open PR reaches your desk once Claude has reviewed it: until its first AI review is written it waits,
  // unless AI reviews are off or paused, or this commit's failed. Once shown (`shown:<id>`, or you put it there) it stays.
  awaitsAi(e: Entry, snap: Snapshot): boolean {
    const it = e.item;
    if (!this.autoAi() || it.kind !== "pr" || it.state !== "open" || e.analysis.signals.me.author) return false;
    if (snap.reviews.has(it.id) || this.store.get(`shown:${it.id}`)) return false;
    return !this.aiFailedOn(it);
  }

  // How many would be in Now or Today but for Claude's review.
  reviewing(snap: Snapshot): number {
    return [...snap.best].filter(([id, p]) => (p.bucket === "now" || p.bucket === "today") && this.awaitsAi(snap.entries.get(id)!, snap))
      .length;
  }

  // Now and Today in the queue's order, which the AI reviews run in too: what was handed back, then each board's. `all` keeps
  // what waits on Claude's first review (awaitsAi), for the AI reviews and the notifications.
  top(snap: Snapshot, seen: Set<string>, all = false): FocusView["sections"] {
    const loaded = this.loaded!;
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
    return { now: byPart(queueOrder(sections.now)), today: byPart(queueOrder(sections.today)) };
  }

  // The single surface: every item once, at its best placement across boards.
  queue(): Effect.Effect<QueueView, Unavailable> {
    return Effect.map(this.requireConfig(), (loaded) => {
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
      sections.blocked = blockedOrder([...sections.blocked, ...merging].map(aged), (id) => snap.deps.get(id)?.needs ?? []);
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
        sessions: this.sessions.cards(),
        sections,
        reviewing,
        hidden,
        cleared,
        resolved: resolved.sort((a, b) => (b.resolved_at ?? "").localeCompare(a.resolved_at ?? "")),
        cards: this.settings["queue.cards"],
        paused: this.paused(),
        stacks: this.stacksOf([...leads, ...merging, ...hidden, ...cleared, ...resolved], snap),
      };
    });
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

  board(id: string): Effect.Effect<BoardView, Unavailable | NotFound> {
    return Effect.gen({ self: this }, function* () {
      const loaded = yield* this.requireConfig();
      if (!loaded.config.boards.some((b) => b.id === id)) return yield* new NotFound({ message: `no board "${id}"` });
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
    });
  }

  resolve(text: string): Effect.Effect<string, RefError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.requireConfig();
      const ids = [...this.snapshot().entries.keys()];
      if (ids.includes(text)) return text;
      const link = linkRef(text);
      if (link && "refused" in link) return yield* new NotFound({ message: link.refused });
      const ref = link?.id ?? text;
      if (ids.includes(ref)) return ref;
      const refs = this.connectors.flatMap((c) => c.refOf(ref, ids) ?? []);
      if (!refs.length)
        return yield* new NotFound({ message: `can't read "${ref}"; use owner/repo#123, repo#123, a GitHub URL or an inbox:// link` });
      const found = refs.flatMap((r) => r.held);
      const [first] = found;
      if (found.length === 1 && first !== undefined) return first;
      if (found.length === 0) return yield* new NotFound({ message: `no item "${ref}" on the desk` });
      return yield* new AmbiguousRef({ message: `"${ref}" matches ${found.length} items`, ref, candidates: found });
    });
  }

  item(ref: string): Effect.Effect<ItemDetail, RefError> {
    return Effect.gen({ self: this }, function* () {
      const loaded = yield* this.requireConfig();
      const snap = this.snapshot();
      const id = yield* this.resolve(ref);
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
        generating: this.aiRunning(id),
        held: this.awaitsAi(e, snap) && ["now", "today"].includes(snap.best.get(id)?.bucket ?? ""),
        activity: this.store.activity({ after: 0, limit: ITEM_ACTIVITY, item: id, latest: true }),
        stack: this.stack(id, snap),
      };
    });
  }

  // ---------------------------------------------------------------- review

  pr(ref: string): Effect.Effect<Entry, RefError | BadRequest> {
    return Effect.gen({ self: this }, function* () {
      const id = yield* this.resolve(ref);
      const e = this.snapshot().entries.get(id)!;
      if (e.item.kind !== "pr") return yield* new BadRequest({ message: `${e.item.id} is an issue; reviews are for pull requests` });
      return e;
    });
  }

  // GET /api/review/:id. Opening a PR starts its AI review (auto_ai, none for this commit) and Claude's read; `ahead` neither.
  // What fails the diff is files_error, reported; what fails the conversation, conversation_error.
  reviewView(ref: string, ahead = false): Effect.Effect<ReviewView, RefError | BadRequest> {
    return Effect.gen({ self: this }, function* () {
      const id = (yield* this.pr(ref)).item.id;
      const diff = this.prText(id).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
            const err = Cause.squash(cause);
            return Effect.sync(() => {
              report(err, "diff", id);
              return { files: [] as ReviewFile[], head: null, error: messageOf(err) };
            });
          },
          onSuccess: (t) => Effect.succeed({ files: t.files, head: t.head ?? null, error: null }),
        }),
      );
      const [talk, got, checks] = yield* Effect.all([this.convos.view(id, !ahead), diff, this.checksOf(id)], {
        concurrency: "unbounded",
      });
      const snap = this.snapshot();
      const e = snap.entries.get(id)!;
      if (!ahead && this.autoAi() && this.wantsAi(e, snap)) this.startAi(id);
      const d = yield* this.item(id);
      const job = this.jobs.get("ai_review", id);
      const running = job?.state === "running";
      const own = !running && job?.head === e.item.head_oid ? job.error : null;
      // A PR the desk would have reviewed on its own says why it didn't.
      const paused = this.autoAiOn() && this.aiPausedNow() && this.wantsAi(e, snap) ? `AI reviews are paused: ${this.aiPaused!.why}` : null;
      return {
        card: this.replyOnly(e) && d.card.cta !== "reviewers" ? { ...d.card, cta: "reply" } : d.card,
        item: d.item,
        handoff_prompt: d.handoff_prompt,
        files: got.files,
        diff_head: got.head ?? e.item.head_oid,
        files_error: got.error,
        order: reviewOrder(got.files, d.ai, d.ai_stale),
        ai: d.ai,
        ai_stale: d.ai_stale,
        ai_error: running ? null : (own ?? paused),
        generating: running,
        ai_job: running || job?.head === e.item.head_oid ? (this.autoAiOn() ? this.aiWaits(job) : job) : null,
        approve: this.canApprove(e),
        activity: d.activity,
        stack: d.stack,
        asks: this.asks(id),
        ...checks,
        reviewers: standings(d.item, this.me()),
        merge: mergeLine(d.item),
        ...talk,
      };
    });
  }

  // A PR's checks for its review, asked of GitHub only when one is opened or fetched ahead: a sync asks for none. What
  // fails the fetch is checks_error, in GitHub's words.
  checksOf(id: string): Effect.Effect<Pick<ReviewView, "checks" | "checks_error">> {
    return Effect.suspend(() => {
      const it = this.snapshot().entries.get(id)!.item;
      return Effect.match(Cache.get(this.checkRuns, `${id} ${it.node_id} ${it.detail_at}`), {
        onFailure: (e) => ({ checks: null, checks_error: e.message }),
        onSuccess: (list) => ({ checks: checksView(list), checks_error: null }),
      });
    });
  }

  // The changed files and description, kept per head commit; a fetch on its way is shared (see shared()).
  prText(id: string): Effect.Effect<PrText, PrTextError> {
    return Effect.suspend((): Effect.Effect<PrText, PrTextError> => {
      const review = this.review;
      if (!review) return Effect.fail(new Conflict({ message: "diffs aren't available in this desk" }));
      const e = this.snapshot().entries.get(id)!;
      const item = e.item;
      // Pushed since you reviewed it: the diff since your review's commit too, for a "since your review" line.
      const me = e.analysis.signals.me;
      const since = me.pushed_since_review
        ? item.reviews.findLast((r) => r.author.toLowerCase() === me.login.toLowerCase() && !!r.commit)?.commit
        : undefined;
      const cached = this.store.get(`pr:${id}`) as (PrText & { head_oid: string }) | null;
      if (cached?.head_oid === item.head_oid) return Effect.succeed(cached);
      const fetch = Effect.tap(review.fetchPr(item, since), (t) =>
        Effect.sync(() => {
          this.store.set(`pr:${id}`, { ...t, head_oid: item.head_oid });
        }),
      );
      return Deferred.await(this.shared(this.fetching, "diff", id, fetch));
    });
  }

  // POST /api/review/:id/ai (and desk_brief, `desk brief`): the cached review for this commit unless `force`. What fails the
  // run is passed on in its words, its error the cause: the run reported it already.
  aiReview(ref: string, force = false): Effect.Effect<AiReview, RefError | BadRequest | Upstream> {
    return Effect.gen({ self: this }, function* () {
      const e = yield* this.pr(ref);
      const cached = this.snapshot().reviews.get(e.item.id);
      if (cached && cached.head_oid === e.item.head_oid && !force) return cached;
      return yield* this.generate(e.item.id).pipe(
        Effect.mapError((err) => new Upstream({ message: err.message, cause: err })),
        // A bug in the run is its ai_error as a failure is, and answered the same way.
        Effect.catchDefect((bug) => Effect.fail(new Upstream({ message: messageOf(bug), cause: bug }))),
      );
    });
  }

  // One run per PR at a time; asking again joins it, and a caller leaving never stops it.
  generate(id: string): Effect.Effect<AiReview, AiError> {
    return Effect.suspend(() => Deferred.await(this.startAi(id)));
  }

  // The PR's AI review, started unless one is on its way: its job runs from now. `fresh` (yours, the queue's) starts its
  // tries over, the loop's retry of a failed one doesn't. Once it's done, a PR that waited on it is on your desk; after a
  // success the pump starts the next, after a failure the job waits out its backoff.
  startAi(id: string, fresh = true): Deferred.Deferred<AiReview, AiError> {
    const running = this.generating.get(id);
    if (running) return running;
    if (!this.stopped) this.jobs.begin("ai_review", id, { item: id, head: this.snapshot().entries.get(id)!.item.head_oid, fresh });
    const d = this.shared(this.generating, "ai_review", id, this.runAi(id), (ok) => {
      if (this.stopped) return;
      this.changed();
      this.notifyNew();
      if (ok) this.pumpAi();
    });
    this.changed();
    return d;
  }

  // Work its callers share (an AI review, a PR's diff), kept in `runs` while it's on its way. Forked through the runner: a
  // caller leaving never stops it, and the desk stopping does, which ends its callers too. The fiber frees its slot and
  // does `after` before they resume, unless the work was interrupted (the diff it waits on, ended by the desk stopping
  // first): that does nothing more. One the stopped desk won't start ends them at once.
  private shared<A, E>(
    runs: Map<string, Deferred.Deferred<A, E>>,
    what: string,
    id: string,
    work: Effect.Effect<A, E>,
    after: (ok: boolean) => void = () => {},
  ): Deferred.Deferred<A, E> {
    const running = runs.get(id);
    if (running) return running;
    const d = Deferred.makeUnsafe<A, E>();
    runs.set(id, d);
    let result: Exit.Exit<A, E> | undefined; // the work's own: a bug in after() is the runner's, not its callers'
    const run = Effect.exit(work).pipe(
      Effect.tap((exit) =>
        Effect.sync(() => {
          result = exit;
          runs.delete(id);
          if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return;
          after(Exit.isSuccess(exit));
        }),
      ),
      Effect.onExit((ended) =>
        Effect.sync(() => {
          if (runs.get(id) === d) runs.delete(id);
          Deferred.doneUnsafe(d, result ?? (Exit.isSuccess(ended) ? ended.value : Exit.failCause(ended.cause)));
        }),
      ),
    );
    const fiber = this.runner.fork(what, run, id);
    if (fiber) this.fibers.set(d, fiber);
    else {
      runs.delete(id);
      Deferred.doneUnsafe(d, Exit.interrupt());
    }
    return d;
  }

  // Stops shared work on its way (an AI review past its time): its callers end with `err`, and it records nothing itself.
  private stopShared<A, E>(runs: Map<string, Deferred.Deferred<A, E>>, id: string, err: E): void {
    const d = runs.get(id);
    if (!d) return;
    Deferred.doneUnsafe(d, Exit.fail(err));
    this.fibers.get(d)?.interruptUnsafe();
  }

  // What fails it, a bug too, is its ai_error for this commit (reported, and logged with the login's own words), and
  // AI_PAUSE_AFTER of them in a row pause the reviews nobody asked for. The desk stopping interrupts it: nothing is kept.
  runAi(id: string): Effect.Effect<AiReview, AiError> {
    return Effect.gen({ self: this }, function* () {
      const snap = this.snapshot();
      const e = snap.entries.get(id)!;
      const review = Effect.gen({ self: this }, function* () {
        if (!this.review) return yield* new Conflict({ message: "AI review isn't available in this desk" });
        const pr = yield* this.prText(id);
        const ai = yield* this.review.generate(e.item, e.analysis.signals, snap.best.get(id)?.why ?? "", pr, this.agentDir(), this.agent());
        this.store.set(`review:${id}`, ai);
        this.jobs.done("ai_review", id);
        this.aiFailures = 0;
        this.aiLastFailed = null;
        if (this.aiPaused) this.log("AI reviews resume");
        this.aiPaused = null;
        this.log(
          `AI review of ${id}: ${ai.verdict}, ${ai.concerns.length} concerns, ${ai.notes.length} notes${ai.dropped ? ` (${ai.dropped} the check dropped)` : ""}, ${ai.chunks ? `${ai.chunks.ranked.length} of ${ai.chunks.total} chunks ranked` : "no ranking"}, ${ai.guide ? `${ai.guide.steps.length} steps covering ${ai.guide.steps.reduce((n, st) => n + st.hunks.length, 0)} hunks` : "no walk-through"}`,
        );
        this.retryAgents(notLoggedIn(this.agent()));
        return ai;
      });
      return yield* review.pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.sync(() => {
                this.aiFailed(id, Cause.squash(cause));
              }),
        ),
      );
    });
  }

  // A failed try: its job retries after its backoff, or fails for good with these words.
  private aiFailed(id: string, err: unknown): void {
    if (this.stopped) return; // killed with the desk
    const message = messageOf(err);
    report(err, "ai_review", id);
    const detail = err instanceof ClaudeNotLoggedIn ? ` (${err.detail})` : ""; // the login's own words, for the log
    this.log(`AI review of ${id} failed: ${message}${detail}`);
    if (id !== this.aiLastFailed) this.aiFailures++; // one PR timing out again doesn't pause the rest
    this.aiLastFailed = id;
    const down = agentDown(err); // the agent's failure, not this PR's: every review waits with it, and none spends a try
    if (down || this.aiFailures >= AI_PAUSE_AFTER) {
      if (!this.aiPausedNow()) this.log(`AI reviews nobody asked for are paused for ${AI_RETRY / 60_000} min`);
      this.aiPaused = { why: message, until: Date.now() + AI_RETRY };
    }
    if (down) this.jobs.held("ai_review", id, message, this.now().getTime() + AI_RETRY);
    else this.jobs.tried("ai_review", id, message);
  }

  aiPausedNow(): boolean {
    return !!this.aiPaused && Date.now() < this.aiPaused.until;
  }

  // Someone else's open PR with no AI review of its head yet, nor a job for it: one that failed retries on its own, or waits for you.
  wantsAi(e: Entry, snap: Snapshot): boolean {
    const it = e.item;
    if (it.kind !== "pr" || it.state !== "open" || e.analysis.signals.me.author || this.generating.has(it.id)) return false;
    if (snap.reviews.get(it.id)?.head_oid === it.head_oid) return false;
    const j = this.jobs.get("ai_review", it.id);
    return !(j && j.head === it.head_oid && j.state !== "done");
  }

  // A try to come doesn't start while AI reviews are paused: its retry_at is no sooner than the pause's end.
  private aiWaits(job: Job | null): Job | null {
    if (!job || job.state !== "queued" || !job.retry_at || !this.aiPausedNow()) return job;
    const until = new Date(this.aiPaused!.until).toISOString();
    return until > job.retry_at ? { ...job, retry_at: until } : job;
  }

  // Its AI review's job is running: "Claude is reviewing it".
  aiRunning(id: string): boolean {
    return this.jobs.get("ai_review", id)?.state === "running";
  }

  // A try on its head failed: it's on your desk without one, its error said in its review.
  aiFailedOn(it: Item): boolean {
    const j = this.jobs.get("ai_review", it.id);
    return !!j?.error && j.head === it.head_oid;
  }

  // The loop's: a review past its time is stopped and counts as a failed try; its callers get the same words.
  aiStop(id: string, err: CommandTimeout): void {
    this.aiFailed(id, err);
    this.stopShared(this.generating, id, err);
    this.changed();
  }

  // The loop's: a running job with no run in this desk (a bug, or a diff the desk stopped) is a failed try.
  aiGone(id: string): void {
    this.log(`AI review of ${id}: ${GONE}`);
    this.jobs.tried("ai_review", id, GONE);
  }

  // AI reviews nobody asked for: on unless review.auto_ai is off...
  autoAiOn(): boolean {
    return !!this.review && this.settings["review.auto_ai"];
  }

  // ...and not paused because they keep failing.
  autoAi(): boolean {
    return this.autoAiOn() && !this.aiPausedNow();
  }

  // Background AI reviews, a couple at a time: first the failed tries whose backoff is over, then in the queue's order, Now,
  // then Today from the top, so the cards on screen are ready first.
  pumpAi(): void {
    if (this.stopped || !this.loaded || !this.autoAi()) return;
    let room = AI_AT_ONCE - this.generating.size; // counted here: a run that fails at once frees its slot before startAi returns
    if (room <= 0) return;
    const snap = this.snapshot();
    for (const j of this.jobs.due("ai_review")) {
      if (room <= 0 || !this.autoAi()) return; // a run that failed at once may have paused them
      const e = snap.entries.get(j.key);
      if (e?.item.kind !== "pr" || e.item.state !== "open") this.jobs.drop(j.kind, j.key);
      else if (snap.reviews.get(j.key)?.head_oid === e.item.head_oid) this.jobs.done(j.kind, j.key);
      else if (!this.generating.has(j.key)) {
        this.startAi(j.key, false);
        room--;
      }
    }
    const top = this.top(snap, new Set(), true);
    for (const c of [...top.now, ...top.today]) {
      if (room <= 0 || !this.autoAi()) return; // a run that failed at once may have paused them
      const e = snap.entries.get(c.id);
      if (e && this.wantsAi(e, snap)) {
        this.startAi(c.id);
        room--;
      }
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
  approve(ref: string, head: string, body?: string): Effect.Effect<{ url: string }, WriteError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.notStopped();
      const e = yield* this.pr(ref);
      const id = e.item.id;
      const can = this.canApprove(e);
      if (!can.ok) return yield* new Conflict({ message: `can't approve ${id}: ${can.reason}` });
      if (head !== e.item.head_oid) return yield* new Stale({ message: `can't approve ${id}: it has new commits since you opened it` });
      const write = Effect.gen({ self: this }, function* () {
        const { url } = yield* this.writer!.approve(e.item.node_id, head, body).pipe(
          Effect.mapError(upstream("GitHub didn't take the approval: ")),
        );
        this.store.logWrite(id, "approve", this.now().toISOString());
        this.log(`approved ${id} on GitHub${url ? ` (${url})` : ""}`);
        yield* this.doneAfterWrite(id);
        this.refreshAfter(id);
        return { url };
      });
      return yield* this.locked(this.approving, id, `already approving ${id}`, write);
    });
  }

  // A write's first step: a stopped desk reads nothing for one (its store may be closed), and the request ends as interrupted.
  private notStopped(): Effect.Effect<void> {
    return Effect.suspend((): Effect.Effect<void> => (this.stopped ? Effect.interrupt : Effect.void));
  }

  // Busy at once on a held lock, interrupted on a stopped desk; the write and its bookkeeping are uninterruptible, the lock goes whatever GitHub said.
  private locked<A, E>(locks: Set<string>, key: string, busy: string, write: Effect.Effect<A, E>): Effect.Effect<A, E | Busy> {
    return Effect.uninterruptible(
      Effect.suspend((): Effect.Effect<A, E | Busy> => {
        if (this.stopped) return Effect.interrupt;
        if (locks.has(key)) return Effect.fail(new Busy({ message: busy }));
        locks.add(key);
        return Effect.ensuring(
          write,
          Effect.sync(() => {
            locks.delete(key);
            if (this.stopped) this.closeIfIdle();
          }),
        );
      }),
    );
  }

  // The PR first (the search index lags), then the full pass, in one runner fiber so the desk stopping interrupts both.
  private refreshAfter(id: string): void {
    this.runner.fork("refresh", this.gh.refresh(id).pipe(Effect.andThen(this.sync())), id);
  }

  // The More menu's GitHub writes this item allows now. A PR in Merging is the coordinator's: Back to desk brings it back first.
  actions(e: Entry): GitHubAction[] {
    const it = e.item;
    const me = e.analysis.signals.me;
    if (!this.writer || e.inflight || this.wrote.get(it.id) === it.updated_at) return [];
    if (it.kind === "issue") return it.state === "open" && (me.author || me.assignee) ? ["close"] : [];
    if (!me.author) return it.state === "open" ? ["request_changes"] : [];
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
  githubAct(ref: string, action: GitHubAction, opts: { head?: string; body?: string } = {}): Effect.Effect<{ url: string }, WriteError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.notStopped();
      const found = yield* this.resolve(ref);
      const e = this.snapshot().entries.get(found)!;
      const it = e.item;
      const id = it.id;
      const [verb, done] = GITHUB_VERB[action].map((x) => x.replace("%", id));
      if (!this.actions(e).includes(action)) return yield* new Conflict({ message: `can't ${verb} now` });
      if (action === "request_changes" && opts.head === undefined) return yield* new BadRequest({ message: "need head_oid" });
      const pinned = action === "merge" || action === "request_changes";
      if (pinned && opts.head !== undefined && opts.head !== it.head_oid)
        return yield* new Stale({ message: `can't ${verb}: it has new commits since you opened it` });
      const body = opts.body?.trim() ?? "";
      if (action === "request_changes" && !body) return yield* new BadRequest({ message: "say what needs to change" });
      if (body.length > MAX_REPLY) return yield* new BadRequest({ message: `keep it under ${MAX_REPLY} characters` });
      const w = this.writer!;
      const send = (): Effect.Effect<{ url: string }, GitHubWriteError> => {
        const none = { url: "" };
        if (action === "close") return Effect.as(it.kind === "issue" ? w.closeIssue(it.node_id) : w.close(it.node_id), none);
        if (action === "draft") return Effect.as(w.draft(it.node_id), none);
        if (action === "ready") return Effect.as(w.ready(it.node_id), none);
        if (action === "merge") return Effect.as(w.merge(it.node_id, it.head_oid, it.merge_method!), none);
        if (action === "reopen") return Effect.as(w.reopen(it.node_id), none);
        return w.requestChanges(it.node_id, it.head_oid, body);
      };
      const write = Effect.gen({ self: this }, function* () {
        const { url } = yield* send().pipe(Effect.mapError(upstream(`couldn't ${verb} on GitHub: `)));
        this.store.logWrite(id, action, this.now().toISOString());
        this.log(`${done} on GitHub${url ? ` (${url})` : ""}`);
        // Closed, merged or changes asked for: yours is done. Reopened: it's back on the desk. A draft is still yours to finish,
        // as is one marked ready with nobody asked to review it.
        if (action === "reopen") {
          // The done its close put on it goes, and what it was before (snoozed, muted) comes back with it.
          const ev = this.store.lastActionFor(id);
          if (ev?.action === "done") yield* this.undo(ev.seq);
          else if (this.store.state(id).done_at) yield* this.act(id, "restore");
        } else if (action !== "draft" && !(action === "ready" && this.unaskedOnceReady(it))) yield* this.doneAfterWrite(id);
        this.changed();
        // Awaited, so the window and its u see it closed (actions() reads the snapshot this replaces); the runner's, so a stop cuts it.
        const refresh = this.runner.fork("refresh", this.gh.refresh(id), id);
        if (refresh) yield* Fiber.await(refresh);
        // A refresh that failed or was skipped (rate limit) leaves the old state, which would offer the same write again.
        if (action !== "request_changes") this.wrote.set(id, it.updated_at);
        return { url };
      });
      return yield* this.locked(this.approving, id, `already writing to ${id} on GitHub`, write);
    });
  }

  // ---------------------------------------------------------------- actions

  // You acted on it in the desk, so your part is done: it leaves the desk at once, as Done does, and comes back when someone
  // else acts. A PR in Merging stays the coordinator's.
  private doneAfterWrite(id: string): Effect.Effect<void, ActError> {
    return Effect.suspend(() => (this.snapshot().entries.get(id)?.inflight ? Effect.void : Effect.asVoid(this.act(id, "done"))));
  }

  // `agent`: not the desk's own window. Hand-offs are yours. An automation's ("automation:<id>") is logged as its own.
  act(
    ref: string,
    action: Action,
    until?: string,
    agent?: string,
  ): Effect.Effect<{ state: ItemState; undo_seq: number }, RefError | Forbidden | Conflict | BadRequest> {
    if (isSessionRef(ref)) return this.sessionAct(ref, action, until, agent);
    return Effect.gen({ self: this }, function* () {
      const id = yield* this.resolve(ref);
      if (action === "undo") {
        const ev = this.store.lastActionFor(id);
        if (!ev) return yield* new NotFound({ message: `nothing to undo for ${id}` });
        return { state: (yield* this.undo(ev.seq, agent)).state, undo_seq: 0 };
      }
      // The coordinator merges what's in Merging, so only you put a PR there.
      if (agent && action === "inflight") return yield* new Forbidden({ message: "hand a PR off for merge from the desk's window" });
      const now = this.now();
      const before = this.store.state(id);
      const s: StateRow = { ...before };
      const entry = this.snapshot().entries.get(id)!;
      // The coordinator keeps working on it whatever its status, so it comes back to the desk first.
      if (entry.inflight && (action === "done" || action === "snooze" || action === "mute"))
        return yield* new Conflict({ message: `${id} is in Merging, so your agent has it; bring it back to the desk first` });
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
              return yield* new Conflict({
                message: `${id} can't wait until ${UNTIL[u as Until]}${can.length ? `; it can until ${can.map((x) => UNTIL[x]).join(", ")}` : ""}`,
              });
            s.snooze_when = u === "push" ? `push:${entry.item.head_oid}` : u;
            s.snooze_until = null;
            s.snoozed_at = now.toISOString();
            s.acked_at = seen;
            s.snooze_on_activity = false;
            s.done_at = null;
            break;
          }
          s.snooze_when = null;
          s.snooze_until = (yield* parseUntil(u, now)).toISOString();
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
            return yield* new Conflict({ message: `only your own open PRs are handed off for merge; ${id} isn't one` });
          if (s.inflight_at) return yield* new Conflict({ message: `${id} is in Merging already` });
          // Ready for review is yours, so a draft in Merging would wait on you there.
          if (entry.item.draft) return yield* new Conflict({ message: `${id} is a draft: mark it ready for review first` });
          // Nobody would review it, so the coordinator would wait on nothing.
          if (entry.analysis.signals.pr.unasked)
            return yield* new Conflict({ message: `nobody's asked to review ${id}: add reviewers first` });
          s.inflight_at = now.toISOString();
          // Merging has it now, so it isn't done, snoozed or muted in the queue any more (undo brings that back).
          Object.assign(s, ACTIVE);
          this.store.set(`sitter:${id}`, null); // a fresh start: no hand-back or note from last time
          break;
        case "takeback":
          if (!s.inflight_at) return yield* new Conflict({ message: `${id} isn't in Merging` });
          s.inflight_at = null;
          this.store.set(`sitter:${id}`, { ...this.merging(id), back: now.toISOString() }); // yours now: not sent to rebase
          break;
        default:
          return yield* new BadRequest({ message: `unknown action "${action as string}"` }); // reachable: the HTTP body isn't checked against Action
      }
      // An automation's pin was its opinion; once you deal with the item it's yours, and undo brings the pin back.
      if (["done", "snooze", "mute", "inflight"].includes(action) && s.pinned && this.store.lastPin(id)?.agent?.startsWith("automation:"))
        s.pinned = false;
      this.store.putState(s);
      const auto = agent?.startsWith("automation:") ? agent : undefined;
      const seq = action === "seen" ? 0 : this.store.logAction(id, action, before, now.toISOString(), auto);
      // An automation's sort was its opinion too, and its why for what it did: what you do with the item ends both.
      if (action !== "seen" && !auto) for (const k of [`sorted:${id}`, `acted:${id}`]) if (this.store.get(k)) this.store.set(k, null);
      // What you bring onto your desk is there now, reviewed or not.
      if (action === "pin" || action === "restore" || action === "unmute") this.store.set(`shown:${id}`, true);
      this.changed();
      if (action === "inflight") this.coordinator.wake(id, "handed off");
      const { snoozed_at: _, acked_at: __, ...state } = s;
      return { state, undo_seq: seq };
    });
  }

  // A session's triage: done until it moves on, snoozed until a time, muted. It isn't an item: nothing else applies.
  sessionAct(
    ref: string,
    action: Action,
    until?: string,
    agent?: string,
  ): Effect.Effect<{ state: ItemState; undo_seq: number }, NotFound | Conflict | BadRequest> {
    return Effect.gen({ self: this }, function* () {
      const c = yield* this.sessions.get(ref);
      if (action === "undo") {
        const ev = this.store.lastActionFor(c.id);
        if (!ev) return yield* new NotFound({ message: `nothing to undo for ${c.name}` });
        return { state: (yield* this.undo(ev.seq, agent)).state, undo_seq: 0 };
      }
      const now = this.now();
      const before = this.store.state(c.id);
      const s: StateRow = { ...before };
      switch (action) {
        case "done":
          Object.assign(s, ACTIVE, { done_at: now.toISOString(), muted: s.muted });
          break;
        case "snooze": {
          const u = until ?? "tomorrow";
          if (u === "activity" || Object.hasOwn(UNTIL, u))
            return yield* new Conflict({ message: `a session snoozes until a time; done brings it back when it moves on` });
          Object.assign(s, ACTIVE, {
            snooze_until: (yield* parseUntil(u, now)).toISOString(),
            snoozed_at: now.toISOString(),
            muted: s.muted,
          });
          break;
        }
        case "mute":
          s.muted = true;
          break;
        case "unmute":
          s.muted = false;
          break;
        case "restore":
          Object.assign(s, ACTIVE);
          break;
        case "seen":
          return { state: stateOf(s), undo_seq: 0 };
        case "pin":
        case "unpin":
        case "inflight":
        case "takeback":
          return yield* new Conflict({ message: `a session takes done, snooze, mute, unmute and restore; not ${action}` });
        default:
          return yield* new BadRequest({ message: `unknown action "${action as string}"` });
      }
      this.store.putState(s);
      const auto = agent?.startsWith("automation:") ? agent : undefined;
      const seq = this.store.logAction(c.id, action, before, now.toISOString(), auto);
      this.changed();
      return { state: stateOf(s), undo_seq: seq };
    });
  }

  // GET /api/sessions/:id (desk_item for a session).
  session(ref: string): Effect.Effect<SessionCard, NotFound> {
    return this.sessions.get(ref);
  }

  // Kick and Resume, from the desk's window only: the coordinator's safe stop-then-resume, refused while it runs or waits
  // on a rate limit.
  kickSession(ref: string): Effect.Effect<{ args: string[]; note: string | null }, NotFound | Conflict | CommandError> {
    return this.sessions.kick(ref);
  }

  // Open: the desktop app's or Codex's own link, which the desk's computer opens.
  openSession(ref: string): Effect.Effect<{ url: string }, NotFound | Conflict | CommandError> {
    return Effect.gen({ self: this }, function* () {
      const c = yield* this.sessions.get(ref);
      if (!c.open_url) return yield* new Conflict({ message: `${c.name} has no link to open` });
      yield* this.opener(c.open_url);
      return { url: c.open_url };
    });
  }

  // `agent`: not the desk's own window. Hand-offs are yours.
  undo(seq?: number, agent?: string): Effect.Effect<{ id: string; state: ItemState; action: Action }, NotFound | Conflict> {
    return Effect.gen({ self: this }, function* () {
      const ev = this.store.lastAction(seq);
      if (!ev) return yield* new NotFound({ message: "nothing to undo" });
      if (agent && (ev.action === "inflight" || ev.action === "takeback"))
        return yield* new Conflict({
          message: `undo ${ev.action === "inflight" ? "a hand-off for merge" : "bringing a PR back to the desk"} in the desk's window`,
        });
      if (this.store.hasLaterAction(ev.item_id, ev.seq))
        return yield* new Conflict({ message: `undo the later action on ${ev.item_id} first` });
      const cur = this.store.state(ev.item_id);
      const restored = { ...ev.before, inflight_at: ev.before.inflight_at ?? null, seen_at: cur.seen_at };
      this.store.putState(restored);
      this.store.markUndone(ev.seq);
      this.changed();
      const { snoozed_at: _, acked_at: __, ...state } = restored;
      return { id: ev.item_id, state, action: ev.action as Action };
    });
  }

  // `why` and `from`: an agent's hand-off, what needs you and which task sends it; the item's why while this pin stays.
  add(ref: string, why?: string, from?: string): Effect.Effect<{ item: ItemDetail; undo_seq: number }, RefError | BadRequest | Upstream> {
    return Effect.gen({ self: this }, function* () {
      const note = why === undefined ? null : yield* this.line(why, "why");
      const who = note === null || !from?.trim() ? "" : yield* this.line(from, "from", MAX_FROM);
      const id = yield* this.hold(ref);
      // A pin alone leaves a done, snoozed or muted item hidden; one undo seq takes back both.
      const before = this.store.state(id);
      this.store.putState({ ...before, ...ACTIVE, pinned: true });
      // The coordinator's desk_add is its opinion, which Claude weighs: no floor, as the old desk-run coordinator's pins.
      const undo_seq = this.store.logAction(id, "pin", before, this.now().toISOString(), isCoordinator(who) ? "coordinator" : undefined);
      if (note !== null)
        this.store.set(`added:${id}`, { ...(this.store.get(`added:${id}`) as Added | null), [undo_seq]: { why: note, from: who } });
      this.changed();
      this.warmAdded(id);
      return { item: yield* this.item(id), undo_seq };
    });
  }

  // An automation's find: on your desk as desk_add puts it, with its why. One that's on your queue already stays as it is;
  // one you dealt with (done, snoozed, muted, handed off for merge), or that nobody needs now, stays that way too.
  // A rule or a question has no agent that's told what its last run added, so the desk remembers (`once`, per automation:
  // the item's sortKey, less the pin): it adds an item once for what it is, also one you'd marked done, which nothing else
  // would bring back; after that the item stays where you put it (Done, Unpin) until it changes.
  push(ref: string, why: string, a: Automation): Effect.Effect<AutomationItem, RefError | BadRequest | Upstream> {
    return Effect.gen({ self: this }, function* () {
      const id = yield* this.hold(ref);
      const note = yield* this.line(why, "why", 300);
      const once = { ...(this.store.get(`pushed:${id}`) as { once?: Record<string, string> } | null)?.once };
      const snap = this.snapshot();
      const e = snap.entries.get(id)!;
      const queued = ["now", "today"].includes(snap.best.get(id)?.bucket ?? "");
      const key = a.decide ? sortKeyOf(e) : null;
      const done = key !== null && e.status === "done";
      let outcome: AutomationItem["outcome"] = "kept";
      if (e.resolved) outcome = "resolved";
      else if ((e.status !== "active" && !done) || e.inflight) outcome = "left";
      else if (done || (!e.state.pinned && !queued)) {
        if (key !== null && once[a.id] === key) outcome = "left";
        else {
          if (key !== null) once[a.id] = key;
          this.store.putState({ ...e.state, ...(done && ACTIVE), pinned: true });
          this.store.logAction(id, "pin", e.state, this.now().toISOString(), `automation:${a.id}`);
          outcome = "added";
          this.warmAdded(id);
        }
      }
      const said = { automation: a.id, name: a.name, why: note, at: this.now().toISOString() };
      this.store.set(`pushed:${id}`, { ...said, ...(Object.keys(once).length > 0 && { once }) });
      this.changed(); // the pump reads the snapshot: it must have the pin
      return { item_id: id, why: note, outcome };
    });
  }

  // An automation's sort: kept like Claude's answer for the item (compute()), so it holds until the item changes or you act
  // on it, and a hard rule's floor, a final rule and your pin bind it as they bind Claude: held says which did. Only what
  // the desk holds: a sort fetches nothing.
  sort(
    ref: string,
    bucket: "today" | "later" | "fyi" | "hide",
    why: string,
    a: Automation,
  ): Effect.Effect<AutomationItem, RefError | BadRequest> {
    return Effect.gen({ self: this }, function* () {
      const id = yield* this.resolve(ref);
      const note = yield* this.line(why, "why", 300);
      const said = { item_id: id, why: note, do: bucket };
      const snap = this.snapshot();
      const e = snap.entries.get(id)!;
      if (e.resolved) return { ...said, outcome: "resolved" as const };
      if (e.status !== "active" || e.inflight) return { ...said, outcome: "left" as const };
      if (!snap.best.has(id)) return { ...said, outcome: "failed" as const, error: "no board lists it, so there's nowhere to sort it" };
      const key = sortKeyOf(e, snap.pins.get(id));
      // Its own sort of the item as it is still stands: nothing to do, and its first why stays.
      const was = this.store.get(`sorted:${id}`) as Sorted | null;
      if (was?.automation === a.id && was.bucket === bucket && was.key === key) return { ...said, why: was.why, outcome: "kept" as const };
      const sorted: Sorted = { automation: a.id, name: a.name, bucket, why: note, key, at: this.now().toISOString() };
      this.store.set(`sorted:${id}`, sorted);
      this.changed();
      const now = this.snapshot();
      const p = now.best.get(id);
      if (p?.judge?.by === a.name && p.rule_bucket === bucket) return { ...said, outcome: "did" as const };
      const pin = this.store.lastPin(id)?.agent?.startsWith("automation:") ? "an automation's pin" : "your pin";
      const holds = !a.on
        ? "it's off, so what it sorts doesn't hold: turn it on in Settings → Your automations"
        : (this.raised(now, id) ??
          (p?.floor ? `${p.hard ? "a hard rule" : pin} keeps it in ${AT[p.floor]} or above` : "a final rule places it"));
      return { ...said, outcome: "held" as const, error: holds };
    });
  }

  // An automation's snooze, done or mute: the desk's own act(), in the action log as the automation's, so Undo takes it back;
  // the item says why while it stands. One you'd dealt with stays as you left it, and so does one nobody needs now; one
  // the desk raised for you, your pin or a hard rule holds is held.
  clear(
    ref: string,
    action: "snooze" | "done" | "mute",
    why: string,
    until: string | undefined,
    a: Automation,
  ): Effect.Effect<AutomationItem, ActError> {
    return Effect.gen({ self: this }, function* () {
      const id = yield* this.resolve(ref);
      const note = yield* this.line(why, "why", 300);
      const said = { item_id: id, why: note, do: action, ...(action === "snooze" && { until: until ?? "tomorrow" }) };
      const snap = this.snapshot();
      const e = snap.entries.get(id)!;
      if (e.resolved) return { ...said, outcome: "resolved" as const };
      if (e.status !== "active" || e.inflight) return { ...said, outcome: "left" as const };
      // What holds it for you, as a sort is held: what the desk raised, your own pin, a hard rule.
      const p = snap.best.get(id);
      const pinned = snap.pins.get(id) === "them" && !this.store.lastPin(id)?.agent?.startsWith("automation:");
      const held =
        this.raised(snap, id) ?? (pinned ? "your pin keeps it on your desk" : p?.hard ? `a hard rule keeps it in ${AT[p.bucket]}` : null);
      if (held) return { ...said, outcome: "held" as const, error: held };
      const { undo_seq } = yield* this.act(id, action, until, `automation:${a.id}`);
      const acted: Acted = { name: a.name, why: note, seq: undo_seq };
      this.store.set(`acted:${id}`, acted);
      this.changed();
      return { ...said, outcome: "did" as const };
    });
  }

  // What the desk put on top of your desk for you, which no automation moves: a hand-back, your ready PR nobody's asked to review.
  raised(snap: Snapshot, id: string): string | null {
    const need = snap.needs.get(id);
    if (need === undefined) return null;
    return need === UNASKED ? "it's your ready PR nobody's asked to review" : "your agent handed it back to you";
  }

  // A PR's pre-review starts as opening it would, not generate(): an agent may add many at once, and the pump keeps to AI_AT_ONCE.
  warmAdded(id: string): void {
    if (this.snapshot().entries.get(id)!.item.kind === "pr") {
      this.runner.fork("diff", Effect.ignore(this.prText(id)), id); // ahead of time: opening it says what failed
      this.runner.fork("conversations", this.convos.warm([id]), id);
    }
    this.pumpAi();
    this.judge.pump();
  }

  // The item's id, fetched read only if the desk doesn't hold it; an ambiguous ref and what its source fails with are passed on.
  hold(text: string): Effect.Effect<string, RefError | BadRequest | Upstream> {
    return Effect.gen({ self: this }, function* () {
      yield* this.requireConfig();
      const link = linkRef(text);
      if (link && "refused" in link) return yield* new BadRequest({ message: link.refused });
      const ref = link?.id ?? text;
      const refs = this.connectors.flatMap((c) => {
        const r = c.refOf(ref, []);
        return r ? [{ id: r.id, from: c }] : [];
      });
      if (!refs.length)
        return yield* new BadRequest({ message: `can't read "${ref}"; use owner/repo#123, a GitHub URL or an inbox:// link` });
      const exact = refs.find((r) => r.id !== undefined);
      // What it names exactly, or the ref trimmed, is what an ambiguous ref's words quote.
      const held = yield* Effect.catchTag(this.resolve(exact?.id ?? ref.trim()), "NotFound", () => Effect.succeed(null));
      if (held !== null) return held;
      if (exact?.id === undefined)
        return yield* new BadRequest({ message: `"${ref}" isn't on the desk; give owner/repo#123 or its URL so the desk can fetch it` });
      const got = yield* exact.from.fetchOne(exact.id);
      this.changed();
      return got;
    });
  }

  // ---------------------------------------------------------------- merging (in flight)

  // GET /api/inflight: your PRs in Merging, open ones first (latest activity on top), then any that merged or closed in the last 3 days.
  inflight(): Effect.Effect<InflightView, Unavailable> {
    return Effect.map(this.requireConfig(), () => {
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
        work: this.work(snap),
      };
    });
  }

  // Claude's work, in Merging: what's running, then queued, then failed, as the ledger has it; what's done isn't listed.
  work(snap: Snapshot): Work[] {
    const asks = new Map(this.asks().map((a) => [a.id, a.text.replaceAll(/\s+/g, " ")]));
    const questions = new Map(this.inquiries().map((q) => [q.id, q]));
    const rank = { running: 0, queued: 1, failed: 2, done: 3 };
    return this.jobs
      .list()
      .filter((j) => j.state !== "done")
      .map((j) => (j.kind === "ai_review" && this.autoAiOn() ? this.aiWaits(j)! : j))
      .map((j): Work => {
        const q = j.kind === "answer" ? questions.get(j.key) : undefined;
        if (q) return Object.assign({ title: q.question, from: q.from }, j);
        return Object.assign({ title: (j.kind === "ask" ? asks.get(j.key) : snap.entries.get(j.key)?.item.title) ?? j.key }, j);
      })
      .sort((a, b) => rank[a.state] - rank[b.state]);
  }

  // POST /api/coordinator/wake: Wake it (or Start it now) in Merging has it look now (and starts it, if it isn't running).
  // w, or Wake it under an ask it stopped without answering: that ask goes to it again, your words as you wrote them.
  // What cmd.exe can't pass is a BadRequest, as in ask; one that didn't start says so, with what stopped its run (reported
  // there) as the cause.
  wakeCoordinator(askId?: string): Effect.Effect<void, Conflict | BadRequest | Upstream | Unavailable> {
    return Effect.gen({ self: this }, function* () {
      if (!this.settings["agent.coordinator"]) return yield* new Conflict({ message: "your agent is off: Settings → Agent" });
      const a = askId ? this.asks().find((x) => x.id === askId && !x.answer) : undefined;
      if (a) {
        if (a.item_id) yield* this.requireConfig(); // askAbout reads the snapshot
        const told = yield* this.coordinator
          .tell(askLine(a, this.askAbout(a.item_id)))
          .pipe(Effect.mapError((e) => new BadRequest({ message: e.message })));
        this.jobs.queue("ask", a.id, a.item_id, true);
        yield* told;
      } else yield* this.coordinator.ran(this.coordinator.now());
      return yield* this.coordinator.saved() ? Effect.void : this.didntStart();
    });
  }

  // The loop's: an ask your agent stopped without answering goes to it again, as Wake it sends it, its tries counted.
  resendAsk(a: Ask): void {
    this.log(`your agent didn't answer ask ${a.id}: asking it again`);
    const tell = Effect.flatten(this.coordinator.tell(askLine(a, this.askAbout(a.item_id)))).pipe(
      Effect.catchTag("UnsafeArgument", (e) =>
        Effect.sync(() => {
          this.jobs.fail("ask", a.id, e.message);
        }),
      ),
    );
    this.jobs.queue("ask", a.id, a.item_id);
    this.runner.fork("coordinator", tell);
  }

  private didntStart(): Effect.Effect<never, Upstream> {
    const why = this.coordinator.failure ? messageOf(this.coordinator.failure) : "";
    return Effect.fail(
      new Upstream({ message: why ? `Your agent didn't start: ${why}` : "Your agent didn't start", cause: this.coordinator.failure }),
    );
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
  inflightEntry(ref: string): Effect.Effect<Entry, RefError | BadRequest | Conflict> {
    return Effect.gen({ self: this }, function* () {
      const e = yield* this.pr(ref);
      if (!e.inflight) return yield* new Conflict({ message: `${e.item.id} isn't one of your open PRs in Merging` });
      return e;
    });
  }

  // One plain line from an agent, whatever it sent.
  line(text: string, what: string, max = MAX_LINE): Effect.Effect<string, BadRequest> {
    const t = text
      .replaceAll(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "") // bidi marks, which make text read as something else
      // oxlint-disable-next-line no-control-regex -- one plain line, whatever the agent sent
      .replaceAll(/[\u0000-\u001f\u007f\s]+/g, " ")
      .trim();
    if (!t) return Effect.fail(new BadRequest({ message: `the ${what} is empty` }));
    return Effect.succeed(t.length > max ? `${t.slice(0, max - 1)}…` : t);
  }

  // Words in paragraphs, yours or an agent's: refused, not cut, over max; newlines and tabs stay, at most one blank line in a row.
  paragraphs(text: string, what: string, max: number): Effect.Effect<string, BadRequest> {
    if (text.length > max) return Effect.fail(new BadRequest({ message: `keep the ${what} under ${max} characters` }));
    const t = text
      .replaceAll(/\r\n?|[\u0085\u2028\u2029]/g, "\n")
      .replaceAll(INVISIBLE, "")
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n")
      .replaceAll(/\n{3,}/g, "\n\n")
      .trim();
    if (!t) return Effect.fail(new BadRequest({ message: `the ${what} is empty` }));
    return Effect.succeed(t);
  }

  // desk_note: the coordinator's latest status line on a PR in Merging, shown on its row.
  note(ref: string, text: string): Effect.Effect<{ text: string }, RefError | BadRequest | Conflict> {
    return Effect.gen({ self: this }, function* () {
      const e = yield* this.inflightEntry(ref);
      const note = { text: yield* this.line(text, "note"), at: this.now().toISOString() };
      this.store.set(`sitter:${e.item.id}`, { ...this.merging(e.item.id), note });
      this.changed();
      return { text: note.text };
    });
  }

  // desk_hand_back: the coordinator can't realistically get it merged. The PR leaves Merging for your desk with the line as its
  // why, on top. Nothing goes to GitHub.
  handBack(ref: string, why: string): Effect.Effect<{ reason: string }, RefError | BadRequest | Conflict> {
    return Effect.gen({ self: this }, function* () {
      const e = yield* this.inflightEntry(ref);
      const reason = yield* this.line(why, "reason");
      this.sendBack(e.item.id, reason, "agent");
      return { reason };
    });
  }

  // What a hand-back does once it's checked. `by`: the desk itself hands back a PR nobody's asked to review (handBackUnasked).
  private sendBack(id: string, reason: string, by: "agent" | "desk"): void {
    const before = this.store.state(id);
    const at = this.now().toISOString();
    this.store.putState({ ...before, inflight_at: null });
    this.store.logAction(id, "takeback", before, at, by);
    this.store.set(`sitter:${id}`, { ...this.merging(id), handback: { reason, at } });
    this.log(`${by === "desk" ? "the desk" : "an agent"} handed ${id} back: ${reason}`);
    this.changed();
    this.notifyNew();
  }

  // A PR in Merging nobody's asked to review (its request taken back, say): the coordinator can't get it reviewed, so it
  // comes back to you to ask someone. In Merging it's your open PR, and UNASKED is one line already: nothing to check.
  handBackUnasked(): void {
    if (!this.loaded) return;
    for (const e of this.snapshot().entries.values())
      if (e.inflight && e.status === "active" && this.stuckUnasked(e) && !e.analysis.signals.pr.blocked)
        this.sendBack(e.item.id, UNASKED, "desk");
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

  // pr.unasked as your draft will read once it's ready: nobody was asked while it was a draft either. Ready for review
  // then isn't done: it stays on your desk, for Add reviewers.
  private unaskedOnceReady(draft: Item): boolean {
    return analyze({ ...draft, draft: false }, this.ctx ?? NO_CONTEXT, this.loaded!.config, this.now()).signals.pr.unasked;
  }

  // POST /api/review/:id/reviewers: who reviews your ready PR nobody's asked (Ask reviewers in its review), one of the desk's
  // GitHub writes, on your click. Your part is done, so it leaves your desk until someone reviews.
  askReviewers(ref: string, ask: { users: string[]; teams: string[] }): Effect.Effect<void, WriteError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.notStopped();
      const e = yield* this.pr(ref);
      const id = e.item.id;
      if (!e.analysis.signals.me.author) return yield* new Conflict({ message: `${id} isn't your PR` });
      if (e.item.state !== "open" || e.item.draft) return yield* new Conflict({ message: `${id} isn't open and ready for review` });
      if (!ask.users.length && !ask.teams.length) return yield* new BadRequest({ message: "pick someone to ask" });
      const writer = this.writer;
      if (!writer) return yield* new Conflict({ message: "asking for reviews isn't available in this desk" });
      const write = Effect.gen({ self: this }, function* () {
        yield* writer
          .requestReviews(e.item.node_id, ask.users, ask.teams)
          .pipe(Effect.mapError(upstream("GitHub didn't ask for the reviews: ")));
        this.store.logWrite(id, "request_reviews", this.now().toISOString());
        const n = ask.users.length + ask.teams.length;
        this.log(`asked ${n} reviewer${n === 1 ? "" : "s"} on ${id} on GitHub`);
        yield* this.doneAfterWrite(id);
      }).pipe(Effect.ensuring(this.refreshed(id)));
      return yield* this.locked(this.approving, id, `already asking on ${id}`, write);
    });
  }

  // Whatever GitHub said to a write, the PR is read again; inside the write's region, so never on an interruption. Waited
  // for, so the window sees a PR that stays on your desk as the write left it (ready, with Add reviewers).
  private refreshed(id: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      const refresh = this.runner.fork("refresh", this.gh.refresh(id), id);
      return refresh ? Effect.asVoid(Fiber.await(refresh)) : Effect.void;
    });
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
    const whose = it.kind === "issue" ? "issue" : e.inflight || e.analysis.signals.me.author ? "mine" : "theirs";
    return { url: it.url, whose, merging: e.inflight, state: it.state };
  }

  // GET /api/asks/:id (desk_ask): where an ask is, and the only branch a change it asks for may be pushed to.
  askPlace(id: string): Effect.Effect<AskPlace, Unavailable | NotFound> {
    return Effect.gen({ self: this }, function* () {
      yield* this.requireConfig();
      const ask = this.asks().find((x) => x.id === id);
      if (!ask) return yield* new NotFound({ message: `no ask "${id}"` });
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
    });
  }

  // POST /api/ask, from the desk's window: your words to the coordinator, about the item (and thread or lines) you were on.
  // What cmd.exe can't pass is refused before anything is kept; once told, the ask and its rollback run to the end.
  ask(b: {
    text: string;
    item_id?: string;
    thread_id?: string;
    thread_url?: string;
    lines?: AskLines;
  }): Effect.Effect<Ask, Conflict | RefError | BadRequest | Upstream> {
    return Effect.gen({ self: this }, function* () {
      if (!this.settings["agent.coordinator"]) return yield* new Conflict({ message: "your agent is off: Settings → Agent" });
      const ref = b.item_id ? yield* this.resolve(b.item_id) : null; // before the snapshot, which needs the config
      const item = ref ? this.snapshot().entries.get(ref)!.item : null;
      const bad = (message: string) => new BadRequest({ message });
      const l = b.lines;
      if (l) {
        if (!item) return yield* bad("lines are on a PR's diff: send its item_id");
        if (item.kind !== "pr") return yield* bad("lines are on a PR's diff");
        if (b.thread_id || b.thread_url) return yield* bad("an ask is on a thread or on lines, not both");
        if (!/^[0-9a-f]{40}$/.test(l.head)) return yield* bad("lines need head: the 40-character commit they were read at");
        // desk_ask hands the name to a shell, quoted: what could break a line or read as something else is refused, not stripped.
        // oxlint-disable-next-line no-control-regex -- control characters are what it refuses
        const odd = /[\u0000-\u001f\u2028\u2029]/.test(l.path) || l.path.replaceAll(INVISIBLE, "") !== l.path;
        if (!l.path || l.path.length > 1000 || odd) return yield* bad("lines need path: a file name with no control characters");
      }
      if (b.thread_url && !/^https:\/\/github\.com\/\S+$/.test(b.thread_url)) return yield* bad("thread_url must be a GitHub URL");
      const a: Ask = {
        id: randomBytes(4).toString("hex"),
        at: this.now().toISOString(),
        text: yield* this.paragraphs(b.text, "ask", MAX_ASK),
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
      const send = Effect.gen({ self: this }, function* () {
        const told = yield* this.coordinator.tell(line).pipe(Effect.mapError((e) => new BadRequest({ message: e.message })));
        this.store.set("asks", [...this.asks(), a].slice(-ASKS_KEPT));
        this.jobs.queue("ask", a.id, a.item_id, true);
        this.changed();
        // Like Wake it: a coordinator that won't start says so now, rather than the ask waiting for an answer that never comes.
        if (started) return a;
        yield* told;
        if (this.coordinator.saved()) return a;
        this.coordinator.untell(line);
        this.store.set(
          "asks",
          this.asks().filter((x) => x.id !== a.id),
        );
        this.jobs.drop("ask", a.id);
        this.changed();
        return yield* this.didntStart();
      });
      return yield* Effect.uninterruptible(send);
    });
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

  inquiry(id: string): Effect.Effect<Inquiry, NotFound> {
    return Effect.suspend((): Effect.Effect<Inquiry, NotFound> => {
      const q = this.inquiries().find((x) => x.id === id);
      return q ? Effect.succeed(q) : Effect.fail(new NotFound({ message: `no inquiry "${id}"` }));
    });
  }

  // GET /api/inquiries/:id: the question, with its item's card wherever the desk shows it (the queue, Merging, a stack).
  inquiryView(id: string): Effect.Effect<InquiryView, NotFound> {
    return Effect.gen({ self: this }, function* () {
      const q = yield* this.inquiry(id);
      // Not on the desk, or the desk can't say yet: its ref still links to GitHub.
      const card = q.item_id
        ? yield* this.item(q.item_id).pipe(
            Effect.map((d): Card | null => d.card),
            Effect.catch(() => Effect.succeed(null)),
          )
        : null;
      return { ...q, card };
    });
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
  }): Effect.Effect<Inquiry, BadRequest | RefError> {
    return Effect.gen({ self: this }, function* () {
      // Refused, not cut: what's past the limit is often what an answer costs.
      const one = (text: string, what: string, max: number) =>
        Effect.filterOrFail(
          this.line(text, what, Infinity),
          (t) => t.length <= max,
          () => new BadRequest({ message: `keep the ${what} under ${max} characters` }),
        );
      const from = yield* one(b.from, "from", 60);
      const question = yield* one(b.question, "question", 300);
      // oxlint-disable-next-line no-control-regex -- paragraphs stay, anything else invisible goes, bidi marks too
      const context = b.context.replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
      if (context.length < MIN_CONTEXT)
        return yield* new BadRequest({
          message: `context is too thin to decide from (${context.length} of at least ${MIN_CONTEXT} characters): say what you're doing, what you found, what the choice turns on, and why your pick`,
        });
      if (context.length > MAX_CONTEXT) return yield* new BadRequest({ message: `keep the context under ${MAX_CONTEXT} characters` });
      const options = b.options ?? [];
      if (options.length > 6) return yield* new BadRequest({ message: "at most 6 options" });
      const links = b.links ?? [];
      if (links.length > MAX_LINKS) return yield* new BadRequest({ message: `at most ${MAX_LINKS} links` });
      if (!b.item && !links.length)
        return yield* new BadRequest({ message: "link what it's about: the PR or issue as item, or links to what you read" });
      const q: Inquiry = {
        id: randomBytes(4).toString("hex"),
        at: this.now().toISOString(),
        from,
        question,
        context,
        options: yield* Effect.forEach(options, (o) =>
          Effect.all({ answer: one(o.answer, "option", 80), next: one(o.next, `"next" of "${o.answer}"`, 400) }),
        ),
        links: yield* Effect.forEach(links, (l) => Effect.all({ label: one(l.label, "link's label", 80), url: linkUrl(l.url) })),
        item_id: b.item ? yield* this.itemId(b.item) : null,
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
      if (this.mayNotify()) this.notify(isCoordinator(q.from) ? "Your agent asks" : `${q.from} asks`, q.question);
      return q;
    });
  }

  // POST /api/inquiries/:id/answer, from the desk's window: your answer, for the agent to read; it leaves your desk.
  answerInquiry(id: string, text: string, dismissed = false): Effect.Effect<Inquiry, NotFound | Conflict | BadRequest> {
    return Effect.gen({ self: this }, function* () {
      const q = yield* this.inquiry(id);
      if (q.answer) return yield* new Conflict({ message: "already answered" });
      const answer = dismissed ? "" : text.trim();
      if (!dismissed && !answer) return yield* new BadRequest({ message: "the answer is empty" });
      if (answer.length > MAX_ASK) return yield* new BadRequest({ message: `keep an answer under ${MAX_ASK} characters` });
      const at = this.now().toISOString();
      const done: Inquiry = { ...q, answer: { text: answer, at, dismissed, ...(!dismissed && { read_at: null }) } };
      this.store.set(
        "inquiries",
        this.inquiries().map((x) => (x.id === id ? done : x)),
      );
      // Nothing pushes it to a session that stopped waiting: it's owed until whoever asked reads it. A dismissal owes nothing.
      if (!dismissed) this.jobs.queue("answer", id, q.item_id);
      this.changed();
      // Your answer is what wakes the coordinator (it ends its turn once it asks); what cmd.exe can't pass is only logged.
      if (isCoordinator(q.from) && this.settings["agent.coordinator"]) {
        const asked = `your question ${q.id} ("${q.question}")`;
        const line = dismissed ? `I dismissed ${asked}: decide yourself.` : `My answer to ${asked}: "${answer.replaceAll(/\s+/g, " ")}"`;
        // tell() keeps the line and wakes it; nothing here waits for that run.
        const tell = this.coordinator.tell(line).pipe(
          Effect.asVoid,
          Effect.catch((e) =>
            Effect.sync(() => {
              this.log(`coordinator: couldn't pass on your answer to ${q.id}: ${e.message}`);
            }),
          ),
        );
        this.runner.fork("coordinator", tell);
      }
      return done;
    });
  }

  // GET /api/inquiries/unread (desk_inquiry with no id): your answers nobody has picked up yet, in the order they were asked.
  unreadAnswers(): Inquiry[] {
    return this.inquiries().filter((q) => q.answer?.read_at === null);
  }

  // POST /api/inquiries/:id/read (desk_inquiry gave whoever asked your answer) and the wake that gives your agent its own:
  // when it was first read, which ends its job in Claude's work.
  answerRead(id: string): Effect.Effect<Inquiry, NotFound> {
    return Effect.map(this.inquiry(id), (q) => {
      if (q.answer?.read_at !== null) return q;
      const read: Inquiry = { ...q, answer: { ...q.answer, read_at: this.now().toISOString() } };
      this.store.set(
        "inquiries",
        this.inquiries().map((x) => (x.id === id ? read : x)),
      );
      this.jobs.done("answer", id);
      this.changed();
      return read;
    });
  }

  // The loop's: your answer sat unread past its wait, so you're told, once; Merging keeps saying so for a day.
  answerUnread(q: Inquiry): void {
    const who = isCoordinator(q.from) ? "your agent" : q.from;
    this.jobs.fail("answer", q.id, "that session has probably ended");
    this.log(`your answer to ${q.from} (question ${q.id}) hasn't been picked up`);
    if (this.mayNotify())
      this.notify("Answer not picked up", `Your answer to ${who} hasn't been picked up, so that session has probably ended.`);
  }

  // desk_answer: the coordinator's answer to one of your asks, in your chat with it in the desk, and a notification.
  answer(id: string, text: string): Effect.Effect<Ask, NotFound | BadRequest> {
    return Effect.gen({ self: this }, function* () {
      const all = this.asks();
      const a = all.find((x) => x.id === id);
      if (!a) return yield* new NotFound({ message: `no ask "${id}"` });
      const done: Ask = { ...a, answer: { text: yield* this.paragraphs(text, "answer", MAX_ANSWER), at: this.now().toISOString() } };
      this.store.set(
        "asks",
        all.map((x) => (x === a ? done : x)),
      );
      this.jobs.done("ask", id);
      this.coordinator.answered(id);
      this.changed();
      const said = lead(done.answer!.text);
      if (!a.answer && this.mayNotify()) {
        const words = said ? yield* this.line(said, "answer") : "It answered your ask.";
        this.notify("Your agent", `${a.item_id ? `${a.item_id}: ` : ""}${words}`);
      }
      return done;
    });
  }

  // POST /api/review/:id/reply: your reply to one of the PR's conversations, on your click. One of the desk's GitHub writes.
  reply(ref: string, convoId: string, body: string): Effect.Effect<{ url: string }, WriteError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.notStopped();
      const e = yield* this.pr(ref);
      const id = e.item.id;
      const text = body.trim();
      if (e.item.state !== "open") return yield* new Conflict({ message: `can't reply on ${id}: it's ${e.item.state}` });
      if (!text) return yield* new BadRequest({ message: "the reply is empty" });
      if (text.length > MAX_REPLY) return yield* new BadRequest({ message: `keep a reply under ${MAX_REPLY} characters` });
      const writer = this.writer;
      if (!writer) return yield* new Conflict({ message: "replying isn't available in this desk" });
      const list = yield* this.convos.list(id).pipe(Effect.mapError(upstream("couldn't read the PR's conversations: ")));
      const c = list.find((x) => x.id === convoId);
      if (!c) return yield* new NotFound({ message: `no conversation "${convoId}" on ${id}` });
      const write = Effect.gen({ self: this }, function* () {
        const { url } = yield* (c.kind === "thread" ? writer.reply(c.id, text) : writer.comment(e.item.node_id, text)).pipe(
          Effect.mapError(upstream("GitHub didn't take the reply: ")),
        );
        this.store.logWrite(id, c.kind === "thread" ? "reply" : "comment", this.now().toISOString());
        this.log(`replied on ${id} to ${c.comments.at(-1)?.author ?? ""}${url ? ` (${url})` : ""}`);
        // Answering was all it asked of you, and nobody else waits on you there: it's done.
        const last = !list.some((x) => x.waiting_on_you && x.id !== convoId);
        const only = this.replyOnly(e) && !this.snapshot().unasked.has(id); // with nobody asked, Add reviewers still waits
        yield* this.convos.drop(id);
        if (only && last) yield* this.doneAfterWrite(id);
        this.changed();
        this.refreshAfter(id);
        return { url };
      });
      return yield* this.locked(this.sending, convoId, "already sending that reply", write);
    });
  }

  // POST /api/review/:id/comment: your comment on the PR (Comment in its review) or the issue (Comment on it opened
  // in place), on your click. One of the desk's GitHub writes; it's yours done, so it leaves your desk until someone answers.
  comment(ref: string, body: string): Effect.Effect<{ url: string }, WriteError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.notStopped();
      const found = yield* this.resolve(ref);
      const e = this.snapshot().entries.get(found)!;
      const id = e.item.id;
      const text = body.trim();
      if (e.item.state !== "open") return yield* new Conflict({ message: `can't comment on ${id}: it's ${e.item.state}` });
      if (!text) return yield* new BadRequest({ message: "the comment is empty" });
      if (text.length > MAX_REPLY) return yield* new BadRequest({ message: `keep a comment under ${MAX_REPLY} characters` });
      const writer = this.writer;
      if (!writer) return yield* new Conflict({ message: "commenting isn't available in this desk" });
      const write = Effect.gen({ self: this }, function* () {
        const { url } = yield* writer.comment(e.item.node_id, text).pipe(Effect.mapError(upstream("GitHub didn't take the comment: ")));
        this.store.logWrite(id, "comment", this.now().toISOString());
        this.log(`commented on ${id}${url ? ` (${url})` : ""}`);
        yield* this.convos.drop(id);
        yield* this.doneAfterWrite(id);
        this.refreshAfter(id);
        return { url };
      });
      return yield* this.locked(this.sending, id, "already sending a comment there", write);
    });
  }

  // POST /api/review/:id/inline: your comment on a line (or a range ending at it) of the diff, on your press, pinned to the
  // commit the review showed so its line numbers are the ones you read. Part of reviewing, not its end: the PR stays put.
  inlineComment(ref: string, at: InlineAt, body: string, head: string): Effect.Effect<{ url: string }, WriteError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.notStopped();
      const e = yield* this.pr(ref);
      const id = e.item.id;
      const text = body.trim();
      if (e.item.state !== "open") return yield* new Conflict({ message: `can't comment on ${id}: it's ${e.item.state}` });
      if (!text) return yield* new BadRequest({ message: "the comment is empty" });
      if (text.length > MAX_REPLY) return yield* new BadRequest({ message: `keep a comment under ${MAX_REPLY} characters` });
      const writer = this.writer;
      if (!writer) return yield* new Conflict({ message: "commenting isn't available in this desk" });
      const side = (s: "new" | "old") => (s === "old" ? "LEFT" : "RIGHT");
      const thread: InlineThread = {
        path: at.path,
        line: at.line,
        side: side(at.side),
        ...(at.start &&
          !(at.start.line === at.line && at.start.side === at.side) && { startLine: at.start.line, startSide: side(at.start.side) }),
        body: text,
      };
      const write = Effect.gen({ self: this }, function* () {
        const { url } = yield* writer
          .inlineComment(e.item.node_id, head, thread)
          .pipe(Effect.mapError(upstream("GitHub didn't take the comment: ")));
        this.store.logWrite(id, "inline_comment", this.now().toISOString());
        this.log(`commented on ${id} at ${at.path}:${at.line}${url ? ` (${url})` : ""}`);
        yield* this.convos.drop(id);
        this.changed();
        this.refreshAfter(id);
        return { url };
      });
      return yield* this.locked(this.sending, `${id} ${at.path}:${at.line}`, "already sending a comment there", write);
    });
  }

  // POST /api/review/:id/ready: your own draft's "Ready for review", one of the desk's GitHub writes, on your click,
  // then a review request to whoever you picked with it (node ids from reviewers()). Asking them failing leaves it ready.
  // `done`: it left your desk. Ready with nobody asked to review it is still yours, so it stays, for Add reviewers.
  markReady(ref: string, ask?: { users: string[]; teams: string[] }): Effect.Effect<{ done: boolean }, WriteError | ReviewersNotAsked> {
    return Effect.gen({ self: this }, function* () {
      yield* this.notStopped();
      const e = yield* this.pr(ref);
      const id = e.item.id;
      if (!e.analysis.signals.me.author) return yield* new Conflict({ message: `${id} isn't your PR` });
      if (e.item.state !== "open" || !e.item.draft) return yield* new Conflict({ message: `${id} isn't an open draft` });
      const writer = this.writer;
      if (!writer) return yield* new Conflict({ message: "marking ready isn't available in this desk" });
      const write = Effect.gen({ self: this }, function* () {
        yield* writer.ready(e.item.node_id).pipe(Effect.mapError(upstream("GitHub didn't mark it ready: ")));
        this.store.logWrite(id, "ready", this.now().toISOString());
        this.log(`marked ${id} ready for review on GitHub`);
        const users = ask?.users ?? [];
        const teams = ask?.teams ?? [];
        const n = users.length + teams.length;
        if (n > 0) {
          yield* writer
            .requestReviews(e.item.node_id, users, teams)
            .pipe(
              Effect.mapError(
                (err) =>
                  new ReviewersNotAsked({ message: `Marked it ready, but GitHub didn't ask for the reviews: ${err.message}`, cause: err }),
              ),
            );
          this.store.logWrite(id, "request_reviews", this.now().toISOString());
          this.log(`asked ${n} reviewer${n === 1 ? "" : "s"} on ${id} on GitHub`);
        }
        const done = n > 0 || !this.unaskedOnceReady(e.item);
        if (done) yield* this.doneAfterWrite(id);
        return { done };
      }).pipe(Effect.ensuring(this.refreshed(id)));
      return yield* this.locked(this.approving, id, `already marking ${id} ready`, write);
    });
  }

  // GET /api/reviewers/:id?q=: who you can ask to review your PR, GitHub's suggestions first; what GitHub fails with is passed on.
  reviewers(ref: string, q: string): Effect.Effect<Reviewer[], RefError | BadRequest | Conflict | Upstream> {
    return Effect.gen({ self: this }, function* () {
      const e = yield* this.pr(ref);
      if (!e.analysis.signals.me.author) return yield* new Conflict({ message: `${e.item.id} isn't your PR` });
      const me = this.me().toLowerCase();
      const list = yield* this.gh.api.reviewers(e.item.repo, e.item.number, q.trim()).pipe(Effect.mapError(upstream("")));
      return list.filter((r) => r.team || r.login.toLowerCase() !== me);
    });
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
    const { loaded, errors, warnings } = parseConfig(text, this.settings, this.connectors);
    if (!loaded) return { errors, warnings, boards: [] };
    const cur = this.loaded ? this.snapshot() : null;
    const next = this.compute(loaded, -1);
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
          unfetched: after.unfetched,
        };
      }),
    };
  }

  // `base`: the text you started from, or its hash from GET /api/config.
  putConfig(text: string, base?: string): Effect.Effect<{ ok: boolean; errors: ConfigError[]; warnings: ConfigError[] }, Stale | FsError> {
    return Effect.gen({ self: this }, function* () {
      if (base !== undefined && base !== this.configText && base !== textHash(this.configText))
        return yield* new Stale({ message: "config.toml changed on disk since you opened it; reload to see it, then reapply your edit" });
      const { loaded, errors, warnings } = parseConfig(text, this.settings, this.connectors);
      if (!loaded) return { ok: false, errors, warnings };
      // A save never brings settings back into config.toml: an unmigrated desk would move them to settings.json on its next start.
      if (warnings.length) return { ok: false, errors: warnings, warnings: [] };
      yield* replaceFile(this.configPath, text);
      yield* this.reloadConfig(true);
      return { ok: true, errors: [], warnings };
    });
  }

  // The tray's and the dock's count: an agent's question waiting on you counts as now.
  status(): Effect.Effect<{ now: number; today: number; new: number; text: string }, Unavailable> {
    return Effect.map(this.overview(), ({ focus: f }) => {
      const now = f.now + f.asks;
      const parts = [`${now + f.today}`, f.new ? `+${f.new}` : ""].filter(Boolean);
      return { now, today: f.today, new: f.new, text: now || f.today ? `desk ${parts.join(" ")}` : "" };
    });
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
function linkUrl(url: string): Effect.Effect<string, BadRequest> {
  const u = URL.parse(url.trim());
  if (!u) return Effect.fail(new BadRequest({ message: `not a link: ${url.slice(0, 80)}` }));
  if (u.protocol !== "https:") return Effect.fail(new BadRequest({ message: `a link is https, not ${u.protocol}` }));
  if (u.href.length > 2_000) return Effect.fail(new BadRequest({ message: "keep a link under 2000 characters" }));
  return Effect.succeed(u.href);
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

export function parseUntil(until: string, now: Date): Effect.Effect<Date, BadRequest> {
  const rel = /^(\d+)([hd])$/.exec(until);
  if (rel && Number(rel[1]) > 0) return Effect.succeed(new Date(now.getTime() + Number(rel[1]) * (rel[2] === "h" ? HOUR : 24 * HOUR)));
  if (until === "tomorrow" || until === "monday") {
    const d = new Date(now);
    d.setHours(9, 0, 0, 0);
    // After midnight, "tomorrow" still means the coming morning; on a Monday before 09:00, "monday" means today.
    if (until === "tomorrow" && now.getHours() >= 5) d.setDate(d.getDate() + 1);
    if (until === "monday" && !(now.getDay() === 1 && now.getHours() < 9)) d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
    return Effect.succeed(d);
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(until);
  const t = day
    ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 9).getTime()
    : /^\d{4}-\d{2}-\d{2}T/.test(until)
      ? Date.parse(until)
      : NaN;
  if (Number.isNaN(t) || t <= now.getTime())
    return Effect.fail(
      new BadRequest({ message: `can't read snooze time "${until}"; use 1h, 3h, 2d, tomorrow, monday, activity or a future ISO time` }),
    );
  return Effect.succeed(new Date(t));
}
