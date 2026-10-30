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
  state: "open" | "closed" | "merged";
  draft: boolean;
  labels: string[];
  assignees: string[];
  created_at: string;
  updated_at: string;
  // PR-only facts; zero values for issues.
  additions: number;
  deletions: number;
  changed_files: number;
  base: string;
  ci: Ci;
  review_decision: ReviewDecision;
  mergeable: Mergeable; // only fetched for PRs you authored; "unknown" otherwise
  head_oid: string;
  head_committed_at: string | null;
  head_author: string; // login of the head commit's author, "" if unknown
  review_requests: { reviewer: string; type: "user" | "team"; codeowner: boolean }[]; // team reviewer = slug
  request_events: { at: string; actor: string; actor_bot: boolean; reviewer: string; reviewer_type: "user" | "team" }[];
  reviews: { author: string; author_bot: boolean; state: ReviewState; at: string; commit: string }[]; // most recent last; commit = oid reviewed
  comments: { author: string; author_bot: boolean; at: string }[]; // last 10 issue comments, most recent last
  comments_total: number;
  threads_total: number;
  threads_unresolved: number;
  thread_last: { author: string; author_bot: boolean; at: string }[]; // last comment per review thread; PRs you authored only
  detail_at: string; // when details were last fetched
}

// Facts about you, refreshed daily.
export interface Context {
  me: string;
  teams: string[]; // team slugs you belong to, any org
  affinity: Record<string, number>; // author login -> PRs of theirs you reviewed or commented on, last 90 days
  repo_prs: Record<string, number>; // "owner/repo" -> PRs you opened there, last 90 days
  orgs: Record<string, number>; // org -> open items involving you (used to pick default spaces)
  refreshed_at: string;
}

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
    pushed_hours: number;
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

export interface Rule {
  when: string;
  bucket: Bucket;
  why?: string;
  nocap?: boolean; // matched items don't count toward caps and are never demoted
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
  analyze: { command: string; model: string }; // the AI review's claude command and model
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
}

// GET /api/agents: whether the agent in agent.driver has the desk's MCP tools and the Review Desk skill. null for driver "none".
export interface AgentStatus {
  driver: string;
  mcp: { connected: boolean; command: string } | null; // command: what Connect runs to register the desk
  skill: { state: "installed" | "outdated" | "missing"; path: string; command: string } | null; // path: the installed SKILL.md
}

// window.desktop: set by the desktop app's preload; undefined in a browser.
export interface DesktopBridge {
  platform: string; // process.platform
  version: string;
  status(): Promise<{ hotkey: { accelerator: string; ok: boolean; error?: string }; open_at_login: boolean }>;
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
}

export type Action = "done" | "snooze" | "mute" | "unmute" | "pin" | "unpin" | "seen" | "restore" | "undo";
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
  rule_bucket: Bucket; // before caps
  rule: number | null; // matched rule index, null = default
  why: string;
  demoted?: string; // e.g. "Now was full (3)"
  trace: TraceStep[];
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
  chips: string[]; // short facts: "CI red", "+120 −30", "draft", "conflict", "3 unresolved"
  ci: Ci;
  review: ReviewDecision;
  draft: boolean;
  size: number;
  created_at: string;
  updated_at: string;
  activity_at: string; // latest activity by someone else
  waiting_since: string; // request time if requested, else created_at
  new: boolean; // activity since you last looked
  pinned: boolean;
  status: Status;
  snooze_until: string | null;
  verdict: AiReview["verdict"] | null; // from the AI review of the current commit
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
  spaces: { id: string; name: string; boards: BoardSummary[] }[];
  focus: { now: number; today: number; new: number };
  rate_limit: { remaining: number; reset_at: string } | null;
}

export interface BoardView {
  board: BoardSummary & { queries: string[] };
  sections: Record<Exclude<Bucket, "hide">, Card[]>;
  hidden: Card[]; // bucket "hide" from rules
  cleared: Card[]; // done, snoozed, muted
}

export interface FocusView {
  sections: { now: Card[]; today: Card[] };
}

// Every item once, at its best placement across boards: the app's main surface.
export interface QueueView {
  sections: Record<Exclude<Bucket, "hide">, Card[]>;
  hidden: Card[]; // a rule put it in "hide"
  cleared: Card[]; // done, snoozed, muted
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

// Written by the configured agent (Settings → Agents) from the diff. Untrusted: the diff came from GitHub.
export interface AiReview {
  verdict: "look" | "skim" | "skip";
  risk: "low" | "medium" | "high";
  summary: string;
  concerns: string[];
  notes: ReviewNote[];
  head_oid: string; // the commit it read; a newer push makes it stale
  model: string;
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
  ai_error: string | null; // the last failed attempt on this commit
  generating: boolean;
  approve: { ok: boolean; reason: string | null }; // reason: why not, e.g. "it's your PR"
}

// GET /api/config
export interface ConfigDoc {
  path: string;
  text: string;
  errors: ConfigError[];
  warnings?: ConfigError[]; // leftover pre-settings keys: ignored, not fatal
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
