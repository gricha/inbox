// Shared types: GitHub items, rule signals, config, and the HTTP API shapes.
import { isKeyOf } from "./narrow.ts";

export type Bucket = "now" | "today" | "blocked" | "later" | "fyi" | "hide";
export const BUCKETS: Bucket[] = ["now", "today", "blocked", "later", "fyi", "hide"];
export const RANK: Record<Bucket, number> = { now: 0, today: 1, blocked: 2, later: 3, fyi: 4, hide: 5 };

export type Ci = "green" | "red" | "pending" | "none";
export type ReviewDecision = "approved" | "changes_requested" | "required" | "none";
export type Mergeable = "clean" | "conflict" | "unknown";
export type ReviewState = "approved" | "changes_requested" | "commented" | "dismissed" | "pending";
// blocked and handed back: only Desk.card() sets them
export type Stage =
  | "draft"
  | "waiting for review"
  | "changes requested"
  | "approved"
  | "blocked"
  | "handed back"
  | "rebasing" // your agent is rebasing it: ready to merge but for a conflict
  | "merged"
  | "closed";

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
  requester?: string; // a PR's: who an agent's line says it was opened for, "@login" or a name, "" if none (requesterOf()); absent on items stored before
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
  ready_at?: string | null; // PR only: when it last became ready for review (its latest ReadyForReviewEvent); null if it never was a draft; absent on items stored before it was fetched
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
    blocker_mine: boolean; // a PR in its chain waits on you: your review, your reply, or your own PR's next step
    blocks: string[]; // open PRs that need this one merged first, directly or through others, as repo#number
    requires_closed: string[]; // PRs it needs that were closed without merging
    waiting_on: string[]; // who is asked to review it and hasn't approved: logins and @teams, you and bots left out; empty once approved
    waits: string; // what it waits on next, in words ("waits on a review from sam", "is ready to merge"); "" once merged or closed
    reviewers: string[]; // who has reviewed it (approved, asked for changes or commented): you, its author and bots left out
    people_requested: string[]; // people asked to review it by name, you and bots left out
    teams_requested: string[]; // teams asked to review it, as slugs, yours included
    ready_weekday_hours: number; // hours it has been ready for review, Monday to Friday's only; -1 for a draft, an issue, once merged or closed, or while unknown
    asked_weekday_hours: number; // the same since the latest request to someone in people_requested, or since it went ready if later; -1 if nobody is, or as ready_weekday_hours
    unasked: boolean; // open and ready, nobody's asked to review it and only bots or the author have reviewed it
    review_optional: boolean; // its repo needs no review to merge it: GitHub gives no review decision on the default branch
    pushed_hours: number;
    paths: string[]; // its changed files' paths, the first 50; empty while they aren't fetched
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
    handed_back: boolean; // your agent handed it back to you (Merging's hand-back) and you haven't acted on it since
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
// Config (~/.inbox/config.toml)

// A rule's bucket, or "judge": no hint of its own, so the board default until Claude answers.
export type RuleBucket = Bucket | "judge";

// How much the judge counts a rule that doesn't say (0 to 10).
export const RULE_WEIGHT = 5;

export interface Rule {
  when: string;
  bucket: RuleBucket;
  why?: string;
  nocap?: boolean; // matched items don't count toward caps and are never demoted
  hard?: boolean; // a floor: what it matches never sorts below its bucket (Today for a Now rule)
  final?: boolean; // Claude doesn't re-sort what it matches: it stays in the rule's bucket (a pin's floor still lifts it)
  weight?: number; // 0 to 10: how much the judge counts it (RULE_WEIGHT when unset)
  id?: string; // the plugin's rule it is, or, with `own`, the one yours replaces
  own?: number; // yours, on a board with `builtin`: its index in the board's `rules` in config.toml
  after?: string; // yours, as config.toml has it: right after this built-in rule (resolved rules don't carry it)
}

// What a plugin comes with for a kind of board (GitHub's PRs to review, My PRs, …): a board names it with `builtin`, and gets
// its rules after the board's own, as the code has them now. A rule's id is stable: config.toml switches one off or replaces it.
export interface BuiltInRules {
  name: string;
  rules: readonly (Omit<Rule, "id" | "own" | "after" | "bucket"> & { id: string; bucket: Bucket; why: string })[];
}

export interface BoardConfig {
  id: string;
  space: string;
  name: string;
  source?: string; // the connector whose items it lists ("notes"); none: GitHub's
  queries: string[]; // GitHub search; the space scope is appended. {me} and {close_authors} expand.
  filter?: string;
  priority?: string; // number expression; higher sorts first within a bucket, before `sort`
  rules: Rule[]; // what places its items, in order: yours, then the plugin's (`builtin`) with yours in their place or after them
  builtin?: string; // the plugin's rules it uses (GitHub's "review", "mine", …)
  off?: string[]; // of those, the ones switched off
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
  signals: { close_collaborator_min: number; bots: string[]; my_repos: string[]; my_names: string[] };
  handoff: { prompt: string; mine: string; issue: string }; // review someone's PR / move your PR along / an issue
  spaces: SpaceConfig[];
  boards: BoardConfig[];
}

// ---------------------------------------------------------------------------
// Settings (settings.json): how the desk behaves. Boards and rules stay in config.toml.

export type SettingType = "number" | "boolean" | "string" | "text" | "list" | "hotkey" | "select" | "secret";
// What a secret setting's value reads as once it's set: the desk never sends the value itself (GET /api/settings, the CLI),
// and takes this back as "unchanged". "" still means none.
export const SECRET_SET = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
export type SettingValue = number | boolean | string | string[];

