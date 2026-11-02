// Shared types: GitHub items, rule signals, config, and the HTTP API shapes.

export type Bucket = "now" | "today" | "later" | "fyi" | "hide";
export const BUCKETS: Bucket[] = ["now", "today", "later", "fyi", "hide"];

export type Ci = "green" | "red" | "pending" | "none";
export type ReviewDecision = "approved" | "changes_requested" | "required" | "none";
export type Mergeable = "clean" | "conflict" | "unknown";
export type ReviewState = "approved" | "changes_requested" | "commented" | "dismissed" | "pending";

// ---------------------------------------------------------------------------
// GitHub item, normalized from GraphQL. Times are ISO strings.

export interface Item {
  id: string; // "owner/repo#123"
  node_id: string;
  kind: "pr" | "issue";
  repo: string; // "owner/repo"
  number: number;
  title: string;
  url: string;
  author: string; // login, "ghost" if deleted
  author_bot: boolean;
  via?: string; // who a bot's PR says it was opened for (its last "via …" line: "@login" or a name), "" if none; absent on items stored before it was fetched
  state: "open" | "closed" | "merged";
  draft: boolean;
  labels: string[];
  assignees: string[];
  created_at: string;
  updated_at: string;
  closed_at?: string | null; // merged or closed; absent on items stored before it was fetched
  body?: string; // the description's first 600 characters, whitespace collapsed (untrusted); absent on items stored before it was fetched
  merged_by?: string; // login, "" if unknown
  // PR-only facts; zero values for issues.
  additions: number;
  deletions: number;
  changed_files: number;
  base: string;
  default_branch?: string; // the repo's default branch; absent on items stored before it was fetched
  ci: Ci;
  review_decision: ReviewDecision;
  mergeable: Mergeable; // only fetched for PRs you authored; "unknown" otherwise
  head_oid: string;
  head_committed_at: string | null;
  head_author: string; // login of the head commit's author, "" if unknown
  head_ref?: string; // the PR's head branch; absent on items stored before it was fetched
  head_repo?: string; // "owner/repo" the head branch lives in (a fork's differs), "" if deleted
  paths?: string[]; // PR only: its changed files' paths, the first 50 (changed_files counts all); absent on items stored before it was fetched
  checks_failed?: string[]; // names of the head commit's failing checks; PRs you authored only
  checks_optional?: string[]; // those of them the base branch doesn't require (ci isn't red for these alone)
  auto_merge?: boolean; // GitHub's auto-merge is on for it; PRs you authored only
  auto_merge_allowed?: boolean; // the repo allows auto-merge; PRs you authored only
  merge_method?: "MERGE" | "SQUASH" | "REBASE"; // the repo's default merge method for you; PRs you authored only
  review_requests: { reviewer: string; type: "user" | "team"; codeowner: boolean }[]; // team reviewer = slug
  request_events: { at: string; actor: string; actor_bot: boolean; reviewer: string; reviewer_type: "user" | "team" }[];
  // trusted: the author is a collaborator on the repo (OWNER, MEMBER, COLLABORATOR); absent on items stored before the desk asked
  reviews: { author: string; author_bot: boolean; trusted?: boolean; state: ReviewState; at: string; commit: string }[]; // most recent last; commit = oid reviewed
  comments: { author: string; author_bot: boolean; trusted?: boolean; at: string }[]; // last 10 issue comments, most recent last
  comments_total: number;
  threads_total: number;
  threads_unresolved: number;
  thread_last: { author: string; author_bot: boolean; trusted?: boolean; at: string; resolved?: boolean }[]; // last comment per review thread; PRs you authored only
  detail_at: string; // when details were last fetched
}

// Facts about you, refreshed daily.
export interface Context {
  me: string;
  name?: string; // your GitHub display name, "" if none
  teams: string[]; // team slugs you belong to, any org
  affinity: Record<string, number>; // author login -> PRs of theirs you reviewed or commented on, last 90 days
  repo_prs: Record<string, number>; // "owner/repo" -> PRs you opened there, last 90 days
  orgs: Record<string, number>; // org -> open items involving you (used to pick default spaces)
  recent?: string[]; // the titles of your latest PRs (untrusted), most recently updated first
  refreshed_at: string;
  areas?: Areas; // the directories you work in; absent until first fetched
  areas_at?: string; // when areas were last fetched (refreshed daily, on their own)
}

