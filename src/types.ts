// Shared types: GitHub items, rule signals, config, and the HTTP API shapes.

export type Bucket = "now" | "today" | "blocked" | "later" | "fyi" | "hide";
export const BUCKETS: Bucket[] = ["now", "today", "blocked", "later", "fyi", "hide"];
export const RANK: Record<Bucket, number> = { now: 0, today: 1, blocked: 2, later: 3, fyi: 4, hide: 5 };

export type Ci = "green" | "red" | "pending" | "none";
export type ReviewDecision = "approved" | "changes_requested" | "required" | "none";
export type Mergeable = "clean" | "conflict" | "unknown";
export type ReviewState = "approved" | "changes_requested" | "commented" | "dismissed" | "pending";
export type Stage = "draft" | "waiting for review" | "changes requested" | "approved" | "blocked" | "merged" | "closed"; // blocked: only Desk.card() sets it

// ---------------------------------------------------------------------------
// What the desk reads of any source's item, stored whole as JSON. Its source is the id's prefix ("notes:1"); a bare id is GitHub's.

export interface Head {
  id: string;
  url: string; // where it lives, "" for none
  created_at: string;
  updated_at: string; // ingest never lets an older snapshot replace a newer one (putItems doesn't check)
}

// GitHub item, normalized from GraphQL. Times are ISO strings.

export interface Item extends Head {
  id: string; // "owner/repo#123"
  node_id: string;
  kind: "pr" | "issue";
  repo: string; // "owner/repo"
  number: number;
  title: string;
  author: string; // login, "ghost" if deleted
  author_bot: boolean;
  via?: string; // who a bot's PR says it was opened for (its last "via …" line: "@login" or a name), "" if none; absent on items stored before it was fetched
  state: "open" | "closed" | "merged";
  draft: boolean;
  labels: string[];
  assignees: string[];
  closed_at?: string | null; // merged or closed; absent on items stored before it was fetched
  body?: string; // the description's first 600 characters, one paragraph a line (untrusted); absent on items stored before it was fetched
  requires?: string[]; // PR only: the PRs its whole markdown description says must merge first, as owner/repo#N in the case written, at most 10; absent on items stored before it was fetched
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
  commits?: { oid: string; at: string; author: string }[]; // the latest 20, oldest first; at: committed; author: login, "" if unknown; PRs you authored only, absent on items stored before
  head_ref?: string; // the PR's head branch; absent on items stored before it was fetched
  head_repo?: string; // "owner/repo" the head branch lives in (a fork's differs), "" if deleted
  // Its latest base change: the branch it was based on before (GitHub moves a stacked PR to main when the one below merges),
  // and when; null if it never changed; absent on items stored before it was fetched
  retargeted?: { from: string; at: string } | null;
  paths?: string[]; // PR only: its changed files' paths, the first 50 (changed_files counts all); absent on items stored before it was fetched
  checks_failed?: string[]; // names of the head commit's failing checks; PRs you authored only
  checks_optional?: string[]; // those of them the base branch doesn't require (ci isn't red for these alone)
  merge_method?: "MERGE" | "SQUASH" | "REBASE"; // the repo's default merge method for you; PRs you authored only
  review_requests: { reviewer: string; type: "user" | "team"; codeowner: boolean; bot?: boolean }[]; // team reviewer = slug; bot: a GitHub App
  review_requests_hidden?: number; // requests whose reviewer GitHub doesn't show you (a team you can't see): still someone asked
  request_events: { at: string; actor: string; actor_bot: boolean; reviewer: string; reviewer_type: "user" | "team" }[];
  // trusted: the author is a collaborator on the repo (OWNER, MEMBER, COLLABORATOR); absent on items stored before the desk asked
  reviews: { author: string; author_bot: boolean; trusted?: boolean; state: ReviewState; at: string; commit: string }[]; // most recent last; commit = oid reviewed
  comments: { author: string; author_bot: boolean; trusted?: boolean; at: string }[]; // last 10 issue comments, most recent last
  comments_total: number;
  threads_total: number;
  threads_unresolved: number;
  // last comment per review thread; PRs you authored only; outdated: the code it's on changed since; commit: the last one it
  // still applied to (an outdated thread's stays there); both absent on items stored before
  thread_last: {
    author: string;
    author_bot: boolean;
    trusted?: boolean;
    at: string;
    resolved?: boolean;
    outdated?: boolean;
    commit?: string;
  }[];
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
    requires: string[]; // PRs it needs merged first, as repo#number, in any state: the one below it in its stack, then its description's
    blocked: boolean; // a PR it needs, or one that PR needs in turn, is still open (only PRs in its own org count; issues never block)
    blocked_by: string[]; // the open PRs it needs directly, as repo#number
    blocker: string; // the open PR at the end of the chain, as repo#number, "(through repo#number)" when it isn't a direct need; "" when not blocked
    blocker_waits: string; // what that PR waits on, as its pr.waits says it, or "is in Merging"; "" when not blocked
    blocks: string[]; // open PRs that need this one merged first, directly or through others, as repo#number
    requires_closed: string[]; // PRs it needs that were closed without merging
    waiting_on: string[]; // who is asked to review it and hasn't approved: logins and @teams, you and bots left out; empty once approved
    waits: string; // what it waits on next, in words ("waits on a review from sam", "is ready to merge"); "" once merged or closed
    unasked: boolean; // open and ready, nobody's asked to review it and only bots or the author have reviewed it
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
    owes_reply: boolean; // your PR has an open thread or a comment where someone other than you (bots aside) spoke last, threads your push outdated after their last word aside; false on others' PRs
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
  hard?: boolean; // a floor: what it matches never sorts below its bucket (Today for a Now rule)
  final?: boolean; // Claude doesn't re-sort what it matches: it stays in the rule's bucket (a pin's floor still lifts it)
}

