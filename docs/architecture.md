# Architecture

One local process owns everything: the desk server. The desktop app (`electron/main.ts`) runs it in-process or from a checkout, or `desk serve` runs it headless. It polls GitHub read-only (its writes are approving a PR when you press `a a` in its review, and sending a reply an agent drafted when you press Send), keeps a SQLite cache and your local triage state, classifies items with rules from a TOML file (and what they leave open by a prose policy your agent judges), runs a coordinator agent session on new events and babysitter agents on your PRs in flight, and serves the web UI and a JSON API on `127.0.0.1:47823`. The desktop window, the CLI (`desk …`) and `desk mcp` are all clients of that API, and it serves MCP for agents at `/mcp`. The full reference for routes, events and MCP tools is [api.md](api.md). If the app finds a desk already running on the port, it attaches to it instead of starting another.

```
GitHub GraphQL + notifications ──(read only)──> src/github/* ──> src/connectors/github.ts
                                                                   │ snapshots, events
                                                                   ▼
                                                     src/store.ts (node:sqlite: items, activity, ...)
gh api (a PR's files) ──────────> src/review.ts ──> claude -p / codex exec (the AI review)
your approve key, Send ──> src/github/write.ts ──(approve, reply, comment: the only API writes)──> GitHub
event log ──> src/babysit.ts ──> claude -p in a worktree of your clone ──(git push to the PR's branch)──> GitHub
                    ▲                 │ desk_draft_reply, desk_escalate (MCP)
                    └─────────────────┘
                                                     │
config.toml ──> src/config.ts ──> src/rules.ts <── src/signals.ts <── src/expr.ts
settings.json ──> src/settings.ts ──┘    ▲           src/resolve.ts (resolved or not)
policy.md ──> src/judge.ts ──────────────┘ Claude's answers, above hard rules' floors (claude -p, no tools)
                                                     │
                                  src/desk.ts (runs the connectors, views, actions, event log, notify)
                                   │                 │ batches of events
                                   │                 ▼
                                   │   src/coordinator.ts ──> claude -p --resume <session> ──MCP (desk_*)──┐
                                   ▼                                                                       │
                                  src/server.ts (Hono: /api/*, /mcp, web/dist, SSE) <──────────────────────┘
                                   │           │            │
                     web/ (in electron/ or a browser)  src/cli.ts   src/mcp.ts
```

Runtime: Node ≥ 22.18 (Electron 45 bundles Node 24), TypeScript run directly, in the packaged app too (type stripping: no enums, namespaces or parameter properties; relative imports end in `.ts`; type-only imports use `import type`). Tests: `node --test` in `test/`. No native modules.

Home: `~/.review-desk/` (override with `DESK_HOME`) holds `config.toml` (spaces, boards, rules), `settings.json` (everything else, only values you changed), `policy.md` (prose for the judge and the coordinator), `desk.db`, `desk.log`, `agent/` (the empty directory the AI review, the judge and login checks run in), `coordinator/` (the coordinator's working directory and its `mcp.json`), `worktrees/` (babysitters' worktrees of your clones) and `babysit/` (their transcripts). Port: `47823` (override `DESK_PORT`).

## Concepts