// "owner/repo" (lowercase) -> directory you work in ("src/sentry/auth/") -> weight, from your PRs and reviews in the last 90 days.
export type Areas = Record<string, Record<string, number>>;

// ---------------------------------------------------------------------------
// Rule signals: what `when`, `filter` and `why` templates can reference.
// Hours fields are hours from now; -1 when the event never happened.

export interface Signals {
  item: {
    kind: "pr" | "issue";
    id: string;
    repo: string;
    owner: string;
    name: string;
    number: number;
    title: string;
    url: string;
    author: string;
    state: "open" | "closed" | "merged";
    draft: boolean;
    labels: string[];
    created_hours: number;
    updated_hours: number;
    activity_hours: number; // since the last human activity by someone other than you
    comments: number;
  };
  pr: {
    size: number; // additions + deletions
    additions: number;
    deletions: number;
    files: number;
    ci: Ci;
    review: ReviewDecision;
    mergeable: Mergeable;
    approvals: number;
    unresolved_threads: number;
    base: string;
    stacked: boolean; // its base isn't the repo's default branch
    pushed_hours: number;
    my_area_files: number; // of its paths, how many are in your areas there; -1 while unknown
    my_area: boolean; // my_area_files >= 1
  };
  me: {
    login: string;
    author: boolean;
    assignee: boolean;
    requested: boolean; // a review is currently requested from you or one of your teams
    requested_direct: boolean; // ...from you by name
    requested_team: string; // team slug behind the request, "" if none
    requested_codeowner: boolean; // the request came from CODEOWNERS
    requested_by: string; // who added the request (latest event for you or your team), "" if unknown
    requested_by_bot: boolean;
    requested_hours: number;
    reviewed: boolean;
    review_state: ReviewState | "none"; // your latest review
    reviewed_hours: number;
    pushed_since_review: boolean; // commits after your latest review
    commented: boolean;
    last_action_hours: number; // your latest comment, review, or head commit
    new_activity: boolean; // someone else commented, reviewed or pushed after your latest action
  };
  author: {
    login: string;
    bot: boolean;
    via: string; // who a bot's PR was opened for, "" if none
    me: boolean;
    engaged_90d: number;
    close: boolean; // engaged_90d >= signals.close_collaborator_min
  };
  repo: {
    name: string;
    mine: boolean; // you own it or it is in signals.my_repos
    my_prs_90d: number;
  };
}

// ---------------------------------------------------------------------------
// Config (~/.review-desk/config.toml)

// A rule's bucket, or "judge": no hint of its own, so the board default until Claude answers.
export type RuleBucket = Bucket | "judge";

export interface Rule {
  when: string;
  bucket: RuleBucket;
  why?: string;
  nocap?: boolean; // matched items don't count toward caps and are never demoted
  hard?: boolean; // a floor: what it matches never sorts below its bucket (Today for a Now rule), and the coordinator can't clear it
}

export interface BoardConfig {
  id: string;
  space: string;
  name: string;
  queries: string[]; // GitHub search; the space scope is appended. {me} and {close_authors} expand.
  filter?: string;
  priority?: string; // number expression; higher sorts first within a bucket, before `sort`
  rules: Rule[];
  default: Bucket;
  default_why: string;
  sort: "waiting" | "updated" | "newest";
  caps?: { now?: number; today?: number };
}

export interface SpaceConfig {
  id: string;
  name: string;
  scope: string; // appended to every query in the space, e.g. "org:getsentry"
}

export interface Config {
  poll_seconds: number;
  signals: { close_collaborator_min: number; bots: string[]; my_repos: string[] };
  notify: { enabled: boolean; quiet: string }; // quiet = "19:00-09:00", "" for none
  handoff: { prompt: string; mine: string; issue: string }; // review someone's PR / move your PR along / an issue
  spaces: SpaceConfig[];
  boards: BoardConfig[];
}

// ---------------------------------------------------------------------------
// Settings (settings.json): how the desk behaves. Boards and rules stay in config.toml.

export type SettingType = "number" | "boolean" | "string" | "text" | "list" | "hotkey" | "select";
export type SettingValue = number | boolean | string | string[];