export interface SettingDef {
  key: string; // "section.name"
  section: string;
  label: string;
  help?: string;
  // text = multi-line string, list = strings, hotkey = Electron accelerator ("" = off), select = one of options, secret = a
  // string the desk keeps in settings.json and never sends back (SECRET_SET stands in for it)
  type: SettingType;
  default: number | boolean | string | readonly string[];
  options?: readonly { value: string; label: string; off?: string }[]; // select only; off: why it can't be picked yet
  min?: number;
  max?: number;
  unit?: string; // a number's, shown after its field ("days")
  more?: boolean; // behind its part's More (the part named by section), folded until opened
  pattern?: string; // strings and list items must match (an empty "string" is always allowed unless required)
  pattern_hint?: string;
  required?: boolean;
  placeholder?: string;
}

export interface SettingsSection {
  id: string;
  title: string;
}

export interface GitHubStatus {
  login: string | null;
  auth: string; // where the token comes from: "gh CLI" or "GITHUB_TOKEN"
  error: string | null; // last sync or context error
  synced_at: string | null;
  rate_limit: { remaining: number; reset_at: string } | null;
  teams: string[];
  orgs: { org: string; items: number; space: string | null }[]; // orgs with your open items, and the space they land in
  catch_all: string | null; // the space that takes every org no other names (Personal), if one does
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
  judge: JudgeStatus;
}

// A device paired over Tailscale: a browser holds its token in a cookie, a machine's agents in their MCP config.
export interface Device {
  id: string;
  name: string;
  kind: "browser" | "device";
  created_at: string;
  last_used_at: string | null;
}

// Settings → Tailscale's rows (GET /api/remote): on, its words, the address while it serves, who may use it.
export interface RemoteView {
  on: boolean;
  text: string;
  url: string | null;
  login: string | null;
  devices: Device[];
}

// GET /api/setup: a desk never set up shows the first-run page while `needed`, until you pick your agent.
export interface SetupView {
  needed: boolean;
  // login: who GitHub says you are; else why it can't be read and what to run (null: nothing to run, just Retry)
  github: { login: string | null; error: string | null; fix: string | null };
  agent: string; // agent.harness
  picked: SetupAgent["id"] | null; // the agent picked here, connected already; the page waits on GitHub alone
  agents: SetupAgent[];
}

export interface SetupAgent {
  id: "claude-code" | "codex" | "opencode";
  name: string; // Claude Code, Codex, OpenCode
  installed: boolean;
  logged_in: boolean;
  fix: string | null; // what to run while it isn't installed or logged in
}

// GET /api/agents: whether Claude Code has the desk's MCP tools and the Inbox skill.
export interface AgentStatus {
  driver: string;
  // name: the server's name, connected or to be; command: what Connect runs to register the desk
  mcp: { connected: boolean; name: string; command: string };
  skill: { state: "installed" | "outdated" | "missing"; path: string; command: string }; // path: the SKILL.md, installed or to be
  needs: "connect" | "update" | null; // what Settings asks of you: connect (tools or skill missing), update the skill, nothing
  note: string | null; // why a name isn't inbox: what keeps it ("Connected as inbox-47998: your other desk keeps inbox")
  connect: string[]; // what Connect runs: only what's missing, in its order
}

export interface JudgeStatus {
  state: "off" | "idle" | "running" | "error";
  off_reason: string | null; // why it's off: the setting
  waiting: number; // items without a fresh answer
  judged: number; // items with an answer for what they are now
  spent: number; // items sent in the last hour
  max_per_hour: number;
  last_at: string | null; // the last call that finished
  error: string | null; // the last call's failure, until one succeeds
  retry_at: string | null; // after a failure, or with the hour's limit reached and items waiting: no call before this
}

// The theme Omarchy has on, on the desk's machine (GET /api/omarchy, and the event stream's `omarchy` when it switches);
// null off Omarchy. One of the desk's themes, or its tokens made from the theme's colours (src/omarchy.ts).
export interface OmarchyTheme {
  name: string; // Omarchy's own, e.g. "tokyo-night"
  scheme: "light" | "dark";
  theme: string | null; // the desk's theme of that name; Light or Dark when it has no colours to read
  tokens: Record<string, string> | null; // otherwise: every token, and color-scheme
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

// The desktop app running the desk and its UI from a checkout (Settings → This device → Run from a checkout).
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
  section: InboxSection | null; // the Inbox section you moved it to, until you're done with it, snooze or mute it
}

// Someone you can ask for a review of your PR: a user (login) or a team (its slug). id is the node id a review request takes.
export interface Reviewer {
  id: string;
  login: string;
  name: string;
  team: boolean;
  suggested: boolean; // GitHub's own pick for this PR
}

export type Action =
  "done" | "snooze" | "mute" | "unmute" | "pin" | "unpin" | "seen" | "restore" | "inflight" | "takeback" | "undo" | InboxSection; // move it to that section of the Inbox
// The More menu's GitHub writes, only from the desk's window: close (your PR, or an issue you opened or are assigned), draft and
// merge your open PR, reopen your closed one, request changes on someone else's (in its review, with what you wrote).
export type GitHubAction = "close" | "draft" | "ready" | "merge" | "reopen" | "request_changes" | "rerequest" | "unrequest";
export const GITHUB_ACTIONS: GitHubAction[] = ["close", "draft", "ready", "merge", "reopen", "request_changes", "rerequest", "unrequest"];
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
  signals?: JudgeSignal[]; // every rule on this board that matches it, the first one's first
}

// One thing the judge weighs about an item: a rule that matches it, an automation's sort of it, or a criterion's yes.
export interface JudgeSignal {
  from: string; // in words: "rule asked-directly on PRs to review", "your rule 2 on Mine", "automation Triage", "criterion Asked by name"
  bucket?: Bucket; // what it suggests; a criterion suggests none
  why: string;
  weight: number; // 0 to 10
  hard?: boolean; // a floor: the judge answers at or above `bucket` (Today for a Now rule)
  key: string; // what it is, for the judge's answer: changing the rule, its weight or its bucket asks again
}