export interface BoardConfig {
  id: string;
  space: string;
  name: string;
  source?: string; // the connector whose items it lists ("notes"); none: GitHub's
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
  unit?: string; // a number's, shown after its field ("days")
  pattern?: string; // strings and list items must match (an empty "string" is always allowed unless required)
  pattern_hint?: string;
  required?: boolean;
  placeholder?: string;
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
  paused: { ai: { why: string; until: string } | null };
}

// GET /api/agents: whether Claude Code has the desk's MCP tools and the Review Desk skill.
export interface AgentStatus {
  driver: string;
  mcp: { connected: boolean; command: string }; // command: what Connect runs to register the desk
  skill: { state: "installed" | "outdated" | "missing"; path: string; command: string }; // path: the installed SKILL.md
}

// GET /api/policy: ~/.review-desk/policy.md, prose the judge follows. While it's empty it follows `starter`.
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

// window.desktop: set by the desktop app's preload; undefined in a browser.
export interface DesktopBridge {
  platform: string; // process.platform
  version: string;
  // This device's theme, kept by the app (the UI's origin, and so its localStorage, changes when it runs from a checkout);
  // null until picked in this app, absent from an older app.
  theme?: string | null;
  setTheme?(id: string): Promise<void>;
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
  snooze_when: string | null; // snoozed until this happens instead: an Until ("push:<sha>": a head past that commit)
  muted: boolean;
  pinned: boolean;
  seen_at: string | null;
  inflight_at: string | null; // your own PR, handed off for merge with m: the coordinator takes it from here
}

// Someone you can ask for a review of your PR: a user (login) or a team (its slug). id is the node id a review request takes.
export interface Reviewer {
  id: string;
  login: string;
  name: string;
  team: boolean;
  suggested: boolean; // GitHub's own pick for this PR
}