export interface SettingDef {
  key: string; // "section.name"
  section: string;
  label: string;
  help?: string;
  type: SettingType; // text = multi-line string, list = strings, hotkey = Electron accelerator ("" = off), select = one of options
  default: number | boolean | string | readonly string[];
  options?: readonly { value: string; label: string }[]; // select only
  min?: number;
  max?: number;
  pattern?: string; // strings and list items must match (an empty "string" is always allowed unless required)
  pattern_hint?: string;
  required?: boolean;
  placeholder?: string;
  desktop?: boolean; // only the desktop app reads it
}

export interface SettingsSection {
  id: string;
  title: string;
  help?: string;
}

export interface GitHubStatus {
  login: string | null;
  auth: string; // where the token comes from: "gh CLI" or "GITHUB_TOKEN"
  error: string | null; // last sync or context error
  synced_at: string | null;
  rate_limit: { remaining: number; reset_at: string } | null;
  teams: string[];
  orgs: { org: string; items: number; space: string | null }[]; // orgs with your open items, and the space covering each
}

export interface SettingsView {
  path: string;
  sections: SettingsSection[];
  defs: SettingDef[];
  values: Record<string, SettingValue>; // effective values
  overridden: string[]; // keys set in settings.json
  errors: ConfigError[]; // settings.json problems; bad entries fall back to defaults
  github: GitHubStatus;
  // Paused after failures in a row (an expired login): why, and when it tries again. Shown once in Settings, not per PR.
  paused: { ai: { why: string; until: string } | null; babysitters: { why: string; until: string } | null };
}

// GET /api/agents: whether Claude Code has the desk's MCP tools and the Review Desk skill. null for an agent the desk doesn't know.
export interface AgentStatus {
  driver: string;
  mcp: { connected: boolean; command: string } | null; // command: what Connect runs to register the desk
  skill: { state: "installed" | "outdated" | "missing"; path: string; command: string } | null; // path: the installed SKILL.md
}

// GET /api/policy: ~/.review-desk/policy.md, prose the judge and the coordinator follow. While it's empty they follow `starter`.
export interface PolicyDoc {
  path: string;
  text: string; // the file's; empty means the starter is in use
  starter: string;
  hash: string; // pass it back as `base` when saving
  judge: JudgeStatus;
}

export interface JudgeStatus {
  state: "off" | "idle" | "running" | "error";
  off_reason: string | null; // why it's off: the setting
  waiting: number; // items without a fresh answer
  judged: number; // items with an answer under this policy
  spent: number; // items sent in the last hour
  max_per_hour: number;
  last_at: string | null; // the last call that finished
  error: string | null; // the last call's failure, until one succeeds
  retry_at: string | null; // after a failure, or with the hour's limit reached and items waiting: no call before this
}

// GET /api/coordinator: the Claude Code session the desk wakes on new events.
export interface CoordinatorStatus {
  state: "off" | "idle" | "waiting" | "running" | "error";
  off_reason: string | null; // e.g. "Coordinator needs Claude Code for now"
  session_id: string;
  started: boolean; // its first run made the session
  dir: string; // its working directory (Claude Code keeps sessions per directory)
  command: string | null; // talk to it in a terminal; null until it's started
  running_since: string | null;
  pending: number; // events waiting for the next run
  next_at: string | null; // the next run starts at this time
  last_run: CoordinatorRun | null;
  error: string | null; // the last run's failure, until one succeeds
  held: boolean; // you have it open in a terminal: runs wait until you close it
}

export interface CoordinatorRun {
  n: number;
  kind: "intro" | "events" | "learn"; // learn: it read your own actions, to refine the policy
  started_at: string;
  ms: number;
  ok: boolean;
  events: number; // a learn run: your actions it read
  actions: number;
  error: string | null;
}

export interface CoordinatorLogEntry {
  seq: number;
  at: string;
  run: number; // 0: not during a run
  kind: "run" | "act" | "note" | "policy" | "config";
  text: string; // an act's reason, a note, what a run did, a policy change's lines before and after; untrusted when the coordinator wrote it
  item_id: string | null;
  action: string | null; // an act's action: snooze, done, mute, ...
  bucket: Bucket | null; // where the item sat when it acted
  undo_seq: number | null; // an act's undo seq
  version: number | null; // a policy change's version, while the desk keeps it: Undo puts back the text before it
  undone: boolean;
}

export interface CoordinatorView {
  status: CoordinatorStatus;
  log: CoordinatorLogEntry[]; // newest first
}

