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

The same eight tools over HTTP and stdio. Results are text; most end with a JSON block for parsing. Errors come back as a tool result with `isError: true` and the API's message, e.g. `no item "nope#1" on the desk`, or `"sentry#1" matches 2 items — candidates: getsentry/sentry#1, other/sentry#1`. Over stdio, a desk that isn't running gives `desk is not running — start it with: desk serve`.

`ref` is `owner/repo#123`, `repo#123` when unique, or a GitHub URL.

| Tool            | Arguments                                                                                                                                                     | Returns                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desk_overview` | none                                                                                                                                                          | Counts per space and board, Focus totals, sync status and config errors; JSON `Overview`. Read only                                                                                       |
| `desk_list`     | `board?` (board id; omit or `"focus"` for Focus), `buckets?` (`now` `today` `later` `fyi` `hide` `cleared`; default now, today), `limit?` (1–200, default 25) | One line per card (bucket, id, title, why); JSON of the cards (`id bucket title why author url chips status new pinned boards`). Focus only holds now and today. Read only                |
| `desk_item`     | `ref`                                                                                                                                                         | Facts, bucket and why on each board, the rule trace, the brief if there is one, and the review hand-off prompt; JSON `{ card, placements, state }`. Read only                             |
| `desk_act`      | `ref`, `action` (`done` `snooze` `mute` `unmute` `pin` `unpin` `restore`), `until?` (snooze only, default `tomorrow`)                                         | What changed and the undo `seq`; JSON `{ ok, state: ItemState, undo_seq }`. Local only                                                                                                    |
| `desk_undo`     | `seq?` (positive integer; default the latest action from anyone: UI, CLI or agent)                                                                            | `undid <action> on <id>`                                                                                                                                                                  |
| `desk_brief`    | `ref`                                                                                                                                                         | Look, skim or skip, risk, summary and reasons; JSON `Brief`. Runs the `claude` CLI on the PR's diff (a model call, 30–90 s); cached per commit                                            |
| `desk_sync`     | none                                                                                                                                                          | `sync started`                                                                                                                                                                            |
| `desk_events`   | `after?` (seq, default 0), `wait?` (seconds, 0–60, default 0), `limit?` (1–500, default 100), `item?` (a ref)                                                 | One line per event (`#seq at item kind by actor data`), oldest first, and `last_seq` to pass as `after` next; JSON `ActivityPage`. With `wait` it returns as soon as one lands. Read only |

`until`: `1h`, `3h`, `2d` (any positive hours or days), `tomorrow` (09:00 local; before 05:00 it means this morning), `monday` (next Monday 09:00), `activity` (until someone else acts), `YYYY-MM-DD` (09:00 that day), or a future ISO time.

## HTTP routes

JSON in and out. Errors are `{ error: string, candidates?: string[] }` with a 4xx or 5xx status: 400 for a bad request, 404 for an unknown board, item or route, 409 for an ambiguous short ref (with `candidates`). Routes marked ✓ answer 503 until the first load finishes; if config.toml has errors from the start, those that read the queue (overview, queue, focus, boards, item, act, analyze, status) keep answering 503 and `/api/config` works so you can fix it. Errors in a later edit keep the last good config running.

