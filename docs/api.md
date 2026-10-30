# API

The desk server is the one process that owns your queue. The desktop app runs it, or `desk serve` does. While it runs, everything below is on `http://localhost:47823` (`DESK_PORT` changes the port): the web UI, a JSON API, a server-sent events stream, and an MCP endpoint for agents. The CLI, `desk mcp` and the web UI are all clients of it.

Types named here are in [src/types.ts](../src/types.ts), which is the source of truth.

## Connect an agent

Agents reach the queue over MCP. The desk serves it at `/mcp` whenever it runs, so there is nothing else to start.

### Your agent (Settings → Agents)

`agent.driver` picks the agent you work in: `claude-code` (the default), `codex` or `none`. Settings → Agents shows whether it has the desk's MCP tools and the Review Desk skill ([skills/review-desk/SKILL.md](../skills/review-desk/SKILL.md)), and its **Connect** button does what's missing (`POST /api/agents/connect`). From a terminal:

```bash
desk connect                   # what's missing for the agent in settings, and the commands that fix it
desk connect --apply           # does it
desk connect claude|codex      # a specific agent instead
```

Connecting copies the skill (and refreshes a copy that differs from the repo's), then registers the MCP server if it isn't registered yet:

| Agent       | Registered when                                        | Registers with                                                                        | Skill                                   |
| ----------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------- |
| Claude Code | `~/.claude.json` has `mcpServers["review-desk"]`       | `claude mcp add --transport http --scope user review-desk http://localhost:47823/mcp` | `~/.claude/skills/review-desk/SKILL.md` |
| Codex       | `~/.codex/config.toml` has `[mcp_servers.review-desk]` | `codex mcp add review-desk --url http://localhost:47823/mcp`                          | `~/.agents/skills/review-desk/SKILL.md` |

`--scope user` makes Claude Code's entry available in every project. `claude mcp list` then shows `review-desk: http://localhost:47823/mcp (HTTP) - ✔ Connected` while the desk runs, and a failed connection while it doesn't. If you added the older stdio `review-desk` before, it already counts as registered; to switch it to HTTP, run `claude mcp remove review-desk -s user`, then Connect again. Codex reads user skills from `~/.agents/skills` ([Codex skills](https://developers.openai.com/codex/skills)).

### The AI review

The same agent writes each PR's AI review: a verdict, a risk level, a summary, concerns, and short notes anchored to lines of the diff. Claude Code runs as `claude -p --json-schema … --tools "" --restricted --strict-mcp-config` (`analyze.command` and `analyze.model` in Settings → AI review); Codex runs as `codex exec --output-schema … --sandbox read-only --ignore-user-config --ephemeral` with its shell, apps, plugins, browser, computer use and web search switched off (`-c`); both get the prompt on stdin in an empty temporary directory, with the PR text fenced as untrusted. `none` turns the AI review off. Reviews are kept per head commit. With `review.auto_ai` on (the default) the desk writes them in the background for other people's open PRs in Now and Today, two at a time, and for any PR whose review you open; a failure isn't retried on the same commit for 30 minutes unless you ask.

### The policy and the judge

Rules come first: they're cheap and say exactly what they do. What they leave open is the gray zone: items no rule matched (they fall to the board's `default`), and items a rule sends to the bucket `judge`. The policy, `~/.review-desk/policy.md`, is prose you write in Settings → Policy, or by asking the coordinator (below), or in any editor; the desk re-reads it when it changes. It's empty at first, and while it's empty nothing is judged.

With a policy, the judge sends the gray zone to the same agent as the AI review, with the same isolation: `claude -p --json-schema … --tools "" --restricted --strict-mcp-config --no-session-persistence` (or `codex exec` as for the review), the prompt on stdin in an empty temporary directory, the policy and the items fenced with a random tag. Each item gets back a bucket (`now` `today` `later` `fyi` `hide`) and a few words of why, which the queue shows as its why. Then caps apply as usual.

- Up to 20 items per call, one call at a time, never-judged items first, at most `policy.max_per_hour` items an hour (default 60). `policy.judge` (default on) turns it off.
- Answers are kept per item, its `updated_at` and the policy's hash. An item that changed keeps its old answer until the new one lands; a new policy starts over.
- Until an item has an answer, or if the call fails, it sits at the board's default. A failure (a 401 from an expired `claude` login, a timeout) shows in Settings → Policy and pauses the judge for 5, then 10, 20 and 60 minutes; syncs don't retry sooner.
- The rule trace (`desk_item`, `desk show`, the item's detail) ends with the judge's step: `policy: today, <why>`, or `policy: not judged yet, so the board default`.

### The coordinator

A Claude Code session the desk runs for you, wired to the desk's MCP server and nothing else. It keeps the queue clean by your policy, and it's who you talk to when you want the policy or the rules changed. Settings → Agents → Coordinator (`coordinator.enabled`, on by default) shows what it's doing, its session id and the command that opens it in a terminal.

- **Its session.** After the first sync, the desk starts it once: `claude -p --session-id <id> --name "Review Desk coordinator"` in `~/.review-desk/coordinator/`, with a system prompt saying its job, `--mcp-config` holding only the desk's own `http://127.0.0.1:<port>/mcp` (`--strict-mcp-config`), `--tools ""` (no built-in tools), `--allowedTools mcp__review-desk`, `--permission-mode dontAsk` and `--restricted`, using `analyze.command` and `analyze.model` like the AI review. The id is kept in `desk.db`; its first run is told to look at the queue (`desk_overview`), so nothing from before it existed is replayed.
- **Waking.** Nothing runs while nothing happens. Events that can change what needs you (new, review requested, reviewed, commented, mentioned, assigned, reopened, unresolved, CI turning red) start a run 30 s after things go quiet, or 2 minutes after the first one at the latest. A run is `claude -p --resume <id>` with the same flags and the batch on stdin, fenced as untrusted. One run at a time; events that land meanwhile go in the next one. While the policy is empty it doesn't wake on events (its session still starts, so you can talk to it about writing one), and events from before aren't replayed; nor are those from while it was turned off.
- **What it does.** Reads the policy (`desk_policy`), looks at the items (`desk_item`), and acts only where the policy calls for it, with `desk_act` and a `reason`, then says what it did with `desk_note`. When you ask, it rewrites the policy (`desk_policy set`) and the rules (`desk_config`: preview, show you what moves, save only on your yes). It can't post to GitHub or approve: those aren't among its tools.
- **Its log.** Every run, action (with its reason and undo), note and policy or rules change goes in its log (`GET /api/coordinator`). When it acted in the last day, the queue's top bar says so in one quiet line ("Coordinator snoozed 3 FYI items · 4m"); a click opens the log, where each action can be undone.
- **Talking to it.** `cd ~/.review-desk/coordinator && claude --resume <id> --mcp-config mcp.json --strict-mcp-config --tools '' --allowedTools mcp__review-desk` (Settings has it with a Copy button). While you have it open, the desk's runs wait (it checks `claude agents --json`) and pick up the events once you close it.
- **Hygiene.** Each run is stopped after 10 minutes and killed when the desk stops; every run is logged to `desk.log` and its log. A failed run (a 401, a timeout) shows in Settings and waits 5, 10, 20, then 60 minutes before the next try; a failed first run starts over with a fresh id.
- **Why not `claude --bg`.** A background session stays up after its turn, so resuming it with the next batch would start a copy, and the desk couldn't time it out, stop it or read its errors. A `claude -p --resume` turn exits when it's done, so it costs nothing between wakes, and it's the same session you resume in a terminal.
- **Codex** isn't supported as the coordinator yet (Settings says so); the judge and the AI review work with it.

### Claude Code over stdio (fallback)

For a client that only speaks stdio, `desk mcp` serves the same tools on stdin/stdout and calls the HTTP API of the running desk:

```bash
claude mcp add --scope user review-desk -- ~/code/review-desk/bin/desk mcp
```

### Any MCP client

- Streamable HTTP at `http://localhost:47823/mcp`. No auth, no session (stateless: no `Mcp-Session-Id`), `POST` only; `GET` and `DELETE` answer `405` because there is no server-initiated stream and no session to end.
- Or stdio: command `desk mcp` (the absolute path to `bin/desk` if it isn't on PATH; `bin/desk.cmd` on Windows), with `DESK_PORT` set if the desk isn't on 47823.
- The old HTTP+SSE transport (2024-11-05) isn't served; use stdio for clients that only have that.

## MCP tools

The same eleven tools over HTTP and stdio. Results are text; most end with a JSON block for parsing. Errors come back as a tool result with `isError: true` and the API's message, e.g. `no item "nope#1" on the desk`, or `"sentry#1" matches 2 items — candidates: getsentry/sentry#1, other/sentry#1`. Over stdio, a desk that isn't running gives `desk is not running — start it with: desk serve`.

`ref` is `owner/repo#123`, `repo#123` when unique, or a GitHub URL.

| Tool            | Arguments                                                                                                                                                     | Returns                                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desk_overview` | none                                                                                                                                                          | Counts per space and board, Focus totals, sync status and config errors; JSON `Overview`. Read only                                                                                                                                             |
| `desk_list`     | `board?` (board id; omit or `"focus"` for Focus), `buckets?` (`now` `today` `later` `fyi` `hide` `cleared`; default now, today), `limit?` (1–200, default 25) | One line per card (bucket, id, title, why); JSON of the cards (`id bucket title why author url chips status new pinned boards`). Focus only holds now and today. Read only                                                                      |
| `desk_item`     | `ref`                                                                                                                                                         | Facts, bucket and why on each board, the rule trace, the AI review's verdict, summary and concerns if there is one, and the review hand-off prompt; JSON `{ card, placements, state }`. Read only                                               |
| `desk_act`      | `ref`, `action` (`done` `snooze` `mute` `unmute` `pin` `unpin` `restore`), `until?` (snooze only, default `tomorrow`), `reason?` (up to 300 characters)       | What changed and the undo `seq`; JSON `{ ok, state: ItemState, undo_seq }`. Local only. The coordinator's actions go in its log with the reason                                                                                                 |
| `desk_undo`     | `seq?` (positive integer; default the latest action from anyone: UI, CLI or agent)                                                                            | `undid <action> on <id>`                                                                                                                                                                                                                        |
| `desk_brief`    | `ref`                                                                                                                                                         | The PR's AI review: look, skim or skip, risk, summary, concerns and notes on the changes; JSON `AiReview`. Usually written already for PRs in Now and Today; otherwise a model call through `agent.driver` (a minute or two). Cached per commit |
| `desk_sync`     | none                                                                                                                                                          | `sync started`                                                                                                                                                                                                                                  |
| `desk_events`   | `after?` (seq, default 0), `wait?` (seconds, 0–60, default 0), `limit?` (1–500, default 100), `item?` (a ref)                                                 | One line per event (`#seq at item kind by actor data`), oldest first, and `last_seq` to pass as `after` next; JSON `ActivityPage`. With `wait` it returns as soon as one lands. Read only                                                       |
| `desk_policy`   | `action` (`get` `set`), `text?` and `base?` (set: the whole new policy, and the hash from get)                                                                | get: the policy fenced, its hash and the judge's status; JSON `{ hash, judge }`. set: saves it; a stale `base` is an error (get it again and redo the edit)                                                                                     |
| `desk_config`   | `action` (`get` `preview` `save`), `text?` (preview, save: the whole new config.toml), `base?` (save: the hash from get)                                      | get: config.toml fenced, its hash and errors. preview: errors, counts per board before → after, and the items that would move (titles fenced); nothing is saved. save: only valid text, and a stale `base` is an error                          |
| `desk_note`     | `text` (1–500 characters)                                                                                                                                     | `noted`: a line in the coordinator's log, which the owner reads from the queue's top bar                                                                                                                                                        |

`until`: `1h`, `3h`, `2d` (any positive hours or days), `tomorrow` (09:00 local; before 05:00 it means this morning), `monday` (next Monday 09:00), `activity` (until someone else acts), `YYYY-MM-DD` (09:00 that day), or a future ISO time.

## HTTP routes

JSON in and out. Errors are `{ error: string, candidates?: string[] }` with a 4xx or 5xx status: 400 for a bad request, 404 for an unknown board, item or route, 409 for an ambiguous short ref (with `candidates`). Routes marked ✓ answer 503 until the first load finishes; if config.toml has errors from the start, those that read the queue (overview, queue, focus, boards, item, act, review, status) keep answering 503 and `/api/config` works so you can fix it. Errors in a later edit keep the last good config running.

| Method      | Path                      | Request                                                           | Response                                                                                                                                                                                                                     | 503 while starting |
| ----------- | ------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| GET         | `/health`                 |                                                                   | `{ ok: true, version: string }`                                                                                                                                                                                              |                    |
| GET         | `/api/overview`           |                                                                   | `Overview`                                                                                                                                                                                                                   | ✓                  |
| GET         | `/api/queue`              |                                                                   | `QueueView`: every item once, at its best placement (the UI's main surface)                                                                                                                                                  | ✓                  |
| GET         | `/api/focus`              |                                                                   | `FocusView`: the queue's now and today                                                                                                                                                                                       | ✓                  |
| GET         | `/api/boards/:id`         |                                                                   | `BoardView`                                                                                                                                                                                                                  | ✓                  |
| GET         | `/api/item`               | `?id=<ref>` (encode `#` as `%23`)                                 | `ItemDetail`                                                                                                                                                                                                                 | ✓                  |
| POST        | `/api/act`                | `{ id: string, action: Action, until?: string, reason?: string }` | `{ ok: true, state: ItemState, undo_seq: number }` (`seen` and `undo` return `undo_seq: 0`). With `X-Desk-Agent: coordinator` the action and its `reason` go in the coordinator's log                                        | ✓                  |
| POST        | `/api/undo`               | `{ seq?: number }` (default: the latest action)                   | `{ ok: true, id: string, action: Action }`; 409 if a later action on the same item must be undone first                                                                                                                      | ✓                  |
| GET         | `/api/review/:id`         | `:id` is `owner%2Frepo%23123` (or `owner/repo%23123`)             | `ReviewView`: the PR's facts, its changed files, the AI review and whether you can approve; 400 for an issue. Opening it asks for the AI review when `review.auto_ai` is on and there's none for this commit                 | ✓                  |
| POST        | `/api/review/:id/ai`      | `{ force?: boolean }`                                             | `{ ok: true, ai: AiReview }`: the one for this commit unless `force`; joins a run already going; 502 with the reason if the agent fails                                                                                      | ✓                  |
| POST        | `/api/review/:id/approve` | `{ head_oid: string, body?: string }`                             | `{ ok: true, url: string }`: approves the PR on GitHub at `head_oid`, the commit the view showed (below); 409 for your own PR, a closed one, one you approved at this commit, or new commits since; 502 with GitHub's reason | ✓                  |
| POST        | `/api/sync`               |                                                                   | `{ ok: true }` (starts a sync now)                                                                                                                                                                                           |                    |
| GET         | `/api/config`             |                                                                   | `ConfigDoc`: `{ path, text, hash, errors: ConfigError[], warnings?: ConfigError[] }`                                                                                                                                         | ✓                  |
| POST        | `/api/config/preview`     | `{ text: string }`                                                | `PreviewResult`: errors, and per board the new counts and which items would move                                                                                                                                             | ✓                  |
| PUT         | `/api/config`             | `{ text: string, base?: string }`                                 | `{ ok: boolean, errors: ConfigError[], warnings: ConfigError[] }`; saves only if valid; 409 if the file changed since `base` (the text you started from, or its `hash`)                                                      | ✓                  |
| GET         | `/api/policy`             |                                                                   | `PolicyDoc`: `{ path, text, hash, judge: JudgeStatus }`; `text` is `""` until you write one                                                                                                                                  |                    |
| PUT         | `/api/policy`             | `{ text: string, base?: string }`                                 | `{ ok: true, hash: string }`; writes `policy.md`; 409 if it changed since `base` (the `hash` you read); 400 over 20,000 characters                                                                                           |                    |
| GET         | `/api/coordinator`        |                                                                   | `CoordinatorView`: `{ status: CoordinatorStatus, log: CoordinatorLogEntry[] }`, the latest 60 entries, newest first                                                                                                          |                    |
| POST        | `/api/coordinator/note`   | `{ text: string }`                                                | `{ ok: true }`; a line in the coordinator's log (`desk_note`)                                                                                                                                                                |                    |
| GET         | `/api/fields`             |                                                                   | `FieldDoc[]`: every field rules can use                                                                                                                                                                                      |                    |
| GET         | `/api/settings`           |                                                                   | `SettingsView`: schema, effective values, what's overridden, GitHub status                                                                                                                                                   |                    |
| PUT         | `/api/settings`           | `{ set?: Record<string, SettingValue>, reset?: string[] }`        | `{ ok: boolean, errors: ConfigError[], settings: SettingsView }`; writes nothing if any value is invalid                                                                                                                     |                    |
| GET         | `/api/agents`             |                                                                   | `AgentStatus` for `agent.driver`: `{ driver, mcp: { connected, command } \| null, skill: { state: "installed" \| "outdated" \| "missing", path, command } \| null }` (null for `none`)                                       |                    |
| POST        | `/api/agents/connect`     |                                                                   | `AgentStatus` after installing the skill and registering the MCP server; 502 with the command to run yourself if the agent's CLI fails or isn't on PATH                                                                      |                    |
| GET         | `/api/status`             |                                                                   | `{ now: number, today: number, new: number, text: string }`; `text` is e.g. `desk ●2 ◐5 +3`, `""` when 0/0                                                                                                                   | ✓                  |
| GET         | `/api/activity`           | `?after=<seq>&limit=<n>&item=<ref>&wait=<seconds>`                | `ActivityPage`: `{ events, last_seq }`, the event log after `after`, oldest first. A long-poll: with `wait` (up to 60) it answers as soon as an event lands; below                                                           |                    |
| GET         | `/api/events`             |                                                                   | Server-sent events, below                                                                                                                                                                                                    |                    |
| POST        | `/mcp`                    | MCP JSON-RPC (Streamable HTTP)                                    | JSON-RPC responses as an SSE stream; 202 for notifications                                                                                                                                                                   |                    |
| GET, DELETE | `/mcp`                    |                                                                   | 405, `Allow: POST`                                                                                                                                                                                                           |                    |
| GET         | anything else             |                                                                   | The web UI from `web/dist` (unknown paths get `index.html`)                                                                                                                                                                  |                    |

`Action` is `done`, `snooze`, `mute`, `unmute`, `pin`, `unpin`, `restore`, `seen` (marks it looked at; not undoable) or `undo` (undoes the latest action on that item). `until` is as for `desk_act`.

### Main types

```ts
interface Card {
  id: string; // "owner/repo#123"
  kind: "pr" | "issue";
  repo: string;
  number: number;
  title: string; // untrusted GitHub text
  url: string;
  author: string;
  author_bot: boolean;
  bucket: "now" | "today" | "later" | "fyi" | "hide";
  why: string; // the rule's reason, e.g. "vaind asked you directly"
  demoted?: string; // e.g. "Now was full (3)"
  board: string;
  boards: string[]; // every board it's on
  chips: string[]; // short facts: "CI red", "+120 −30", "draft", "conflict", "3 unresolved"
  ci: "green" | "red" | "pending" | "none";
  review: "approved" | "changes_requested" | "required" | "none";
  draft: boolean;
  size: number;
  created_at: string;
  updated_at: string;
  activity_at: string; // latest activity by someone else
  waiting_since: string;
  new: boolean; // activity since you last looked
  pinned: boolean;
  status: "active" | "done" | "snoozed" | "muted";
  snooze_until: string | null;
  verdict: "look" | "skim" | "skip" | null; // from the AI review of the current commit
  resolved: string | null; // why it needs nobody now: "merged", "closed", "approved by alice", "no longer requested"
  resolved_at: string | null; // when it resolved (its last update when GitHub doesn't say); null while it's open
}

interface QueueView {
  sections: { now: Card[]; today: Card[]; later: Card[]; fyi: Card[] };
  hidden: Card[]; // a rule put it in "hide"
  cleared: Card[]; // done, snoozed, muted
  resolved: Card[]; // the world dealt with it (see Resolved, below); newest first
}
// BoardView is the same for one board, plus board: BoardSummary & { queries: string[] }, without resolved items.
// FocusView is { sections: { now: Card[]; today: Card[] } }; resolved items are never in it.

interface Overview {
  me: string;
  synced_at: string | null;
  syncing: boolean;
  sync_error: string | null;
  config_errors: { path: string; message: string }[];
  connectors: { id: string; name: string; status: "ok" | "syncing" | "paused" | "error"; synced_at: string | null; error: string | null }[]; // GitHub today
  spaces: { id: string; name: string; boards: BoardSummary[] }[]; // BoardSummary: id, name, space, counts per bucket + cleared, new, error?
  focus: { now: number; today: number; new: number };
  rate_limit: { remaining: number; reset_at: string } | null;
  coordinator: { state: "off" | "idle" | "waiting" | "running" | "error"; acted: CoordinatorActed | null }; // acted: its latest run with actions in the last day, for the top bar
}

interface Placement {
  board: string;
  bucket: Bucket; // after the judge and caps
  rule_bucket: Bucket; // before caps
  rule: number | null; // the matched rule, null = the board default
  why: string;
  demoted?: string;
  trace: TraceStep[];
  judge?: { bucket: Bucket | null; why: string; pending: boolean }; // in the gray zone while the judge is on; bucket null: the board default
}

interface PolicyDoc {
  path: string;
  text: string;
  hash: string; // pass it back as `base`
  judge: JudgeStatus; // state off | idle | running | error, off_reason, waiting, judged, spent and max_per_hour this hour, last_at, error, retry_at
}

interface CoordinatorStatus {
  state: "off" | "idle" | "waiting" | "running" | "error";
  off_reason: string | null; // e.g. "Coordinator needs Claude Code for now"
  session_id: string;
  started: boolean; // its first run made the session
  dir: string; // ~/.review-desk/coordinator: Claude Code keeps sessions per directory
  command: string | null; // opens it in a terminal; null until it's started
  running_since: string | null;
  pending: number; // events waiting for the next run
  next_at: string | null;
  last_run: {
    n: number;
    kind: "intro" | "events";
    started_at: string;
    ms: number;
    ok: boolean;
    events: number;
    actions: number;
    error: string | null;
  } | null;
  error: string | null; // the last run's failure, until one succeeds
  policy_empty: boolean;
  held: boolean; // you have it open in a terminal, so runs wait
}

interface CoordinatorLogEntry {
  seq: number;
  at: string;
  run: number; // 0: while you talk to it
  kind: "run" | "act" | "note" | "policy" | "config";
  text: string; // an action's reason, a note, what a run did; its own words, so untrusted
  item_id: string | null;
  action: string | null;
  bucket: Bucket | null; // where the item sat when it acted
  undo_seq: number | null;
  undone: boolean;
}

interface ItemDetail {
  card: Card;
  item: Item; // the normalized GitHub item
  signals: Signals; // every field rules can read
  placements: Placement[]; // per board: bucket, rule, why, and the rule trace
  state: ItemState; // done_at, snooze_until, snooze_on_activity, muted, pinned, seen_at
  handoff_prompt: string;
  ai: AiReview | null;
  ai_stale: boolean; // new commits since the AI review
  generating: boolean;
  activity: ActivityEvent[]; // the item's last 8 events, newest first
}

interface ReviewView {
  card: Card;
  item: Item;
  handoff_prompt: string;
  files: { path: string; previous_path: string | null; status: string; additions: number; deletions: number; patch: string | null }[];
  files_error: string | null; // the diff couldn't be fetched
  ai: AiReview | null; // the latest, even if stale
  ai_stale: boolean;
  ai_error: string | null; // the last failed attempt on this commit
  generating: boolean;
  approve: { ok: boolean; reason: string | null }; // reason: why not, e.g. "it's your PR"
}

interface AiReview {
  verdict: "look" | "skim" | "skip";
  risk: "low" | "medium" | "high";
  summary: string;
  concerns: string[];
  notes: { path: string; line: number; side: "new" | "old"; body: string }[]; // line 0: about the whole file
  head_oid: string; // the commit it read
  model: string;
  at: string;
}

interface ActivityEvent {
  seq: number; // increasing; pass the last one you saw as `after`
  at: string; // when it happened if GitHub says (a review, a comment, a merge), else when the desk noticed
  source: string; // the connector: "github"
  item_id: string; // "owner/repo#123"
  kind: ActivityKind; // below
  actor: string; // login, "" if unknown
  data: Record<string, string | boolean>;
}

interface ActivityPage {
  events: ActivityEvent[]; // oldest first
  last_seq: number; // the last event's seq, or the log's latest when there are none: the next call's `after`
}
```

## Resolved

An item is resolved when the world has dealt with it. It's worked out from every snapshot, never stored, so it comes back on its own when the reason stops holding (asked again, reopened). Resolved items leave Now, Today, Later and FYI (and don't count against caps) for `QueueView.resolved`, with the reason as their `why`; done, snooze, mute and pin are kept as they were. The reasons, in order:

- `merged`, `closed`: any item.
- `approved by <login>`: a PR you or your team were asked to review that someone else (not you, not a bot) approved after the ask, while that's still their latest verdict. Not while your own latest review requests changes, nor while GitHub still says more reviews are required (another approval, or a code owner's). `github.resolve_on_others_approval`: `always` (default), `team_only` (only when the ask went to a team), `never`.
- `no longer requested`: you or your team were asked, the ask is gone, and you never reviewed.

Your own PRs and issues only resolve by merging or closing. An item that drops out of every search gets one refresh so the desk learns which it was; if it's resolved it stays on its boards (past their filters) for 3 days, under Resolved.

## Events

`GET /api/events` is a server-sent events stream:

- `event: update` with `data: {"rev": n}`, once on connect and again after any change: a sync landing, a triage action or undo, a config, settings or policy save, an AI review starting or finishing, a judge call or coordinator run starting or finishing, an approval. Refetch what you show.
- `: ping` comment lines every 25 s to keep the connection open.

### The event log

`GET /api/activity` (and the `desk_events` tool) reads the event log: what happened to items on the desk, derived by comparing each fresh snapshot of an item with the last one. Follow it by passing `last_seq` back as `after`; with `wait=60` the request holds until something happens, so a loop of calls is event-driven. `item` narrows it to one item (an exact `owner/repo#123` works after the item has left the desk). Bad numbers are a 400; an unknown short ref is a 404.

| `kind`             | When                                                                    | `actor`             | `data`                                                 |
| ------------------ | ----------------------------------------------------------------------- | ------------------- | ------------------------------------------------------ |
| `new`              | first seen on the desk                                                  | author              | `kind` (`pr`, `issue`)                                 |
| `review_requested` | a review was asked of you or one of your teams (again, if re-requested) | who asked           | `reviewer`, `type` (`user`, `team`), `codeowner`       |
| `request_removed`  | that ask went away, other than by your own review or a merge            |                     | `reviewer`, `type`                                     |
| `reviewed`         | someone else (not a bot) reviewed                                       | reviewer            | `state` (`approved`, `changes_requested`, `commented`) |
| `pushed`           | a new head commit                                                       | the commit's author | `oid`                                                  |
| `ci`               | CI turned green, red or pending (not the "pending" a push starts)       |                     | `from`, `to`                                           |
| `commented`        | someone else (not a bot) commented                                      | commenter           |                                                        |
| `merged`           | merged                                                                  | who merged          |                                                        |
| `closed`           | closed without merging                                                  |                     |                                                        |
| `reopened`         | reopened                                                                |                     |                                                        |
| `mentioned`        | a notification says you or your team were mentioned                     |                     | `reason` (`mention`, `team_mention`)                   |
| `assigned`         | you were assigned                                                       |                     |                                                        |
| `resolved`         | it became resolved                                                      | who resolved it     | `reason`                                               |
| `unresolved`       | it stopped being resolved                                               |                     | `was` (the old reason)                                 |

How GitHub changes reach the log: the notifications API is polled about every 60 s (`If-Modified-Since`, honouring `X-Poll-Interval`; read only, nothing is marked read). A notification about an item on the desk refreshes that item at once; one about an item the desk doesn't have yet, for a review request, mention, team mention, assignment or your own item, starts a full pass early. The full pass (every board's searches, then details for what changed) still runs every `github.poll_seconds`, and a rate limit pauses both.

## Security model

- **This machine only.** The server listens on `127.0.0.1`, never on other interfaces.
- **Host and Origin checks** on every route, `/mcp` included. A request whose `Host` isn't `localhost`, `127.0.0.1` or `[::1]` gets 403, which blocks DNS rebinding. A request with an `Origin` other than the desk's own (`http://localhost:<port>`, `http://127.0.0.1:<port>`, plus the Vite dev server when `DESK_DEV=1`) gets 403, which blocks other websites. MCP clients and the CLI send no `Origin` and are allowed. Responses can't be framed (`X-Frame-Options: DENY`).
- **No auth beyond that.** Any program running as you on this machine can read the queue and triage it, the same as with the CLI. `X-Desk-Agent: coordinator` only files a call's actions under the coordinator in its log; it grants nothing.
- **One write to GitHub, on your keypress.** Approving a PR is the desk's only GitHub write: `POST /api/review/:id/approve`, which the review view's `a a` sends. It goes through `src/github/write.ts`, whose allowlist holds exactly one mutation, `addPullRequestReview(event: APPROVE)`, pinned with `commitOID` to the commit you read (if the desk has seen a newer push, it refuses); that module reads its own token, logs every write, and the desk records it in the action log (undo can't reach it). No MCP tool and no CLI command calls it: agents never approve. Everything else is read only: the GitHub client runs GraphQL queries and refuses any document containing `mutation`, REST GETs for the notifications feed (the client refuses any other method, so it can't mark a thread read), and the review reads a PR's files and description with `gh api` GETs. Done, snooze, mute and pin are local state in `desk.db`.
- **Untrusted text is fenced.** Titles and AI review text come from GitHub, and a hand-off prompt template can include the title. MCP results that carry them (`desk_list`, `desk_item`, `desk_brief`, and `desk_events` for logins and reasons) put them between `<untrusted-data nonce="…">` and `</untrusted-data nonce="…">`, after a line saying to treat them as data, not instructions; the nonce is random per result, so text inside can't fake the closing marker. Titles are flattened to one line with control characters removed. The AI review's prompt fences PR text with a random tag too, the agent runs with no tools, no MCP servers and an empty working directory, and the CLI strips control characters so a title can't emit terminal escapes. The AI review is untrusted output as well: the diff it read came from GitHub. The judge works the same way: no tools, no MCP, an empty directory, the items fenced. The coordinator has the desk's MCP tools and nothing else (`--tools ""`, `--strict-mcp-config`, `--allowedTools mcp__review-desk`), so it can triage locally and edit the policy and rules but can't reach GitHub, a shell or files; its wake messages fence GitHub text, and its own notes and reasons are shown as text, never run.