// The judge's step in a placement, or an automation's sort standing in for it until the judge has weighed it.
export interface JudgeStep {
  bucket: Bucket | null; // its answer; null: none, so where the rules put it
  why: string;
  pending: boolean; // not judged since the item or its signals last changed (an earlier answer may still show)
  by?: string; // the automation that sorted it, by name; absent: Claude
}

// Kept per item in kv `judge:<id>`: good while what the judge read of the item (judgeKey) and its signals stay the same.
export interface JudgeAnswer {
  key: string; // judgeKey() with the signals it saw
  signals?: Pick<JudgeSignal, "from" | "bucket" | "weight" | "key">[]; // what it weighed, for the item's trace
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

// The main page's order, by part: your PRs back to you (handed back, or nobody's asked to review them), other people's PRs
// waiting on your review, the rest that's someone else's (issues, PRs that mention you), then your own PRs. The page is one
// list: no heading says which part a row is in.
type QueueGroup = "back" | "review" | "other" | "mine";
const QUEUE_GROUPS: readonly QueueGroup[] = ["back", "review", "other", "mine"];
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
  people?: string[]; // everyone it involves (peopleOf()), for the filter's involves:
  stage?: Stage; // a PR's, from stage() in src/stage.ts, or that your agent handed it back; an issue has none
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
  cta?: "ready" | "reply" | "reviewers" | "merge"; // the row's one call to action: Ready for review on your own open draft, Reply on your PR whose only action is answering someone, Add reviewers on your ready PR nobody's asked to review, or Merge on yours that's approved, green and mergeable
  review_optional?: true; // your PR's repo needs no review to merge it (pr.review_optional): Hand off for merge beside Add reviewers
  talk?: true; // a PR people said something on (a thread, a comment, a review that commented): its review keeps the conversation's line while it loads
  actions?: GitHubAction[]; // the GitHub writes its More menu offers, as the desk allows them now; absent when none
  resolved: string | null; // why it needs nobody now ("merged", "approved by alice"); null while it's open
  resolved_at: string | null; // when it resolved (else its last update, when GitHub doesn't say); null while it's open
  inflight: boolean; // your PR, in Merging
  group?: QueueGroup; // a Now or Today card: which part of the main page's order it's in (QUEUE_GROUPS)
  placed_by?: "hard" | "pin" | "claude" | "automation" | "pending" | "unanswered"; // a hard rule, a pin's floor, Claude, an automation's sort, the rules until Claude answers, or since it gave no answer; unset with the judge off and no sort
  team_ask?: string; // a review asked only of your team: "CODEOWNERS ping to @ml-team", so a rule's why can't pass it off as yours
  stack?: StackRef; // an open PR whose line has two or more open
  // An open PR blocked by another: the item id at the end of the chain, as pr.blocker says it ("sentry#129460 (through api#2)"), and what that one waits on
  blocker?: { id: string; ref: string; waits: string };
  needs?: string[]; // a blocked PR's open PRs it needs merged first directly, as repo#number (pr.blocked_by)
  depth?: number; // on Blocked: how deep in its chain the row hangs, 0 for a chain's first rows
  blocks?: string[]; // open PRs that need this one merged first, directly or not, as repo#number
  section?: InboxSection; // on the Inbox: which of its sections it's in (QueueView.inbox)
  score?: number; // on the Inbox: 0 to 10, a model's or the desk's own (src/urgency.ts); its section's order
  reason?: string; // on the Inbox: why it's there, quietly on its row
  quick?: string; // quick to review, and why ("low risk, 24 lines"): someone else's PR you can unblock cheaply, a bolt on its row
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
  state: "ready" | "stale" | "running" | "queued" | "paused" | "off" | "failed" | "none"; // failed: a try on its head, nothing running
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

// Who sorts and reviews (agent.harness), as the window and the desk's words name it.
export type AgentName = "Claude" | "Codex" | "OpenCode";

export interface Overview {
  me: string;
  synced_at: string | null;
  syncing: boolean;
  sync_error: string | null;
  config_errors: ConfigError[];
  connectors: ConnectorStatus[];
  spaces: { id: string; name: string; boards: BoardSummary[] }[];
  // asks: agents' questions waiting on your answer; sessions: sessions that need you
  focus: { now: number; today: number; new: number; asks: number; sessions: number };
  inflight: { total: number }; // your open PRs in Merging
  agent: boolean; // your agent is on (Settings, Agents): the window draws its Ask your agent entries
  ai_agent: AgentName; // who sorts and reviews (agent.harness), as the window names it
  rate_limit: { remaining: number; reset_at: string } | null;
  sentry?: { dsn: string; release: string | undefined } | null; // where the UI reports its errors: absent or null, nowhere
  update?: UpdateView | null; // absent or null: no packaged app runs this desk (a checkout, desk serve), so nothing to update
}

// The packaged app's version against Inbox's latest GitHub Release.
export interface UpdateView {
  current: string;
  latest: string | null; // null until a check found a release
  url: string | null; // the latest release's page, where its builds are
  available: boolean; // latest is newer than current
  install: boolean; // the app downloads and restarts into it itself (POST /api/update); otherwise url is where to get it
  installing: boolean;
  error: string | null; // why the last install failed; install is false after one
}

// A source of items and events: GitHub today.
export interface ConnectorStatus {
  id: string; // "github"
  name: string; // "GitHub"
  status: "ok" | "syncing" | "paused" | "error"; // paused = rate limited
  synced_at: string | null; // when the last full pass finished
  error: string | null;
  progress?: { done: number; total: number; found: number } | null; // the pass running: searches done of total, items found so far
}

export interface BoardView {
  board: BoardSummary & { queries: string[] };
  sections: Record<Exclude<Bucket, "hide">, Card[]>;
  hidden: Card[]; // bucket "hide" from rules
  cleared: Card[]; // done, snoozed, muted
}

export interface FocusView {
  sessions: SessionCard[]; // sessions that need you, after agents' questions: blocked, then stalled
  sections: { now: Card[]; today: Card[] }; // one list on screen: now first, then today
  reviewing: number; // PRs that reach it once Claude's first review of them is written
  paused: Paused | null; // said once above the queue instead of on every card
}

// The agent stopped (Claude or Codex, as Overview.ai_agent names it): its login failed, or AI reviews nobody asked for keep failing.
export interface Paused {
  who: "claude" | "ai";
  why: string;
}

// Every item once, at its best placement across boards: the app's main surface.
export interface QueueView {
  inquiries: Inquiry[]; // agents' questions waiting on your answer, oldest first: the main page's first rows
  notes: NotesView;
  sessions: SessionCard[]; // every session that needs you, with your triage on it; the active ones follow the questions
  // blocked: what your rules put in Blocked, and your PRs in Merging that another PR blocks; a chain's rows together, longest wait first
  sections: Record<Exclude<Bucket, "hide">, Card[]>;
  reviewing: number; // as in FocusView
  hidden: Card[]; // a rule put it in "hide"
  cleared: Card[]; // done, snoozed, muted
  resolved: Card[]; // merged, closed, approved by someone else, no longer requested; newest first
  paused: Paused | null;
  stacks: Record<string, Stack>; // by id: each stack a card here carries (current: the card sections list it by, else its first card)
  // The Inbox, by section, each by score then the desk's order: what's in now, today, later and fyi (sections), as
  // src/urgency.ts places it. Agents' questions and the sessions that need you lead Urgent.
  inbox: Record<InboxSection, Card[]>;
  first_pass: FirstPass | null; // said above the Inbox's rows
}

// A new desk's first minutes: its first sync, then the judge's and the scorer's first answers. null once through, when what
// sorts is held or failed (a bubble says so), and on a desk that synced before this was kept.
export interface FirstPass {
  step: "sync" | "sort";
  done: number; // sync: searches; sort: Inbox items answered
  total: number;
  found: number; // sync: items its searches found so far; sort: as total
  line: string; // what the Inbox says
}

// The Inbox's sections: Urgent (an urgent criterion said yes, a hand-back, or a score at queue.urgent_at or above), FYI
// (what the rules or an automation sorted to fyi, or a score at queue.fyi_at or below) and Standard, the rest.
export type InboxSection = "urgent" | "standard" | "fyi";
export const INBOX_SECTIONS: readonly InboxSection[] = ["urgent", "standard", "fyi"];

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
  guide?: ReviewGuide; // absent on reviews written before it, and when Claude wrote no walk-through worth keeping
  // The next review's parts; absent on reviews written before them.
  risk_reasons?: { factor: RiskFactor; why: string }[];
  intent?: { goal: string; fit: "matches" | "partial" | "differs" | "undescribed"; gap: string; stack: string };
  look?: ReviewLook[]; // where correctness hinges: read these even if nothing else
  interfaces?: ReviewInterface[];
  improvements?: ReviewNote[]; // held up by the check like concerns; never notes in the code
  diagrams?: ReviewDiagram[]; // parsed by the desk; what failed the grammar never reaches here
  skill?: string; // the hash of the review instructions it was written with
  doc?: string; // its review document's id (src/doc.ts), <home>/docs/<doc>.json and .html
  refused?: string[]; // diagrams the grammar refused, and why: for the log
  head_oid: string; // the commit it read; a newer push makes it stale
  model: string; // as claude reports it (claude-opus-5[1m]), else "claude-code"
  at: string;
}