| Method      | Path                  | Request                                                    | Response                                                                                                                                                                               | 503 while starting |
| ----------- | --------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| GET         | `/health`             |                                                            | `{ ok: true, version: string }`                                                                                                                                                        |                    |
| GET         | `/api/overview`       |                                                            | `Overview`                                                                                                                                                                             | ✓                  |
| GET         | `/api/queue`          |                                                            | `QueueView`: every item once, at its best placement (the UI's main surface)                                                                                                            | ✓                  |
| GET         | `/api/focus`          |                                                            | `FocusView`: the queue's now and today                                                                                                                                                 | ✓                  |
| GET         | `/api/boards/:id`     |                                                            | `BoardView`                                                                                                                                                                            | ✓                  |
| GET         | `/api/item`           | `?id=<ref>` (encode `#` as `%23`)                          | `ItemDetail`                                                                                                                                                                           | ✓                  |
| POST        | `/api/act`            | `{ id: string, action: Action, until?: string }`           | `{ ok: true, state: ItemState, undo_seq: number }` (`seen` and `undo` return `undo_seq: 0`)                                                                                            | ✓                  |
| POST        | `/api/undo`           | `{ seq?: number }` (default: the latest action)            | `{ ok: true, id: string, action: Action }`; 409 if a later action on the same item must be undone first                                                                                | ✓                  |
| POST        | `/api/analyze`        | `{ id: string, force?: boolean }`                          | `{ ok: true, brief: Brief }`; 400 for an issue, 409 while one runs, 502 with the reason if the `claude` CLI fails                                                                      | ✓                  |
| POST        | `/api/sync`           |                                                            | `{ ok: true }` (starts a sync now)                                                                                                                                                     |                    |
| GET         | `/api/config`         |                                                            | `ConfigDoc`: `{ path, text, errors: ConfigError[], warnings?: ConfigError[] }`                                                                                                         | ✓                  |
| POST        | `/api/config/preview` | `{ text: string }`                                         | `PreviewResult`: errors, and per board the new counts and which items would move                                                                                                       | ✓                  |
| PUT         | `/api/config`         | `{ text: string, base?: string }`                          | `{ ok: boolean, errors: ConfigError[], warnings: ConfigError[] }`; saves only if valid; 409 if the file changed since `base`                                                           | ✓                  |
| GET         | `/api/fields`         |                                                            | `FieldDoc[]`: every field rules can use                                                                                                                                                |                    |
| GET         | `/api/settings`       |                                                            | `SettingsView`: schema, effective values, what's overridden, GitHub status                                                                                                             |                    |
| PUT         | `/api/settings`       | `{ set?: Record<string, SettingValue>, reset?: string[] }` | `{ ok: boolean, errors: ConfigError[], settings: SettingsView }`; writes nothing if any value is invalid                                                                               |                    |
| GET         | `/api/agents`         |                                                            | `AgentStatus` for `agent.driver`: `{ driver, mcp: { connected, command } \| null, skill: { state: "installed" \| "outdated" \| "missing", path, command } \| null }` (null for `none`) |                    |
| POST        | `/api/agents/connect` |                                                            | `AgentStatus` after installing the skill and registering the MCP server; 502 with the command to run yourself if the agent's CLI fails or isn't on PATH                                |                    |
| GET         | `/api/status`         |                                                            | `{ now: number, today: number, new: number, text: string }`; `text` is e.g. `desk ●2 ◐5 +3`, `""` when 0/0                                                                             | ✓                  |
| GET         | `/api/activity`       | `?after=<seq>&limit=<n>&item=<ref>&wait=<seconds>`         | `ActivityPage`: `{ events, last_seq }`, the event log after `after`, oldest first. A long-poll: with `wait` (up to 60) it answers as soon as an event lands; below                     |                    |
| GET         | `/api/events`         |                                                            | Server-sent events, below                                                                                                                                                              |                    |
| POST        | `/mcp`                | MCP JSON-RPC (Streamable HTTP)                             | JSON-RPC responses as an SSE stream; 202 for notifications                                                                                                                             |                    |
| GET, DELETE | `/mcp`                |                                                            | 405, `Allow: POST`                                                                                                                                                                     |                    |
| GET         | anything else         |                                                            | The web UI from `web/dist` (unknown paths get `index.html`)                                                                                                                            |                    |

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
  verdict: "look" | "skim" | "skip" | null; // from a brief
  resolved: string | null; // why it needs nobody now: "merged", "closed", "approved by alice", "no longer requested"
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
}

interface ItemDetail {
  card: Card;
  item: Item; // the normalized GitHub item
  signals: Signals; // every field rules can read
  placements: Placement[]; // per board: bucket, rule, why, and the rule trace
  state: ItemState; // done_at, snooze_until, snooze_on_activity, muted, pinned, seen_at
  handoff_prompt: string;
  brief: Brief | null; // verdict, risk, summary, reasons, model, head_oid, at
  brief_stale: boolean; // new commits since the brief
  analyzing: boolean;
  activity: ActivityEvent[]; // the item's last 8 events, newest first
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
- `approved by <login>`: a PR you or your team were asked to review that someone else (not you, not a bot) approved after the ask, while that's still their latest verdict. Not while your own latest review requests changes. `github.resolve_on_others_approval`: `always` (default), `team_only` (only when the ask went to a team), `never`.
- `no longer requested`: you or your team were asked, the ask is gone, and you never reviewed.

Your own PRs and issues only resolve by merging or closing. An item that drops out of every search gets one refresh so the desk learns which it was; if it's resolved it stays on its boards (past their filters) for 3 days, under Resolved.

## Events

`GET /api/events` is a server-sent events stream:

- `event: update` with `data: {"rev": n}`, once on connect and again after any change: a sync landing, a triage action or undo, a config or settings save, a brief starting or finishing. Refetch what you show.
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
- **No auth beyond that.** Any program running as you on this machine can read the queue and triage it, the same as with the CLI.
- **Read only to GitHub.** The desk only runs GraphQL queries (the client refuses any document containing `mutation`), REST GETs for the notifications feed (the client refuses any other method, so it can't mark a thread read), plus one read-only `gh api` GET for a brief's diff. Done, snooze, mute and pin are local state in `desk.db`; no tool or route writes to GitHub.
- **Untrusted text is fenced.** Titles and brief text come from GitHub, and a hand-off prompt template can include the title. MCP results that carry them (`desk_list`, `desk_item`, `desk_brief`, and `desk_events` for logins and reasons) put them between `<untrusted-data nonce="…">` and `</untrusted-data nonce="…">`, after a line saying to treat them as data, not instructions; the nonce is random per result, so text inside can't fake the closing marker. Titles are flattened to one line with control characters removed. The brief's prompt fences PR text with a random tag too, and the CLI strips control characters so a title can't emit terminal escapes.