- **Item**: an open PR or issue from GitHub (`src/types.ts` `Item`), id `owner/repo#123`.
- **Space**: a group of boards with a shared search scope, e.g. `Sentry` = `org:getsentry`, `Personal` = `-org:getsentry`.
- **Board**: a source feeding the queue, not a tab. One or more GitHub searches (the space scope is appended), an optional `filter`, ordered `rules`, a `default` bucket, a `sort`, optional `caps`.
- **Rule**: `{ when, bucket, why, nocap, hard }`. The first rule whose `when` is true places the item. `why` is a template: `{author.login}` interpolates a signal. A placement is Claude's hint; a `hard` rule's bucket is also a floor (Today for Now): nothing sorts what it matches lower.
- **Bucket**: `now`, `today`, `later`, `fyi`, or `hide`. Hidden items are listed under the board with the rule that hid them; nothing disappears silently. A rule may also say `judge`: no bucket of its own, so the board default is Claude's hint.
- **Policy**: `policy.md`, prose the owner writes (Settings → Policy, or by asking the coordinator), which the coordinator also refines from the owner's own actions (learn runs). While it's empty, `DEFAULT_POLICY` (`src/judge.ts`) is in effect. The last 20 versions are kv `policy_history`, for the coordinator log's Undo.
- **Judge** (`src/judge.ts`): every placement goes to your own Claude Code with the policy and the rules' placement as its hint (and a hard rule's floor), 20 at a time, one call at a time, at most `policy.max_per_hour` items an hour, half of it at most for sorting answered items again (never-answered first, then those in Now or Today, by their answer or else their hint, then the latest activity). Like the AI review it runs with no tools, no MCP and the empty `agent/` directory, with the items fenced, on your own Claude Code model and settings. Each item goes with its facts (how you were asked, others' reviews, how much of it is in your areas, the AI's pre-flight call, the description's start). Answers (`{ bucket, why }`) are kept in kv `judge:<id>` per `judgeKey` (what it read of the item that can change, not `updated_at`, so a bot's comment asks nothing) and policy hash; `classify()` takes them as a lookup, so quiet and caps still apply after. Until an item has one, or after a failure (which backs off 5 → 60 minutes, or until `policy.judge` is turned off and on), it sits where the rules put it. The trace ends with the judge's step.
- **Coordinator** (`src/coordinator.ts`): a Claude Code session the desk wakes per debounced batch of events (`claude -p --resume <id>`, one run at a time, 10-minute timeout, killed on stop), with only the desk's MCP tools and your own model and settings. It acts by the policy through `desk_act` with reasons and logs with `desk_note`; on request it edits the policy and the rules. A learn run (at most every 6 hours, after 3 or more of the owner's own actions, undoing the coordinator's included) hands those actions to a fresh session that isn't kept, with only `desk_policy` and `desk_note`, to refine the policy. Who acted is on each action (`events.agent`). Its state (session id, the coordinator directory that session belongs to, event cursor, last run, last learn run, backoff) is kv `coordinator`; a session from another directory (a `desk.db` copied from another desk, or saved before this was kept) is never resumed: the desk starts its own; its log is the `coordinator_log` table. Its MCP config sends `X-Desk-Agent: coordinator`, which attributes actions to it in that log, and refuses its rules saves during any run, its policy saves during an event wake, any mute, and its clearing what a hard rule placed. Why `-p` and not `--bg`: [api.md](api.md#the-coordinator).
- **Caps**: `caps = { now = 3, today = 6 }`, per board; the first-run template gives every board one, since they apply after the judge and a board without caps lets the policy fill Now. Overflow is demoted one bucket (now → today → later), keeping order. Pinned items, items matched by a `nocap` rule, and your PRs in flight that need you (they sit above every board) are exempt and don't count; a `hard` rule's item counts but isn't demoted below its floor.
- **Quiet**: before caps, an item nobody touched (`updated_at`) for `queue.quiet_days` (default 14, 0 = off) leaves the queue (now, today) for Later with `demoted: "quiet for 3 weeks"`. Pinned items and a review asked of you in that time stay, and a hard rule's item goes no lower than its floor; your PRs in flight that need you aren't on the boards' buckets, so they stay too.
- **Queue**: the one surface. Every item once, at its best placement across boards. The UI shows the now and today buckets as one list, now's cards first (their refs highlighted), then "sorted away" (later, FYI, resolved, hidden by rules, cleared), which it keeps off the page until asked (and names only later and resolved). **Focus** is its now + today part (the CLI, MCP and status line use it). Now and today cards carry `preflight` (the AI review of their head, for skimming) or, for your own PR, `next`, its failing checks and a reply to send, and for an issue its latest event; the views carry `cards` (the fold, `queue.cards`) and `paused`.
- **Connector**: a source of items and events (`src/connectors/connector.ts`): a full reconcile pass, a cheap change feed, and a diff of two snapshots of an item into events. GitHub is the only one so far; the desk runs whatever is in `Desk.connectors` and lists them in the overview.
- **Event log**: the `activity` table. Every fresh snapshot is compared with the stored one (`src/connectors/github-events.ts`, pure) and the differences are logged: review requested, reviewed, pushed, CI, commented, merged, resolved, … ([api.md](api.md#the-event-log)).
- **Resolved**: `resolution()` in `src/resolve.ts` says when the world has dealt with an item (merged, closed, you approved, approved by someone else, no longer requested). Derived from each snapshot, never stored; resolved items leave the buckets for the Resolved group ([api.md](api.md#resolved)).
- **Settings**: `SETTINGS` in `src/settings.ts` is the schema (key, type, default, validation, help). The Settings page and `desk settings` render from it. Old configs had these keys in config.toml; they move to settings.json on first start (config.toml.bak keeps the original).
- **Local state** (never sent to GitHub): `done` (hidden until someone else acts), `snooze` (until a time, or until activity), `mute` (until unmuted), `pin`, `seen`, `inflight` (your own PR, done with: the In-flight lane has it).
- **In flight**: your open PRs marked with `d`. They leave the queue's buckets for the In-flight lane and come back to the top of the queue (in now) only when they need you (a question, a reply to send, a problem nobody is fixing, ready to merge). `Desk.inflight()` builds the lane; `Desk.compute()` puts the ones that need you in Now ([api.md](api.md#in-flight)).
- **Stack** (`src/stacks.ts`, pure): PRs in one repo, each based on the head branch of the one below it, worked out from the stored PRs on every snapshot (`Snapshot.stacks`). Cards carry `stack` ("3/20": the open PRs of its line), the queue and focus list a stack once (`oneLinePerStack()`: the lowest PR in its most urgent section), the review view and `QueueView.stacks` carry the chain, Merging keeps a stack's rows together. The connector fetches what the boards don't list ([api.md](api.md#stacks)).
- **Babysitter** (`src/babysit.ts`): for an in-flight PR that needs work (CI red, a conflict, feedback from collaborators: `authorAssociation` OWNER, MEMBER or COLLABORATOR, or a bot in `inflight.trusted_bots`; anyone else's goes to you, never to an agent), one `claude -p` run in a git worktree of your local clone (`--restricted`, plus your own `settings.json` through `--settings`), started from the event log, at most `inflight.max_agents` at once. It may edit, run the repo's tests, commit and push to the PR's own branch; replies are drafts (`desk_draft_reply`) you send, decisions go back to you (`desk_escalate`). Its record per PR (runs, what it tried, drafts, the question) is `sitter:<id>` in `kv`.

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

The one exception is `src/github/write.ts`: an allowlist with exactly three mutations. `addPullRequestReview(event: APPROVE)` pinned to the commit the view showed (`commitOID`), sent only by `POST /api/review/:id/approve` (the review view's `a a`); `addPullRequestReviewThreadReply` and `addComment`, sent only by `POST /api/inflight/:id/send` (Send on a drafted reply, on your own PR, from the desk's window: the lane, or `y` on its card in Now). It reads its own token for each write, never retries, logs the write, and the desk records it in the action log as something undo can't take back. No MCP tool or CLI command reaches it.

A babysitter's prompt also gets `prContext()` (a PR's review threads with their ids, reviews, comments and failing checks, one query) and the tail of a failing GitHub Actions job's log (`gh api repos/:repo/actions/jobs/:id/logs`, a GET). Your own PRs' details also carry the head branch, where it lives and the failing check names.

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
  areas(): Promise<Areas>; // the directories of your PRs and reviews, last 90 days
  // Threads updated since `since`, read or not (all=true); a 304 when If-Modified-Since says nothing changed.
  notifications(opts: { since: string | null; last_modified: string | null }): Promise<NotificationPage>;
  rateLimit(): { remaining: number; reset_at: string } | null; // from the last response
}
export function createGitHub(opts?: { token?: string; fetch?: typeof fetch; log?: (msg: string) => void }): GitHub;
```

Two loops in the connector: the **reconcile** (every board's searches, then details for what changed) on `github.poll_seconds`, and the **feed**, which polls notifications every `X-Poll-Interval` seconds (60 by default). A thread about an item the desk holds refreshes that item at once; one about an item it doesn't hold, for a review request, mention, team mention, assignment or your own item, starts a reconcile early. An item that leaves every search gets one detail refresh, so the desk learns it merged, closed or stopped asking you; a resolved one stays on its boards for 3 days (a `kept` hit, past the board filter) to show under Resolved, as does one that resolved in the last 3 days while a search still lists it (you approved it). After you approve a PR, the connector refreshes that one PR at once (`refresh()`), since the search index lags the approval. After the details, `fillStacks()` fetches what the boards' stacks are missing and stored members gone stale, and stores them without events (the `said` column keeps the snapshot their events were last logged against, until a board lists them); PRs stored before the fields stacks need are refetched 40 a pass ([api.md](api.md#stacks)). A rate limit pauses both loops.

Both fragments also carry the PR's latest base change (`timelineItems(itemTypes: [BASE_REF_CHANGED_EVENT, AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT], last: 1)`, kept as `retargeted`): when the PR below a stacked one merges, GitHub moves it to main with an `AutomaticBaseChangeSucceededEvent` whose `oldBase` is the merged PR's branch, and that's how the merged PR stays below it in the stack. For stacks, `branchPrs(repo, probes)` asks `Repository.pullRequests` by exact branch, one alias a probe, 40 a query: `headRefName` (any state; a fork's PR with the same branch name is dropped) for the PR below, `baseRefName` (open) for those above. Measured on getsentry/sentry (2026-11-02): 4 probes, cost 1.

Both fragments carry `bodyText` (kept as `body`, 600 characters; a bot's PR keeps the last "via …" line of the whole text as `via`, the person an agent like Junior opened it for), `baseRepository.defaultBranchRef` (`default_branch`, for `pr.stacked`) and a PR's `files(first: 50){ nodes { path } }` (`paths`). Measured on 20 review-requested PRs (2026-11-02): cost 2 before and after, 5.5 s → 6.0 s, 39 KB → 124 KB (the full `bodyText`).

Areas (daily, apart from the context; see api.md's "Your areas"): `search` with each PR's `changedFiles files(first: 50){ nodes { path } }`, 50 a page (100 took 9.5 s of GitHub's 10 s limit), up to 500 per query, over `is:pr author:@me created:>=<90d>`, `is:pr author:@me merged:>=<90d> created:<<90d>` and `is:pr reviewed-by:@me -author:@me updated:>=<90d>`. Measured (2026-11-02, ~510 PRs): 12 pages, cost 1 each, 12 points a day, 28 s, the slowest page 7 s; 17 repos, 6 KB in kv.

Context (refreshed daily): your name and teams via `viewer { name organizations.teams(userLogins:[me]) }`; affinity from `is:pr reviewed-by:@me -author:@me updated:>=<90d>` and `is:pr commenter:@me -author:@me updated:>=<90d>` (distinct PRs per author, up to 1000 each); `repo_prs` from `is:pr author:@me created:>=<90d>`, whose 20 latest updated titles are `recent` (the light search carries `title`); `orgs` from `is:open involves:@me` counted by owner.

Errors: retries 502/503/timeouts twice with backoff; on secondary rate limit or `remaining < 200`, it throws `RateLimitedError(resetAt)` and the sync loop waits.

## Store (`src/store.ts`)

`node:sqlite`, WAL. Tables: `items(id PK, node_id, data JSON, updated_at, detail_at, last_hit_at)`, `hits(query, item_id, kept)`, `queries(query PK, fetched_at, total, error)`, `state(id PK, …ItemState, snoozed_at, acked_at)` (`inflight_at` included), `events(seq PK, at, item_id, action, before JSON, undone)` (the undo log of your triage actions), `activity(seq PK, at, source, item_id, kind, actor, data JSON)` (the event log), `kv(key PK, value JSON)` (context, sync status, the notifications cursor, notified set; `review:<id>`, the AI review, and `pr:<id>`, the PR's files and description, each kept for one head commit and dropped with the item; `judge:<id>`, the judge's answer, dropped with the item; `judge_spent`, the last hour's judged items; `coordinator`, its session and cursor; `stack_probes`, when each stack probe was last asked), `coordinator_log(seq PK, at, run, kind, text, item_id, action, bucket, undo_seq)` (the coordinator's runs, actions with reasons, notes; the latest 1000).

Done and snooze record `acked_at`, the latest activity you had seen; the item comes back when someone else acts after that. Timed snoozes also wake early on activity.

## HTTP API (`src/server.ts`)

Full reference: [api.md](api.md). Binds `127.0.0.1`. Rejects requests whose `Host` isn't `localhost`/`127.0.0.1`, whose `Origin` (when present) isn't this server (or the Vite dev server when `DESK_DEV=1`: 5173, 5174 or `DESK_DEV_PORT`; or exactly `DESK_UI_ORIGIN`, the Vite server the desktop app started when it runs from a checkout), and API requests a browser marks `Sec-Fetch-Site: cross-site` or `same-site`; approve and Send take only the desk's own page: `same-origin` with its `Origin`. JSON everywhere; types in `src/types.ts`.

| Method | Path                         | Body / query                                           | Returns                                                                                                                                                      |
| ------ | ---------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/overview`              |                                                        | `Overview`                                                                                                                                                   |
| GET    | `/api/queue`                 |                                                        | `QueueView` (the UI's main surface)                                                                                                                          |
| GET    | `/api/focus`                 |                                                        | `FocusView` (now + today)                                                                                                                                    |
| GET    | `/api/boards/:id`            |                                                        | `BoardView`                                                                                                                                                  |
| GET    | `/api/item`                  | `?id=owner/repo#1` (short `repo#1` resolves if unique) | `ItemDetail`                                                                                                                                                 |
| POST   | `/api/act`                   | `{ id, action: Action, until?, reason? }`              | `{ ok: true, state: ItemState, undo_seq: number }`                                                                                                           |
| POST   | `/api/undo`                  | `{ seq? }` (default: latest)                           | `{ ok: true, id }`                                                                                                                                           |
| GET    | `/api/review/:id`            | `:id` = `owner%2Frepo%23123`                           | `ReviewView`: facts, changed files (kept per commit), the reading order (`reviewOrder()`), the AI review, whether you can approve                            |
| POST   | `/api/review/:id/ai`         | `{ force? }`                                           | `{ ok: true, ai: AiReview }` — the one for this commit unless `force`; otherwise runs your own Claude Code (a minute or two); 502 with the reason on failure |
| POST   | `/api/review/:id/approve`    | `{ head_oid, body? }`                                  | `{ ok: true, url }` — approves `head_oid` on GitHub through `src/github/write.ts`; 409 for your own or a closed PR, or new commits since                     |
| POST   | `/api/sync`                  |                                                        | `{ ok: true }` (starts a sync now)                                                                                                                           |
| GET    | `/api/config`                |                                                        | `{ path, text, errors: ConfigError[] }`                                                                                                                      |
| POST   | `/api/config/preview`        | `{ text }`                                             | `PreviewResult`                                                                                                                                              |
| PUT    | `/api/config`                | `{ text, base? }`                                      | `{ ok, errors }` (saves only if valid, then syncs; 409 if the file changed since `base`, the text or its hash)                                               |
| GET    | `/api/policy`                |                                                        | `PolicyDoc`: `{ path, text, hash, judge }`                                                                                                                   |
| PUT    | `/api/policy`                | `{ text, base? }`                                      | `{ ok, hash }` (writes policy.md; 409 if it changed since `base`, the hash)                                                                                  |
| GET    | `/api/coordinator`           |                                                        | `CoordinatorView`: its status and log                                                                                                                        |
| POST   | `/api/coordinator/note`      | `{ text }`                                             | `{ ok }` (a line in its log)                                                                                                                                 |
| GET    | `/api/fields`                |                                                        | `FieldDoc[]`                                                                                                                                                 |
| GET    | `/api/settings`              |                                                        | `SettingsView`: schema, values, what's overridden, GitHub status                                                                                             |
| PUT    | `/api/settings`              | `{ set?: {key: value}, reset?: [key] }`                | `{ ok, errors, settings }` (writes nothing if any value is invalid)                                                                                          |
| GET    | `/api/agents`                |                                                        | `AgentStatus`: whether Claude Code has the MCP tools and the skill, and the commands                                                                         |
| POST   | `/api/agents/connect`        |                                                        | `AgentStatus` after copying the skill and registering the MCP server (`src/agents.ts`); 502 with the command if the agent's CLI fails                        |
| GET    | `/api/status`                |                                                        | `{ now, today, new, text }` (`text` e.g. `desk 7 ●2 +3`: the queue, urgent, new; `""` when 0/0)                                                              |
| GET    | `/api/inflight`              |                                                        | `InflightView`: your PRs in flight, their status in plain words, the babysitter's state, drafts and question                                                 |
| POST   | `/api/inflight/:id/draft`    | `{ body, thread_id? }`                                 | `{ ok, draft }` — `desk_draft_reply`: a reply waiting in the lane for you to send                                                                            |
| POST   | `/api/inflight/:id/escalate` | `{ question }`                                         | `{ ok, question }` — `desk_escalate`: the PR waits on you in Merging with the question as its why                                                            |
| POST   | `/api/inflight/:id/dismiss`  | `{ draft_id? }`                                        | `{ ok }` — discards a draft, or the question                                                                                                                 |
| POST   | `/api/inflight/:id/send`     | `{ draft_id }`                                         | `{ ok, url }` — posts the draft on GitHub through `src/github/write.ts`; only from the desk's own page                                                       |
| GET    | `/api/activity`              | `?after=&limit=&item=&wait=` (wait ≤ 60 s)             | `{ events, last_seq }`: the event log; a long-poll that answers as soon as an event lands                                                                    |
| GET    | `/api/events`                |                                                        | SSE: `event: update` `data: {"rev": n}` after any change; `: ping` every 25 s                                                                                |
| GET    | `/health`                    |                                                        | `{ ok: true, version }`                                                                                                                                      |
| POST   | `/mcp`                       | MCP JSON-RPC                                           | Streamable HTTP, stateless: the `desk mcp` tools, calling the routes above in-process. GET and DELETE are 405                                                |

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
- `desk_act({ ref, action, until?, reason? })` — local triage: done, snooze, mute, unmute, pin, unpin, restore. Returns an undo `seq`. The coordinator's go in its log with the reason.
- `desk_undo({ seq? })` — undo that action (default: the latest from anyone).
- `desk_brief({ ref })` — the PR's AI review: verdict, risk, summary, concerns, notes (a model call unless it's written already; kept per commit).
- `desk_sync()`.
- `desk_events({ after?, wait?, limit?, item? })` — the event log after `after`; with `wait` it returns when the next event lands.
- `desk_policy({ action: get | set, text?, base? })` — the policy, fenced, with its hash and the judge's status; set saves it (base = that hash).
- `desk_config({ action: get | preview | save, text?, base? })` — config.toml fenced with its hash; preview says what moves; save writes valid text (base = the hash).
- `desk_note({ text })` — a line in the coordinator's log.
- `desk_draft_reply({ ref, thread_id?, body })` — a reply on your own in-flight PR, kept as a draft you send from the lane.
- `desk_escalate({ ref, question })` — hands a decision on your in-flight PR back to you, in Now.

Every tool result marks PR titles and bodies as untrusted data; the policy and config come fenced too. No tool writes to GitHub: agents never approve or post.

## Web UI (`web/`)

Vite + React, built to `web/dist`, served at `/`. Fonts are bundled (`web/src/fonts`), nothing loads from the network. The review view draws diffs with `@pierre/diffs` (Shiki highlighting; each language grammar is its own lazily loaded chunk, which is why `web/dist` is about 12 MB). See `docs/ui.md`.

## Desktop app (`electron/`)

`electron/main.ts` is a thin shell: it fixes PATH for GUI launches, attaches to or starts the desk, opens a window on it, and adds a tray/menu bar count, a global hotkey, notifications and "Open at login". Pure logic is in `electron/lib.ts` (tested in `test/electron.test.ts`); `electron/preload.cjs` exposes `window.desktop` (`DesktopBridge` in `src/types.ts`). Packaging: electron-builder, config in `package.json` → `release/`.

Run from a checkout (`app.source` or `DESK_SOURCE`; `npm run app:dev` uses it on the repo itself): instead of the in-process desk, `electron/source.ts` runs `node --watch --watch-path=src src/cli.ts serve` and Vite (on a free port, `DESK_UI_ORIGIN` for the desk) from that folder as children in their own process groups, logging to `<home>/live.log`. A `src/` change restarts the desk (node --watch sends it SIGTERM and waits; the desk stops its agent processes first, `src/children.ts`); the window keeps its page and reconnects (the Vite proxy ends the page's event stream when the desk goes, so it reopens). A `web/` change is hot reload; an `electron/` change needs a rebuilt app. A desk that exits waits for the next change under `src/` or in `node_modules/.package-lock.json` (`npm install`), and the window says so with its last lines; the app never starts an in-process desk in its place. It runs the first `node` on the login shell's PATH; with none (or not a checkout, or no `node_modules`) the app runs in-process and Settings says why. Vite sends the desk's anti-framing headers too, and logs one proxy error per desk outage. A desk not in the app's process sends its notifications to the app attached with `/api/events?notify=1`. Quitting stops both; every launch, whatever the setting, first stops what a crashed app left (pids in `<home>/live.json`). Changing the setting relaunches the app.
