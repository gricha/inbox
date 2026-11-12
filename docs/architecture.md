# Architecture

One local process owns everything: the **desk**. It reads GitHub, keeps a SQLite cache and your triage state, places items with rules, your agent and urgency criteria, and serves the web UI, a JSON API and MCP on `127.0.0.1:47823`.

Everything else is a client of that API: the desktop window, the CLI (`desk …`), `desk mcp`, and agents over `/mcp`.

- [AGENTS.md](../AGENTS.md) is the map: where each kind of change goes.
- [api.md](api.md) is the reference for routes, types, MCP tools and behaviour.
- This file is how the pieces fit.

```
GitHub (GraphQL, notifications) ──read──> src/github/ ──> src/connectors/github.ts ──snapshots, events──> src/store.ts
                                                                                                             │
config.toml, settings.json ──> src/config.ts, src/settings.ts ──> src/rules.ts (+ src/signals.ts, src/expr.ts) │
rule weights ──> src/judge.ts (your agent) ──────────────────────────┘                                       │
criteria ──> src/urgency.ts (Urgent / Standard / FYI) ─────────────────────────────────┐                     │
                                                                                       ▼                     ▼
                                                            src/desk.ts: views, actions, event log, notifications,
                                                            AI reviews, jobs, automations, the coordinator
                                                                                       │
                     your click ──> src/github/write.ts ──> GitHub (the only writes)   │
                                                                                       ▼
                                                   src/server.ts (Hono: /api/*, /mcp, SSE, the web UI)
                                                        │              │              │
                                     web/ (Electron window or browser)  src/cli.ts    src/mcp.ts ── agents, the coordinator
```

## Runtime and home

- **Node** 22.18 or newer runs the TypeScript directly, in the packaged app too (Electron 45 bundles Node 24). Type stripping means no enums, namespaces or parameter properties; relative imports end in `.ts`; type-only imports use `import type`.
- **Tests**: `node --test` in `test/` and `web/test/`. No native modules.
- **Port**: `47823` (`DESK_PORT`).
- **Home**: `~/.inbox/` (`DESK_HOME`). `deskHome()` and `settleHome()` in `src/home.ts`. A desk that finds the old `~/.review-desk/` moves it there once and leaves a link behind.

What the home holds:

| File                    | What                                                                             |
| ----------------------- | -------------------------------------------------------------------------------- |
| `config.toml`           | spaces, boards, rules                                                            |
| `settings.json`         | every other setting, only the ones you changed                                   |
| `secrets.json`          | the decision model's key                                                         |
| `desk.db`               | the store (below)                                                                |
| `desk.log`              | the desk's log                                                                   |
| `labels.jsonl`          | every criterion answer and score the desk takes (api.md → Urgency)               |
| `docs/`                 | review documents, `<id>.json` and `.html` ([review-format.md](review-format.md)) |
| `agent/`                | the empty directory every tool-less agent call runs in                           |
| `live.log`, `live.json` | output and pids of a desk run from a checkout (Desktop app, below)               |

## Concepts

- **Item**: an open PR or issue (`Item` in `src/types.ts`), id `owner/repo#123`. Another source's id starts with its name (`notes:1`).
- **Connector**: a source of items and events (`src/connectors/connector.ts`). It has a full reconcile pass, a cheap change feed, a snapshot diff into events, its refs (`refOf`, `fetchOne`), what each board lists (`boardIds`), and the rules, automations and criteria it comes with. GitHub is the only one.
- **Space**: a group of boards with a shared search scope, e.g. `org:getsentry`.
- **Board**: a source feeding the queue (not a tab). For GitHub, one or more searches. Then an optional `filter`, ordered `rules`, a `default` bucket, a `sort` and optional `caps`.
- **Rule**: `{ when, bucket, why, nocap, hard, final }`. The first whose `when` is true places the item. `why` is a template (`{author.login}`).
  - A rule's placement is a hint to the judge.
  - `hard`: its bucket is also a floor (Today for Now). Nothing sorts the item lower.
  - `final`: the judge isn't asked. The item stays put (a pin's floor can still lift it).
  - `judge`: no bucket of its own; the board default is the hint.