export type Action = "done" | "snooze" | "mute" | "unmute" | "pin" | "unpin" | "seen" | "restore" | "inflight" | "takeback" | "undo";
// The More menu's GitHub writes, only from the desk's window: close (your PR, or an issue you opened or are assigned), draft and
// merge your open PR, reopen your closed one, request changes on someone else's (in its review, with what you wrote).
export type GitHubAction = "close" | "draft" | "ready" | "merge" | "reopen" | "request_changes";
export const GITHUB_ACTIONS: GitHubAction[] = ["close", "draft", "ready", "merge", "reopen", "request_changes"];
// snooze `until`: "1h" | "3h" | "tomorrow" (09:00) | "monday" (09:00) | "activity" | ISO time | an Until
// What a snooze can wait on instead of a time: the item stays in Later until it happens.
export type Until = "ci" | "push" | "approved" | "ready" | "conflict";
export const UNTIL: Record<Until, string> = {
  ci: "CI passes",
  push: "new commits",
  approved: "it's approved",
  ready: "it's ready for review",
  conflict: "the merge conflict is fixed",
};

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
  hint?: { bucket: Bucket; why: string }; // with judge: where the rules put it, which holds until Claude answers (for good on a final rule)
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

// An agent's hand-off: what it needs from you, and which task sent it ("" when it didn't say).
export interface Handoff {
  why: string;
  from: string;
}

// The main page's parts, in order: your PRs the coordinator handed back, other people's PRs waiting on your review, the
// rest that's someone else's (issues, PRs that mention you), then your own PRs.
export type QueueGroup = "back" | "review" | "other" | "mine";
export const QUEUE_GROUPS: readonly QueueGroup[] = ["back", "review", "other", "mine"];
// Cards in their parts' order, each part keeping the order it had.
export const byPart = (cards: Card[]): Card[] =>
  cards.toSorted((a, b) => QUEUE_GROUPS.indexOf(a.group ?? "other") - QUEUE_GROUPS.indexOf(b.group ?? "other"));

export interface Card {
  id: string;
  kind: "pr" | "issue";
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  author_bot: boolean;
  by: string; // as its row says who it's from: "you" (yours, or a bot's for you), the person a bot opened it for, else its author
  stage?: Stage; // a PR's, from stage() in src/stage.ts; an issue has none
  bucket: Bucket;
  why: string;
  handoff?: Handoff; // an agent put it on your desk (desk_add) and said why; gone once you act on it
  demoted?: string;
  board: string;
  boards: string[]; // every board the item is on (for Focus)
  chips: string[]; // short facts: "issue", "draft", "CI red", "conflict", "changes requested", "approved", "3 unresolved", "+120 −30"
  ci: Ci;
  review: ReviewDecision;
  draft: boolean;
  created_at: string;
  updated_at: string;
  activity_at: string; // latest activity by someone else
  waiting_since: string; // request time if requested, else created_at
  new: boolean; // activity since you last looked, on an item that isn't resolved or cleared
  pinned: boolean;
  status: Status;
  snooze_until: string | null;
  snooze_when: Until | null; // snoozed until this happens
  wake_on?: Until[]; // what a snooze can wait on now; absent when nothing
  done_at?: string; // when you marked it done, or did what took it off your desk; only while it's done
  verdict: AiReview["verdict"] | null; // from the AI review of the current commit
  preflight?: Preflight; // Now and Today cards only
  handed_back?: boolean; // your PR back on top: the coordinator can't get it merged, or nobody's asked to review it; its why says which
  cta?: "ready" | "reply" | "reviewers"; // the row's one call to action: Ready for review on your own open draft, Reply on your PR whose only action is answering someone, or Add reviewers on your ready PR nobody's asked to review
  actions?: GitHubAction[]; // the GitHub writes its More menu offers, as the desk allows them now; absent when none
  resolved: string | null; // why it needs nobody now ("merged", "approved by alice"); null while it's open
  resolved_at: string | null; // when it resolved (else its last update, when GitHub doesn't say); null while it's open
  inflight: boolean; // your PR, in Merging
  group?: QueueGroup; // a Now or Today card: which part of the main page it's in (QUEUE_GROUPS)
  placed_by?: "hard" | "pin" | "claude" | "pending" | "unanswered"; // a hard rule, a pin's floor, Claude, the rules until Claude answers, or since it gave no answer; unset with the judge off
  team_ask?: string; // a review asked only of your team: "CODEOWNERS ping to @ml-team", so a rule's why can't pass it off as yours
  stack?: StackRef; // an open PR whose line has two or more open
  // An open PR blocked by another: the item id at the end of the chain, as its why says it ("sentry#129460 (through api#2)"), and what that one waits on
  blocker?: { id: string; ref: string; waits: string };
  blocks?: string[]; // open PRs that need this one merged first, directly or not, as repo#number
}