// What the coordinator did in its latest run with actions, for the queue's top bar; null when nothing recent.
export interface CoordinatorActed {
  counts: Record<string, number>; // per action, e.g. { snooze: 3, mute: 1 }, undone ones left out
  buckets: Bucket[]; // where those items sat when it acted
  at: string; // its last action
}

// window.desktop: set by the desktop app's preload; undefined in a browser.
export interface DesktopBridge {
  platform: string; // process.platform
  version: string;
  // source: absent from an app older than Run from a checkout.
  status(): Promise<{ hotkey: { accelerator: string; ok: boolean; error?: string }; open_at_login: boolean; source?: SourceStatus | null }>;
}

// The desktop app running the desk and its UI from a checkout (Settings → Desktop app → Run from a checkout).
export interface SourceStatus {
  dir: string;
  // running: the desk process is up or restarting; attached: a desk already ran on the port, so the app uses that one
  state: "running" | "failed" | "attached" | "invalid";
  detail?: string; // failed: the desk's last lines of output; invalid: why the folder can't run
  log?: string; // where both processes' output goes
}

export interface ConfigError {
  path: string; // e.g. "boards[1].rules[2].when"
  message: string;
}

// ---------------------------------------------------------------------------
// Local state (never sent to GitHub)

export interface ItemState {
  id: string;
  done_at: string | null; // hidden until someone else acts after this time
  snooze_until: string | null;
  snooze_on_activity: boolean; // also wake on activity
  muted: boolean;
  pinned: boolean;
  seen_at: string | null;
  inflight_at: string | null; // your own PR, handed off for merge with m: Claude (its babysitter) takes it from here
}

export type Action = "done" | "snooze" | "mute" | "unmute" | "pin" | "unpin" | "seen" | "restore" | "inflight" | "takeback" | "undo";
// snooze `until`: "1h" | "3h" | "tomorrow" (09:00) | "monday" (09:00) | "activity" | ISO time

// ---------------------------------------------------------------------------
// Classification

export interface TraceStep {
  index: number; // rule index, -1 = filter
  when: string;
  matched: boolean;
  error?: string;
}

export interface Placement {
  board: string;
  bucket: Bucket; // after caps
  rule_bucket: Bucket; // before caps (after the judge)
  rule: number | null; // matched rule index, null = default
  why: string;
  demoted?: string; // e.g. "3 from PRs to review are urgent already"
  trace: TraceStep[];
  hard?: boolean; // a hard rule matched it
  floor?: Bucket; // ...or you pinned it, so it never sorts below this, whatever Claude, quiet days or caps say
  judge?: JudgeStep; // set while the judge is on
  hint?: { bucket: Bucket; why: string }; // with judge: where the rules put it, which holds until Claude answers
}

// The policy judge's step in a placement.
export interface JudgeStep {
  bucket: Bucket | null; // its answer; null: none, so where the rules put it
  why: string;
  pending: boolean; // not judged under this policy since the item last changed (an earlier answer may still show)
}

// Kept per item in kv `judge:<id>`: good while what the judge read of the item (judgeKey) and the policy stay the same.
export interface JudgeAnswer {
  key: string; // judgeKey()
  policy: string; // the policy's hash
  bucket: Bucket | null; // null: the agent gave no answer for it
  why: string;
  at: string;
}

export type Status = "active" | "done" | "snoozed" | "muted";

// ---------------------------------------------------------------------------
// HTTP API (127.0.0.1:47823). All JSON.

