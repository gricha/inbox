# Architecture

One local process owns everything: the desk server. The desktop app (`electron/main.ts`) runs it in-process, or `desk serve` runs it headless. It polls GitHub read-only (its one write is approving a PR when you press `a a` in its review), keeps a SQLite cache and your local triage state, classifies items with rules from a TOML file, and serves the web UI and a JSON API on `127.0.0.1:47823`. The desktop window, the CLI (`desk …`) and `desk mcp` are all clients of that API, and it serves MCP for agents at `/mcp`. The full reference for routes, events and MCP tools is [api.md](api.md). If the app finds a desk already running on the port, it attaches to it instead of starting another.

```
GitHub GraphQL + notifications ──(read only)──> src/github/* ──> src/connectors/github.ts
                                                                   │ snapshots, events
                                                                   ▼
                                                     src/store.ts (node:sqlite: items, activity, ...)
gh api (a PR's files) ──────────> src/review.ts ──> claude -p / codex exec (the AI review)
your approve key ──> src/github/write.ts ──(addPullRequestReview: APPROVE, the only write)──> GitHub
                                                     │
config.toml ──> src/config.ts ──> src/rules.ts <── src/signals.ts <── src/expr.ts
settings.json ──> src/settings.ts ──┘                src/resolve.ts (resolved or not)
                                                     │
                                  src/desk.ts (runs the connectors, views, actions, event log, notify)
                                                     │
                                  src/server.ts (Hono: /api/*, /mcp, web/dist, SSE)
                                   │           │            │
                     web/ (in electron/ or a browser)  src/cli.ts   src/mcp.ts
```

Runtime: Node ≥ 22.18 (Electron 45 bundles Node 24), TypeScript run directly, in the packaged app too (type stripping: no enums, namespaces or parameter properties; relative imports end in `.ts`; type-only imports use `import type`). Tests: `node --test` in `test/`. No native modules.

Home: `~/.review-desk/` (override with `DESK_HOME`) holds `config.toml` (spaces, boards, rules), `settings.json` (everything else, only values you changed), `desk.db`, `desk.log`. Port: `47823` (override `DESK_PORT`).

## Concepts

