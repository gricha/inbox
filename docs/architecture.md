# Architecture

One local process owns everything: the desk server. The desktop app (`electron/main.ts`) runs it in-process or from a checkout, or `desk serve` runs it headless. It polls GitHub read-only (its writes are approving a PR and marking your own draft ready for review with the reviewers you picked, each when you click Approve, Ready for review or Ask reviewers, your reply to a conversation or a comment on the PR or an issue, when you click Reply or Comment, and the More menu's close, draft, merge, reopen and request changes, on their buttons in the menu), keeps a SQLite cache and your local triage state, classifies items with rules from a TOML file (and what they leave open by a prose policy your agent judges), keeps your PRs handed off for merge in Merging for the coordinator (a background Claude Code session it starts and wakes) to get merged, and serves the web UI and a JSON API on `127.0.0.1:47823`. The desktop window, the CLI (`desk …`) and `desk mcp` are all clients of that API, and it serves MCP for agents at `/mcp`. The full reference for routes, events and MCP tools is [api.md](api.md). If the app finds a desk already running on the port, it attaches to it instead of starting another.

```
GitHub GraphQL + notifications ──(read only)──> src/github/* ──> src/connectors/github.ts
                                                                   │ snapshots, events
                                                                   ▼
                                                     src/store.ts (node:sqlite: items, activity, ...)
gh api (a PR's files) ──────────> src/review.ts ──> claude -p (the AI review)
your a / w / Reply / . ──> src/github/write.ts ──(approve, reply, ready + reviewers, the More menu's: the only API writes)──> GitHub
                                                     │
config.toml ──> src/config.ts ──> src/rules.ts <── src/signals.ts <── src/expr.ts
settings.json ──> src/settings.ts ──┘    ▲           src/resolve.ts (resolved or not)
policy.md ──> src/judge.ts ──────────────┘ Claude's answers, above hard rules' floors (claude -p, no tools)
                                                     │
                                  src/desk.ts (runs the connectors, views, actions, event log, notify)
                                   ▼
                                  src/server.ts (Hono: /api/*, /mcp, web/dist, SSE) <── the coordinator, your own
                                   │           │            │                          Claude Code session (MCP desk_*)
                     web/ (in electron/ or a browser)  src/cli.ts   src/mcp.ts
```

Runtime: Node ≥ 22.18 (Electron 45 bundles Node 24), TypeScript run directly, in the packaged app too (type stripping: no enums, namespaces or parameter properties; relative imports end in `.ts`; type-only imports use `import type`). Tests: `node --test` in `test/`. No native modules.

Home: `~/.inbox/` (override with `DESK_HOME`) holds `config.toml` (spaces, boards, rules), `settings.json` (everything else, only values you changed), `policy.md` (prose for the judge), `desk.db`, `desk.log` and `agent/` (the empty directory the AI review, the judge and Claude's read of what reviewers said run in). Before the rename to Inbox it was `~/.review-desk/`: the first desk to start without `DESK_HOME` (the CLI's `desk serve`, or the desktop app before it starts one) moves it to `~/.inbox/` with one rename and logs it, leaving `~/.review-desk` as a link to `.inbox` (a junction on Windows) so what still opens the old path (Review Desk.app at login, its checkout's desk, a `desk install` job from before) uses the same home instead of making an empty one; delete the link once nothing does. It doesn't move when `~/.inbox/` is there already (then the old one is left alone, and each start logs that it's still there) or something answers on the port (a desk still running from it, which keeps it until a start finds the port free). A link at `~/.review-desk` to a folder elsewhere (a dotfiles home) is moved as the link, so `~/.inbox` points where it did; a file or a link to nothing stays as it is; `src/home.ts`. Port: `47823` (override `DESK_PORT`).

## Concepts

- **Item**: an open PR or issue from GitHub (`src/types.ts` `Item`, which extends `Head`), id `owner/repo#123`; another source's id starts with its name (`notes:1`), and a bare id is GitHub's.
- **Space**: a group of boards with a shared search scope, e.g. `Sentry` = `org:getsentry`, `Personal` = `-org:getsentry`.
- **Board**: a source feeding the queue, not a tab. Its `source` lists its items (GitHub when it names none; one the desk doesn't run is a config error), for GitHub one or more searches (the space scope is appended); then an optional `filter`, ordered `rules`, a `default` bucket, a `sort`, optional `caps`.
- **Rule**: `{ when, bucket, why, nocap, hard, final }`. The first rule whose `when` is true places the item. `why` is a template: `{author.login}` interpolates a signal. A placement is Claude's hint; a `hard` rule's bucket is also a floor (Today for Now): nothing sorts what it matches lower. A `final` rule's isn't a hint: Claude isn't asked, so what it matches stays in its bucket (a pin's floor still lifts it).
- **Bucket**: `now`, `today`, `blocked`, `later`, `fyi`, or `hide`. Only rules fill `blocked` (Claude never answers it): what can't move until something else happens, another PR merging first (`src/deps.ts`) or reviewers. Hidden items are listed under the board with the rule that hid them; nothing disappears silently. A rule may also say `judge`: no bucket of its own, so the board default is Claude's hint.
- **Policy**: `policy.md`, prose the owner writes (Settings → Agent → Your policy, or by asking an agent with `desk_policy`). While it's empty, `DEFAULT_POLICY` (`src/judge.ts`) is in effect.
- **Judge** (`src/judge.ts`): every placement goes to your own Claude Code with the policy and the rules' placement as its hint (and a hard rule's floor), 20 at a time, one call at a time, at most `policy.max_per_hour` items an hour, half of it at most for sorting answered items again (never-answered first, then those in Now or Today, by their answer or else their hint, then the latest activity). Like the AI review it runs with no tools, no MCP and the empty `agent/` directory, with the items fenced, on your own Claude Code model and settings. Each item goes with its facts (how you were asked, others' reviews, how much of it is in your areas, the AI's pre-flight call, the description's start). Answers (`{ bucket, why }`) are kept in kv `judge:<id>` per `judgeKey` (what it read of the item that can change, not `updated_at`, so a bot's comment asks nothing) and policy hash; `classify()` takes them as a lookup, so quiet and caps still apply after. Until an item has one, or after a failure (which backs off 5 → 60 minutes, or until `policy.judge` is turned off and on), it sits where the rules put it. The trace ends with the judge's step.
- **Coordinator** (`src/coordinator.ts`): a background Claude Code session (`claude --bg`, run by claude's daemon, not the desk) that the desk starts on the first hand-off or ask, keeps running (resumed with no turn if it stopped, looked at every 5 minutes) and wakes with one line per minute's batch of news on PRs in Merging (README → Coordinator; what it does on a wake is the skill's "Coordinator" section): it reads `desk_merging` and `desk_events`, writes `desk_note` and `desk_hand_back`, and pushes and merges with the owner's own `git` and `gh`. An ask from the owner (Ask your agent in the window, `POST /api/ask`) wakes it at once, and it answers with `desk_answer`.
- **Caps**: `caps = { now = 3, today = 6 }`, per board; the first-run template gives every board one, since they apply after the judge and a board without caps lets the policy fill Now. Overflow is demoted one bucket (now → today → later), keeping order. Pinned items and items matched by a `nocap` rule are exempt and don't count; a `hard` rule's item counts but isn't demoted below its floor.
- **Quiet**: before caps, an item nobody touched (`updated_at`) for `queue.quiet_days` (default 14, 0 = off) leaves the queue (now, today) for Later with `demoted: "quiet for 3 weeks"`. Pinned items and a review asked of you in that time stay, and a hard rule's item goes no lower than its floor.
- **Queue**: the one surface. Every item once, at its best placement across boards. The UI shows the now and today buckets as one list, now's cards first (their refs highlighted), then "sorted away" (later, FYI, resolved, hidden by rules, cleared), which it keeps off the page until asked (and names only later and resolved). **Focus** is its now + today part (the CLI, MCP and status line use it). Now and today cards carry `preflight` (the AI review of their head, for skimming); a card's `cta` is its one call to action (Ready for review on your own open draft); the views carry `cards` (the fold, `queue.cards`) and `paused`.
- **Connector**: a source of items and events (`src/connectors/connector.ts`): what it needs before the desk starts and its part of a first config.toml (`init`), a full reconcile pass, a cheap change feed, a diff of two snapshots of an item into events, the refs it reads (`refOf`, `fetchOne`) and what each of its boards lists (`boardIds`, asked of a board's `source`). GitHub is the only one so far; the desk runs whatever is in `Desk.connectors` and lists them in the overview.
- **Event log**: the `activity` table. Every fresh snapshot is compared with the stored one (`src/connectors/github-events.ts`, pure) and the differences are logged: review requested, reviewed, pushed, CI, commented, merged, resolved, … ([api.md](api.md#the-event-log)).
- **Resolved**: `resolution()` in `src/resolve.ts` says when the world has dealt with an item (merged, closed, you approved, approved by someone else, no longer requested). Derived from each snapshot, never stored; resolved items leave the buckets for the Resolved group ([api.md](api.md#resolved)).
- **Settings**: `SETTINGS` in `src/settings.ts` is the schema (key, type, default, validation, help). The Settings page (each setting in its section's part, `more` folded behind its More) and `desk settings` render from it. Old configs had these keys in config.toml; they move to settings.json on first start (config.toml.bak keeps the original).
- **Local state** (never sent to GitHub): `done` (hidden until someone else acts), `snooze` (until a time, until activity, or until something happens on the PR: `snooze_when`, checked by `happened()` in `src/signals.ts` on every snapshot and cleared once it has, so it comes back once), `mute` (until unmuted), `pin`, `seen`, `inflight` (your own PR, done with: Merging has it).
- **Merging** (internally `inflight`): your open PRs handed off for merge. They leave the queue's buckets for Merging, which says what each waits on (`waitsOn()`) and the coordinator's latest note, and come back to the top of the queue only when the coordinator hands them back. `Desk.inflight()` builds it; `Desk.compute()` keeps them off the queue and puts hand-backs on top. A PR's note and hand-back are `sitter:<id>` in `kv` (the prefix the babysitters used, so earlier hand-backs survive) ([api.md](api.md#merging)).
- **Sentry** (`src/sentry.ts`): `desk serve` loads and starts it before the server's modules load (`DESK_SENTRY=0` doesn't; nothing else loads the SDK, and the packaged app ships without it): request spans, its log lines, and `report()` from the catches that would otherwise only log (sync, refresh, notifications, a diff, an AI review, the judge, the coordinator, an automation, a conversation), tagged `what` and the item. A route's 5xx is an issue too, unless it's a refusal the desk chose (a `DeskHttpError`: below 500, or a 503 while starting) or one wrapping what `report()` sent. Request and response bodies, MCP arguments and results, and IPs stay out; log lines carry what they say (an agent's question, a hand-back's reason). Its unhandled-rejection listener is left out, so a rejection still crashes the desk. Loop timers (`detached()`) start a trace of their own, not the request's that re-armed them. On SIGTERM it flushes before exit. The UI starts its own from `Overview.sentry`, with the same release (the checkout's commit). The app's in-process desk doesn't start it.
- **Stack** (`src/stacks.ts`, pure): PRs in one repo, each based on the head branch of the one below it, worked out from the stored PRs on every snapshot (`Snapshot.stacks`). Cards carry `stack` ("3/20": the open PRs of its line), the queue and focus list a stack once (`oneLinePerStack()`: the lowest PR in its most urgent section), the review view and `QueueView.stacks` carry the chain, Merging keeps a stack's rows together. The connector fetches what the boards don't list ([api.md](api.md#stacks)).

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
renderTemplate(tpl: string, s: Signals): string     // "{path}" → value; numbers rounded, lists "a, b and N more"
FIELDS: FieldDoc[]                                     // every signal path, type and doc
```

## GitHub module (`src/github/`)

Read only: only `query` operations, never `mutation`, and REST only through `get()`, which refuses any method but GET. Token from `gh auth token` (or `GITHUB_TOKEN`), held in memory. Fetches `https://api.github.com/graphql` (and `/notifications`) directly. The sync logic that uses it (searches, details, the notifications feed, context) lives in the connector, `src/connectors/github.ts`.

The one exception is `src/github/write.ts`: an allowlist of mutations. `addPullRequestReview(event: APPROVE)` pinned to the commit the view showed (`commitOID`), sent only by `POST /api/review/:id/approve` (the review view's Approve); `addPullRequestReviewThreadReply` and `addComment`, sent only by `POST /api/review/:id/reply` (Reply under one of the PR's conversations), and `addComment` by `POST /api/review/:id/comment` (Comment in a PR's review, or on an open issue opened in place); `markPullRequestReadyForReview` and `requestReviews`, sent only by `POST /api/review/:id/ready` (Ready for review on your own open draft, with the reviewers you picked), and `requestReviews` by `POST /api/review/:id/reviewers` (Ask reviewers on your ready PR nobody's asked to review); and the More menu's (`closePullRequest`, `convertPullRequestToDraft`, `mergePullRequest` pinned with `expectedHeadOid`, `reopenPullRequest`, `addPullRequestReview(event: REQUEST_CHANGES)`, `closeIssue`), sent only by `POST /api/github` and only for what `Desk.actions()` allows the item; all only from the desk's own window. It reads its own token for each write, never retries, logs the write, and the desk records it in the action log as something undo can't take back. No MCP tool or CLI command reaches it.

Your own PRs' details also carry the head branch, where it lives, the failing check names and the repo's merge method.

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

Two loops in the connector: the **reconcile** (every board's searches, then details for what changed) on `github.poll_seconds`, and the **feed**, which polls notifications every `X-Poll-Interval` seconds (60 by default). A thread about an item the desk holds refreshes that item at once; one about an item it doesn't hold, for a review request, mention, team mention, assignment or your own item, starts a reconcile early. An item that leaves every search gets one detail refresh, so the desk learns it merged, closed or stopped asking you; a resolved one stays on its boards for 3 days (a `kept` hit, past the board filter) to show under Resolved, as does one that resolved in the last 3 days while a search still lists it (you approved it). After you approve a PR, the connector refreshes that one PR at once (`refresh()`), since the search index lags the approval. After the details, `fillStacks()` fetches what the boards' stacks are missing and stored members gone stale, keeps the stored PRs the listed ones need merged first (in their own org, at most 20 from each, refreshed every 10 minutes while open, at most 20 a pass) and fetches by number those it doesn't hold, and stores them without events (the `said` column keeps the snapshot their events were last logged against, until a board lists them); PRs stored before the fields stacks and dependencies need (`requires` among them) are refetched 40 a pass ([api.md](api.md#stacks), [Dependencies](api.md#dependencies)). A rate limit pauses both loops.

Both fragments also carry the PR's latest base change (`timelineItems(itemTypes: [BASE_REF_CHANGED_EVENT, AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT], last: 1)`, kept as `retargeted`): when the PR below a stacked one merges, GitHub moves it to main with an `AutomaticBaseChangeSucceededEvent` whose `oldBase` is the merged PR's branch, and that's how the merged PR stays below it in the stack. For stacks, `branchPrs(repo, probes)` asks `Repository.pullRequests` by exact branch, one alias a probe, 40 a query: `headRefName` (any state; a fork's PR with the same branch name is dropped) for the PR below, `baseRefName` (open) for those above. A `pr` probe, for a PR a listed one needs that the desk doesn't hold, asks `issueOrPullRequest(number:)` in the same query, at most 20 a pass; a number that's no PR it can read is kept in kv `dep_misses` and not asked again for a day. Measured on getsentry/sentry (2026-11-02): 4 probes, cost 1.

Both fragments carry `bodyText` (kept as `body`, 600 characters; the PR fragment also asks for the markdown `body`, read into `requires` by `requiresOf()` and not kept; a bot's PR keeps the last "via …" line of the whole text as `via`, the person an agent like Junior opened it for), `baseRepository.defaultBranchRef` (`default_branch`, for `pr.stacked`) and a PR's `files(first: 50){ nodes { path } }` (`paths`). Measured on 20 review-requested PRs (2026-11-02): cost 2 before and after, 5.5 s → 6.0 s, 39 KB → 124 KB (the full `bodyText`).

Areas (daily, apart from the context; see api.md's "Your areas"): `search` with each PR's `changedFiles files(first: 50){ nodes { path } }`, 50 a page (100 took 9.5 s of GitHub's 10 s limit), up to 500 per query, over `is:pr author:@me created:>=<90d>`, `is:pr author:@me merged:>=<90d> created:<<90d>` and `is:pr reviewed-by:@me -author:@me updated:>=<90d>`. Measured (2026-11-02, ~510 PRs): 12 pages, cost 1 each, 12 points a day, 28 s, the slowest page 7 s; 17 repos, 6 KB in kv.

Context (refreshed daily): your name and teams via `viewer { name organizations.teams(userLogins:[me]) }`; affinity from `is:pr reviewed-by:@me -author:@me updated:>=<90d>` and `is:pr commenter:@me -author:@me updated:>=<90d>` (distinct PRs per author, up to 1000 each); `repo_prs` from `is:pr author:@me created:>=<90d>`, whose 20 latest updated titles are `recent` (the light search carries `title`); `orgs` from `is:open involves:@me` counted by owner.

Errors: retries 502/503/504, a request with no answer and GraphQL's own timeout twice with backoff; on a rate limit (a 429, a 403 GitHub calls one, GraphQL's `RATE_LIMITED`) or `remaining < 200`, it fails with `GitHubRateLimited` (its `resetAt`: Retry-After, else the limit's reset, else a minute on) and the sync loop waits.

## Store (`src/store.ts`)

`node:sqlite`, WAL. Tables: `items(id PK, node_id, data JSON, updated_at, detail_at, last_hit_at)`, `hits(query, item_id, kept)`, `queries(query PK, fetched_at, total, error)`, `state(id PK, …ItemState, snoozed_at, acked_at)` (`inflight_at` included), `events(seq PK, at, item_id, action, before JSON, undone)` (the undo log of your triage actions), `activity(seq PK, at, source, item_id, kind, actor, data JSON)` (the event log), `kv(key PK, value JSON)` (context, sync status, the notifications cursor, notified set; `review:<id>`, the AI review, and `pr:<id>`, the PR's files and description, each kept for one head commit and dropped with the item; `judge:<id>`, the judge's answer, dropped with the item; `judge_spent`, the last hour's judged items; `sitter:<id>`, a PR's Merging note and hand-back; `stack_probes`, when each stack probe was last asked; `dep_misses`, the numbers a PR's description names that are no PR it can read, asked again after a day). `jobs(kind, key, item, head, state, attempts, queued_at, started_at, finished_at, retry_at, error)` is the ledger of Claude's work (below). `coordinator_log` is the old desk-run coordinator's log, no longer written.

Done and snooze record `acked_at`, the latest activity you had seen; the item comes back when someone else acts after that. Timed snoozes also wake early on activity.

## Claude's work (`src/jobs.ts`)

What Claude owes you is one ledger in the store, so a desk restart forgets none of it: each AI review of a PR (`ai_review`, keyed by the PR, of one head commit) and each of your asks to your agent (`ask`, keyed by the ask), with its state (queued, running, done, failed), its tries, when the latest started and finished, when it tries again, and the last try's error in your words. What the desk tracked only in memory writes through it (`startAi` begins a review's job and its run ends it, the coordinator begins an ask's job when it hands the ask over and `desk_answer` ends it), and the window reads it, so a review says "Claude is reviewing it" exactly while its job runs and a failed one says why, with Try again, across restarts. A desk starting queues again the reviews it was in the middle of, that try not counted; an ask stays as it was, since your agent, not the desk, has it. A loop on the desk's runner (`Jobs.tick`, every minute, its unref'd timer forking one pass) sees each job through: a review past 15 minutes is stopped and one whose run is gone noted, each a failed try, tried again 2 and then 10 minutes later ahead of new reviews, and after three it's failed with the last try's words (with AI reviews off a failed try is failed at once, and a PR's own retries count once toward the pause after failures in a row). A try the agent's own failure took isn't the PR's (`agentDown` in `src/review.ts`: its login, a usage or rate limit, Claude Code not installed): it pauses the reviews at once, spends none of the job's tries, and the job is owed again when the pause ends, for as long as the agent is down, so a weekly limit that resets in the morning leaves nothing failed; an ask your agent stopped without answering (idle or stopped, with no run in flight and the ask not already waiting to go) goes to it again 5 and 15 minutes after it last went, and is failed 30 minutes after the third; what's owed on a PR that merged, closed or moved to a commit the job isn't of goes, and a done job after a day. Merging lists what's running, queued and failed as Claude's work, there rather than in Settings → Agent because it's live work you delegated, as Merging's PRs are, not something you set. The judge, Claude's read of what reviewers said and automations aren't in it: the judge's and the reads' work is worked out again from the store on every pass, sync and opening, each retrying with its own backoff (the judge's state is in Settings → Agent), and an automation already keeps each run in the store and marks one a restart cut.

## HTTP API (`src/server.ts`)

Full reference: [api.md](api.md). Binds `127.0.0.1`. Rejects requests whose `Host` isn't `localhost`/`127.0.0.1`, whose `Origin` (when present) isn't this server (or the Vite dev server when `DESK_DEV=1`: 5173, 5174 or `DESK_DEV_PORT`; or exactly `DESK_UI_ORIGIN`, the Vite server the desktop app started when it runs from a checkout), and API requests a browser marks `Sec-Fetch-Site: cross-site` or `same-site` (from a checkout, anything but a navigation, so another site can't load the checkout's files; the hot-reload socket takes the same Host and Origin checks); approve, ready, reply and `/api/github` take only the desk's own page: `same-origin` with its `Origin`. JSON everywhere; types in `src/types.ts`.

| Method | Path                         | Body / query                                           | Returns                                                                                                                                                      |
| ------ | ---------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/overview`              |                                                        | `Overview`                                                                                                                                                   |
| GET    | `/api/queue`                 |                                                        | `QueueView` (the UI's main surface)                                                                                                                          |
| GET    | `/api/focus`                 |                                                        | `FocusView` (now + today)                                                                                                                                    |
| GET    | `/api/boards/:id`            |                                                        | `BoardView`                                                                                                                                                  |
| GET    | `/api/item`                  | `?id=owner/repo#1` (short `repo#1` resolves if unique) | `ItemDetail`                                                                                                                                                 |
| POST   | `/api/act`                   | `{ id, action: Action, until? }`                       | `{ ok: true, state: ItemState, undo_seq: number }`                                                                                                           |
| POST   | `/api/undo`                  | `{ seq? }` (default: latest)                           | `{ ok: true, id }`                                                                                                                                           |
| GET    | `/api/review/:id`            | `:id` = `owner%2Frepo%23123`                           | `ReviewView`: facts, changed files (kept per commit), the reading order (`reviewOrder()`), the AI review, whether you can approve                            |
| POST   | `/api/review/:id/ai`         | `{ force? }`                                           | `{ ok: true, ai: AiReview }` — the one for this commit unless `force`; otherwise runs your own Claude Code (a minute or two); 502 with the reason on failure |
| POST   | `/api/review/:id/approve`    | `{ head_oid, body? }`                                  | `{ ok: true, url }` — approves `head_oid` on GitHub through `src/github/write.ts`; 409 for your own or a closed PR, or new commits since                     |
| POST   | `/api/review/:id/ready`      |                                                        | `{ ok: true }` — marks your own open draft ready for review through `src/github/write.ts`; only from the desk's own page                                     |
| POST   | `/api/github`                | `{ id, action, head_oid?, body? }`                     | `{ ok: true, url }` — the More menu's write via `src/github/write.ts`; 409 unless the item allows it; desk's page only                                       |
| POST   | `/api/sync`                  |                                                        | `{ ok: true }` (starts a sync now)                                                                                                                           |
| GET    | `/api/config`                |                                                        | `{ path, text, errors: ConfigError[] }`                                                                                                                      |
| POST   | `/api/config/preview`        | `{ text }`                                             | `PreviewResult`                                                                                                                                              |
| PUT    | `/api/config`                | `{ text, base? }`                                      | `{ ok, errors }` (saves only if valid, then syncs; 409 if the file changed since `base`, the text or its hash)                                               |
| GET    | `/api/policy`                |                                                        | `PolicyDoc`: `{ path, text, hash, judge }`                                                                                                                   |
| PUT    | `/api/policy`                | `{ text, base? }`                                      | `{ ok, hash }` (writes policy.md; 409 if it changed since `base`, the hash)                                                                                  |
| GET    | `/api/fields`                |                                                        | `FieldDoc[]`                                                                                                                                                 |
| GET    | `/api/settings`              |                                                        | `SettingsView`: schema, values, what's overridden, GitHub status                                                                                             |
| PUT    | `/api/settings`              | `{ set?: {key: value}, reset?: [key] }`                | `{ ok, errors, settings }` (writes nothing if any value is invalid)                                                                                          |
| GET    | `/api/agents`                |                                                        | `AgentStatus`: whether Claude Code has the MCP tools and the skill, and the commands                                                                         |
| POST   | `/api/agents/connect`        |                                                        | `AgentStatus` after copying the skill and registering the MCP server (`src/agents.ts`); 502 with the command if the agent's CLI fails                        |
| GET    | `/api/status`                |                                                        | `{ now, today, new, text }` (`text` e.g. `desk 7 +3`: the queue, new; `""` when 0/0)                                                                         |
| GET    | `/api/inflight`              |                                                        | `InflightView`: your PRs in Merging, what each waits on and the coordinator's latest note                                                                    |
| POST   | `/api/coordinator/wake`      |                                                        | Starts the coordinator, or has it look at Merging now (Start it now, Wake it)                                                                                |
| POST   | `/api/ask`                   | `{ text, item_id?, thread_id?, thread_url?, lines? }`  | `{ ok, ask }`: your words to the coordinator (Ask your agent), sent at once with whose it is; only from the desk's own page                                  |
| GET    | `/api/asks`                  |                                                        | `AsksView`: `{ on, asks }`                                                                                                                                   |
| GET    | `/api/asks/:id`              |                                                        | `AskPlace` — `desk_ask`: whose it is, the lines, and the branch a change may go to                                                                           |
| POST   | `/api/asks/:id/answer`       | `{ text }`                                             | `{ ok, ask }` — `desk_answer`: the coordinator's answer, in paragraphs; the first notifies with its first paragraph                                          |
| POST   | `/api/inflight/:id/note`     | `{ text }`                                             | `{ ok, text }` — `desk_note`: the PR's status line in Merging                                                                                                |
| POST   | `/api/inflight/:id/handback` | `{ why }`                                              | `{ ok, reason }` — `desk_hand_back`: the PR leaves Merging for the top of the queue                                                                          |
| GET    | `/api/activity`              | `?after=&limit=&item=&wait=` (wait ≤ 60 s)             | `{ events, last_seq }`: the event log; a long-poll that answers as soon as an event lands                                                                    |
| GET    | `/api/events`                |                                                        | SSE: `event: update` `data: {"rev": n}` after any change; `: ping` every 25 s                                                                                |
| GET    | `/health`                    |                                                        | `{ ok: true, version }`                                                                                                                                      |
| POST   | `/mcp`                       | MCP JSON-RPC                                           | Streamable HTTP, stateless: the `desk mcp` tools, calling the routes above in-process. GET and DELETE are 405                                                |

Errors: `{ error: string }` with 4xx/5xx. Unknown item → 404. Ambiguous short id → 409 with `candidates`.

`until` for snooze: `1h`, `3h`, `2d` (any positive hours or days), `tomorrow` (09:00 local; before 05:00 it means this morning), `monday` (next Monday 09:00), `activity` (until someone else acts), `YYYY-MM-DD` (09:00 local that day), or a future ISO time. Or until it happens (`Until`; `waitable()` says which an item can, as the card's `wake_on`): `ci` (CI passes), `push` (new commits past the head you saw), `approved` (your PR), `ready` (someone's draft out of draft), `conflict` (the merge conflict is fixed); one that doesn't fit is a 409.

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
desk connect [claude|codex] [--apply]   your agent (Settings → Agent): its MCP tools and the skill; --apply connects what's missing
desk install | uninstall           launchd LaunchAgent for the headless server (macOS); the app has "Open at login"
```

`desk install` writes `~/Library/LaunchAgents/dev.inbox.desk.plist`, its job's log in `~/.inbox/desk.log`. Both commands boot out and remove `dev.review-desk.desk`, the label before the rename to Inbox, too; install first waits for the job it booted out to let go of the port and moves `~/.review-desk` to `~/.inbox` (`settleHome()`), since the folder it makes for the log would keep the home from moving. With a desk still running from `~/.review-desk` on the port (Review Desk.app, say), install writes nothing and says to quit that desk and run it again: a plist naming a log in `~/.review-desk` would point into the folder its own desk moves.

## MCP (`src/mcp.ts`)

One set of tools (`@modelcontextprotocol/sdk`), two transports: Streamable HTTP at the server's `/mcp` (a fresh stateless server per request, calling the API in-process through `app.request`), and stdio via `desk mcp` (proxies to the HTTP API through `src/client.ts`). Connecting clients: [api.md](api.md#connect-an-agent). Tools:

- `desk_overview()` — counts per space/board, sync status.
- `desk_list({ board?, buckets?, limit? })` — cards; `board` defaults to focus.
- `desk_item({ ref })` — item facts, why, rule trace, hand-off prompt.
- `desk_act({ ref, action, until? })` — local triage: done, snooze, mute, unmute, pin, unpin, restore. Returns an undo `seq`.
- `desk_undo({ seq? })` — undo that action (default: the latest from anyone).
- `desk_brief({ ref })` — the PR's AI review: verdict, risk, summary, concerns, notes (a model call unless it's written already; kept per commit).
- `desk_sync()`.
- `desk_events({ after?, wait?, limit?, item? })` — the event log after `after`; with `wait` it returns when the next event lands.
- `desk_policy({ action: get | set, text?, base? })` — the policy, fenced, with its hash and the judge's status; set saves it (base = that hash).
- `desk_config({ action: get | preview | save, text?, base? })` — config.toml fenced with its hash; preview says what moves; save writes valid text (base = the hash).
- `desk_merging()` — your PRs in Merging with their state (CI, reviews, threads, mergeable, stacked, merge method) and the last note.
- `desk_note({ ref, text })` — the coordinator's status line on a PR in Merging.
- `desk_hand_back({ ref, why })` — gives a PR in Merging back to you, at the top of the queue with the reason.
- `desk_answer({ ask_id, text })` — the coordinator's answer to your ask from the desk's window, shown in your chat with it.
- `desk_ask({ ask_id })` — where an ask is and where a change may go, the file fenced.

Every tool result marks PR titles and bodies as untrusted data; the policy and config come fenced too. No tool writes to GitHub: agents never approve or mark ready through the desk.

## Web UI (`web/`)

Vite + React, built to `web/dist`, served at `/` (run from a checkout, the desk passes the app's Vite server through there instead: Desktop app, below). Fonts are bundled (`web/src/fonts`), nothing loads from the network. The review view draws diffs with `@pierre/diffs` (Shiki highlighting; each language grammar is its own lazily loaded chunk, which is why `web/dist` is about 12 MB). See `docs/ui.md`.

## Desktop app (`electron/`)

`electron/main.ts` is a thin shell: it fixes PATH for GUI launches, attaches to or starts the desk, opens a window on it, and adds a tray/menu bar count, a global hotkey, notifications and "Open at login". Pure logic is in `electron/lib.ts` (tested in `test/electron.test.ts`); `electron/preload.cjs` exposes `window.desktop` (`DesktopBridge` in `src/types.ts`). Packaging: electron-builder, config in `package.json` → `release/`; the app is Inbox, `dev.inbox.app`. What it keeps for itself, `window.json` and `theme.json`, is in Electron's userData, a folder Electron names for the app (`~/Library/Application Support/Inbox` on macOS, `~/.config/Inbox` on Linux, `%APPDATA%\Inbox` on Windows; `<home>/app` with `DESK_HOME` set). Before the rename it was Review Desk's: Inbox's start copies each of the two it doesn't have yet from that folder (`carryOver` in `electron/lib.ts`), never Chromium's caches. Chromium's own storage stays behind with them, so the two folds the window keeps in its localStorage, the list beside a review (`desk.list`) and the review's sidebar (`desk.review.side`), start open again in the new app, once. Open at login moves with the home (`app.open_at_login` in settings.json), so the new app registers itself on its first start; on Linux it also removes the old `review-desk.desktop` autostart entry, and on macOS and Windows the old app's login item goes when the old app is deleted.

Run from a checkout (`app.source` or `DESK_SOURCE`; `npm run app:dev` uses it on the repo itself): instead of the in-process desk, `electron/source.ts` runs `node --watch --watch-path=src src/cli.ts serve` and Vite (on a free port, `DESK_UI_ORIGIN` for the desk) from that folder as children in their own process groups, logging to `<home>/live.log`. A `src/` change restarts the desk (node --watch sends it SIGTERM and waits; the desk stops its agent processes first, `src/children.ts`); the window keeps its page and reconnects (the Vite proxy ends the page's event stream when the desk goes, so it reopens). A `web/` change is hot reload; an `electron/` change needs a rebuilt app. A desk that exits waits for the next change under `src/` or in `node_modules/.package-lock.json` (`npm install`), and the window says so with its last lines; the app never starts an in-process desk in its place. It runs the first `node` on the login shell's PATH, if it's 22.18 or newer, (`zsh -ilc`, asked again for up to 20 s if the first try takes over 5 s, as the first shell after a boot can), then in the usual dirs and where nvm (its default alias), Volta, mise, asdf and fnm keep it (`fallbackDirs`). Without node or `node_modules`, or with a folder that isn't a checkout, the window says so and the app looks again every 15 s (reading PATH again when node is what's missing; Windows only reads it at launch), starting the desk from the checkout once it can; a changed `app.source` in settings.json restarts the app. Only with no checkout chosen does it run in-process (`deskPlan` in `electron/lib.ts`). Vite sends the desk's anti-framing headers too, and logs one proxy error per desk outage. The window loads the Vite server's own origin; the desk's address passes it through (`fromUi()` and `proxyUpgrades()` in `src/server.ts`, its hot-reload socket included), so `http://localhost:47823` in a browser is always the checkout's current UI on one origin (its localStorage theme kept) and reloads itself after a desk or Vite restart; while Vite is down it answers 503 with a page that tries again every 2 s. A desk not in the app's process sends its notifications to the app attached with `/api/events?notify=1`. Quitting stops both; every launch, whatever the setting, first stops what a crashed app left (pids in `<home>/live.json`). Changing the setting relaunches the app.