// ---------------------------------------------------------------------------
// Stacks: PRs in one repo, each based on the head branch of the one below it, the bottom one on the default branch (or on
// a branch no PR heads). Computed by the desk (src/stacks.ts) from the PRs it holds plus those it fetched for the stack.

// Where a card's PR sits in its stack, counting what's still to land: "3/20".
export interface StackRef {
  id: string; // the stack: its bottom PR's id
  pos: number; // this PR's place among the open PRs of its line, 1 = the lowest open one; merged ones below don't count
  size: number; // the open PRs in that line (Stack.line with this PR current, less its merged and closed ones)
  folded?: string[]; // on the one card a queue view lists for the stack: its other members it stands for, bottom first
}

// One PR of a stack.
export interface StackMember {
  id: string;
  number: number;
  title: string; // untrusted
  url: string;
  author: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  ci: Ci;
  review: ReviewDecision;
  parent: string | null; // the member it's based on; null at the bottom
  current: boolean; // the PR the view is about
  bucket: Bucket | null; // where the queue has it; null off the queue (merged, closed, cleared, in Merging, on no board)
  why: string; // its card's why ("merged" for a merged one), "" when the desk has none
}

// A whole stack, as one view shows it.
export interface Stack {
  id: string; // its bottom PR's id
  repo: string;
  base: string; // the branch under the bottom PR: the default branch, or one no PR the desk knows heads
  line: StackMember[]; // bottom first, through the current PR; above a fork it takes the branch with open PRs, then the longest
  forks: StackMember[]; // the members on other branches of a fork, each with its parent; bottom first
  current: string; // the PR the view is about: the reviewed one, or the one card the queue lists for the stack
  up: string | null; // the next open PR above the current one on the line
  down: string | null; // ...and below it
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
  focus: { now: number; today: number; new: number; asks: number }; // asks: agents' questions waiting on your answer
  inflight: { total: number }; // your open PRs in Merging
  agent: boolean; // your agent is on (Settings, Agents): the window draws its Ask your agent entries
  rate_limit: { remaining: number; reset_at: string } | null;
  sentry?: { dsn: string; release: string | undefined } | null; // where the UI reports its errors: absent or null, nowhere
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
  reviewing: number; // PRs that reach it once Claude's first review of them is written
  cards: number; // queue.cards: the queue shows this many, the rest behind one line; 0 = all
  paused: Paused | null; // said once above the queue instead of on every card
}

// Claude stopped: its login failed (the AI review or the judge), or AI reviews nobody asked for keep failing.
export interface Paused {
  who: "claude" | "ai";
  why: string;
}