- **Item**: an open PR or issue from GitHub (`src/types.ts` `Item`), id `owner/repo#123`.
- **Space**: a group of boards with a shared search scope, e.g. `Sentry` = `org:getsentry`, `Personal` = `-org:getsentry`.
- **Board**: a source feeding the queue, not a tab. One or more GitHub searches (the space scope is appended), an optional `filter`, ordered `rules`, a `default` bucket, a `sort`, optional `caps`.
- **Rule**: `{ when, bucket, why, nocap }`. The first rule whose `when` is true places the item. `why` is a template: `{author.login}` interpolates a signal.
- **Bucket**: `now`, `today`, `later`, `fyi`, or `hide`. Hidden items are listed under the board with the rule that hid them; nothing disappears silently.
- **Caps**: `caps = { now = 3, today = 6 }`. Overflow is demoted one bucket (now → today → later), keeping order. Pinned items and items matched by a `nocap` rule are exempt and don't count.
- **Queue**: the one surface. Every item once, at its best placement across boards: Now, Today, then "sorted away" (later, FYI, resolved, hidden by rules, cleared). **Focus** is its Now + Today part (the CLI, MCP and status line use it).
- **Connector**: a source of items and events (`src/connectors/connector.ts`): a full reconcile pass, a cheap change feed, and a diff of two snapshots of an item into events. GitHub is the only one so far; the desk runs whatever is in `Desk.connectors` and lists them in the overview.
- **Event log**: the `activity` table. Every fresh snapshot is compared with the stored one (`src/connectors/github-events.ts`, pure) and the differences are logged: review requested, reviewed, pushed, CI, commented, merged, resolved, … ([api.md](api.md#the-event-log)).
- **Resolved**: `resolution()` in `src/resolve.ts` says when the world has dealt with an item (merged, closed, approved by someone else, no longer requested). Derived from each snapshot, never stored; resolved items leave the buckets for the Resolved group ([api.md](api.md#resolved)).
- **Settings**: `SETTINGS` in `src/settings.ts` is the schema (key, type, default, validation, help). The Settings page and `desk settings` render from it. Old configs had these keys in config.toml; they move to settings.json on first start (config.toml.bak keeps the original).
- **Local state** (never sent to GitHub): `done` (hidden until someone else acts), `snooze` (until a time, or until activity), `mute` (until unmuted), `pin`, `seen`.

## Expression language (`src/expr.ts`)

Used by `when`, `filter`. Safe: no JS eval, no property access outside the known signal fields.

- Literals: numbers, `'single'` or `"double"` strings, `true`, `false`, lists `[a, b]`.
- Names: dotted signal paths, e.g. `me.requested_direct`. Unknown paths are compile errors with a suggestion.
- Operators by precedence (low → high): `||`/`or`; `&&`/`and`; `!`/`not`; comparison `== != < <= > >= in matches`; `+ -`; `* /`; unary `-`; parentheses.
- `a in b`: list membership, or substring when `b` is a string. `s matches "re"`: case-insensitive regex.
- Functions: `len(x)`, `lower(s)`, `contains(s, sub)`, `startswith(s, p)`, `any(list, "glob*")` (glob with `*`).
- Results are truthy-tested for `when`/`filter`.

API:

```ts
compile(src: string): { ok: true; eval(s: Signals): unknown } | { ok: false; error: string }
renderTemplate(tpl: string, s: Signals): string     // "{path}" → value; numbers rounded
FIELDS: FieldDoc[]                                     // every signal path, type and doc
```

## GitHub module (`src/github/`)

Read only: only `query` operations, never `mutation`, and REST only through `get()`, which refuses any method but GET. Token from `gh auth token` (or `GITHUB_TOKEN`), held in memory. Fetches `https://api.github.com/graphql` (and `/notifications`) directly. The sync logic that uses it (searches, details, the notifications feed, context) lives in the connector, `src/connectors/github.ts`.

The one exception is `src/github/write.ts`: an allowlist with exactly one mutation, `addPullRequestReview(event: APPROVE)` pinned to the commit the view showed (`commitOID`), sent only by `POST /api/review/:id/approve` (the review view's `a a`). It reads its own token for each write, never retries, logs the write, and the desk records it in the action log as something undo can't take back. No MCP tool or CLI command reaches it.

Measured on the real queue (2026-10-27): a search with full PR details is too slow (25 PRs = 9 s, 50 = timeout). So sync is two-stage:

1. **Light search** per query: `search(type: ISSUE, first: 100)` returning `id number updatedAt repository{nameWithOwner} author{login}` + typename. ~1 s, cost 1. Paginate up to 300 per query.
2. **Details** via `nodes(ids:)`, batches of 20, 3 concurrent, only for items that are new, whose `updatedAt` changed, or whose details are stale (your PRs: 3 min for CI; others: 30 min). Two fragments:
   - _review_ fragment (everyone's items): no `mergeable`, `reviewThreads(first: 60){ nodes { isResolved } }`. 20 PRs ≈ 2.7 s, cost 2.
   - _mine_ fragment (PRs you authored): adds `mergeable` and each thread's last comment author. Slow, but you have few PRs.

`ReviewRequestedEvent.actor.__typename == "Bot"` identifies bot-added asks (e.g. sentry-junior is a Bot).

```ts
export interface SearchHit {
  node_id: string;
  id: string;
  kind: "pr" | "issue";
  updated_at: string;
  author: string;
}
export interface GitHub {
  viewer(): Promise<string>;
  search(query: string, max?: number): Promise<{ hits: SearchHit[]; total: number }>;
  details(hits: SearchHit[], me: string): Promise<Item[]>; // missing/deleted nodes are skipped
  context(me: string): Promise<Omit<Context, "refreshed_at">>; // teams, 90-day affinity, repo_prs, orgs
  // Threads updated since `since`, read or not (all=true); a 304 when If-Modified-Since says nothing changed.
  notifications(opts: { since: string | null; last_modified: string | null }): Promise<NotificationPage>;
  rateLimit(): { remaining: number; reset_at: string } | null; // from the last response
}
export function createGitHub(opts?: { token?: string; fetch?: typeof fetch; log?: (msg: string) => void }): GitHub;
```

Two loops in the connector: the **reconcile** (every board's searches, then details for what changed) on `github.poll_seconds`, and the **feed**, which polls notifications every `X-Poll-Interval` seconds (60 by default). A thread about an item the desk holds refreshes that item at once; one about an item it doesn't hold, for a review request, mention, team mention, assignment or your own item, starts a reconcile early. An item that leaves every search gets one detail refresh, so the desk learns it merged, closed or stopped asking you; a resolved one stays on its boards for 3 days (a `kept` hit, past the board filter) to show under Resolved. A rate limit pauses both loops.

Context (refreshed daily): teams via `viewer.organizations.teams(userLogins:[me])`; affinity from `is:pr reviewed-by:@me -author:@me updated:>=<90d>` and `is:pr commenter:@me -author:@me updated:>=<90d>` (distinct PRs per author, up to 1000 each); `repo_prs` from `is:pr author:@me created:>=<90d>`; `orgs` from `is:open involves:@me` counted by owner.

Errors: retries 502/503/timeouts twice with backoff; on secondary rate limit or `remaining < 200`, it throws `RateLimitedError(resetAt)` and the sync loop waits.

## Store (`src/store.ts`)

`node:sqlite`, WAL. Tables: `items(id PK, node_id, data JSON, updated_at, detail_at, last_hit_at)`, `hits(query, item_id, kept)`, `queries(query PK, fetched_at, total, error)`, `state(id PK, …ItemState, snoozed_at, acked_at)`, `events(seq PK, at, item_id, action, before JSON, undone)` (the undo log of your triage actions), `activity(seq PK, at, source, item_id, kind, actor, data JSON)` (the event log), `kv(key PK, value JSON)` (context, sync status, the notifications cursor, notified set; `review:<id>`, the AI review, and `pr:<id>`, the PR's files and description, each kept for one head commit and dropped with the item).

Done and snooze record `acked_at`, the latest activity you had seen; the item comes back when someone else acts after that. Timed snoozes also wake early on activity.

## HTTP API (`src/server.ts`)

Full reference: [api.md](api.md). Binds `127.0.0.1`. Rejects requests whose `Host` isn't `localhost`/`127.0.0.1` and whose `Origin` (when present) isn't this server (or the Vite dev server when `DESK_DEV=1`). JSON everywhere; types in `src/types.ts`.

| Method | Path                      | Body / query                                           | Returns                                                                                                                                                             |
| ------ | ------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/overview`           |                                                        | `Overview`                                                                                                                                                          |
| GET    | `/api/queue`              |                                                        | `QueueView` (the UI's main surface)                                                                                                                                 |
| GET    | `/api/focus`              |                                                        | `FocusView` (now + today)                                                                                                                                           |
| GET    | `/api/boards/:id`         |                                                        | `BoardView`                                                                                                                                                         |
| GET    | `/api/item`               | `?id=owner/repo#1` (short `repo#1` resolves if unique) | `ItemDetail`                                                                                                                                                        |
| POST   | `/api/act`                | `{ id, action: Action, until? }`                       | `{ ok: true, state: ItemState, undo_seq: number }`                                                                                                                  |
| POST   | `/api/undo`               | `{ seq? }` (default: latest)                           | `{ ok: true, id }`                                                                                                                                                  |
| GET    | `/api/review/:id`         | `:id` = `owner%2Frepo%23123`                           | `ReviewView`: facts, changed files (kept per commit), the AI review, whether you can approve                                                                        |
| POST   | `/api/review/:id/ai`      | `{ force? }`                                           | `{ ok: true, ai: AiReview }` — the one for this commit unless `force`; otherwise runs the agent in `agent.driver` (a minute or two); 502 with the reason on failure |
| POST   | `/api/review/:id/approve` | `{ head_oid, body? }`                                  | `{ ok: true, url }` — approves `head_oid` on GitHub through `src/github/write.ts`; 409 for your own or a closed PR, or new commits since                            |
| POST   | `/api/sync`               |                                                        | `{ ok: true }` (starts a sync now)                                                                                                                                  |
| GET    | `/api/config`             |                                                        | `{ path, text, errors: ConfigError[] }`                                                                                                                             |
| POST   | `/api/config/preview`     | `{ text }`                                             | `PreviewResult`                                                                                                                                                     |
| PUT    | `/api/config`             | `{ text, base? }`                                      | `{ ok, errors }` (saves only if valid, then syncs; 409 if the file changed since `base`)                                                                            |
| GET    | `/api/fields`             |                                                        | `FieldDoc[]`                                                                                                                                                        |
| GET    | `/api/settings`           |                                                        | `SettingsView`: schema, values, what's overridden, GitHub status                                                                                                    |
| PUT    | `/api/settings`           | `{ set?: {key: value}, reset?: [key] }`                | `{ ok, errors, settings }` (writes nothing if any value is invalid)                                                                                                 |
| GET    | `/api/agents`             |                                                        | `AgentStatus`: whether `agent.driver` has the MCP tools and the skill, and the commands                                                                             |
| POST   | `/api/agents/connect`     |                                                        | `AgentStatus` after copying the skill and registering the MCP server (`src/agents.ts`); 502 with the command if the agent's CLI fails                               |
| GET    | `/api/status`             |                                                        | `{ now, today, new, text }` (`text` e.g. `desk ●2 ◐5 +3`, `""` when 0/0)                                                                                            |
| GET    | `/api/activity`           | `?after=&limit=&item=&wait=` (wait ≤ 60 s)             | `{ events, last_seq }`: the event log; a long-poll that answers as soon as an event lands                                                                           |
| GET    | `/api/events`             |                                                        | SSE: `event: update` `data: {"rev": n}` after any change; `: ping` every 25 s                                                                                       |
| GET    | `/health`                 |                                                        | `{ ok: true, version }`                                                                                                                                             |
| POST   | `/mcp`                    | MCP JSON-RPC                                           | Streamable HTTP, stateless: the `desk mcp` tools, calling the routes above in-process. GET and DELETE are 405                                                       |

Errors: `{ error: string }` with 4xx/5xx. Unknown item → 404. Ambiguous short id → 409 with `candidates`.

`until` for snooze: `1h`, `3h`, `2d` (any positive hours or days), `tomorrow` (09:00 local; before 05:00 it means this morning), `monday` (next Monday 09:00), `activity` (until someone else acts), `YYYY-MM-DD` (09:00 local that day), or a future ISO time.

## CLI (`desk`)

`bin/desk` → `node src/cli.ts`. Talks to the API; if the server isn't running, says `desk is not running — start it with: desk serve`.

```
desk serve [--port N] [--open]     run the server in the foreground (clients use DESK_PORT)
desk open                          open the UI in the browser
desk status [--short]              counts; --short prints the status-line text
desk ls [board|focus] [--all] [--json]   list cards (default: focus); --all adds later, fyi, hidden, cleared
desk show <ref> [--json]           one item: why, facts, rule trace
desk done|mute|unmute|pin|unpin|restore <ref>
desk snooze <ref> [1h|3h|2d|tomorrow|monday|activity|YYYY-MM-DD|ISO]
desk undo [seq]
desk sync
desk prompt <ref>                  print the hand-off prompt (review, your PR, or issue)
desk brief <ref> [--force]         the PR's AI review: look / skim / skip, summary, concerns; kept per commit
desk fields                        the fields rules can use
desk config [path|check|edit]      works with the server down too
desk settings [set <key> <value> | reset <key>]
desk mcp                           MCP server on stdio
desk connect [claude|codex] [--apply]   your agent (Settings → Agents): its MCP tools and the skill; --apply connects what's missing
desk install | uninstall           launchd LaunchAgent for the headless server (macOS); the app has "Open at login"
```

## MCP (`src/mcp.ts`)

One set of tools (`@modelcontextprotocol/sdk`), two transports: Streamable HTTP at the server's `/mcp` (a fresh stateless server per request, calling the API in-process through `app.request`), and stdio via `desk mcp` (proxies to the HTTP API through `src/client.ts`). Connecting clients: [api.md](api.md#connect-an-agent). Tools:

- `desk_overview()` — counts per space/board, sync status.
- `desk_list({ board?, buckets?, limit? })` — cards; `board` defaults to focus.
- `desk_item({ ref })` — item facts, why, rule trace, hand-off prompt.
- `desk_act({ ref, action, until? })` — local triage: done, snooze, mute, unmute, pin, unpin, restore. Returns an undo `seq`.
- `desk_undo({ seq? })` — undo that action (default: the latest from anyone).
- `desk_brief({ ref })` — the PR's AI review: verdict, risk, summary, concerns, notes (a model call unless it's written already; kept per commit).
- `desk_sync()`.
- `desk_events({ after?, wait?, limit?, item? })` — the event log after `after`; with `wait` it returns when the next event lands (for the coordinator).

Every tool result marks PR titles and bodies as untrusted data. No tool writes to GitHub: agents never approve.

## Web UI (`web/`)

Vite + React, built to `web/dist`, served at `/`. Fonts are bundled (`web/src/fonts`), nothing loads from the network. The review view draws diffs with `@pierre/diffs` (Shiki highlighting; each language grammar is its own lazily loaded chunk, which is why `web/dist` is about 12 MB). See `docs/ui.md`.

## Desktop app (`electron/`)

`electron/main.ts` is a thin shell: it fixes PATH for GUI launches, attaches to or starts the desk, opens a window on it, and adds a tray/menu bar count, a global hotkey, notifications and "Open at login". Pure logic is in `electron/lib.ts` (tested in `test/electron.test.ts`); `electron/preload.cjs` exposes `window.desktop` (`DesktopBridge` in `src/types.ts`). Packaging: electron-builder, config in `package.json` → `release/`.