type RiskFactor = "data" | "security" | "contract" | "concurrency" | "deploy" | "irreversible" | "reach" | "untested" | "other";

export interface ReviewLook {
  path: string;
  side: "new" | "old";
  line: number;
  end: number; // its last line, in the same hunk
  why: string;
}

export interface ReviewInterface {
  name: string;
  kind: "function" | "type" | "endpoint" | "schema" | "config" | "event" | "cli" | "permission" | "other";
  change: "added" | "changed" | "removed";
  breaking: boolean;
  impact: string;
  path: string;
  side: "new" | "old";
  line: number;
}

// A review document the desk keeps (POST /api/docs, desk_doc): where it is, and what of it fell out on the way in.
export interface DocSaved {
  id: string;
  json: string; // <home>/docs/<id>.json, the document
  html: string; // <home>/docs/<id>.html, its page
  link: string; // inbox://doc/<id>
  dropped: string[]; // what was left out, part by part, as docs/review-format.md says why
}

export interface ReviewDiagram {
  id: string;
  title: string;
  caption: string;
  source?: string; // the Mermaid it was parsed from; absent on reviews written before review documents
  graph: DiagramGraph;
}

// Which hunks of the diff are worth your attention, as Claude ranked them. Ids are h1, h2, … across the files in order,
// as the prompt numbered them; everything not ranked (or unread) is not worth reviewing.
export interface ChunkRanking {
  ranked: { id: string; path: string; level: "look" | "skim"; why: string }[]; // in Claude's order, then any hunk it noted but didn't rank, as a skim
  unread: string[]; // left out of the prompt because the PR, or the hunk's file, was too long to read whole: not judged either way
  total: number; // hunks in the diff
}

// Claude's walk through the diff, in the order to understand it. Ids and paths as ChunkRanking keeps them, so a retargeted
// base can't point a step at other code.
export interface ReviewGuide {
  steps: { title: string; body: string; check: string; note?: string; diagram?: string; hunks: { id: string; path: string }[] }[];
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
  looks?: number[]; // indices into ai.look that start on it
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
  steps?: ReviewStep[]; // the walk-through, when this commit's review has one: its hunks are the same ones chunks, unread and skipped hold
  beyond?: ReviewHunk[]; // with steps: the hunks of chunks, unread and skipped no step covers, file by file
}

