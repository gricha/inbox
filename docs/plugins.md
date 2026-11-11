# Plugins: a small core, and sources as plugins

The owner's direction: a small core, with every source (GitHub first) as a plugin. This doc is the design, checked against the code.

- **Built:** the `Connector` seam, items that carry their source, per-source refs, boards and init, and the built-ins a source ships. See [What exists today](#what-exists-today).
- **Planned:** everything else here. Each step keeps today's behaviour; each behaviour change is its own decision, on the owner's yes ([Decisions for you](#9-decisions-for-you)).

## What exists today

**The seam:** `Connector` in `src/connectors/connector.ts`. The desk runs every connector in `desk.connectors`; today only `GitHubConnector` (`src/connectors/github.ts`). Its members:

- `id`, `name`: `"github"`, `"GitHub"`. `id` is the `source` of its events and boards.
- `rules`, `automations`, `criteria`: what it ships for its boards (`github-rules.ts`), automations (`github-automations.ts`) and Urgency (`github-criteria.ts`). The owner only switches them.
- `init(first)`: what it must have before the desk starts (GitHub: your context), and its part of the first config.toml. `Desk.init()` asks every connector. On a first run one failing writes no config and the desk starts without one; the first-run page says why and its Retry asks again ([api.md → The first run](api.md#the-first-run)).
- `start`, `stop`, `reschedule`: its loops; re-arm on a settings change.
- `reconcile` (a full pass, `Desk.sync()`), `poll` (the cheap change feed).
- `events(prev, next)`: what changed between two snapshots (GitHub: `itemEvents` in `github-events.ts`).
- `status()`: its sync state, in the overview.
- `refOf(text, held)`, `fetchOne(id)`: which held ids a ref names, and reading the one it names exactly. `Desk.resolve()`, `hold()` and `itemId()` ask every connector.
- `boardIds(board, scope, loaded)`: what one of its boards lists, as `Members` (`ids`, `kept`, `queries`, `unfetched`, `error`). `Desk.compute()` asks the board's `source`.

**Also built:**

- `Head` (`id`, `url`, `created_at`, `updated_at`) in `src/types.ts`; `Item extends Head`. An id's prefix is its source (`notes:1`); a bare id is GitHub's.
- Per-source prune: `store.pruneItems(source, before, keep)`. `KEEP_RESOLVED` (3 days) is the core's, in `connector.ts`.
- config.toml: a board's `source` defaults to `"github"`; an unknown one is a config error (`must be one of github`). The search-query check applies only to GitHub's boards. `builtin` names a rule set the source ships.
- Settings: `SETTINGS_PARTS` (`web/src/view.ts`) lists the core's parts, then one per plugin: GitHub, and Sessions.
- `test/plugin.test.ts`: an in-memory `notes` source guarding the prune, refs, boards and init, so the core stops assuming GitHub.
- Sessions (`src/connectors/sessions.ts`): a second source, not a `Connector` yet ([Sessions](#sessions-srcconnectorssessionsts-built)).

**Still GitHub-shaped in the core** (what the plan removes):

- `compute()` reads GitHub's typed `analysis` (`analyze()` in `src/signals.ts`) for every item.
- `desk.gh` is read directly: `ctx`, `me()`, the AI review, the writes.
- `Desk.card()` builds GitHub's fields; writes are `Desk` methods (`approve`, `githubAct`, `reply`, `markReady`, …).
- The judge, the AI review and conversations read GitHub items.

**Landed after this design; fold in before the steps that touch them:**

- Urgency (`src/urgency.ts`): the Inbox's Urgent, Standard and FYI sections, criteria and scores. "Now" and "Today" below are the internal buckets those sections are drawn from.
- Claude's work ledger (`src/jobs.ts`).
- The chosen agent: the judge, automations, AI reviews and the coordinator run Claude Code, Codex or OpenCode (`askAgent()`, Settings → Agent).

## 1. The core, and what it isn't

The core is `src/desk.ts` with GitHub taken out. It keeps:

- **The store:** items, state, the action log, the event log, kv.
- **One recompute** from items to cards: boards, rules, the judge, floors, quiet days, caps, Blocked, the main page's parts.
- **Your verbs:** done, snooze, mute, pin, undo, add, hand off, take back.
- **The rest:** the one write path, Merging and your agent, agents' questions, automations, notifications.

A plugin is a source. It:

- pulls snapshots, or is pushed them;
- reads each into plain facts the core decides with (its **lens**);
- renders its own rows;
- checks and sends the writes you click.

The core never knows what a PR, review, CI run, branch, login, team, search query, diff or merge is, nor a ref's syntax or which writes exist. GitHub is the first plugin. Agents' questions become the second only if you take Q.

**One rule for every item hook.** A plugin's side of a hook is a fact it derives from its snapshots on every recompute: a lens field, `members` or `resolved()`. The core reconciles against it, so when the fact stops holding, what it did undoes itself. The core never removes, blocks, raises or hands off an item because a plugin called something.

## 2. The core's primitives and hooks

```
pull   start()'s loops, sync() ─────┐
push   a function its file exports  ├─▶ put ─▶ store, events(prev, next), resolved flips ─▶ event log ─▶ long-polls, wake()
add    you, desk_add, a find: ref() ┘   (a ref nobody holds is fetched, then pinned)
look   look(items, at) ─▶ a Lens per item ─▶ status (done, snooze, mute, Merging)
place  per board (members + pins): filter ─▶ first rule ─▶ judge ─▶ floors ─▶ quiet ─▶ caps ─▶ best across boards
move   hand-backs and needs ─▶ every react("synced") ─▶ notify ─▶ the judge's pump
show   held off ─▶ parts, rank ─▶ row(item, lens, seat) ─▶ Inbox, Blocked, Merging, Archive
out    the window's click ─▶ Desk.write ─▶ plugin.write's checks ─▶ under its lock: send, log, after, next, then
```

```ts
// src/plugin.ts (planned): the seam. desk.ts imports this and nothing GitHub-shaped.

// Built (src/types.ts). Items are stored whole as JSON; the core reads only these.
export interface Head {
  id: string; // key in state, both logs and kv; prefix before ":" is its plugin; a bare id is GitHub's
  url: string; // "" for none: Card.url, and the links in your agent's lines
  created_at: string; // sort "newest"; fallback for a missing `activity` or `since`
  updated_at: string; // an older snapshot never replaces a newer one; quiet days
}
export type NewEvent = Omit<ActivityEvent, "seq" | "source">; // built; the core's own kinds: resolved, unresolved

// REMOVE: the world dealt with it. Derived from each snapshot, never stored, so it undoes itself.
export interface Resolution {
  reason: string;
  actor: string;
  at: string | null;
  mine?: boolean; // the Archive shows it
}

// What a plugin says of each item on every recompute: synchronous, no network. Only `fields` is required.
export interface Lens {
  fields: Record<string, unknown>; // what rules' when, filter, priority and why read (GitHub: its Signals)
  activity?: string; // others' latest: ends Done and "until activity"; the new dot; sort "updated"
  since?: string; // since it began waiting on you: the row's age, sort "waiting"
  part?: "review" | "other" | "mine"; // its part of the main page (default "other"); the core puts what it raises in "back"
  weight?: number; // over a cap, the lowest keeps its slot (GitHub: look 0, not reviewed 1, skim 2, skip 3); default 0
  arrive?: "held" | "silent"; // held: off Now and Today until its own look is done; silent: reaching them isn't news
  until?: string[]; // WAIT: keys a snooze can wait on now ("ci", "push:9f3c1e"); the kind is before ":"
  blocked?: { id: string; ref: string; waits: string }; // BLOCK: the item at the end of its chain ("web#3 (through web#2)") and what it waits on
  needs?: { by: "you" | "agent"; why: string }; // whose move it is; the core's gates decide what that does
  yours?: true; // Merging may hold it, and it may go to your agent (GitHub: your own open PR)
  handoff?: string; // why you can't hand it off now; only act("inflight") reads it
  judge?: unknown[]; // what the judge read that can change; none: never judged
  freed?: string; // until D1: something it needed got done (GitHub: a needed PR merged)
  waits_since?: string; // until D2: Blocked's order and age (GitHub: kv `blocked`'s since, or when you last asked)
  capped?: string; // until D3: what a cap says instead of its own words (GitHub: "the AI says skip it")
}

export interface LookAt {
  now: Date;
  merging: ReadonlyMap<string, "you" | "agent">; // you handed it off, or the desk gave it to your agent
}

// Where the core put an item. Today's Desk.seat() answers bucket and why; this grows it.
export interface Seat {
  bucket: Bucket | null; // its best bucket; null: on no list
  why: string;
  demoted?: string; // quiet or capped, in words
  listed: boolean; // a board lists it, whatever its status
  status: Status;
  merging: "you" | "agent" | null;
}

// What renders, built after placement. The core reads only `fold` and `rank`; clients read the rest on Card.
export interface Row {
  ref: string; // after the title; the tray's label and a notification's
  title: string; // untrusted
  kind: string; // "pr", "issue"
  by: string; // "you", "alice", "Your agent"
  stage?: string; // "waiting for review"
  cta?: string; // its one call to action: "ready", "reviewers", "merge", "reply"
  actions?: string[]; // the writes its menus offer (GitHub: Desk.actions())
  fold?: { key: string; at: number }; // rows sharing a key show as one line (a stack)
  extra?: unknown; // only its own cells and pages read this: CI, verdict, preflight, stack, blocks, Merging's columns
  rank?: number; // until D3: order inside its part, lower first (GitHub: queueOrder's terms)
}

// One mutation, checked and ready.
export interface Write {
  lock: string; // what a second press waits on: "approving <id>", or "sending" on the item, a conversation or a line
  busy: string; // what that second press is told
  send: Effect.Effect<{ url: string; after: "done" | "keep" | "restore"; logged?: string }, Upstream>; // logged: its action-log name when not the action's
  next?: { logged: string; send: Effect.Effect<void, ReviewersNotAsked> }; // a second mutation after `after` (ready, then reviewers); failing keeps the first
  then?: (landed: boolean) => Effect.Effect<void>; // last, whatever GitHub said: the read-again; never fails
}
```

**Lens details:**

- **Times.** No `activity` means nobody else has acted: no dot, and `created_at` for Done. No `since` means `created_at`. Quiet means neither `since` nor `updated_at` is within quiet_days; nothing pinned is ever quiet. That matches today's test in `rules.ts`, since today's `waiting_since` is never after `updated_at`.
- **The judge's key.** The core hashes `judge`, then who pinned it, then `blocked by <blocked.ref>`, in `judgeKey()`'s order (`src/judge.ts`). `ref` keeps today's "(through X)", so keys stay byte for byte and nothing is judged again.
- **Fields that go.** `blocks` moves to `row.extra` (rules read `pr.blocks` from fields; the Review page reads the card). `rebase` becomes `needs.by = "agent"`. `pending` and `silent` become `arrive`; `slot` becomes `weight`. `triage` goes with questions (Q).

**Errors and verbs.** `RefError`, `ActError` and `WriteError` move from desk.ts to `src/errors.ts`, so `src/plugin.ts` can name them without a cycle. `put` never fails (docs/effect.md → Desk's shape). `act`, `add`, `push` and `hold` keep their signatures. The new `Desk.write(ref, action, input): Effect.Effect<{ url: string }, WriteError | ReviewersNotAsked>` is called only by the window's routes.

| Hook       | Yours or an agent's (kept on the desk)                           | The plugin's (from its snapshots)                                                              | Undone when                                                 |
| ---------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Add        | `add` (pin, desk_add), `push` (an automation's find), via `hold` | `members` (a board lists it); `ref` (fetched if need be)                                       | you unpin; the board stops listing it                       |
| Remove     | done (until `activity` moves), mute                              | `resolved(item)`                                                                               | `resolved` answers null again                               |
| Wait       | snooze until a time, activity, or one of `until`                 | `until` offers; `happened` ends one; `arrive: "held"`                                          | the time comes, activity moves, or it happened; held: shown |
| Block      | none: rules fill Blocked (`final`); the judge never answers it   | `blocked`                                                                                      | `blocked` clears                                            |
| Your agent | hand off (only `yours`), take back; desk_hand_back               | `needs.by = "agent"` (the desk gives it); `needs.by = "you"` (hands back or raises); `handoff` | `needs` clears or your agent is off: it returns silently    |
| Automation | a schedule, run by your agent; finds go to `push`                | `agent` (allow, deny); a find reaches it through `ref`                                         |                                                             |
| Pull       | Sync now: `sync()`                                               | `start()`'s loops: `put`, then `changed(true)`                                                 |                                                             |
| Push in    | none                                                             | a function its file exports, wired in server.ts, ending in `put`                               |                                                             |
| Push out   | the window's click, through `Desk.write`                         | `write` answers a `Write`                                                                      |                                                             |

**Writing.** `Desk.write`:

1. resolves the ref as today's writes do and finds the plugin by the id's prefix;
2. calls the plugin's `write` with the writer `startServer` gave that plugin (its checks speak in its own words);
3. takes `lock`, so a second press gets `Busy` with `busy`;
4. runs one uninterruptible region: `send`, `logWrite`, `after` (done, keep, or restore what an earlier done hid), `changed()`, then `next` with its own `logWrite`, then `then(landed)`.

That keeps today's orders:

- Approve forks its read-again after the done.
- The More menu awaits its read-again, then marks what it wrote.
- Ready and Ask reviewers read again whatever GitHub said (`Effect.ensuring`). Ready asks its reviewers after its done and keeps the ready if that fails (`ReviewersNotAsked`, 502).
- Done's `acked_at` is the activity you saw, so a comment the read-again brings in still brings the item back. (A read-again inside `send` would have acked it.)
- Two lock sets, as today: Approve, the More menu, ready and Ask reviewers lock `approving` on the item. A comment, a reply and a comment on a line lock `sending` on the item, conversation or line. So a comment can go while an approve is on its way.

## 3. A plugin

```ts
export interface Plugin<I extends Head = Head> {
  readonly id: string; // its ids' prefix (GitHub's: none), its events' source, its boards' `source`
  readonly name: string; // built
  readonly rules: Readonly<Record<string, BuiltInRules>>; // built
  readonly automations: readonly BuiltInAutomation[]; // built
  readonly criteria: readonly BuiltInCriterion[]; // built
  look(items: readonly I[], at: LookAt): Map<string, Lens>; // all at once: stacks and dependencies need them all
  resolved(item: I): Resolution | null; // per snapshot: put compares before with after
  row(item: I, lens: Lens, seat: (id: string) => Seat): Row; // seat: where a stack's members sit
  init?(first: boolean): Effect.Effect<string | null, GitHubReadError | Upstream>; // built
  start?(): void; // PULL: loops on unref'd timers, each pass forked through host.runner
  stop?(): void; // clears its timers; Desk.stop() calls it before runner.stop()
  sync?(): Effect.Effect<void>; // a full pass now (today's reconcile); never fails: status() says what did
  status?(): ConnectorStatus & { paused?: Paused; detail?: unknown }; // sync state; a pause (shown once as a bubble); its Settings facts
  react?(e: { on: "synced" } | { on: "settings" } | { on: "added"; id: string } | { on: "retry"; only?: string }): void;
  members?(board: CompiledBoard, scope: string): Members; // ADD: today's boardIds, less `loaded`
  ref?(text: string, held: readonly string[]): { held: string[]; id?: string; fetch?: Effect.Effect<string, Upstream | NotFound> } | null; // today's refOf + fetchOne
  events?(prev: I | null, next: I): NewEvent[]; // built
  wake?(e: ActivityEvent): string | null; // what an event tells your agent about an item in Merging ("CI failed"): ids and kinds, never source text
  happened?(item: I, key: string): boolean; // WAIT: a snooze on `key` is over
  waits?: Readonly<Record<string, string>>; // until D4: each wait kind's words (GitHub: UNTIL)
  fields?: readonly FieldDoc[]; // what its boards' rules read: Searches and rules, /api/fields, expr's compile check
  brief?(batch: readonly JudgeItem<I>[]): string[]; // the judge's lines: who you are, each item's facts
  write?(item: I, action: string, input: unknown, writer: unknown): Effect.Effect<Write, WriteError>; // PUSH OUT: only Desk.write calls it
  agent?: { allow: string[]; deny: string[] }; // what automation runs may and may never use, beside the core's lists
  about?(item: I, merging: boolean): { line: string; place: Record<string, unknown> }; // an ask about it
  detail?(item: I, seat: (id: string) => Seat): Record<string, unknown>; // the rest of desk_item, under today's keys
}
// Members is built (connector.ts). JudgeItem<I> is today's less `signals` and `ai`: GitHub's brief reads its own.

// What a plugin's factory gets (DeskOptions.plugins: ((host: Host) => Plugin)[]): not the Desk, no coordinator, no writer.
export interface Host {
  put(items: readonly Head[], o?: { events?: NewEvent[]; quiet?: true; source?: "desk" }): void; // stored, diffed by events(), resolved flips added, logged; quiet: stored only; source: until D5
  changed(synced?: true): void; // its items or status changed; synced: a pass ended, so the core's after-sync work runs
  top(held?: true): readonly Card[]; // Now and Today in order (held: with what arrives held): what it warms ahead
  seat(id: string): Seat;
  claude(prompt: string, o?: { schema?: object; dir?: string }): Effect.Effect<ClaudeAnswer, CommandError | ClaudeError>; // your agent, no tools; an answer lifts a login failure
  readonly store: Store; // reads anything; writes its own tables and listed kv keys; items and events only through put
  readonly settings: Settings;
  readonly runner: Runner;
  now(): Date;
  log(m: string): void;
}
```

Required: `id`, `look`, `resolved`, `row`. The rest are optional; GitHub uses them all.

**Pulling.** `start()` arms loops on unref'd timers and forks each pass through `host.runner` (docs/effect.md). `stop()` clears them. A pass calls `host.put`, then `host.changed(true)`. That is today's `synced()`, which runs after every pass even when nothing came, so time-based moves (the 10 minutes before "nobody's asked") happen without news. The core calls `sync()` for Sync now and for an edited config.toml.

**Refs.** `Desk.resolve` tries an exact held id, then every plugin's `ref`:

- one held match is the id; several are `AmbiguousRef`; none is NotFound ("no item … on the desk");
- a ref every plugin answers null to is the "can't read" NotFound.

`hold` keeps its two BadRequests: a ref nobody reads, and `{ held: [] }` with no `id` (a short ref it doesn't hold). Otherwise it runs `fetch`, which answers the stored id, so adding through a renamed repo's redirect still works. `itemId` keeps a ref the desk no longer holds when a plugin answers it as its exact `id`, so its events outlive it. (Today: `refOf` and `fetchOne`, built.)

**Being pushed to.** A system that pushes in calls a function the plugin's file exports, ending in `host.put`. server.ts wires it to a route by hand. `src/mcp.ts` keeps calling routes through `src/client.ts`. No route or tool registry. Nothing pushes in until Q.

**Pushing out.**

- Writes go only through `write`, only via `Desk.write`, only from the window's routes (`fromDesk`), logged every time.
- GitHub's `write` is a plain switch over its writer. `src/github/write.ts` and its `ALLOWED` stay the complete list of mutations; the read client keeps refusing every `mutation`.
- Only `write` gets the writer, so `look`, `react` and the loops never hold it.
- Without a writer, GitHub's row leaves out `cta` and `actions`, as today. Reply isn't gated on a writer, as today.

**Deterministic first.** From data to placement:

1. `look` turns snapshots into facts in code: waits, the blocker, needs, what's yours. GitHub's `author.engaged_90d` and `me.my_area` are deterministic. A model-made fact (the AI review's verdict) is cached per commit, and rules can read it.
2. Rules (config.toml, plus the source's built-ins) map fields to a bucket. First match wins, `hard` sets a floor, `final` keeps the judge out, and only rules fill Blocked.
3. The judge (policy.md, through your agent) decides what rules leave open, with their bucket as a hint. It never goes below a floor, never answers Blocked, and reads the plugin's `brief`. No `brief`, never judged.
4. The plugin's own prefilter holds an item (`arrive: "held"`) while it works (GitHub's AI review), then feeds `weight`.
5. The core applies quiet days, caps, `needs` and order.

Actions split the same way: `row.actions` is what menus offer, `row.cta` the one the row offers, and `write` checks and sends it. Only `yours` can be handed to your agent; `handoff` says when it can't.

**config.toml** (built). A board names its `source`, default `"github"`. The core asks only that plugin's members, with the board's space's `scope` (GitHub: `org:x`). Other keys belong to the source; `queries` stays GitHub's.

```toml
[[boards]]
id = "review"
space = "sentry"
source = "github"   # optional; the core's keys: filter, priority, rules, default, sort, caps
builtin = "review"  # the source's rule set
queries = ["is:open is:pr review-requested:{me}"]
```

**Settings.** `SETTINGS` stays one static array, so `desk.settings["github.bots"]` still typechecks. GitHub's entries (`github.*`, `review.*`, `handoff.*`, keys unchanged) move to GitHub's own file and are spread in. In Settings, the sidebar lists the core's parts (Inbox and notifications, Agent, Your automations, Urgency, This device), then one part per plugin (`SETTINGS_PARTS`). GitHub's part holds its account, its entries, Searches and rules, and its automations; `more` folds its tuning behind More GitHub settings. Its section shows `status()` beside its entries.

**Built-in automations** (built). A plugin ships automations so a fresh install works with no config (GitHub's: `src/connectors/github-automations.ts`).

- Each has a stable id, a name, one plain line of what it does, whether it's on by default, and its definition (trigger, `when`, `decide`, `can`, a rule's action and why).
- The core runs them through `src/automations.ts` as yours, with every guarantee yours have, as `<plugin>.<id>`.
- The owner only switches one (kv `automations_builtin`, from the window only). A release that changes one takes effect; one dropped from code is gone. To change one: Copy to your automations (an editable copy, off).
- Generic only: no person, repo or topic. Rule-only ones may be on by default; anything needing a model is off.
- GitHub's, on: Pick a reviewer, Follow up on silent reviewers, Team reviews someone else took, Wide team pings. Off: Snooze while CI is red, Questions in mentions.

Built-in criteria work the same way for Urgency (`src/connectors/github-criteria.ts`, kv `criteria_builtin`).

## 4. The plugins we have, against today's files

### GitHub (`src/plugins/github/`)

| Today                                                                                                                     | In the plugin                                                                          |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `start`, `stop`, `reconcile`, `poll`, `fillStacks`, `reschedule` (`src/connectors/github.ts`)                             | `start`, `stop`, `sync`, `react({ on: "settings" })`; ingest becomes `host.put`        |
| `queriesFor`, `expandQuery`, the `hits` and `queries` tables, its read of pinned states; `boardIds`                       | `members` (still reads pins from `host.store`)                                         |
| `normRef`, `REF`, `refOf`, `fetchOne` (all in github.ts now)                                                              | `ref`                                                                                  |
| `refreshContext`, `contextError`, the rate-limit pause; `ctx`, `me()`; `init`; overview's `rate_limit`                    | `init(first)`, `status()`; kv `context` unchanged                                      |
| `analyze`, `FIELDS` (`src/signals.ts`); `resolution` (`src/resolve.ts`)                                                   | `look`'s `fields`, `activity`, `since`; `resolved`; `fields`                           |
| `UNTIL` (`src/types.ts`), `waitable`, `happened` (signals.ts); `push:<sha>`                                               | `until`, `happened`, `waits`                                                           |
| `buildStacks` (`src/stacks.ts`), `dependencies` (`src/deps.ts`), the blocker words, `aged`, `trackBlocked`                | `blocked`, `freed`, `waits_since`, `fold`; `trackBlocked` in `react({ on: "synced" })` |
| compute's `inflight`, the unasked hoist, `stuckUnasked`, `rebaseConflicts`' test, `act("inflight")`'s checks              | `yours`, `needs`, `handoff`                                                            |
| `queueCard`'s group, `awaitsAi`, `notifyNew`'s own-draft skip, the caps' weight and skip words (`rules.ts`), `queueOrder` | `part`, `arrive`, `weight`, `capped`, `row.rank`                                       |
| `card()`'s chips, stage, cta, team_ask, verdict, stack, blocks; `preflight` (judge.ts); `Desk.actions()`; `waitsOn`       | `row`, `row.extra`                                                                     |
| `canApprove`, `approve`, `githubAct`, `reply`, `comment`, `inlineComment`, `markReady`, `askReviewers`                    | `write`: a switch answering one `Write` per click                                      |
| `itemEvents` (`github-events.ts`), `wakeFor` (`src/coordinator.ts`)                                                       | `events` (built), `wake`                                                               |
| `judgeKey`'s item part, `describe`, `ownerLines`, `areaLines` (`src/judge.ts`)                                            | `Lens.judge`, `brief`                                                                  |
| `item()`'s signals, handoff_prompt, ai, ai_stale, generating, held, stack; `askAbout`, `askPlace`                         | `detail`, `about`                                                                      |
| the `gh` and `git` lines automations add to their allow and deny lists (`src/automations.ts`)                             | `agent`                                                                                |

`trackBlocked` keeps its scope (your PRs a board lists or Merging has) by reading `host.seat(id).listed` and `merging`. It runs in `react({ on: "synced" })`, after the core's moves and before it notifies, as today. So a hand-back a merge freed is notified with its "unblocked: sentry#X merged ·" prefix. Its kv `blocked` keeps feeding Blocked's order and age through `waits_since` (until D2). Its events go through `put` with no items, under source `desk` (until D5).

### Sessions (`src/connectors/sessions.ts`, built)

Your own Claude Code and Codex sessions on this computer that are blocked on you or stalled. docs/api.md → Sessions has what it reads and decides.

- **Follows the one rule already.** Each pass derives the fact (blocked or stalled, and why). An item exists only while the fact holds, so a session that moves on, ends, or is archived resolves itself.
- **Core verbs work on it.** Done, snooze, mute and undo act on its id (`session:<id>`), in the `state` table and action log like any item.
- **Not a `Connector` yet**, because the recompute still reads every item as GitHub's. Its cards live in memory and reach the core the way questions do: `QueueView.sessions`, `FocusView.sessions`, `Desk.sessionAct()`, `desk_list`, `desk_item` (`GET /api/sessions/:id`).
- **Its writes are a session's, never GitHub's,** from the window only: Kick and Resume (`claude --resume <id> --bg`, through the coordinator's `halt()`), and Open (the desktop app's or Codex's link).
- **Settings:** its own part, Sessions (`sessions.enabled`, `sessions.ask`, `sessions.quiet_minutes`). No built-in automations (`automations: false`).

When the core takes plugins:

| Today                                                                            | In the plugin                                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `Sessions.start`, `stop`, `reschedule`, `poll` (30 s, only while the desk runs)  | `start`, `stop`, `sync`, `react({ on: "settings" })`               |
| `classify()`, `Found`, `cards()`                                                 | `look`'s fields and `resolved()`: there while the verdict holds    |
| `SessionCard`; `SessionRow`, `SessionDetail` in `web/src/components/Session.tsx` | `row`, `detail`                                                    |
| `Desk.kickSession`, `openSession` (`POST /api/sessions/:id/kick`, `/open`)       | `write`: Kick, Resume, Open                                        |
| `isSessionRef` (`session:` prefix)                                               | `ref`                                                              |
| the agent's read of a turn that ended asking something (`sessions.ask`)          | like `Lens.judge`: its own read, cached per session and last event |

### Agents' questions (`src/desk.ts`, kv `inquiries`)

The agents' channel to you, as asks are yours to your agent. Nothing about them is GitHub-shaped except `item`, which resolves through refs.

- `Desk.inquire` checks a question and notifies "Your agent asks" or "<from> asks".
- kv `inquiries` holds at most 100, dropping the oldest answered first.
- `answerInquiry` passes your answer to your agent. Its route needs no config, so you can answer while config.toml has errors.
- They lead the Inbox as `QueueView.inquiries` and count as `focus.asks`.

They stay exactly this in desk.ts unless you take Q.

### The judge and policy (core)

The judge stays in `src/judge.ts` with what it has today: batches of 20, one call at a time, `policy.max_per_hour`, the backoff, kv `judge:<id>` and the policy hash. Stale answers show until fresh ones land. `JUDGE_BUCKETS` leaves out Blocked, and `final` skips it. The per-item key parts come from `Lens.judge` and the lines from `brief`; the frame stays the core's.

- **In:** rules first, then the judge where rules leave it open, then the plugin's own `arrive: "held"`.
- **Out:** the judge's only way out is FYI (fyi or hide), with its why. The world takes an item off through `resolved()`. Done, snooze and mute are yours (or an automation's, only with the verbs its `can` allows).
- **Per plugin:** a source's AI prefilter is set on its boards' rules: `bucket = "judge"`, `final`, `hard`, and with F2, `judge = "<automation>"`. One policy.md; the prompt names each item's board.

### Automations (`src/automations.ts`, core)

docs/api.md → Automations is the reference. A run on Claude Code is `claude -p --permission-mode dontAsk` with a JSON schema `{summary, items[{ref, why}]}` in `<home>/automations`; on Codex or OpenCode, the equivalent. Its tool lists get assembled, and a test checks they equal today's exactly:

- **Allow:** the core's (Read, Grep, Glob, WebSearch, WebFetch, the desk's read tools) + every plugin's `agent.allow` (GitHub: its `gh` read commands) + the automation's `tools` (F1).
- **Deny:** your agent's list (`src/coordinator.ts`) + the core's (Write, Edit, NotebookEdit, the desk's mutating tools) + every plugin's `agent.deny` (GitHub: `git push`, `git commit`, the `gh` writes). Deny always wins.

Your agent's own run keeps its list alone, because it pushes with `--force-with-lease` and merges; that list stays in coordinator.ts beside `ROLE` and `REBASE`. Each find goes to `push(ref, why, a)` through `hold`, so any plugin's `ref` can claim it. An agent's draft or edit stays off until you turn it on; only the window deletes one. With F1, `tools` is how a run reaches a system with no plugin: the data source is an MCP server, the rules are the prompt, the output is items on the desk.

### Your agent (the coordinator) and Merging (core)

- **The core keeps:** `inflight_at` and kv `sitter:<id>`; your agent's one session (`src/coordinator.ts`), its wakes, `tell`, the 60 s batch and the 5-minute check; the Merging page, asks, `desk_note`, `desk_hand_back`; `takeback`; and the rule that agents never hand off.
- **Membership.** In Merging means `inflight_at` set, `yours`, and unresolved. That is compute's `inflight` exactly, since GitHub derives `yours` from your login on every look and your own PRs resolve only by closing. The Merging page also lists yours resolved within 3 days.
- **Hand off.** `act("inflight")` refuses, in this order: not `yours` or resolved (in `handoff`'s words); already in Merging; then whatever `handoff` says. GitHub's `handoff`: not your open PR, a draft, nobody asked. Nothing is handed off by default.
- **The desk's own moves stay core, with today's gates:**
  - _Your agent's hand-back_ goes on top of Now while the item is active, unresolved, out of Merging and not done since it came back, whether or not a board lists it. Held in Blocked while `blocked` and your rules keep it there.
  - _The desk's hand-back_ (`handBackUnasked`) brings back what's in Merging, active, with `needs.by = "you"` and no `blocked`, with `why`.
  - _The hoist_ puts `needs.by = "you"` on top of Now while the item is active, unresolved, out of Merging, not handed back, listed by a board, and not quiet unless pinned. Held in Blocked like a hand-back. GitHub's `needs.by = "you"` is `stuckUnasked` alone: your PR nobody's asked to review, 10 minutes after it last changed.
  - _To your agent:_ `needs.by = "agent"` is today's `rebaseConflicts`: your approved PR that conflicts, CI not red, not blocked, not a draft. While `at.merging` says your agent has it, GitHub keeps it until it sees it mergeable. The core keeps the gates (your agent on, `coordinator.saved()`, no `sitter:` record, Now or Today, `yours`), `REBASE`'s words, and the silent return once `needs` clears or your agent is off.
- **What changes inside:**
  - `record()` wakes your agent on any event `wake()` words, for an item in Merging.
  - A held hand-back's prefix is `wake()` of its latest `unblocked` event.
  - `coordinator.wake` takes any held id (today a `PR` regex drops others), and `message()` links `item.url` instead of building a github.com URL.
  - `ROLE`, `REBASE`, the deny list and the skill's Coordinator section stay worded for PRs: getting PRs merged is your agent's job. Merging still writes nothing to GitHub.

### The AI review (GitHub's own prefilter)

Moves into the plugin:

- `src/review.ts`'s `fetchPr`, `generateReview`, `checkClaims`; kv `review:` and `pr:`;
- `pumpAi`, `wantsAi`, `warmReviews`;
- `aiFailures`, `aiLastFailed`, `aiPaused`, behind `status().paused` and `react({ on: "retry" })`;
- `src/conversation.ts` (kv `take:`) and `replyOnly`;
- the Review page and the Desk methods behind its routes.

It reaches the core only through `arrive`, `weight`, the `pr.*` fields, `row.extra.preflight` and `detail`. `warmAdded` becomes `react({ on: "added", id })`.

Stays core:

- `shown:` (generic). Pin, restore, unmute and showing any card in Now or Today set it; only `arrive: "held"` reads it.
- The agent helpers (`askClaude`, `askAgent`, `claudeSpawn`, `runCommand`, `claudeEnvelope` in review.ts; `denyDir` in coordinator.ts) move to `src/claude.ts`. `host.claude` wraps them, and its answers lift a login failure, as the AI review's do today. Conversations keep calling them directly, so theirs don't.
- `retryAgents`: lifts the judge's backoff and calls every plugin's `react({ on: "retry", only })`. `agentKey` stays in desk.ts, so changing `review.auto_ai` still retries both.

## 5. AGENTS.md's rules, kept

- **Writes.** A source is written only in its plugin's `write`. Only `Desk.write` calls it, with the writer only it holds, and only the window's routes call `Desk.write`. GitHub's writes stay in write.ts behind `ALLOWED`; adding to any plugin's list is a product decision. Hand off, Back to desk and a hand-back still write nothing. Live checks still stub the writer with `startServer({ writer })`, which becomes `{ github: writer }` inside.
- **State.** State stays on the desk. Lenses and rows are computed there; clients render `Card`, so the tray, MCP and notifications agree.
- **One ordered list.** Parts and their order are the core's. A plugin picks a part and a weight; it adds no part, bucket or page.
- **Untrusted text.** `wake()` and `about()` carry ids, URLs and kinds, never source text. Titles and agents' words still pass `line()`, `paragraphs()` and `INVISIBLE`.

## 6. What stays out of the core

- **GitHub's facts and words:** stage, wait kinds, resolution reasons, chips, cta kinds, stacks, `requires` parsing and the dependency graph, Context, spaces' `org:` scope, search queries, the feed, the rate limit, CODEOWNERS, merge conditions, hand-off prompts. Each reaches the core only as a lens field or inside `row.extra`.
- **Plugin pages and asks.** The Review page is GitHub's UI. New things become rules or settings, not pages. Asks are your agent's channel, not items; a plugin only words one (`about`).
- **Not added:** a loader, manifests, versions or sandboxes (plugins are modules in this repo, listed in `startServer`); a route or MCP tool registry; an event bus; a plugin storage API; one shared "agent job" pump (the judge, AI review, conversations, automations and coordinator fail differently on purpose); a `remove` call; plugin buckets or parts; a `block` verb or `desk_block`; an agent registry; per-plugin policy files; rules that act instead of place.
- **GitHub's kv keys** stay unprefixed and are listed in its file: `context`, `blocked`, `review:`, `pr:`, `take:`, `reconciled_at`, `synced_at`. `baseline_at` (what counts as new) is the core's; GitHub sets it once, after its first pass.

**Still GitHub-shaped in core files, on purpose** (until a second plugin needs otherwise):

- config.ts: the query check (GitHub's boards only); `spaceOf` and `catchAllOf`, which read `org:`, `user:` and `repo:` scopes for Settings' GitHub part, until GitHub's `status()` carries them.
- `SETTINGS`' `github.*`, `review.*`, `handoff.*`; `agentKey` reading `review.auto_ai`.
- `UNTIL` in types.ts, which format.ts, client.ts and desk_act's description use to word a snooze.
- store.ts's `itemMeta` `lacks`: GitHub's backfill test in SQL.
- Added, the board for pins, which names no source. GitHub answers its members: none of its own, and as `kept`, every search's. That keeps an unresolved item any search keeps off every board, Added included, until a second source keeps items to show as resolved.
- errors.ts's GitHub errors; coordinator.ts's `ROLE`, `REBASE` and deny list; the judge's frame, worded for PRs.
- Ref wording: the refusals, the automation schema ("owner/repo#123, repo#123 or a GitHub URL"), and `failedItem` in automations.ts (shows a GitHub URL as owner/repo#123).

## 7. Card

`Card` keeps `kind`, `repo`, `number` and `chips` for the tray, MCP and the CLI. It gains `ref` (from `row.ref`) and `extra`. `wake_on` and `snooze_when` stay kinds, worded by clients with `UNTIL`. GitHub's other fields (ci, review, draft, verdict, preflight, stack, team_ask, blocks) move into `extra` in one step that changes every reader with them (step 13).

## 8. Migration: small commits straight on main

Every commit keeps `npm run check` green and changes nothing you see. `test/plugin.test.ts` grows with each step (a snooze, a blocker, a resolution, a write…). Every step that moves a function updates its row in AGENTS.md's "Where a change goes" in the same commit.

**Done (1–5).** Needed by any plugin design; landed as `Connector` methods named for what they do today:

1. This doc.
2. Items carry their source; the prune is per source (`Head`, `pruneItems(source, …)`).
3. Refs and fetch per source (`refOf`, `fetchOne`; `normRef` and `REF` moved into github.ts).
4. Board membership per source (`source`, `boardIds` → `Members`; `KEEP_RESOLVED` is the core's).
5. Context: `Desk.me()` and `ctx` delegate to the connector; init's first config comes from it.

**Next (6–29).** Each adds to `Connector` until step 28 renames it. What moves is described in the sections above; here is the order and each step's tests.

6. **`look()`, part 1:** `fields`, `activity`, `since`, `freed`, `waits_since`, `resolved()`. `compute`, ingest's flips and `classify` read the lens. `Entry` keeps `analysis` beside it until step 26. New test: quiet is the later of `updated_at` and `since`.
7. **Waits:** `until`, `happened`, `waits`. `act("snooze")` stores the plugin's key.
8. **Blocking:** `blocked`. The holds, `blockedOrder` and Merging's blocked rows read the lens. `Desk.seat` gains `demoted`, `listed`, `status`, `merging`. `trackBlocked` moves into github.ts.
9. **Your agent's hooks:** `yours`, `needs`, `handoff`, `LookAt.merging`. New test: a hand-back of a PR no board lists and nobody pinned comes back on top of Now. The hoist, hand-back, hold and rebase tests pass unchanged.
10. **Order:** first pin the order and cap tests, then add `part`, `weight`, `capped`, `arrive` (read by `byPart`, the caps, `top()`, `notifyNew()`). `shown:` becomes generic.
11. **`row()`:** `card()` fills its basics from it and gains `ref`. `Row.rank` carries `queueOrder`'s terms; `oneLinePerStack` reads `fold`.
12. **The tray:** `cardLabel` (`electron/lib.ts`) reads `Card.ref`. Lands alone: it needs a rebuilt app (`npm run dist:mac`).
13. **`row.extra`:** with every reader: CardRow, Review, Inflight, `web/src/view.ts` (`handsOff()`), Detail.tsx, RowMenu.tsx, mcp.ts, cli.ts. Run `npm run shots` (queue, review, merging, row menu) in every theme.
14. **Events:** `ActivityKind` becomes `string` in the core (GitHub keeps its union); `wake()` replaces `wakeFor`.
15. **`Desk.write` with approve** (`canApprove` moves into `write`). Tests: refusals keep their words; a second press is `Busy`; a comment during an approve goes through; a failed read-again still answers the url.
16. **More menu, ready, Ask reviewers via `Desk.write`:** draft is `keep`, reopen `restore`, each read-again `then`, ready's reviewers `next`. Tests: a comment the read-again brings in still brings a closed or readied item back; a refused ready is still read again; a refused request_reviews answers `ReviewersNotAsked` with the ready kept; every write route answers 403 to anything but the window.
17. **Reply, comment, line comment via `Desk.write`.** Test: two replies on two conversations go at once.
18. **`src/claude.ts`:** the agent helpers.
19. **The AI review's state onto GitHub's connector.** The tests that watch it (docs/effect.md) read it there.
20. **The AI review's pump** into `react()`, `status().paused`, `retryAgents`.
21. **The Review page's Desk methods and routes** into GitHub's file, same routes.
22. **Conversations into GitHub,** with their tests.
23. **The judge:** `Lens.judge`, `brief()`. Test: keys equal `judgeKey`'s, pinned and blocked items included.
24. **`agent`, `about()`, `detail()`.** Test: the assembled automation lists equal today's.
25. **`Host` replaces `Desk` inside GitHub.** `ingest` and `record` become `put`; the AI review calls `host.claude`; `reschedule` and `searchKey` become `react({ on: "settings" })` (`agentKey` stays); overview's `rate_limit` moves to `status().detail`.
26. **`desk.gh` and `Entry.analysis` go,** with a codemod (oxc-parser and magic-string; docs/effect.md) over the tests that read `desk.gh`.
27. **GitHub's settings move to their own file.**
28. **`DeskOptions.plugins` and `writers`:** `startServer` builds `[(host) => github(host, { api, review, writes: !!writer })]` and `{ github: writer }`. `Connector` becomes `Plugin`; `refOf` + `fetchOne` become `ref`; `boardIds` becomes `members` without `loaded` (GitHub reads its settings from `host.settings`, so while config.toml has errors a changed setting's searches run on the next pass). The codemod covers `new Desk(` sites.
29. **A pure `git mv`** into `src/plugins/github/`: connectors/github\*, github/, signals, resolve, stage, deps, stacks, review, conversation, areas. Test: desk.ts, rules.ts, judge.ts, automations.ts, coordinator.ts and store.ts import nothing from `src/plugins/`, and plugins never call `putState`, `logAction` or `addActivity`. AGENTS.md's write rule points at `src/plugins/github/write.ts`.

Then each decision you take is one commit. It changes its guarding tests on purpose and drops the field or member that kept today's behaviour.

## 9. Decisions for you

Each has a recommended answer and today's behaviour as the conservative one, with what keeping it costs. The migration lands the conservative answer.

**Seen on the main page.**

- **D1. A needed PR merging counts as activity.** Recommended: yes. GitHub folds the time the PR it needs merged into `activity`. Done and "until activity" already end on it today. New: your PR gets the new dot when its blocker merges, and "+1" counts it; boards sorted "updated" (My PRs, Mentions, Collaborators) move it up; the item page's "active … ago" counts it. `Lens.judge` keeps others' activity only, so nothing is judged again. _Conservative:_ `freed` (+1 field).
- **D2. One "waiting since".** Recommended: yes. GitHub's `since` becomes what Blocked uses: when it got blocked, if blocked; else, for your PR waiting on reviewers, when you last asked; else today's request time or `created_at`. For your PRs only: their age everywhere counts from that time instead of when you opened them; a board sorted "waiting" orders by it; their quiet days, the hoist's included, count from it. Others' PRs are unchanged. _Conservative:_ `waits_since` (+1 field). Guarded by tests in `test/desk.test.ts`.
- **D3. One weight orders a part and decides who keeps a capped slot.** Recommended: yes. GitHub's weight follows `queueOrder`: a close look at the current commit -3, at an earlier commit -2, your PR approved and green -1, the rest 0, someone else's PR with red CI 1, a skip 2. Over a cap, what changes:
  - a stale "look" keeps its slot before unreviewed PRs (they tie today);
  - an unreviewed PR and a skim tie (unreviewed wins today);
  - a stale skip leaves first (today it counts as unreviewed);
  - others' red-CI PRs leave before skims;
  - your approved, green PRs keep their slot before your other PRs (rule order decides today);
  - capped cards no longer sort right after close looks, and a capped skip shows the cap's words instead of "the AI says skip it".

  _Conservative:_ `capped` and `Row.rank` (+1 lens field, +1 row field). Guarded by `test/rules.test.ts`.

- **Q. Agents' questions become the second plugin.** Recommended: yes, after D1 to D3, since it's your own example of a source. One visible step adds `src/plugins/questions.ts`:
  - **Items.** `questions:<hex>` items replace kv `inquiries`, imported once, same cap. Put quietly, so desk_events doesn't change.
  - **Asking.** `ask(body, resolve)` keeps `Desk.inquire`'s checks and words. server.ts wires it to `POST /api/inquiries`, passes `desk.itemId` as `resolve` (the item is still checked last), and notifies in today's words.
  - **Lens.** While open: `needs: { by: "you", why: "<from> asks" }`, part `"asks"` (before "back"), `arrive: "silent"`, and `refuse` in place of `handoff`, covering done, snooze, mute, pin and hand off, saying your agent waits on your answer.
  - **Answering.** Answer and Dismiss keep their own route, not `Desk.write`. `answer()` reads the item without the config check, so you can answer while config.toml has errors (a test). server.ts passes the answer to your agent; nothing enters the action log.
  - **What you'd see:** the tray menu, `desk ls` and desk_list list open questions as Now items, and `QueueView.inquiries` goes. The rows and `InquiryPage` look the same.
  - **Adds to the core:** part "asks", `refuse` for `handoff`, and the hoist passing part "asks" with no board and never quiet. _Conservative:_ questions stay in desk.ts, at no cost.

**For agents only.** Each is one commit, on your yes.

- **D4. Snooze words come only from what's offered now.** Recommended: yes. Today desk_act refuses a snooze until a kind the item doesn't offer with 409 "can't wait until it's approved; it can until …". With D4 it's an unreadable snooze time (400). The window is unchanged: it offers only what `until` lists. _Conservative:_ `waits` (+1 member).
- **D5. blocked and unblocked events say source `github`** instead of `desk`. Recommended: yes. Only desk_events shows it. _Conservative:_ `put`'s `source` option.

**Offered, not assumed.**

- **F1. Tools on automations.** Recommended: yes, last. An automation gets `tools?: string[]`: tools allowed beyond the desk's and plugins'. An agent's edit already leaves it off until you turn it on, and deny still wins. _Conservative:_ not built.
- **F2. An automation as a source's prefilter.** Recommended: yes, last, as one rule key: `{ when = "…", bucket = "judge", judge = "<automation>" }`. The run gets the items, fenced, with its prompt and tools, and answers `{ bucket, why }` per item. Answers are kept like the judge's, keyed by `Lens.judge` and the automation's `updated_at`. Floors and `final` bind them; they never answer Blocked. _Conservative:_ not built; the judge with policy.md does it.

**Settled.** Ids carry their source in the prefix. Blocking fields stay `pr.blocked*`, so config.toml is never rewritten. AI takes things off your desk only by sorting them into FYI. Plugins are code in this repo, listed in `startServer`. One policy.md. The desk's own moves stay code over `needs`. Merging takes only what a plugin calls `yours`: your own PRs today.