export interface Card {
  id: string;
  kind: "pr" | "issue";
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  author_bot: boolean;
  bucket: Bucket;
  why: string;
  demoted?: string;
  board: string;
  boards: string[]; // every board the item is on (for Focus)
  chips: string[]; // short facts: "issue", "draft", "CI red", "conflict", "changes requested", "approved", "3 unresolved", "+120 −30"
  ci: Ci;
  review: ReviewDecision;
  draft: boolean;
  size: number;
  created_at: string;
  updated_at: string;
  activity_at: string; // latest activity by someone else
  waiting_since: string; // request time if requested, else created_at
  new: boolean; // activity since you last looked, on an item that isn't resolved or cleared
  pinned: boolean;
  status: Status;
  snooze_until: string | null;
  verdict: AiReview["verdict"] | null; // from the AI review of the current commit
  preflight?: Preflight; // Now and Today cards only
  next?: string; // your own PR in Now or Today: what to do about it, e.g. "merge conflict with main: m hands it off for merge"
  checks_failed?: string[]; // your own PR in Now or Today: its failing checks' names
  checks_optional?: string[]; // those of them its base branch doesn't require
  handed_back?: boolean; // your PR, back from Merging because Claude can't get it merged; its why says why
  desk_auto_merge?: boolean; // your open PR out of Merging with the auto-merge m turned on still on: b turns it off
  involved?: string; // an issue in Now or Today: how you're on it ("assigned to you", "you were mentioned")
  last_event?: ActivityEvent; // an issue in Now or Today: its latest event, for a line of context
  resolved: string | null; // why it needs nobody now ("merged", "approved by alice"); null while it's open
  resolved_at: string | null; // when it resolved (else its last update, when GitHub doesn't say); null while it's open
  inflight: boolean; // your PR, in Merging
  cleared_by_coordinator?: string; // cleared (snoozed, done, muted) by the coordinator: its reason; untrusted, it wrote it
  placed_by?: "hard" | "pin" | "claude" | "pending" | "unanswered"; // a hard rule, a pin's floor, Claude, the rules until Claude answers, or since it gave no answer; unset with the judge off
  team_ask?: string; // a review asked only of your team: "CODEOWNERS ping to @ml-team", so a rule's why can't pass it off as yours
  cta?: string; // the row's one call to action: "Reply" on your PR whose only action is answering someone
}

// The AI review of a card's current head, for skimming in the queue. The other fields come from the latest review, which is
// for an older head unless state is ready. stale: a new one is coming; off: review.auto_ai is off; none: an issue, or your PR.
export interface Preflight {
  state: "ready" | "stale" | "running" | "queued" | "paused" | "off" | "none";
  verdict?: "look" | "skim" | "skip";
  risk?: "low" | "medium" | "high";
  summary?: string;
  since?: string; // what changed since your last review: a re-review's gist
  concerns?: string[]; // at most 2
  notes?: number; // notes on the changes, in the review view
  at?: string; // when it was written
}

export interface BoardSummary {
  id: string;
  name: string;
  space: string;
  counts: Record<Bucket, number> & { cleared: number };
  new: number;
  error?: string; // last query error
}

export interface Overview {
  me: string;
  synced_at: string | null;
  syncing: boolean;
  sync_error: string | null;
  config_errors: ConfigError[];
  connectors: ConnectorStatus[];
  spaces: { id: string; name: string; boards: BoardSummary[] }[];
  focus: { now: number; today: number; new: number };
  inflight: { total: number; needs_you: number }; // your open PRs in Merging, and how many need you
  rate_limit: { remaining: number; reset_at: string } | null;
  coordinator: { state: CoordinatorStatus["state"]; acted: CoordinatorActed | null };
}

// A source of items and events: GitHub today.
export interface ConnectorStatus {
  id: string; // "github"
  name: string; // "GitHub"
  status: "ok" | "syncing" | "paused" | "error"; // paused = rate limited
  synced_at: string | null; // when the last full pass finished
  error: string | null;
}

export interface BoardView {
  board: BoardSummary & { queries: string[] };
  sections: Record<Exclude<Bucket, "hide">, Card[]>;
  hidden: Card[]; // bucket "hide" from rules
  cleared: Card[]; // done, snoozed, muted
}

export interface FocusView {
  sections: { now: Card[]; today: Card[] }; // one list on screen: now first, then today
  cards: number; // queue.cards: the queue shows this many, the rest behind one line; 0 = all
  paused: Paused | null; // said once above the queue instead of on every card
}

// Claude stopped: its login failed (the AI review, the judge or the coordinator), or AI reviews nobody asked for keep failing.
export interface Paused {
  who: "claude" | "ai";
  why: string;
}

// Every item once, at its best placement across boards: the app's main surface.
export interface QueueView {
  sections: Record<Exclude<Bucket, "hide">, Card[]>;
  hidden: Card[]; // a rule put it in "hide"
  cleared: Card[]; // done, snoozed, muted
  resolved: Card[]; // merged, closed, approved by someone else, no longer requested; newest first
  cards: number; // as in FocusView
  paused: Paused | null;
  babysitting: boolean; // inflight.babysit: Claude works on your PRs in Merging, or they only wait there
}