// One stop of the walk-through.
interface ReviewStep {
  title: string;
  body: string;
  check: string; // what to verify here, or ""
  note?: string; // block prose: context no single line carries
  diagram?: string; // the id of its diagram in ai.diagrams
  hunks: ReviewHunk[];
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
  // While the judge is on: what it weighs for the item now, and what its answer weighed (null: no answer yet)
  judge?: { signals: JudgeSignal[]; saw: JudgeAnswer["signals"] | null; at: string | null; fresh: boolean };
  state: ItemState;
  handoff_prompt: string;
  ai: AiReview | null;
  ai_stale: boolean;
  generating: boolean;
  held: boolean; // in Now or Today, but kept off the queue until Claude's first review of it is written
  activity: ActivityEvent[]; // the latest events for this item, newest first
  stack: Stack | null; // its stack, with it current
  issue_ai?: IssueReview | null; // an issue's pre-review, the latest even if the issue has moved on since
  issue_ai_state?: "running" | "failed" | "off" | null; // its run: on its way, failed on this version (issue_ai_error says why), or AI reviews are off
  issue_ai_error?: string | null;
  blocked_author?: boolean; // its author is on your desk's blocklist: their items are muted and no agent reads them
}

// An issue's pre-review (src/issue.ts), written by your own agent for the issue as it was at `updated_at`. Every field but
// the dates is model output read from untrusted issue text: drawn as plain prose, never as HTML.
export interface IssueReview {
  updated_at: string;
  at: string;
  model: string;
  // Text from someone outside the repo's collaborators read as an attempt to steer an agent: nothing else read it, and every
  // field below is empty.
  injection: { who: string; why: string } | null;
  kind: "bug" | "feature" | "question" | "other";
  summary: string; // one sentence: what it's about, in our words
  problem: string; // what is actually wrong or wanted, not what the report says to do
  cause: string; // a bug's root cause, from the code when it was read; "" when unknown
  evidence: { path: string; line: number; why: string }[]; // places in the code, checked to exist
  fix: string; // what we'd change, our own proposal
  fixable: boolean; // a small, clear bug fix it has conviction about: Make PR with fix
  steps: { title: string; body: string }[]; // a walk through a complicated one, to decide what to do; empty when simple
  code: boolean; // it read the repo's code in your local clone; false: only the issue's text
  repo_dir?: string; // that clone
  base?: string; // the repo's default branch, which a fix branches off
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
  generating: boolean; // its job is running
  ai_job: Job | null; // its AI review's job: running, or for this commit
  approve: { ok: boolean; reason: string | null }; // reason: why not, e.g. "it's your PR"
  activity: ActivityEvent[]; // the PR's last 8 events, newest first
  stack: Stack | null; // its stack, with it current
  checks: Checks | null; // its head commit's checks, one by one; null: none ran, or they couldn't be fetched
  checks_error: string | null; // they couldn't be fetched
  reviewers: Standings; // who reviews it and where each stands
  merge: string | null; // what stands in its merge's way, in one line ("Merge conflict with main"); null: nothing, or the desk doesn't know
  conversation: Conversation[]; // what reviewers said, those waiting on you first
  conversation_error: string | null; // it couldn't be fetched
  reading: boolean; // Claude is reading the ones waiting on you
  reading_error: string | null; // its last try on this PR failed
  asks: Ask[]; // yours to the coordinator about it, oldest first
}

// One check on a PR's head commit: a check run (an Actions job, an app's) or a commit status. Its name is untrusted GitHub text.
export interface Check {
  name: string;
  state: "failing" | "cancelled" | "running" | "passing" | "skipped";
  optional: boolean; // the base branch requires other checks and not this one: failing, it doesn't hold the merge back
  url: string; // its page: a check run's on GitHub, a status's wherever it points; https only, "" for none
}

// A PR's checks as its review lists them, in the sidebar with its files.
export interface Checks {
  line: string; // all of them in one line: "CI passing · 14 checks", "2 failing of 14 checks", "3 running of 14 checks"
  failing: boolean; // a check that counts is failing: the line is red, as "CI failing" is
  list: Check[]; // failing first, then cancelled, running, passing and skipped, each by name
}

// Where one reviewer stands on a PR: you are "you", a team is @slug.
export interface Standing {
  who: string;
  state: "changes requested" | "asked" | "approved" | "commented"; // asked: to review it, and it waits on them
}

// Who reviews a PR and where each stands, as its review lists them in the sidebar.
export interface Standings {
  line: string; // all of it in one line: "Approved by marco · waiting on sam and @backend", "Changes requested by kofi", "Nobody's asked"
  changes: boolean; // someone asks for changes: the line is amber, as "changes requested" is
  list: Standing[]; // who holds it first: changes requested, asked, approved, commented
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
  comment_id: string; // the latest comment it read; a newer one asks again
  at: string;
}

// ---------------------------------------------------------------------------
// The event log (GET /api/activity, the desk_events MCP tool)