- **Bucket**: `now`, `today`, `blocked`, `later`, `fyi`, `hide`. Only rules fill `blocked` (what waits on another PR merging or on reviewers; facts in `src/deps.ts`). Hidden items stay listed with the rule that hid them.
- **Resolved**: `resolution()` in `src/resolve.ts` says the world dealt with an item (merged, closed, approved, no longer requested). Derived per snapshot, never stored.
- **Local state** (never sent to GitHub): `done` (until someone else acts), `snooze` (until a time, activity, or an event: `snooze_when`, checked by `happened()` in `src/signals.ts`), `mute`, `pin`, `seen`, and `inflight` (handed off to Merging).
- **Merging** (internally `inflight`): your PRs handed off for merge. They leave the queue until the coordinator hands them back to the top. `Desk.inflight()` builds it; `waitsOn()` says what each waits on. Notes and hand-backs are kv `sitter:<id>`.
- **Stack** (`src/stacks.ts`, pure): PRs in one repo, each based on the branch of the one below. Worked out from stored PRs on every snapshot. The queue lists a stack once (`oneLinePerStack()`).
- **Event log**: the `activity` table. Each fresh snapshot is diffed against the stored one (`src/connectors/github-events.ts`, pure) into events: review requested, reviewed, pushed, CI, commented, merged…
- **Settings**: `SETTINGS` in `src/settings.ts` is the schema. The Settings page and `desk settings` render from it.

## How an item is placed

`Desk.compute()` builds one snapshot of everything, then each item goes through:

1. **Rules** (`classify()` in `src/rules.ts`): the board's filter, then the first matching rule, else the board default.
2. **Judge** (`src/judge.ts`): your agent weighs every rule that matches (with its weight), an automation's sort and the criteria's yeses, from the first rule's hint, and answers `{ bucket, why }`. Details below.
3. **Quiet**: an item nobody touched for `queue.quiet_days` (default 14) drops from Now or Today to Later. Pins, recent review requests and hard floors stay.
4. **Caps** (`caps = { now = 3, today = 6 }` per board): overflow drops one bucket, keeping order. Pins and `nocap` rules are exempt. Hard-rule items count but stay at their floor.
5. **Urgency** (`src/urgency.ts`): items in now, today, later or fyi get criteria answers and a score out of 10, then a section: Urgent, Standard or FYI. That's `QueueView.inbox`, what the window draws. Full detail: [api.md → Urgency](api.md#urgency).

Every item appears once, at its best placement across boards. The buckets stay the rules' view (`QueueView.sections`, the rule trace, `desk_list`). **Focus** is now plus today, for the CLI, MCP and the status line.

### The judge

- Batches of 20, one call at a time, at most `policy.max_per_hour` items an hour. Half of that at most goes to re-judging items it already answered.
- Each item goes with its facts: how you were asked, others' reviews, how much is in your areas, the AI review's call, the description's start.
- Answers are kept in kv `judge:<id>`, keyed by what the judge read (not `updated_at`, so a bot's comment doesn't re-ask) and the signals it weighed (`Snapshot.judging`), so a rule's new weight re-asks what it matches.
- Until an item has an answer, or after a failure, it sits where the rules put it. Failures back off 5, 10, 20, then 60 minutes.
- It never answers `blocked`.
- Its instructions are fixed in `buildJudgePrompt()`; the owner's say is rules, weights, automations and criteria.

## Expression language (`src/expr.ts`)

Used by `when`, `filter` and criteria. No JS eval; only known signal fields.

- Literals: numbers, `'single'` or `"double"` strings, `true`, `false`, lists `[a, b]`.
- Names: dotted signal paths, e.g. `me.requested_direct`. Unknown paths fail to compile, with a suggestion.
- Operators, low to high: `||`/`or`; `&&`/`and`; `!`/`not`; `== != < <= > >= in matches`; `+ -`; `* /`; unary `-`.
- `a in b`: list membership, or substring when `b` is a string. `s matches "re"`: case-insensitive regex.
- Functions: `len(x)`, `lower(s)`, `contains(s, sub)`, `startswith(s, p)`, `any(list, "glob*")`.
- `compile()` checks and compiles; `renderTemplate()` fills `why` templates; `FIELDS` in `src/signals.ts` lists every field (`desk fields`).

## GitHub (`src/github/`)

**Reads.** The read client (`src/github/client.ts`) sends only GraphQL `query` operations and REST `GET`s; it refuses any `mutation`. The token comes from `gh auth token` (or `GITHUB_TOKEN`) and stays in memory.