// One changed file, from GitHub's pulls/{n}/files.
export interface ReviewFile {
  path: string;
  previous_path: string | null; // renames
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  patch: string | null; // unified hunks; null for binary files and diffs GitHub won't show
}

// A short "what this does / why it matters" note on a line of the diff; line 0 is about the whole file.
export interface ReviewNote {
  path: string;
  line: number;
  side: "new" | "old"; // old = a removed line, numbered in the old file
  body: string;
}

// Written by your own Claude Code from the diff. Untrusted: the diff came from GitHub.
export interface AiReview {
  verdict: "look" | "skim" | "skip";
  risk: "low" | "medium" | "high";
  summary: string;
  since?: string; // a re-review: what changed since your last review, and whether it settles the concerns
  concerns: string[];
  notes: ReviewNote[];
  head_oid: string; // the commit it read; a newer push makes it stale
  model: string; // as claude reports it (claude-opus-5[1m]), else "claude-code"
  at: string;
}

export interface ItemDetail {
  card: Card;
  item: Item;
  signals: Signals;
  placements: Placement[];
  state: ItemState;
  handoff_prompt: string;
  ai: AiReview | null;
  ai_stale: boolean;
  generating: boolean;
  activity: ActivityEvent[]; // the latest events for this item, newest first
}

// GET /api/review/:id: one PR's review view.
export interface ReviewView {
  card: Card;
  item: Item;
  handoff_prompt: string;
  files: ReviewFile[];
  files_error: string | null; // the diff couldn't be fetched
  ai: AiReview | null; // the latest, even if stale
  ai_stale: boolean;
  ai_error: string | null; // the last failed attempt on this commit, or why AI reviews are paused
  generating: boolean;
  approve: { ok: boolean; reason: string | null }; // reason: why not, e.g. "it's your PR"
  activity: ActivityEvent[]; // the PR's last 8 events, newest first
  conversation: Conversation[]; // what reviewers said, those waiting on you first
  conversation_error: string | null; // it couldn't be fetched
  reading: boolean; // Claude is reading the ones waiting on you
  reading_error: string | null; // its last try on this PR failed
}

// One conversation on a PR: a review thread, a comment on the PR, or a review's body. Every text is untrusted GitHub text.
export interface Conversation {
  id: string; // a review thread's node id (what a reply goes to), else the comment's or review's
  kind: "thread" | "comment" | "review"; // a reply to a comment or review is a comment on the PR
  path: string | null; // a review thread's file; null: on the PR
  line: number | null;
  outdated: boolean; // the code it's on changed since
  resolved: boolean;
  state: ReviewState | null; // a review's
  comments: { id: string; author: string; bot: boolean; body: string; at: string; url: string }[]; // oldest first
  waiting_on_you: boolean;
  url: string;
  take: Take | null; // Claude's pre-filter, of its latest comment; only for one waiting on you
}

// Claude's read of a conversation waiting on you, written by your own Claude Code. Untrusted: it read GitHub text.
export interface Take {
  gist: string; // what they want, one line
  take: string; // Claude's call and why: "Valid concern: …", "A nit: …", "Already addressed: …", "Only you can answer: …"
  reply: string; // a suggested reply, in your voice
  comment_id: string; // the latest comment it read; a newer one asks again
  at: string;
}

// ---------------------------------------------------------------------------
// The event log (GET /api/activity, the desk_events MCP tool)

export type ActivityKind =
  | "new" // first seen on the desk
  | "review_requested" // from you or your team; data: reviewer, type, codeowner
  | "request_removed" // data: reviewer, type
  | "reviewed" // by someone else; data: state (approved, changes_requested, commented)
  | "pushed" // a new head commit; data: oid
  | "ci" // data: from, to (green, red, pending)
  | "commented" // by someone else
  | "merged"
  | "closed"
  | "reopened"
  | "mentioned" // data: reason (mention, team_mention)
  | "assigned" // to you
  | "conflict" // your PR started conflicting with its base; data: base
  | "resolved" // data: reason
  | "unresolved"; // data: was (the reason that stopped holding)

export interface ActivityEvent {
  seq: number; // increasing; pass the last one you saw as `after`
  at: string; // when it happened if the source says, else when the desk noticed
  source: string; // connector id, e.g. "github"
  item_id: string;
  kind: ActivityKind;
  actor: string; // login, "" if unknown
  data: Record<string, string | boolean>;
}