export const ACTIVITY_KINDS = [
  "new", // first seen on the desk
  "review_requested", // from you or your team; data: reviewer, type, codeowner
  "request_removed", // data: reviewer, type
  "reviewed", // by someone else; data: state (approved, changes_requested, commented)
  "pushed", // a new head commit; data: oid
  "ci", // data: from, to (green, red, pending)
  "commented", // by someone else
  "merged",
  "closed",
  "reopened",
  "mentioned", // data: reason (mention, team_mention)
  "assigned", // to you
  "conflict", // your PR started conflicting with its base; data: base
  "resolved", // data: reason
  "unresolved", // data: was (the reason that stopped holding)
  "blocked", // your PR, blocked by another PR; data: by
  "unblocked", // no longer; data: was, merged (the PR that merged, "" if none), closed (pr.requires_closed, joined)
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
// Each kind as what an automation reacts to, after "When": "a review is asked of you", "CI changes".
export const EVENT: Record<ActivityKind, string> = {
  new: "it first reaches the desk",
  review_requested: "a review is asked of you or your team",
  request_removed: "a review request is removed",
  reviewed: "someone reviews it",
  pushed: "new commits are pushed",
  ci: "CI changes",
  commented: "someone comments",
  merged: "it's merged",
  closed: "it's closed",
  reopened: "it's reopened",
  mentioned: "you're mentioned",
  assigned: "it's assigned to you",
  conflict: "your PR conflicts with its base",
  resolved: "it needs nobody any more",
  unresolved: "it needs someone again",
  blocked: "another PR blocks yours",
  unblocked: "your PR is unblocked",
};

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
  review_optional: boolean; // its repo needs no review to merge it (pr.review_optional): it merges once CI passes
  merge_method: Item["merge_method"] | null; // the repo's default merge method for you, when the desk knows it
  ci: Ci;
  failing: string[]; // failing check names
  approved_by: string[];
  changes_by: string[]; // changes requested by
  waiting_on: string[]; // reviewers asked and not heard from yet; teams as @slug
  threads_unresolved: number;
  mergeable: Mergeable;
  draft: boolean; // a draft PR
  rebase: boolean; // the desk gave it to the coordinator only to rebase (ready to merge but conflicts); it stays on your Inbox, not in the window's Merging, and leaves once mergeable
  theirs: boolean; // someone else's approved PR you handed off: the coordinator merges it and nothing else
  blocked_by: { ref: string; waits: string } | null; // another PR must merge first: pr.blocker and pr.blocker_waits
  requires_closed: string[]; // PRs it needs that were closed without merging, as repo#number: pr.requires_closed
  waits_on: string | null; // what it waits on, in Merging's words: "waits on CI", "ready to merge"; null once merged or closed
  note: { text: string; at: string } | null; // the coordinator's latest desk_note on it; untrusted, an agent wrote it
}

export interface InflightView {
  rows: InflightRow[]; // open ones first, then those that merged or closed in the last 3 days; a stack's rows together, bottom first
  stacks: Record<string, Stack>; // by id: each stack with a row here (current: its first row)
  coordinator: CoordinatorView;
  work: Work[]; // Claude's work: what's running, then queued, then failed
}

// One piece of work owed, in the desk's ledger (src/jobs.ts): an AI review of a PR, an ask to their agent, or their answer
// to an agent's question, owed to whoever asked until it reads it.
export interface Job {
  kind: "ai_review" | "ask" | "answer";
  key: string; // the PR's id for a review, the ask's id for an ask, the question's id for an answer
  item: string | null; // what it's about
  head: string | null; // the commit a review is of
  state: "queued" | "running" | "done" | "failed";
  attempts: number; // tries started, of JOB_ATTEMPTS
  queued_at: string;
  started_at: string | null; // the latest try's
  finished_at: string | null;
  retry_at: string | null; // a failed try's next one, queued
  error: string | null; // the last try's, in the owner's words
}

export const JOB_ATTEMPTS = 3; // a job's tries before it's failed

// A job in Merging's Claude's work: the PR's title, the ask's words, or the question you answered and who asked it.
export interface Work extends Job {
  title: string;
  from?: string; // an answer's: the session that asked
}

// The session the desk starts and wakes, as claude.ai and `claude agents` name it; the window calls it "your agent".
export const COORDINATOR_NAME = "Inbox coordinator";
// Its name before the rename to Inbox, which its questions from then, and a session that follows the old skill, still give.
const OLD_COORDINATOR_NAME = "Review Desk coordinator";
export const isCoordinator = (from: string): boolean => from === COORDINATOR_NAME || from === OLD_COORDINATOR_NAME;

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
  fix?: boolean; // Make PR with fix on an issue: your agent may open a draft PR with its fix
  answer: { text: string; at: string } | null; // untrusted: an agent wrote it; in paragraphs, drawn by src/prose.ts, never as HTML
}

// Lines of a PR's diff an ask is about, at the commit you read them in: picked with + (or a drag), or the AI note you were on.
export interface AskLines extends InlineAt {
  head: string; // 40 hex
  note?: boolean; // Claude's AI note at these lines (] [), not lines you picked
}

// What an ask is about, in the desk's words: never PR text.
export interface AskAbout {
  url: string;
  whose: "mine" | "theirs" | "issue"; // `me.author` (yours, or a bot's opened for you: onBehalf()), or in Merging
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
  fix: { repo: string; base: string } | null; // Make PR with fix on an open issue: a new branch off base and a draft PR in repo; else null
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
  // read_at: when whoever asked first read your answer (desk_inquiry, or the wake that gives your agent its own); null
  // until then; absent on a dismissal, which owes nothing, and on an answer from before the desk kept it.
  answer: { text: string; at: string; dismissed: boolean; read_at?: string | null } | null;
}

// A note to yourself (New note, ⌘N): on your Inbox until you mark it done. With a reminder it waits until then, then
// notifies once and leads Urgent.
export interface Note {
  id: string;
  at: string; // written
  text: string;
  remind_at: string | null;
  reminded_at: string | null; // when its reminder notified
}