// Every item once, at its best placement across boards: the app's main surface.
export interface QueueView {
  inquiries: Inquiry[]; // agents' questions waiting on your answer, oldest first: the main page's first rows
  // blocked: what your rules put in Blocked, and your PRs in Merging that another PR blocks; a chain's rows together, longest wait first
  sections: Record<Exclude<Bucket, "hide">, Card[]>;
  reviewing: number; // as in FocusView
  hidden: Card[]; // a rule put it in "hide"
  cleared: Card[]; // done, snoozed, muted
  resolved: Card[]; // merged, closed, approved by someone else, no longer requested; newest first
  cards: number; // as in FocusView
  paused: Paused | null;
  stacks: Record<string, Stack>; // by id: each stack a card here carries (current: the card sections list it by, else its first card)
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

// Where your inline comment goes: a line of a PR's diff, or a range from `start` to it.
export interface InlineAt {
  path: string;
  line: number;
  side: "new" | "old"; // old = a removed line, numbered in the old file
  start?: { line: number; side: "new" | "old" };
}

// Written by your own Claude Code from the diff. Untrusted: the diff came from GitHub.
export interface AiReview {
  verdict: "look" | "skim" | "skip";
  risk: "low" | "medium" | "high";
  summary: string;
  since?: string; // a re-review: what changed since your last review, and whether it settles the concerns
  concerns: string[]; // each also a note on its line (written since evidence: the first notes)
  notes: ReviewNote[]; // each quoted code in the diff and held up when a second Claude checked it against the diff
  dropped?: number; // concerns and notes the check took out: their quote wasn't in the diff, or the diff didn't bear them out
  chunks?: ChunkRanking; // absent on reviews written before ranking, or when Claude didn't rank
  head_oid: string; // the commit it read; a newer push makes it stale
  model: string; // as claude reports it (claude-opus-5[1m]), else "claude-code"
  at: string;
}

// Which hunks of the diff are worth your attention, as Claude ranked them. Ids are h1, h2, … across the files in order,
// as the prompt numbered them; everything not ranked (or unread) is not worth reviewing.
export interface ChunkRanking {
  ranked: { id: string; path: string; level: "look" | "skim"; why: string }[]; // in Claude's order, then any hunk it noted but didn't rank, as a skim
  unread: string[]; // left out of the prompt because the PR, or the hunk's file, was too long to read whole: not judged either way
  total: number; // hunks in the diff
}

// One hunk of the diff in GET /api/review/:id, with what the AI review made of it.
export interface ReviewHunk {
  id: string; // h1, h2, … across the files in order, as the AI review's prompt numbers them
  path: string;
  file: number; // index in ReviewView.files
  header: string; // its @@ line
  patch: string; // its own lines, the @@ line first
  additions: number;
  deletions: number;
  level: "look" | "skim" | "skip" | "unread" | null; // null: no ranking for this commit
  rank: number | null; // 1 = read it first; look and skim only
  why: string | null; // look and skim: Claude's few words ("" on a hunk it noted but didn't rank); unread: which was too long, the PR or its file
  notes: number[]; // indices into ai.notes to show with it, in reading order: the file's own notes (line 0) on its first hunk in the order
}

// The order the review view reads in, decided by the desk: what to look at across files, then the rest; only the desk's own
// calls (lockfiles, no text diff) are folded.
export interface ReviewOrder {
  ranked: boolean; // false: no ranking for this commit (none yet, one written before ranking, or a newer push): `chunks` is every hunk, file by file
  chunks: ReviewHunk[]; // read these, in this order: Claude's (most worth first; a re-review, what changed since you looked first), then hunks it noted but didn't rank
  unread: ReviewHunk[]; // Claude didn't see these (the PR or their file was too long to read whole), file by file
  skipped: ReviewHunk[]; // Claude saw these and left them out (level "skip"), file by file
  rest: ReviewRest[]; // folded, by file: lockfiles and generated files, and files with no text diff
  notes: number[]; // ai.notes in reading order: what ] and [ step through; empty when the review is for an older commit
}

export interface ReviewRest {
  path: string;
  file: number; // index in ReviewView.files
  why: string; // "lockfile or generated", "no text diff: binary or too large", "renamed without changes"
  hunks: ReviewHunk[]; // level "skip"; none for a file with no text diff
  notes: number[]; // the file's own notes when it has no hunks to carry them
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
  held: boolean; // in Now or Today, but kept off the queue until Claude's first review of it is written
  activity: ActivityEvent[]; // the latest events for this item, newest first
  stack: Stack | null; // its stack, with it current
}

// GET /api/review/:id: one PR's review view.
export interface ReviewView {
  card: Card;
  item: Item;
  handoff_prompt: string;
  files: ReviewFile[]; // patch repeats order's hunks, which the review UI renders instead
  diff_head: string; // the commit the diff's own files are at, which can be newer than item.head_oid until the next sync
  files_error: string | null; // the diff couldn't be fetched
  order: ReviewOrder; // every hunk once, in the order to read them
  ai: AiReview | null; // the latest, even if stale
  ai_stale: boolean;
  ai_error: string | null; // the last failed attempt on this commit, or why AI reviews are paused
  generating: boolean;
  approve: { ok: boolean; reason: string | null }; // reason: why not, e.g. "it's your PR"
  activity: ActivityEvent[]; // the PR's last 8 events, newest first
  stack: Stack | null; // its stack, with it current
  conversation: Conversation[]; // what reviewers said, those waiting on you first
  conversation_error: string | null; // it couldn't be fetched
  reading: boolean; // Claude is reading the ones waiting on you
  reading_error: string | null; // its last try on this PR failed
  asks: Ask[]; // yours to the coordinator about it, oldest first
}

// One conversation on a PR: a review thread, a comment on the PR, or a review's body. Every text is untrusted GitHub text.
export interface Conversation {
  id: string; // a review thread's node id (what a reply goes to), else the comment's or review's
  kind: "thread" | "comment" | "review"; // a reply to a comment or review is a comment on the PR
  path: string | null; // a review thread's file; null: on the PR
  line: number | null;
  side: "new" | "old" | null; // a review thread's: old = on a removed line, numbered in the old file
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
  | "unresolved" // data: was (the reason that stopped holding)
  | "blocked" // your PR, blocked by another PR; data: by
  | "unblocked"; // no longer; data: was, merged (the PR that merged, "" if none), closed (pr.requires_closed, joined)

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
// Merging: your own PRs you handed off (Hand off for merge), which the coordinator gets merged (GET /api/inflight).

export interface InflightRow {
  card: Card;
  state: Item["state"];
  base: string;
  stacked: boolean; // its base isn't the repo's default branch: it sits on another PR
  merge_method: Item["merge_method"] | null; // the repo's default merge method for you, when the desk knows it
  ci: Ci;
  failing: string[]; // failing check names
  approved_by: string[];
  changes_by: string[]; // changes requested by
  waiting_on: string[]; // reviewers asked and not heard from yet; teams as @slug
  threads_unresolved: number;
  mergeable: Mergeable;
  draft: boolean; // a draft PR
  rebase: boolean; // the desk gave it to the coordinator only to rebase (ready to merge but conflicts); it leaves once mergeable
  blocked_by: { ref: string; waits: string } | null; // another PR must merge first: pr.blocker and pr.blocker_waits
  requires_closed: string[]; // PRs it needs that were closed without merging, as repo#number: pr.requires_closed
  waits_on: string | null; // what it waits on, in Merging's words: "waits on CI", "ready to merge"; null once merged or closed
  note: { text: string; at: string } | null; // the coordinator's latest desk_note on it; untrusted, an agent wrote it
}

export interface InflightView {
  rows: InflightRow[]; // open ones first, then those that merged or closed in the last 3 days; a stack's rows together, bottom first
  stacks: Record<string, Stack>; // by id: each stack with a row here (current: its first row)
  coordinator: CoordinatorView;
}

// The session the desk starts and wakes, as claude.ai and `claude agents` name it; the window calls it "your agent".
export const COORDINATOR_NAME = "Review Desk coordinator";

// The background Claude Code session the desk starts and wakes (README → Coordinator).
export interface CoordinatorView {
  on: boolean;
  id: string | null; // what `claude attach`, `logs`, `stop` and `rm` take; null until it's started
  url: string | null; // its Remote Control page on claude.ai
  error: string | null; // why claude last couldn't start or resume it, until it does
  // What it's doing, as `claude agents` last said: working ("busy", "shell"), on a permission prompt ("waiting"), idle,
  // stopped (no process), or null (none yet). Looked at every 10 s while one of your asks waits on its answer.
  status: "busy" | "shell" | "waiting" | "idle" | "stopped" | null;
  queued: string[]; // your asks not handed over yet: it gets them once it's done with what it's on
}

// Your words to the coordinator from the desk's window (Ask your agent), about what you were on, and its answer (desk_answer).
export interface Ask {
  id: string;
  at: string;
  text: string; // your words, in paragraphs
  item_id: string | null;
  thread_id: string | null; // a conversation in the PR's review
  thread_url: string | null;
  lines?: AskLines | null; // absent on asks kept before it; the file's name never goes in the wake line (desk_ask gives it)
  answer: { text: string; at: string } | null; // untrusted: an agent wrote it; in paragraphs, drawn by web/src/prose.ts, never as HTML
}

// Lines of a PR's diff an ask is about, at the commit you read them in: picked with + (or a drag), or the AI note you were on.
export interface AskLines extends InlineAt {
  head: string; // 40 hex
  note?: boolean; // Claude's AI note at these lines (] [), not lines you picked
}

// What an ask is about, in the desk's words: never PR text.
export interface AskAbout {
  url: string;
  whose: "mine" | "theirs" | "issue"; // the real author, or in Merging (your own m put it there): a bot's "via" alone never makes it yours
  merging: boolean;
  state: "open" | "closed" | "merged";
}

// GET /api/asks/:id (desk_ask): where an ask is, and where a change it asks for may go.
export interface AskPlace {
  ask: Ask;
  about: AskAbout | null; // null: about nothing, or the item left the desk
  head: string | null; // the PR's head at the desk's last sync
  base: string | null; // the PR's base branch: removed lines are numbered there
  push: { repo: string; branch: string } | null; // only your own open PR's branch, in Merging or not; else null
}

// A question an agent session put to you through the desk (desk_inquire): a row on the main page until you answer it, and
// its own page with all you need to decide without opening anything else. Everything but the answer is untrusted: an agent wrote it.
export interface Inquiry {
  id: string;
  at: string;
  from: string; // the session that asks, as it names itself
  question: string;
  context: string; // what it's doing, what it found and what the choice turns on, in paragraphs
  options: InquiryOption[]; // its pick first; you can always write your own
  links: InquiryLink[]; // what it's about and what it read: comments, files, runs, docs
  item_id: string | null; // the PR or issue it's about
  answer: { text: string; at: string; dismissed: boolean } | null;
}

// GET /api/inquiries/:id: with the card of the PR or issue it's about, when the desk holds it.
export interface InquiryView extends Inquiry {
  card: Card | null;
}

export interface InquiryOption {
  answer: string;
  next: string; // what the agent does next if you pick it, and what that costs or risks; "" on a question asked before it was required
}

export interface InquiryLink {
  label: string;
  url: string; // http(s), or claude: for a Claude session
}

// An automation (Settings → Automations): your instruction, run on its schedule by your own Claude Code, read only. What a
// run finds that needs you goes on your desk with its why. An agent may draft or edit one; it's off until you turn it on.
export interface Automation {
  id: string; // a slug: "warden-issues"
  name: string;
  schedule: string; // "daily 09:00", "weekdays 09:00,13:00", "mon,thu 17:30", "weekdays hourly": local time
  prompt: string; // the instruction, in your words
  on: boolean;
  by: "you" | "an agent"; // who last changed what it does
  updated_at: string;
}

export interface AutomationRun {
  id: string;
  automation: string;
  trigger: "schedule" | "now";
  at: string;
  done_at: string | null; // null while it runs
  error: string | null;
  summary: string; // the agent's: untrusted
  // added: it's on your desk now; kept: it was already; left: you'd dealt with it (done, snoozed, muted, in Merging), so it
  // stays that way; resolved: nobody needs it now (closed, merged, approved by someone else); failed: the desk couldn't
  // take it (error says why)
  items: { item_id: string; why: string; outcome: "added" | "kept" | "left" | "resolved" | "failed"; error?: string }[];
  session: string | null; // the run's Claude Code session: claude --resume <id> shows what it did
}

// GET /api/automations
export interface AutomationView extends Automation {
  next_at: string | null; // while it's on
  running: boolean;
  runs: AutomationRun[]; // newest first, the last 10
}

// GET /api/asks
export interface AsksView {
  on: boolean; // the coordinator setting: off, nothing is sent
  asks: Ask[]; // oldest first
  coordinator: CoordinatorView; // what it's doing, for an ask that waits on its answer
}

// GET /api/config
export interface ConfigDoc {
  path: string;
  text: string;
  hash: string; // PUT /api/config takes it (or the whole text) as `base`
  errors: ConfigError[];
  warnings?: ConfigError[]; // leftover pre-settings keys: ignored, not fatal
  hard: { board: string; bucket: Bucket; when: string; why: string; final?: boolean }[]; // the loaded config's hard and final rules, for the Rules page
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