**Writes.** `src/github/write.ts` is the only module that writes. Its `ALLOWED` map is the complete list of mutations:

| Mutation                                           | Sent when you…                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| approve (pinned to the commit you saw)             | press Approve in a review                                                     |
| reply, comment                                     | reply to a conversation, or comment on a PR or issue                          |
| inline comment (pinned to the commit)              | comment on a line of the diff                                                 |
| ready, request reviews                             | press Ready for review on your draft, or Ask reviewers                        |
| merge (pinned with `expectedHeadOid`)              | press Merge on your own ready PR (its row's call to action, or the More menu) |
| close, draft, reopen, request changes, close issue | use the More menu or a row's right-click menu                                 |

Every write comes from a click in the desk's own window, is logged, and is recorded in the action log as something undo can't reverse. `Desk.actions()` decides which More-menu writes an item allows; anything else is a 409. No MCP tool or CLI command reaches `write.ts`. Adding a mutation is a product decision (AGENTS.md → Rules).

### Sync

The connector (`src/connectors/github.ts`) runs two loops:

- **Reconcile**, every `github.poll_seconds`: every board's searches, then details for what changed.
- **Feed**: polls `/notifications` every `X-Poll-Interval` (about 60 s), with `If-Modified-Since`. A thread about a held item refreshes it at once. One about a new item (review request, mention, assignment, your own) starts a reconcile early.

A rate limit pauses both. After you approve, that PR is refreshed at once, since search lags.

Searching with full PR details is too slow (25 PRs took 9 s; 50 timed out). So sync is two-stage:

1. **Light search** per query: ids, `updatedAt`, repo and author. About 1 s, up to 300 per query.
2. **Details** via `nodes(ids:)`, 20 a batch, 3 at once. Only for new items, changed `updatedAt`, or stale details (your PRs after 3 min, for CI; others after 30 min).
   - The _review_ fragment, for everyone's items.
   - The _mine_ fragment, for your PRs: adds `mergeable`, each thread's last commenter, the head branch, failing checks and the repo's merge method.

Other things the connector fetches:

- **Leaving a search**: an item that drops out gets one more detail read, so the desk learns it merged or closed. A resolved item stays on its boards for 3 days (`kept`), under Resolved.
- **Stacks and dependencies** (`fillStacks()`): probes branches with `Repository.pullRequests` to find the PRs below and above, and fetches PRs a listed one needs merged first (`requiresOf()` reads the description). These are stored without events. See [api.md → Stacks](api.md#stacks) and [Dependencies](api.md#dependencies).
- **Retargeting**: both fragments read the latest base change, so a PR GitHub moved to main after the one below merged still shows its stack.
- **Bodies**: `bodyText` (600 characters), the PR's changed paths, and who a bot opened it for (`requesterOf()`, `onBehalf()`: [api.md → Opened for you](api.md#opened-for-you)).
- **Context**, daily: your name, teams, review affinity per author (90 days), your recent PRs, your orgs.
- **Areas**, daily: the directories of your PRs and reviews over 90 days (api.md → Your areas).

**Errors**: 502/503/504, no answer, and GraphQL timeouts are retried twice with backoff. A rate limit (429, GitHub's 403, `RATE_LIMITED`) or under 200 points left fails with `GitHubRateLimited`, and sync waits until its reset.

## Store (`src/store.ts`)

`node:sqlite` in WAL mode, `desk.db`.

| Table             | What                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `items`           | each item's snapshot (`data`), when it was detailed and last listed; `said`, the snapshot its events were last logged against |
| `hits`, `queries` | which search lists which item (`kept`: only to show as resolved), and each search's last fetch                                |
| `state`           | your local state per item, plus `acked_at` (done and snooze come back when someone acts after it)                             |
| `events`          | the undo log of triage actions, and who took each                                                                             |
| `activity`        | the event log                                                                                                                 |
| `jobs`            | Claude's work (below)                                                                                                         |
| `devices`         | paired devices' token hashes ([api.md → Security model](api.md#security-model))                                               |
| `kv`              | everything else                                                                                                               |

Main `kv` keys:

- `review:<id>`: the AI review; `pr:<id>`: the PR's files and description. Each for one head commit.
- `judge:<id>`: the judge's answer; `judge_spent`: the last hour's judged items.
- `said:<id>`, `score:<id>`: urgency answers and scores.
- `sitter:<id>`: a PR's Merging note and hand-back.
- `stack_probes`, `dep_misses`: stack and dependency lookups, and numbers that aren't readable PRs (re-asked after a day).
- Context, sync status, the notifications cursor, the notified set.

`coordinator_log` is no longer written.

## Claude's work (`src/jobs.ts`)

What Claude owes you lives in one ledger, the `jobs` table, so a restart forgets none of it. Merging lists what's running, queued and failed ([ui.md → Merging](ui.md#merging)).

| Job         | Key                              | Starts                    | Ends                                                |
| ----------- | -------------------------------- | ------------------------- | --------------------------------------------------- |
| `ai_review` | the PR, one head commit          | `startAi()`               | its run finishing                                   |
| `ask`       | your ask to your agent           | the coordinator taking it | `desk_answer`                                       |
| `answer`    | an agent's question you answered | `answerInquiry()`         | the asking session reading it (`Desk.answerRead()`) |

Each job has a state (queued, running, done, failed), tries, timestamps, and the last error in your words. `Jobs.tick` runs every minute.

**AI reviews**

- A run past 15 minutes is stopped. A failed try is retried after 2, then 10 minutes, ahead of new reviews. After three it's failed, with Try again.
- With AI reviews off, a failed try fails at once.
- A desk restart re-queues reviews that were running, without counting the try.
- When the agent itself is down (login, usage limit, not installed: `agentDown` in `src/review.ts`), reviews pause and no tries are spent. The job is owed again when the pause ends.

**Asks**

- One your agent stopped without answering is sent again 5 and 15 minutes after it last went, and fails 30 minutes after the third.
- A restart leaves an ask as it was: your agent has it, not the desk.

**Answers**

- Owed from the moment you answer (a dismissal owes nothing).
- Done when the asking session reads it: `desk_inquiry`, or for your own agent, the wake that delivers it. Each stamps `answer.read_at`.
- Nothing pushes an answer to a session that stopped polling. Unread after 30 minutes, it fails with "that session has probably ended" and you're notified once. Only the asking session knows what the question was for, so nothing re-routes it.

**Cleanup**: work on a PR that merged, closed or moved past the job's commit is dropped. Done jobs, and failed answers you were told about, leave after a day.

**Not in the ledger**: the judge and the read of what reviewers said are recomputed from the store on every pass, each with its own backoff. Automations keep their own runs.

## Agents

Every model call is the owner's own agent CLI: `claude`, `codex` or `opencode`, picked in Settings → Agent (`agent.harness`). No `--model`, no API key. The one exception is the optional decision model (OpenRouter), used only when you set its key ([api.md → The decision model](api.md#the-decision-model-openrouter)).

### Tool-less calls

`askAgent()` in `src/review.ts` runs the AI review, the judge, the read of what reviewers said, urgency questions and scores, and automations' questions.

- It runs in the empty `<home>/agent/` directory.
- Claude Code gets `--tools "" --strict-mcp-config --no-session-persistence`. Codex has no "no tools", so everything that can act is off and it runs in a read-only sandbox. OpenCode runs with every permission denied and no MCP server.
- PR text is fenced as untrusted in every prompt.

Prompts, the AI review's checks and the reviewer read: [api.md → Your own agent](api.md#your-own-agent), [The AI review](api.md#the-ai-review).

### Connecting an agent

`src/agents.ts` checks whether your agent has the desk's MCP server and the Inbox skill (`skills/inbox/`), and connects them (`desk connect`, Settings → Agent). One driver per agent registers the MCP server at user scope and copies the skill. See [api.md → Connect an agent](api.md#connect-an-agent).

### The coordinator (`src/coordinator.ts`)

Your agent, run in the background to get PRs in Merging merged and to answer Ask your agent.

- **Claude Code**: one `claude --bg` session, run by Claude's own daemon, so a desk restart leaves it alone. Wakes are `--resume --bg`.
- **Codex**: one `codex exec` session; each wake is a `codex exec resume` turn the desk runs and waits on, one at a time, stopped after an hour.
- **OpenCode**: `opencode run`, then `opencode run --session`, the same way.

The desk starts it on the first hand-off or ask, and checks every 5 minutes that it's still running (no turn). It wakes it with one line per minute's batch of news on PRs in Merging, and at once for an ask.

On a wake it reads `desk_merging` and `desk_events`, writes `desk_note` and `desk_hand_back`, answers asks with `desk_answer`, and pushes and merges with your own `git` and `gh`. What it does is in the skill's "Coordinator" section. Product rules: [vision.md](vision.md), [api.md → The coordinator](api.md#the-coordinator).

### Sessions (`src/connectors/sessions.ts`)

Reads your Claude Code and Codex sessions on this computer and surfaces the ones blocked or stalled on you, with what the window can do about each (Kick, Resume, Attach, Open). Not a connector: it doesn't feed boards. See [api.md → Sessions](api.md#sessions).

## Automations, urgency, decisions

- **Automations** (`src/automations.ts`): schedules and event triggers that push, sort or clear items. GitHub's built-ins are in `src/connectors/github-automations.ts`. [api.md → Automations](api.md#automations).
- **Urgency** (`src/urgency.ts`): criteria, scores, sections. GitHub's built-ins are in `src/connectors/github-criteria.ts`. [api.md → Urgency](api.md#urgency).
- **Decision model** (`src/decisions.ts`): the OpenRouter client both use when its key is set.

## Server (`src/server.ts`)

Hono, JSON everywhere, types in `src/types.ts`. Each route calls a method on `Desk`. Errors are `{ error }` with a 4xx/5xx ([effect.md](effect.md)). Routes: [api.md → HTTP routes](api.md#http-routes).

Who it answers:

- It binds `127.0.0.1` only.
- It rejects a `Host` that isn't `localhost`/`127.0.0.1` (DNS rebinding), a foreign `Origin`, and API requests a browser marks `cross-site` or `same-site`.
- GitHub writes and Ask your agent take only the desk's own page (`same-origin`, with its `Origin`).
- Allowed dev origins: the Vite dev server with `DESK_DEV=1` (5173, 5174 or `DESK_DEV_PORT`), and exactly `DESK_UI_ORIGIN` when the app runs from a checkout.
- From other devices, only through `tailscale serve`, with a paired device's token (`src/remote.ts`; [api.md → Security model](api.md#security-model)).

`GET /api/events` is SSE: `update` with a revision after any change, so clients refetch.

## MCP (`src/mcp.ts`)

One set of tools (`@modelcontextprotocol/sdk`), two transports:

- **HTTP** at `/mcp`: a fresh stateless server per request, calling the routes in-process.
- **stdio** via `desk mcp`: proxies to the HTTP API through `src/client.ts`.

Tool results mark PR titles and bodies as untrusted; the config comes fenced. No tool writes to GitHub. Tool list: [api.md → MCP tools](api.md#mcp-tools).

## CLI (`src/cli.ts`)

`bin/desk` runs `node src/cli.ts`. Most commands talk to the running desk (`render` and `config` work without one); with none running they say `desk is not running — start it with: desk serve`. `desk help` prints the full usage.

```
desk serve [--port N] [--open] [--tailscale]   run the desk in the foreground
desk open | status [--short] | sync
desk ls [board|focus] [--all] [--json]          list cards (default: focus)
desk show <ref> [--json]                        one item: why, facts, rule trace
desk add <ref> [why]                            put a PR or issue on your desk
desk done|mute|unmute|pin|unpin|restore <ref>
desk snooze <ref> [until] | undo [seq]
desk prompt <ref> | brief <ref> [--force]       hand-off prompt; the PR's AI review
desk render <doc.json> [-o out.html]            a review document as HTML, no desk needed
desk config [path|check|edit] | settings [set|reset] | fields
desk mcp [--url <address>]                      MCP on stdio
desk connect [claude|codex|opencode] [--apply]  connect your agent
desk connect <address> --code <code> | pair      use a desk on another machine
desk install | uninstall                        launchd job for the headless desk (macOS)
```

A ref is `owner/repo#123`, `repo#123` when unique, a GitHub URL, or an `inbox://item/…` link. Snooze takes a duration (`1h`, `2d`), `tomorrow`, `monday`, `activity`, a date or ISO time, or an event: `ci`, `push`, `approved`, `ready`, `conflict`.

`desk install` writes `~/Library/LaunchAgents/dev.inbox.desk.plist`, logging to `~/.inbox/desk.log`. It also removes the old `dev.review-desk.desk` job and settles the home first (`settleHome()`).

## Sentry (`src/sentry.ts`)

- `desk serve` starts it before the server's modules load. `DESK_SENTRY=0` turns it off. The packaged app doesn't ship the SDK, and the app's in-process desk doesn't start it.
- It sends request spans, log lines, 5xx responses, and `report()` from catches that would otherwise only log (sync, the judge, AI reviews, the coordinator, automations…), tagged with `what` and the item.
- A refusal the desk chose (a `DeskHttpError` under 500, or a 503 while starting) isn't an issue.
- Bodies, MCP arguments and results, and IPs stay out. Log lines carry what they say (an agent's question, a hand-back's reason).
- Unhandled rejections still crash the desk. It flushes on SIGTERM.
- The UI starts its own from `Overview.sentry`, with the same release.

## Web UI (`web/`)

Vite + React, built to `web/dist` and served at `/`. Fonts are bundled; nothing loads from the network. Diffs use `@pierre/diffs` with Shiki; each language grammar is its own lazy chunk, which is why `web/dist` is about 12 MB.

What the pages do: [ui.md](ui.md). How they look: [visual.md](visual.md).

## Desktop app (`electron/`)

`electron/main.ts` is a thin shell around the desk:

- fixes PATH for GUI launches;
- attaches to a desk already on the port, or starts one;
- opens a window on it, with a tray count, a global hotkey, notifications, "Open at login" and the `inbox://` protocol.

Pure logic is in `electron/lib.ts` (tested in `test/electron.test.ts`). `electron/preload.cjs` exposes `window.desktop` (`DesktopBridge` in `src/types.ts`). A desk outside the app's process sends notifications to the app through `/api/events?notify=1`.

The app keeps `window.json` and `theme.json` in Electron's userData (`~/Library/Application Support/Inbox`, `~/.config/Inbox`, `%APPDATA%\Inbox`; `<home>/app` with `DESK_HOME` set). On first start it copies them from Review Desk's folder if it has none (`carryOver`). "Open at login" lives in settings.json (`app.open_at_login`).

Packaging: electron-builder, config in `package.json`, output in `release/`. App id `dev.inbox.app`.

### Run from a checkout

With `app.source` (or `DESK_SOURCE`) set, the app runs the desk from that checkout instead of in-process. `npm run app:dev` does this on the repo itself. Which mode: `deskPlan` in `electron/lib.ts`.

- `electron/source.ts` starts two children in their own process groups, logging to `<home>/live.log`:
  - `node --watch --watch-path=src src/cli.ts serve`: a `src/` change restarts the desk (it stops its agent processes first, `src/children.ts`).
  - Vite on a free port, passed to the desk as `DESK_UI_ORIGIN`: a `web/` change is hot reload.
- An `electron/` change needs a rebuilt app.
- The desk passes the Vite server through (`fromUi()`, `proxyUpgrades()` in `src/server.ts`), so `http://localhost:47823` always serves the checkout's current UI. While Vite is down it answers 503 with a page that retries every 2 s.
- The window keeps its page across a desk restart and reconnects.
- A desk that exits waits for the next change under `src/` or an `npm install`. The window shows its last lines. The app never falls back to an in-process desk.
- **Node**: the first `node` 22.18+ on the login shell's PATH (`zsh -ilc`, retried for up to 20 s on a slow first shell), else where nvm, Volta, mise, asdf or fnm keep it (`fallbackDirs`).
- Missing node, `node_modules` or a checkout: the window says what's missing and the app looks again every 15 s.
- Quitting stops both children. Every launch first stops what a crashed app left (pids in `<home>/live.json`). Changing `app.source` relaunches the app.

### Updates and releases

- `npm run release <x.y.z>` (`scripts/release.ts`) tags; `npm run release:publish v<x.y.z>` (`scripts/release-publish.sh`) builds every platform on a Mac and publishes the GitHub Release. `.github/workflows/release.yml` does it on a tag push, once Actions isn't blocked by billing.
- `Updates` in `src/updates.ts` compares the packaged app's version with the latest release every 6 hours, read with your GitHub token (the repo is private). It reaches the UI as `Overview.update`; the sidebar's footer shows the line.
- `POST /api/update` installs it where electron-updater can (`installUpdate()` in `electron/main.ts`): an AppImage on Linux, an installed build on Windows (`selfUpdates()` in `electron/lib.ts`). Elsewhere, including macOS, the line links to the release's download.