export interface ActivityPage {
  events: ActivityEvent[]; // oldest first
  last_seq: number; // the next call's `after`: the last event's seq, or the log's latest when there are none
}

// ---------------------------------------------------------------------------
// Merging: your own PRs you handed off (m). Claude (a babysitter agent each) gets them merged (GET /api/inflight).

// A reply an agent drafted (desk_draft_reply). You send it from Merging; nothing else posts it.
export interface Draft {
  id: string;
  thread_id: string | null; // the review thread it answers (a GraphQL node id); null: a comment on the PR
  to: string; // what it answers: "dana on src/api.ts:12", "the PR"
  quote: string; // the start of the comment it answers; untrusted GitHub text
  body: string; // untrusted: an agent wrote it from GitHub text
  at: string;
  sent_at: string | null;
  url: string | null; // the posted comment, once sent
  by?: "babysitter" | "agent"; // who drafted it: the PR's babysitter, or another agent over MCP
}

// One babysitter run: a Claude Code session in the PR's worktree.
export interface SitterRun {
  id: string; // also the Claude Code session id
  started_at: string;
  ended_at: string | null;
  head_oid: string; // the commit it started from
  why: string[]; // what it was asked to deal with: "CI", "a merge conflict", "2 comments"
  outcome: "running" | "pushed" | "committed" | "nothing" | "failed" | "timeout" | "stopped";
  pushed_oid: string | null;
  summary: string; // the agent's last line, or why it failed
  step: string; // what it was doing last: "npm test", "edit src/api.ts"
  log: string; // the transcript (stream-json), under the desk's home
}

export interface SitterStatus {
  state: "running" | "queued" | "done" | "waiting" | "blocked" | "idle";
  text: string; // plain words: "fixing CI", "pushed a fix for 2 comments · abc1234", "no local clone of acme/api"
  since: string | null; // when that started or happened
}

export interface InflightRow {
  card: Card;
  state: Item["state"];
  base: string;
  ci: Ci;
  failing: string[]; // failing check names
  approved_by: string[];
  changes_by: string[]; // changes requested by
  waiting_on: string[]; // reviewers asked and not heard from yet; teams as @slug
  threads_unresolved: number;
  mergeable: Mergeable;
  draft: boolean; // a draft PR
  needs_you: string | null; // why it needs you: the question, "reply ready to send", "ready to merge", ...
  escalation: { question: string; at: string; by?: "babysitter" | "agent" | "desk" } | null; // from desk_escalate, or the desk's own check
  outside_at: string | null; // feedback from someone who isn't a collaborator, not dismissed yet: yours to read, never an agent's
  sitter: SitterStatus;
  drafts: Draft[]; // unsent replies
  run: SitterRun | null; // the latest run
  resume: string | null; // a shell command that opens the latest run's session in Claude Code
  auto_merge: boolean; // GitHub's auto-merge is on: it merges once it's approved and green
  merge_note: string | null; // why auto-merge isn't on ("the repo doesn't allow auto-merge"): you merge it
}

export interface InflightView {
  rows: InflightRow[]; // open ones first, then those that merged or closed in the last 3 days
  babysitting: boolean; // inflight.babysit: off, Merging says so once instead of on every row
}

// GET /api/config
export interface ConfigDoc {
  path: string;
  text: string;
  hash: string; // PUT /api/config takes it (or the whole text) as `base`
  errors: ConfigError[];
  warnings?: ConfigError[]; // leftover pre-settings keys: ignored, not fatal
  hard: { board: string; bucket: Bucket; when: string; why: string }[]; // the loaded config's hard rules, for the Rules page
}

export interface PreviewResult {
  errors: ConfigError[];
  warnings?: ConfigError[];
  boards: {
    id: string;
    name: string;
    counts: Record<Bucket, number>;
    before: Record<Bucket, number> | null; // null for a new board
    moved: { id: string; title: string; from: Bucket | null; to: Bucket }[];
    unfetched: string[]; // queries not in the cache yet; saving fetches them
  }[];
}

export interface FieldDoc {
  path: string; // "me.requested_direct"
  type: "string" | "number" | "boolean" | "string[]";
  doc: string;
}