// QueueView.notes, placed by the desk: due reminders lead Urgent, notes without one lead Standard, the rest wait in the Archive.
export interface NotesView {
  due: Note[]; // soonest reminder first
  open: Note[]; // newest first
  later: Note[]; // soonest first
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

// A Claude Code or Codex session on this machine that needs you (the Sessions source): blocked on you, or stalled.
export const SESSION_PREFIX = "session:";
export const isSessionRef = (ref: string): boolean => ref.startsWith(SESSION_PREFIX);
export type SessionKind = "cli" | "background" | "desktop" | "codex";
export const SESSION_KIND: Record<SessionKind, string> = { cli: "CLI", background: "Background", desktop: "Desktop", codex: "Codex" };
// kick: start a background one again; resume: a terminal's whose process is gone, in the background; attach: copy
// `claude attach <id>` for a background one that runs; open: the desktop app's or Codex's own link.
export type SessionAction = "kick" | "resume" | "attach" | "open";
export interface SessionCard {
  id: string; // "session:<its id>": its ref on the desk
  session_id: string; // Claude Code's session id, or Codex's thread id
  kind: SessionKind;
  name: string;
  cwd: string;
  branch: string | null;
  state: "blocked" | "stalled";
  reason: string; // in words: "needs permission: Bash", "asked a question", "rate limited until 14:05", "stopped mid-turn"
  since: string; // when it got there
  excerpt: string; // one line of what it asks or last did; "" when there's none
  resets_at: string | null; // a rate limit's
  alive: boolean; // its process runs
  actions: SessionAction[];
  open_url: string | null; // claude:// or codex://, for open
  attach: string | null; // the command attach copies
  status: "active" | "done" | "snoozed" | "muted";
  snooze_until: string | null;
}

// What an automation may do with an item. add: on your desk, pinned to Today, with its why. today, later, fyi, hide: sorted
// there as Claude's answer would be, until the item changes or you act on it. snooze, done, mute: the desk's own, logged as
// the automation's, so Undo works. Never now: only a rule's own bucket or Claude's answer puts an item first.
export const VERBS = ["add", "today", "later", "fyi", "hide", "snooze", "done", "mute"] as const;
export type Verb = (typeof VERBS)[number];
export const VERB: Record<Verb, string> = {
  add: "add to your desk",
  today: "sort to Today",
  later: "sort to Later",
  fyi: "sort to FYI",
  hide: "hide",
  snooze: "snooze",
  done: "mark done",
  mute: "mute",
};

// How an automation decides what to do with the items its check passed, cheapest first. rule: no model; each gets its fixed
// action (`rule`). ask: one model call without tools says, per item, what to do or leaves it alone. agent: a Claude Code
// run with read-only tools, which may look further.
export const WAYS = ["rule", "ask", "agent"] as const;
export type Way = (typeof WAYS)[number];

// An automation (Settings → Automation Rules): your instruction, run on its schedule or when something happens on an item, by
// your own Claude Code, read only. What a run lists, the desk acts on: only the verbs you allow it (`can`). An agent may
// write or edit one, on as yours is.
export interface Automation {
  id: string; // a slug: "warden-issues"
  name: string;
  schedule: string; // "daily 09:00", "weekdays 09:00,13:00", "mon,thu 17:30", "weekdays hourly": local time; "" for one with events
  events?: ActivityKind[]; // instead of a schedule: it runs when one of these lands on an item, for the items of a sync pass at once
  prompt: string; // the instruction, in your words; "" for a rule, which has none
  when?: string; // its check, in the rules' language (FIELDS): the desk asks it of each item first, and only what passes is handed on
  decide?: "rule" | "ask"; // how it decides (WAYS); absent: agent
  rule?: RuleAction; // with decide rule: its fixed action, for every item its check passes
  can?: Verb[]; // what it may do with an item; absent: add only
  on: boolean;
  by: "you" | "an agent"; // who last changed what it does
  updated_at: string;
  plugin?: string; // one a plugin comes with: its plugin's id ("github"); its definition is the plugin's, you only switch it
  help?: string; // a plugin's: what it does, in one plain line
}

// What a plugin comes with: an automation in its own file, whose id ("<plugin>.<id>"), name and definition are the code's;
// the desk keeps only whether you switched it on or off, and `on` is what it is until you do.
export type BuiltInAutomation = Pick<Automation, "name" | "schedule" | "events" | "prompt" | "when" | "decide" | "rule" | "can"> & {
  id: string; // within its plugin, stable across releases: "pick-reviewer"
  help: string;
  on: boolean;
};

// What came of one item of a run, as its record says it: "Added", "Sorted to FYI", "Snoozed until CI passes", "Couldn't mute".
const DID: Record<Verb, string> = {
  add: "Added",
  today: "Sorted to Today",
  later: "Sorted to Later",
  fyi: "Sorted to FYI",
  hide: "Hidden",
  snooze: "Snoozed",
  done: "Marked done",
  mute: "Muted",
};
export function outcomeText(x: Pick<AutomationItem, "outcome" | "do" | "until">): string {
  const verb = x.do ?? "add";
  const u = x.until ?? "tomorrow";
  const until = isKeyOf(UNTIL, u) ? `until ${UNTIL[u]}` : /^\d+[hd]$/.test(u) ? `for ${u}` : `until ${u}`;
  if (x.outcome === "did") return verb === "snooze" ? `Snoozed ${u === "activity" ? "until new activity" : until}` : DID[verb];
  if (x.outcome === "failed") return verb === "add" ? "Couldn't add" : `Couldn't ${VERB[verb]}`;
  if (x.outcome === "kept" && verb !== "add") return "Already there";
  const said = {
    added: "Added",
    kept: "Already on your desk",
    left: "You'd dealt with it",
    resolved: "Nobody needs it now",
    held: "Held where it is",
    refused: "Not allowed",
  };
  return said[x.outcome];
}

// A rule's action: the verb (one of its `can`), a snooze's `until` (tomorrow when absent) and the why the item shows.
export interface RuleAction {
  do: Verb;
  until?: string;
  why: string;
}

export interface AutomationRun {
  id: string;
  automation: string;
  trigger: "schedule" | "now" | "event";
  at: string;
  done_at: string | null; // null while it runs
  error: string | null;
  summary: string; // the agent's: untrusted
  items: AutomationItem[];
  session: string | null; // the run's Claude Code session: claude --resume <id> shows what it did
  agent?: "codex" | "opencode"; // run on Codex (codex resume <id> shows it) or OpenCode (opencode -s <id>)
}

export interface AutomationItem {
  item_id: string;
  why: string;
  do?: Verb; // what the run said to do with it; absent: add
  until?: string; // a snooze's, as the run said it
  // added: it's on your desk now; did: the desk did `do` (a sort, a snooze, done, mute); kept: it was on your desk already;
  // left: you'd dealt with it (done, snoozed, muted, in Merging), so it stays that way; resolved: nobody needs it now (closed,
  // merged, approved by someone else); held: a review asked of them by name, or its sort is kept but a hard rule, a final rule or your pin holds it where it is
  // (error says which); refused: the automation may not do that (its `can`); failed: the desk couldn't (error says why)
  outcome: "added" | "did" | "kept" | "left" | "resolved" | "held" | "refused" | "failed";
  error?: string;
}

// A criterion (Settings → Automation Rules → Urgency): a yes-or-no about an item that orders the Inbox and never acts on it. `when` is free (the
// rules' language); `ask` is a question a model answers, only of the items whose `when` passes. A yes from an `urgent` one
// puts the item in Urgent whatever its score. An agent's is saved on: it only orders.
export interface Criterion {
  id: string; // a slug: "service-accounts"
  name: string;
  when?: string;
  ask?: string;
  urgent: boolean;
  weight?: number; // points a yes adds to the desk's own score, and how heavily the scorer counts it (1 when unset)
  on: boolean;
  by: "you" | "an agent";
  updated_at: string;
  plugin?: string; // one a plugin comes with: its plugin's id; you only switch it
  help?: string; // a plugin's: what it says yes to, in one plain line
}

// What a plugin comes with: a criterion in its own file, as BuiltInAutomation is.
export type BuiltInCriterion = Pick<Criterion, "name" | "when" | "ask" | "urgent" | "weight"> & { id: string; help: string; on: boolean };

// PUT /api/criteria/:id; undefined is left out, as JSON leaves it.
export type CriterionBody = Pick<Criterion, "name"> & {
  when?: string | undefined;
  ask?: string | undefined;
  urgent?: boolean | undefined;
  on?: boolean | undefined;
};

// GET /api/criteria
export interface CriteriaView {
  criteria: (Criterion & { yes: number; waiting: number })[]; // yes: Inbox items it says yes to now; waiting: its questions not answered yet
  held: { why: string; until: string } | null; // its model can't answer now: questions wait, and the Inbox uses what it has
  scored: { by: string; at: string } | null; // the latest model score: who gave it, when
}

// PUT /api/automations/:id: the whole automation; what's left out (or undefined, as JSON leaves it) is its default.
export type AutomationBody = Pick<Automation, "name"> & {
  events?: ActivityKind[] | undefined;
  when?: string | undefined;
  rule?: { do: Verb; why: string; until?: string | undefined } | undefined;
  can?: Verb[] | undefined;
  schedule?: string | undefined;
  prompt?: string | undefined;
  decide?: Way | undefined;
  on?: boolean | undefined;
};

// GET /api/automations
export interface AutomationView extends Automation {
  // What starts it, in words: its schedule ("Mon and Thu at 17:30"; as written when it can't be read), or its events
  // ("When CI changes or someone comments")
  trigger: string;
  next_at: string | null; // a schedule's, while it's on
  running: boolean;
  // Its question's model can't answer now (not logged in, out of credits, rate limited): why, and when it tries again. Its
  // run isn't spent: the same items are asked about then.
  waiting: { why: string; until: string } | null;
  // Newest first, the last 10. did: what it did, by verb ("put 2 on your desk, sorted 3 to FYI, snoozed 1"); didnt: what it couldn't
  // ("couldn't add 1, refused 2"); each "" when there's nothing to say.
  runs: (AutomationRun & { did: string; didnt: string })[];
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
  hard: { board: string; bucket: Bucket; when: string; why: string; final?: boolean; weight: number }[]; // the loaded config's hard and final rules, for Searches and rules
  builtins: BuiltInBoard[]; // the loaded config's boards that use a plugin's rules, and each of those rules as it stands
}

export interface BuiltInBoard {
  board: string; // its id
  name: string; // its name, with its space's when another board has it
  source: string; // the plugin: "github"
  set: string; // its `builtin`: "review"
  set_name: string; // "PRs to review"
  rules: {
    id: string;
    when: string;
    bucket: Bucket;
    why: string; // in plain words
    hard?: boolean;
    final?: boolean;
    weight: number; // 0 to 10: how much the judge counts it
    on: boolean; // not in the board's `off`
    yours: boolean; // a rule of yours with its id stands in its place
    path?: string; // yours: where it is in config.toml ("boards[1].rules[0]")
  }[];
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

// ---------------------------------------------------------------------------
// A diagram in an AI review: the strict Mermaid subset src/diagram.ts parses, as plain data the window lays out and draws.
// Every string in it is untrusted (the model wrote it) and only ever becomes SVG text.

export type DiagramShape = "box" | "term" | "store" | "choice" | "circle";
export type DiagramMark = "new" | "changed" | "removed";

export interface DiagramNode {
  id: string;
  label: string;
  shape: DiagramShape;
  mark: DiagramMark | null;
  group: string | null; // the subgraph it sits in
}

export interface DiagramEdge {
  from: string;
  to: string;
  label: string; // "" for none
  style: "arrow" | "line" | "dotted"; // -->, ---, -.->
}

export interface DiagramParticipant {
  id: string;
  label: string;
  actor: boolean;
}

export interface DiagramMessage {
  from: string;
  to: string;
  text: string;
  reply: boolean; // -->>
}

export interface DiagramNote {
  over: string[]; // one participant, or the two it spans
  text: string;
  at: number; // drawn before messages[at]
}

export type DiagramGraph =
  | {
      kind: "flow"; // a flowchart, or a state diagram drawn as one
      direction: "LR" | "TB";
      nodes: DiagramNode[];
      edges: DiagramEdge[];
      groups: { id: string; label: string }[];
    }
  | {
      kind: "sequence";
      participants: DiagramParticipant[];
      messages: DiagramMessage[];
      notes: DiagramNote[];
    };
