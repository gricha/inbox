# Plugins: a small core, and sources as plugins

This is a design, not built yet: the owner's direction for a small core with every source as a plugin, worked out against the code. It was read against 9a8a4fc, and the line numbers are that commit's (`git show 9a8a4fc:<file>`). Each field names the place that reads it today, and nothing you see changes: the migration (section 8) lands today's behaviour everywhere, then each decision in section 9 is its own commit, on the owner's yes, with today's behaviour as the conservative answer.

## 1. The core, and what it isn't

The core is `src/desk.ts` with GitHub taken out. It keeps:

- **The store:** items, state, the action log, the event log and kv.
- **The one recompute** from items to cards: boards, rules, the judge, floors, quiet days, caps, Blocked, and the main page's parts.
- **Your verbs:** done, snooze, mute, pin, undo, add, hand off and take back.
- **The rest:** the one write path, Merging and your agent, agents' questions, automations and notifications.

A plugin is a source. It pulls snapshots or is pushed them. It reads each one into plain facts the core decides with (its lens), renders its own rows, and checks and sends the writes you click. The core never knows what a PR, a review, a CI run, a branch, a login, a team, a search query, a diff or a merge is, nor a ref's syntax or which writes exist. GitHub is the first plugin. Agents' questions stay the core's channel from agents, as they are today, until you take Q (section 9), which makes them the second. Nothing is there for later: each member replaces a place where desk.ts reads a GitHub fact today.

**One rule for every item hook.** A plugin's side of a hook is a fact it derives from its snapshots on every recompute: a lens field, `members` or `resolved()`. The core reconciles against it, so when the fact stops holding, what it did undoes itself. The core never removes, blocks, raises or hands off an item because a plugin called something.

## 2. The core's primitives and hooks

```
pull   start()'s loops, sync() ─────┐
push   a function its file exports  ├─▶ put ─▶ store, events(prev, next), resolved flips ─▶ event log ─▶ long-polls, wake()
add    you, desk_add, a find: ref() ┘   (a ref nobody holds is fetched, then pinned)
look   look(items, at) ─▶ a Lens per item ─▶ status (done, snooze, mute, Merging)
place  per board (members + pins): filter ─▶ first rule ─▶ judge ─▶ floors ─▶ quiet ─▶ caps ─▶ best across boards
move   hand-backs and needs (to your agent, back to you, on top of Now) ─▶ every react("synced") ─▶ notify ─▶ the judge's pump
show   held off ─▶ parts, rank ─▶ row(item, lens, seat) ─▶ Inbox, Blocked, FYI, Merging, Archive
out    the window's click ─▶ Desk.write ─▶ plugin.write's checks ─▶ under its lock: send, log, after, next, then
```

```ts
// src/plugin.ts: the seam. desk.ts imports this and nothing GitHub-shaped.
// What the core reads of an item, which is stored whole as JSON. GitHub's Item already has these fields.
export interface Head {
  id: string; // the key in state, both logs and kv; its plugin is the prefix before ":" ("notes:1"); a bare id is GitHub's
  url: string; // where it lives ("" for none): Card.url, and the links in your agent's lines
  created_at: string; // sort "newest"; what a missing `activity` or `since` falls back to
  updated_at: string; // an older snapshot never replaces a newer one (the feed and a pass race); quiet days
}
export type NewEvent = Omit<ActivityEvent, "seq" | "source">; // today's; the core's own kinds are resolved and unresolved
// REMOVE: the world dealt with it. Derived from each snapshot and never stored, so it undoes itself.
export interface Resolution {
  reason: string;
  actor: string;
  at: string | null;
  mine?: boolean;
} // mine: the Archive shows it (:1443)
// What a plugin says of each item on every recompute: synchronous, no network. Only `fields` is required.
export interface Lens {
  fields: Record<string, unknown>; // rules' when, filter, priority and why read these (GitHub: its Signals)
  activity?: string; // others' latest: Done and "until activity" end when it moves; the new dot; sort "updated"
  since?: string; // since it began waiting on you: the row's age, sort "waiting"
  part?: "review" | "other" | "mine"; // its part of the main page; none: "other"; the core puts what it raises in "back"
  weight?: number; // over a cap, the lowest keeps its slot (GitHub: look 0, not reviewed 1, skim 2, skip 3); none: 0
  arrive?: "held" | "silent"; // held: off Now and Today until its own look is done (the "reviewing" count); silent: reaching them isn't news
  until?: string[]; // WAIT: stored keys a snooze can wait on now ("ci", "push:9f3c1e"); the kind is before ":"
  blocked?: { id: string; ref: string; waits: string }; // BLOCK: the item at the end of its chain, in words ("web#3 (through web#2)"), and what that one waits on
  needs?: { by: "you" | "agent"; why: string }; // whose move it is; the core's gates decide what that does (section 4)
  yours?: true; // Merging may hold it, and it may go to your agent (GitHub: your own open PR)
  handoff?: string; // why you can't hand it off now, in its own words; only act("inflight") reads it
  judge?: unknown[]; // what the judge read that can change; none: never judged
  freed?: string; // until D1: something it needed got done (GitHub: a needed PR merged), which also ends Done and "until activity"
  waits_since?: string; // until D2: Blocked's order and age (GitHub: kv `blocked`'s since, or when you last asked)
  capped?: string; // until D3: what a cap that moves it says instead of the cap's words (GitHub: "the AI says skip it")
}
// What look() may know of the desk: no network, no placement yet.
export interface LookAt {
  now: Date;
  merging: ReadonlyMap<string, "you" | "agent">;
} // you handed it off, or the desk gave it to your agent
// Where the core put an item: for row(), and for a plugin's own work through Host.seat. Today's Desk.seat (:1217), grown.
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
  ref: string; // quietly after the title; the tray's label and a notification's
  title: string; // untrusted
  kind: string; // the small label: "pr", "issue"
  by: string; // "you", "alice", "Your agent"
  stage?: string; // "waiting for review"
  cta?: string; // its one call to action ("ready", "reviewers", "reply")
  actions?: string[]; // the writes its menus offer (GitHub: today's Desk.actions())
  fold?: { key: string; at: number }; // rows sharing a key show as one line (a stack); oneLinePerStack stays the core's
  extra?: unknown; // what only its own cells and pages read: CI, verdict, preflight, the stack, blocks, Merging's columns
  rank?: number; // until D3: order inside its part, lower first (GitHub: queueOrder's terms, reading seat.demoted)
}
// One mutation, checked and ready. Desk.write takes `lock`, then runs one uninterruptible region: send, logWrite, after, next, then.
export interface Write {
  lock: string; // what a second press waits on: GitHub's "approving <id>", or "sending" on the item, a conversation or a line
  busy: string; // what that press is told, in today's words
  send: Effect.Effect<{ url: string; after: "done" | "keep" | "restore"; logged?: string }, Upstream>; // with its own log line; logged: its action-log name when it isn't the action's
  next?: { logged: string; send: Effect.Effect<void, ReviewersNotAsked> }; // a second mutation once `after` is applied (ready, then its reviewers); failing keeps the first
  then?: (landed: boolean) => Effect.Effect<void>; // last, whatever GitHub said: the read-again; never fails
}
```

- **Times.** `activity` absent means nobody else has acted: no dot, and created_at for Done. `since` absent is created_at. Quiet means neither `since` nor updated_at falls within quiet_days, and nothing pinned is ever quiet. That equals today's test (rules.ts:189), because today's `waiting_since` is the request time when you were asked, else created_at, which is never after updated_at.
- **The judge's key.** The core hashes `judge`, then who pinned it, then `blocked by <blocked.ref>`, in judgeKey's order (judge.ts:90). `ref` keeps today's "(through X)", so every key stays byte for byte and nothing is judged again.
- **What goes.** `blocks` goes into `row.extra`: rules read `pr.blocks` from fields, and the Review page's "blocks …" (Review.tsx:1001) reads the card. `rebase` becomes `needs.by = "agent"`. `pending` and `silent` become `arrive`, and `slot` becomes `weight`. `triage` goes with questions (Q).

`RefError`, `ActError` and `WriteError` move from desk.ts to `src/errors.ts`, so `src/plugin.ts` can name them without a cycle. `put` never fails (docs/effect.md, "Desk's shape"). The verbs `act`, `add`, `push` and `hold` keep today's signatures. The new `Desk.write(ref, action, input): Effect.Effect<{ url: string }, WriteError | ReviewersNotAsked>` is called only by the window's routes.

| Hook       | Yours or an agent's (kept on the desk)                                            | A plugin's (from its snapshots)                                                                                | Undone when                                                                        |
| ---------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Add        | `add` (your pin, desk_add) and `push` (an automation's find), both through `hold` | `members` (a board lists it); `ref` (a ref names it, fetched if need be)                                       | you unpin; the board stops listing it                                              |
| Remove     | done (until `activity` moves), mute                                               | `resolved(item)`                                                                                               | it reopens: `resolved` answers null again                                          |
| Wait       | snooze until a time, activity, or one of `until`                                  | `until` offers; `happened` ends one; `arrive: "held"`                                                          | the time comes, activity moves, or it happened; held: its look lands or it's shown |
| Block      | none: rules fill Blocked (`final`), and the judge never answers it                | `blocked`                                                                                                      | `blocked` clears                                                                   |
| Your agent | hand off (only what's `yours`), take back; desk_hand_back                         | `needs.by = "agent"` (the desk gives it); `needs.by = "you"` (the desk hands it back, or raises it); `handoff` | `needs` clears or your agent is off: it comes back silently                        |
| Automation | a schedule, run by your own `claude`; its finds go to `push`                      | `agent` (allow, deny); a find reaches it through `ref`                                                         |                                                                                    |
| Pull       | Sync now: `sync()`                                                                | `start()`'s loops: `put`, then `changed(true)`                                                                 |                                                                                    |
| Push in    | none                                                                              | a function its file exports, wired by server.ts, ending in `put`                                               |                                                                                    |
| Push out   | the window's click, through `Desk.write`                                          | `write` answers a `Write`                                                                                      |                                                                                    |

**Writing.** `Desk.write` resolves the ref as today's writes do, finds the item's plugin by its id's prefix, and calls the plugin's `write` with the writer `startServer` gave for that plugin. The plugin's checks run in its own words. Then `Desk.write` takes `lock`, so a second press is `Busy` with `busy`. It runs one uninterruptible region: `send`, `logWrite`, `after` (done, keep, or restore what the done before it hid), `changed()`, then `next` with its own `logWrite`, then `then(landed)`.

That keeps today's orders. Approve forks its read-again after the done (:1828). The More menu awaits its read-again, then marks what it wrote (:1920-1922). Ready and Ask reviewers read again whatever GitHub said (`Effect.ensuring`, :2789, :2404), and ready asks its reviewers after its done, keeping the ready when that fails (`ReviewersNotAsked`, 502). Done's `acked_at` is the activity you saw (:1961), so someone else's comment the read-again brings in still brings the item back, which a read-again inside `send` would have acked. GitHub keeps today's two lock sets and their words: Approve, the More menu, ready and Ask reviewers lock `approving` on the item; a comment, a reply and a comment on a line lock `sending` on the item, the conversation or the line, so a comment can go while an approve is on its way.

## 3. A plugin

```ts
export interface Plugin<I extends Head = Head> {
  readonly id: string; // its ids' prefix (GitHub's: none), its events' source, its boards' `source`
  look(items: readonly I[], at: LookAt): Map<string, Lens>; // all at once: stacks and dependencies need them all
  resolved(item: I): Resolution | null; // per snapshot: put compares one before with one after
  row(item: I, lens: Lens, seat: (id: string) => Seat): Row; // a stack's members say where each sits
  init?(first: boolean): Effect.Effect<string | null, GitHubReadError | Upstream>; // before the desk starts: what it must have (GitHub: your context); first: its boards for the first config.toml
  start?(): void; // PULL: its loops on unref'd timers, each pass forked through host.runner (docs/effect.md)
  stop?(): void; // clears its timers; Desk.stop() calls it before runner.stop()
  sync?(): Effect.Effect<void>; // a full pass now (Sync now, an edited config.toml); never fails: status() says what did
  status?(): ConnectorStatus & { paused?: Paused; detail?: unknown }; // its sync state; its pause, said once above the queue; its Settings section's facts (GitHub: the rate limit, where each org's items land, the catch-all space)
  react?(e: { on: "synced" } | { on: "settings" } | { on: "added"; id: string } | { on: "retry"; only?: string }): void; // after the core's moves, before it notifies; settings reloaded (it compares its own keys); you or a find added `id`; what failed on Claude tries now
  members?(board: CompiledBoard, scope: string): Members; // ADD: what one of its boards lists; scope: its space's
  ref?(text: string, held: readonly string[]): { held: string[]; id?: string; fetch?: Effect.Effect<string, Upstream | NotFound> } | null; // its matches; id: the one it names exactly, which fetch reads and puts, answering the id it's stored under; null: not its ref
  events?(prev: I | null, next: I): NewEvent[];
  wake?(e: ActivityEvent): string | null; // what an event tells your agent while the item is in Merging ("CI failed"): ids and kinds, never source text
  happened?(item: I, key: string): boolean; // WAIT: a snooze on `key` is over
  waits?: Readonly<Record<string, string>>; // until D4: each kind's words (GitHub: UNTIL)
  fields?: readonly FieldDoc[]; // what rules on its boards read: the Searches and rules view, /api/fields, expr's compile-time check
  brief?(batch: readonly JudgeItem<I>[]): string[]; // the judge's lines: who you are, each item's facts
  write?(item: I, action: string, input: unknown, writer: unknown): Effect.Effect<Write, WriteError>; // PUSH OUT: only Desk.write calls it; it narrows its own writer
  agent?: { allow: string[]; deny: string[] }; // what automation runs may and never use, beside the core's lists
  about?(item: I, merging: boolean): { line: string; place: Record<string, unknown> }; // an ask about it: your agent's words, desk_ask's place
  detail?(item: I, seat: (id: string) => Seat): Record<string, unknown>; // the rest of desk_item, under today's keys
}
export interface Members {
  ids: ReadonlySet<string>;
  kept: ReadonlySet<string>;
  queries: string[];
  unfetched: string[];
  error?: string;
}
// JudgeItem<I> is today's (judge.ts:74) less `signals` and `ai`: GitHub's brief reads its own.
// What a plugin's factory gets (DeskOptions.plugins: ((host: Host) => Plugin)[]): not the Desk, no coordinator, no writer.
export interface Host {
  put(items: readonly Head[], o?: { events?: NewEvent[]; quiet?: true; source?: "desk" }): void; // stored, diffed by its events(), resolved flips added, logged (events even with no items); quiet: stored only; source: until D5
  changed(synced?: true): void; // its items or status changed; synced: a pass or a read ended, so the core's after-sync work runs
  top(held?: true): readonly Card[]; // Now and Today in order (held: with what arrives held): what it warms ahead
  seat(id: string): Seat; // where an item sits now
  claude(prompt: string, o?: { schema?: object; dir?: string }): Effect.Effect<ClaudeAnswer, CommandError | ClaudeError>; // your own claude, no tools; an answer lifts what failed on the login
  readonly store: Store; // reads anything; writes its own tables and the kv keys its file lists, and its rows' hits, touches and prune; items and events only through put
  readonly settings: Settings;
  readonly runner: Runner;
  now(): Date;
  log(m: string): void;
}
```

Four members are required: `id`, `look`, `resolved` and `row`. The optional ones are GitHub's. `init` fails with today's tags, which errors.ts already holds.

**Pulling.** The plugin's `start()` arms its loops on unref'd timers and forks each pass through `host.runner`, as docs/effect.md says periodic loops do; `stop()` clears them. A pass calls `host.put`, then `host.changed(true)` when it ends. That is today's `synced()`, which runs after every pass even when nothing came, so time-based moves (the 10 minutes before "nobody's asked") happen without news. The core calls `sync()` for Sync now and for an edited config.toml.

**Refs.** `Desk.resolve` tries an exact held id first, then every plugin's `ref`. One held match is the id, several are `AmbiguousRef`, none is today's NotFound ("no item … on the desk"), and a ref every plugin answers null to is today's "can't read" NotFound. `hold` keeps its two BadRequests in today's words: a ref every plugin answers null to, and `{ held: [] }` with no `id` (a short ref it doesn't hold). Otherwise it runs `fetch`, which answers the stored id, so an add through a renamed repo's redirect still works (github.ts:441), or NotFound in GitHub's words. `itemId` keeps a ref the desk no longer holds when a plugin's `ref` answers it as its `id`, the text itself (an exact id, not a URL naming one), so its events outlive it.

**Being pushed to.** A system that pushes in calls a function the plugin's file exports, which ends in `host.put`, and server.ts wires it to a route by hand. `src/mcp.ts` keeps calling routes through `src/client.ts`. There is no route or tool registry. Nothing pushes in until Q, where agents' questions are the first.

**Pushing out.** Writes go only through `write`, only through `Desk.write`, and only from the window's routes (`fromDesk`), logged every time. GitHub's `write` is a plain switch over `GitHubWriter`. `src/github/write.ts` and its `ALLOWED` stay the complete list of mutations, and the read client keeps refusing every `mutation`. The writer goes only into `write`, so `look`, `react` and the loops never hold it. GitHub's factory is told whether it has a writer, and its row leaves out `cta` and `actions` without one, as `this.writer &&` does today (:1206, :1863); Reply isn't gated on a writer, as today (:1308).

**From data to items and actions, deterministic first.**

1. `look` turns snapshots into facts in code: waits, the blocker, needs, what's yours. A decision model is one more field it computes. GitHub's `author.engaged_90d` and `me.my_area` are deterministic. A model-made one (the AI review's verdict) is cached per commit, and rules can read it.
2. Rules (config.toml) map fields to a bucket. The first match wins, `hard` sets a floor, `final` keeps the judge out, and only rules fill Blocked.
3. The judge (policy.md, read by your own `claude`) decides what the rules leave open, with their bucket as its hint. It never goes below a floor, never answers Blocked, and reads the plugin's `brief`. A plugin without `brief` is never judged.
4. The plugin's own prefilter holds an item (`arrive: "held"`) while it works (GitHub's AI review), then feeds `weight`.
5. The core applies quiet days, caps, `needs` and order.

Actions follow the same split. `row.actions` is what the menus offer, `row.cta` the one the row offers, and `write` checks and sends it. Only what's `yours` can be handed to your agent, and `handoff` says when it can't.

**config.toml.** A board names its `source`, which defaults to `"github"`, so today's files parse unchanged; one the desk doesn't run is a config error (`must be one of github`), as the key was before it existed. The core asks only that plugin's `members`, with the board's space's `scope` (GitHub's `org:x`). Its other keys are its source's; `queries` stays GitHub's, and config.ts's "needs at least one GitHub search query" applies to GitHub's boards.

```toml
[[boards]]
id = "review"
space = "sentry"
source = "github"            # optional; the core's keys: filter, priority, rules, default, sort, caps
queries = ["is:open is:pr review-requested:{me}"]
```

**Settings.** `SETTINGS` stays one static array, so `desk.settings["github.bots"]` still typechecks. GitHub's entries (`github.*`, `review.*`, `handoff.*`, keys unchanged) live in GitHub's own file and are spread into it. Its section shows `status()` beside its entries, rendered from the schema as today. Settings' parts are the sidebar's items while you're in Settings: the core's (Inbox and notifications, Agent, Your automations, This device), then under a hairline one per plugin (`SETTINGS_PARTS` in `web/src/view.ts`), each its own route. GitHub's holds all of GitHub's entries, its account and Searches and rules; `more` folds its tuning (the repos that count as yours, bots, close collaborators, the sync interval and the `handoff.*` prompts) behind More GitHub settings; and under them, the automations it comes with.

**Pre-baked automations.** A plugin comes with automations, so a desk installed today works with no config: `automations: readonly BuiltInAutomation[]` on it, in a file of its own beside it (GitHub's `src/connectors/github-automations.ts`), each a stable id, a name, one plain line of what it does, whether it's on by default, and its definition in the automation model (trigger, `when`, `decide`, `can` and a rule's action and why). The core runs them through `src/automations.ts` as the owner's own, with every guarantee theirs have (`can`, floors, pins, hand-backs, the why in its name, logged and undoable), as `<plugin>.<id>`. The owner only switches one (kv `automations_builtin`, per id; only from the window, never an agent), so a release that changes its definition just takes effect and one dropped from code is gone; to change one, Copy to your automations makes an editable own one from its definition, off. Generic only, no person, repo or topic: rules (no model) may be on by default, anything that needs a model is off. GitHub's: Pick a reviewer, Follow up on silent reviewers, Team reviews someone else took (FYI) and Wide team pings (hidden) on; Snooze while CI is red and Questions in mentions (a model's ask) off.

## 4. The plugins we have, against today's files

### GitHub (`src/plugins/github/`)

| Today                                                                                                                                                                            | In the plugin                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `start`, `stop`, `reconcile`, the feed (`poll`), `fillStacks`, `reschedule` (src/connectors/github.ts:91, 237, 477, 365, 103)                                                    | `start`, `stop`, `sync`, `react({ on: "settings" })`; `desk.ingest` becomes `host.put` |
| `queriesFor`, `expandQuery` (:229, 211), the `hits` and `queries` tables; its read of pinned states (:308)                                                                       | `members`; it keeps reading pins from `host.store`                                     |
| `normRef`, `REF` (desk.ts:190), `resolve`'s matching (:1511), `itemId`'s regex (:916), `hold`'s split (:2133), `fetchOne` (github.ts:441)                                        | `ref`                                                                                  |
| `refreshContext`, `contextError`, the rate-limit pause (github.ts:174, 75, 162); `ctx`, `me()` (desk.ts:491); init's first config (:367); overview's `rate_limit` (:1284)        | `init(first)`, `status()`; kv `context` unchanged                                      |
| `analyze`, `FIELDS` (src/signals.ts:150, 6); `resolution` (src/resolve.ts:16)                                                                                                    | `look`'s `fields`, `activity`, `since`; `resolved`; `fields`                           |
| `UNTIL`, `waitable`, `happened` (src/types.ts:361, signals.ts:312, 324); `push:<sha>` (desk.ts:1985)                                                                             | `until`, `happened`, `waits`                                                           |
| `buildStacks`, `dependencies` (src/deps.ts:90), the blocker words (desk.ts:991-1000), `aged()` (:1423), `trackBlocked` (:2350)                                                   | `blocked`, `freed`, `waits_since`, `fold`; `trackBlocked` in `react({ on: "synced" })` |
| compute's `inflight` (:986), the unasked loop (:1113), `stuckUnasked` (:2380), `rebaseConflicts`' test (:2232), `act("inflight")`'s checks (:2019)                               | `yours`, `needs`, `handoff`                                                            |
| `queueCard`'s group (:1307), `awaitsAi` (:1370), `notifyNew`'s own-draft skip (:941), `call()` (:1032), the caps' weight and skip words (rules.ts:215, 223), `queueOrder` (:121) | `part`, `arrive`, `weight`, `capped`, `row.rank`                                       |
| `card()`'s chips, stage, cta, team_ask, verdict, stack, blocks (:1145); `preflight` (:1313); `Desk.actions()` (:1860); `waitsOn` (:2911)                                         | `row`, `row.extra`                                                                     |
| `canApprove` (:1801), `approve`, `githubAct`, `reply`, `comment`, `inlineComment`, `markReady`, `askReviewers`                                                                   | `write`: a switch answering one `Write` per click                                      |
| `itemEvents` (src/connectors/github-events.ts), `wakeFor` (src/coordinator.ts:140)                                                                                               | `events`, `wake`                                                                       |
| `judgeKey`'s item part (src/judge.ts:90), `describe`, `ownerLines`, `areaLines`                                                                                                  | `Lens.judge`, `brief`                                                                  |
| `item()`'s signals, handoff_prompt, ai, ai_stale, generating, held, stack (desk.ts:1531); `askAbout`, `askPlace` (:2422, 2433)                                                   | `detail`, `about`                                                                      |
| the `gh` and `git` lines automations add to `ALLOW` and `DENY` (src/automations.ts:21, 44)                                                                                       | `agent`                                                                                |

`trackBlocked` keeps its scope, your PRs a board lists or Merging has, by reading `host.seat(id).listed` and `merging`. It runs in `react({ on: "synced" })`, which the core calls after its moves and before it notifies, as today (:765), so a hand-back a merge freed is notified with its "unblocked: sentry#X merged ·" prefix. Its kv `blocked` keeps feeding Blocked's order and age through `waits_since` (until D2). Its events go through `put` with no items, under `desk` (until D5).

### Sessions (`src/connectors/sessions.ts`, built)

The second real source, and the first that isn't GitHub-shaped: your own Claude Code and Codex sessions on this computer that are blocked on you or stalled (docs/api.md → Sessions has what it reads and decides). It follows the one rule for every item hook already: each pass derives the fact (blocked or stalled, and why) from what it read, and an item exists only while the fact holds, so a session that moves on, loses its process with its turn finished, or is archived resolves on its own; done, snooze, mute and undo are the core's verbs on its id (`session:<id>`, in the `state` table and the action log like any item's). It isn't a `Connector` yet, because the recompute still reads every item as GitHub's: its cards live in memory and reach the core through `QueueView.sessions` and `FocusView.sessions` (after agents' questions), `Desk.sessionAct()` (the triage), `desk_list` and `desk_item` (`GET /api/sessions/:id`), the way questions do, rather than through `members`, `row` and the store's items. Its one write is a session's, never GitHub's: Kick and Resume (`claude --resume <id> --bg`, through the coordinator's own `halt()`) and Open (the desktop app's or Codex's link), from the desk's window only. Its settings are its own part, Sessions, in Settings' sidebar under GitHub (`sessions.enabled`, `sessions.ask`, `sessions.quiet_minutes`); it comes with no built-in automations (`automations: false` in `SETTINGS_PARTS`), so its part has no Automations heading. When the core takes plugins, it maps onto the plan as:

| Today                                                                           | In the plugin                                                               |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `Sessions.start`, `stop`, `reschedule`, `poll` (30 s, only while the desk runs) | `start`, `stop`, `sync`, `react({ on: "settings" })`                        |
| `classify()`, `Found`, `cards()`                                                | `look`'s fields and `resolved()`: the item is there while the verdict holds |
| `SessionCard`, `SessionRow`/`SessionDetail` in `web/src/components/Session.tsx` | `row`, `detail`                                                             |
| `Desk.kickSession`, `openSession` (`POST /api/sessions/:id/kick`, `/open`)      | `write`: Kick, Resume, Open                                                 |
| `isSessionRef` (`session:` prefix)                                              | `ref`                                                                       |
| `askAgent` on a turn that ended asking something                                | `Lens.judge`-like: the plugin's own read, cached per session and last event |

### Agents' questions (desk.ts:2520-2640, kv `inquiries`)

They're the agents' channel to you, as asks are yours to your agent, and nothing about them is GitHub-shaped except `item`, which resolves through refs like any other. `Desk.inquire` checks a question in today's words and notifies "Your agent asks" or "<from> asks". kv `inquiries` holds at most 100 in all, dropping the oldest answered (:2598-2600). `answerInquiry` passes your answer to your agent, and its route needs no config, so you can answer while config.toml has errors. They lead the main page as `QueueView.inquiries` and count as `focus.asks`. Until Q they stay exactly that, in desk.ts. With Q, they become the second plugin (section 9).

### The AI prefilter, in and out (the judge and policy)

The judge stays core, in src/judge.ts, with what it has today: batches of 20, one call at a time, `policy.max_per_hour`, the backoff, kv `judge:<id>` and the policy hash. Stale answers show until fresh ones land, `JUDGE_BUCKETS` leaves out Blocked, and `final` skips it. The per-item key parts come from `Lens.judge` and the lines from `brief`; the frame stays the core's.

- **In:** rules first, then the judge where they leave it, then the plugin's own `arrive: "held"`.
- **Out:** the judge's only way out is FYI (fyi or hide), with its why. The world takes an item off through `resolved()`, and done, snooze and mute are yours. AI never marks an item done or mutes it.
- **Configured per plugin:** a source's AI prefilter is set on its boards' rules, since a board belongs to a source: `bucket = "judge"`, `final`, `hard`, and, if you say yes, `judge = "<automation>"` (F2). The prose stays in one policy.md, and the prompt names each item's board.

### Automations (`src/automations.ts`, core)

A run is today's: your own `claude -p --permission-mode dontAsk --json-schema {summary, items[{ref, why}]}` in `<home>/automations`. Its lists are assembled, and a test checks they equal today's exactly:

- **Allow:** the core's (Read, Grep, Glob, WebSearch, WebFetch, the desk's read tools), plus every plugin's `agent.allow` (GitHub: its `gh` read commands), plus the automation's `tools` (F1).
- **Deny:** your agent's list (coordinator.ts:21), plus the core's (Write, Edit, NotebookEdit, the desk's mutating tools), plus every plugin's `agent.deny` (GitHub: `git push`, `git commit`, and the `gh` writes automations.ts adds). Deny always wins.

Your agent's own run keeps its list alone, because it pushes with `--force-with-lease` and merges. That list stays in coordinator.ts beside `ROLE` and `REBASE`. Each find goes to `push(ref, why, a)` as today, through `hold`, so any plugin's `ref` can claim it. An agent's draft or edit stays off until you turn it on, and only the window deletes one. With F1, `tools` is how a run reaches a system with no plugin: the data source is an MCP server, the rules are the prompt, and the output is items on the desk.

Automations have grown past this section since it was written, and docs/api.md → Automations is their reference: one starts on a schedule or on the event log's kinds, may carry a `when` check, decides by a rule (no model), a question (one call with no tools) or the agent run above, and beyond `push` may sort an item, snooze it, mark it done or mute it, but only with the verbs in its `can`, which you set. So the table's Automation row and "AI never marks an item done or mutes it" describe the judge and an automation allowed nothing but `add`, the default.

### Your agent (the coordinator) and Merging (core)

- **The core keeps:** `inflight_at` and kv `sitter:<id>`; the one `claude --bg` session with `--resume` wakes, `tell`, the 60 s batch and the 5-minute check; the Merging page, asks, `desk_note` and `desk_hand_back`; `takeback`; and the rule that agents never hand off.
- **Membership.** In Merging means `inflight_at` set, `yours` and unresolved. That is compute's `inflight` exactly (:986), because GitHub works `yours` out from your login on every look and your own PRs resolve only by closing (resolve.ts:20). The Merging page also lists yours that resolved within 3 days.
- **Hand off.** `act("inflight")` refuses, in today's order: what isn't `yours` or is resolved, in `handoff`'s words; what's in Merging already; then whatever `handoff` says. GitHub's `handoff` is today's words for not your open PR, a draft, and nobody asked. Nothing is handed off by default.
- **The desk's own moves stay core, with today's three gates.**
  - _Your agent's hand-back_ (:1097) goes on top of Now while the item is active, unresolved, out of Merging and not done since it came back, whether or not a board lists it. It's held in Blocked while `blocked` and your rules keep it there.
  - _The desk's hand-back_ (`handBackUnasked`, :2341) brings back what's in Merging, active, with `needs.by = "you"` and no `blocked`, with `why`.
  - _The hoist_ (:1113) puts `needs.by = "you"` on top of Now while the item is active, unresolved, out of Merging, not handed back, listed by a board, and not quiet unless pinned. It's held in Blocked like a hand-back. GitHub's `needs.by = "you"` is `stuckUnasked` alone: your PR nobody's asked to review, 10 minutes after it last changed.
  - _To your agent:_ `needs.by = "agent"` is today's `rebaseConflicts` (:2232). GitHub sets it on your approved PR that conflicts, CI not red, not blocked and not a draft. While `at.merging` says your agent has it, GitHub keeps it until it sees it mergeable. The core keeps the gates (your agent on, `coordinator.saved()`, no `sitter:` record, Now or Today, `yours`), `REBASE`'s words, and the silent return with the record cleared once `needs` clears or your agent is off.
- **What changes inside:** `record()` wakes your agent on any event that `wake()` words, for an item in Merging. A held hand-back's prefix is `wake()` of its latest `unblocked` event. `coordinator.wake` takes any held id where the `PR` regex drops others today (coordinator.ts:45), and `message()` links `item.url` instead of building a github.com URL. `ROLE`, `REBASE`, your agent's deny list and the skill's Coordinator section stay worded for PRs, because getting PRs merged is your agent's job. Merging still writes nothing to GitHub.

### The AI review (GitHub's own prefilter)

These move into the plugin: src/review.ts's `fetchPr`, `generateReview` and `checkClaims`; `ReviewDeps` and kv `review:` and `pr:`; `pumpAi`, `wantsAi` and `warmReviews`; `aiErrors`, `aiFailures` and `aiPaused`, behind `status().paused` and `react({ on: "retry" })`; src/conversation.ts (kv `take:`) and `replyOnly`; and the Review page with the Desk methods behind its routes. It reaches the core only through `arrive`, `weight`, the `pr.*` fields, `row.extra.preflight` and `detail`. `warmAdded` (:2122) becomes `react({ on: "added", id })`.

`shown:` stays core and generic. Pin, restore and unmute set it, and so does showing any card in Now or Today; only `arrive: "held"` reads it. The Claude helpers (`askClaude`, `claudeSpawn`, `runCommand`, `claudeEnvelope`, `denyDir`) move to `src/claude.ts`. `host.claude` wraps `askClaude`, and its answers lift what failed on the login, as the AI review's do today. Conversations keep calling `askClaude` directly, so theirs don't, as today. `retryAgents` stays core: it lifts the judge's backoff and calls every plugin's `react({ on: "retry", only })`. `agentKey` stays in desk.ts, so changing `review.auto_ai` still retries both.

## 5. AGENTS.md's rules, kept

- **Writes.** The desk writes to a source only in that plugin's `write`. Only `Desk.write` calls it, with the writer only it holds, and only the window's routes call `Desk.write`. GitHub's writes stay in write.ts behind `ALLOWED`, and adding to any plugin's list is a product decision. That holds by review, as today; what the structure adds is that nothing else in a plugin holds the writer. Hand off, Back to desk and a hand-back still write nothing. Live checks still stub the writer with `startServer({ writer })`, which becomes `{ github: writer }` inside.
- **State.** State stays on the desk. Lenses and rows are computed in the desk, and clients render `Card`, so the tray, MCP and notifications still agree.
- **One ordered list.** Parts and their order are the core's. A plugin picks a part and a weight; it adds no part, bucket or page.
- **Untrusted text.** `wake()` and `about()` carry ids, URLs and kinds, never source text. Titles and agents' words still pass `line()`, `paragraphs()` and `INVISIBLE`.

## 6. What stays out of the core

- **GitHub's facts and words:** stage, the wait kinds, resolution reasons, chips, cta kinds, stacks, `requires` parsing and the dependency graph, Context, spaces' `org:` scope, search queries, the feed, the rate limit, CODEOWNERS, merge conditions and the hand-off prompts. Each reaches the core only as a lens field or inside `row.extra`.
- **Plugin pages and asks.** The Review page is GitHub's UI; new things still become rules or settings, not pages. Asks aren't items but your agent's channel, and a plugin only words one (`about`).
- **Not added:** a loader, manifests, versions or sandboxes (plugins are modules in this repo, listed in `startServer`); a route or MCP tool registry, an event bus, or a plugin storage API; one "agent job" pump over the judge, the AI review, conversations, automations and the coordinator (their failure policies differ on purpose); a `remove` call; plugin buckets or parts; a `block` verb or `desk_block`; an agent registry; per-plugin policy files; rules that act instead of place.
- **GitHub's kv keys** are unprefixed and listed in its file: `context`, `blocked`, `review:`, `pr:`, `take:`, `reconciled_at`, `synced_at`. `baseline_at` is the core's (what counts as new); GitHub sets it once, after its first pass, as today (github.ts:341). `KEEP_RESOLVED` becomes the core's: a resolved item still in a search passes its board's filter for that long (desk.ts:1008).
- **Still GitHub-shaped in core files, on purpose:** config.ts's query check, for GitHub's boards; config.ts's `spaceOf` and `catchAllOf`, which read spaces' `org:`, `user:` and `repo:` scopes so Settings' GitHub part can say where each org's items land (`github.orgs[].space`, `catch_all`), until GitHub's `status()` carries them; `SETTINGS`' `github.*`, `review.*` and `handoff.*`, and `agentKey` reading `review.auto_ai`; types.ts's `UNTIL`, which format.ts:70 and client.ts:45 word a snooze with and whose kinds desk_act's description lists (mcp.ts:371); store.ts's `itemMeta` `lacks`, GitHub's backfill test in SQL (store.ts:119); Added, desk.ts's board for pins, which names no source, so GitHub answers its members: none of its own, and its `kept`, every search's, which keeps an unresolved item any search keeps off every board, Added included, until a second source keeps items to show as resolved; errors.ts's GitHub errors; coordinator.ts's `ROLE`, `REBASE` and deny list; the judge's frame, worded for PRs; and the ref refusals', the automation schema's ref words ("owner/repo#123, repo#123 or a GitHub URL") and a failed find's (automations.ts's `failedItem` shows a GitHub URL as owner/repo#123), until a second plugin reads refs.

## 7. Card

`Card` keeps `kind`, `repo`, `number` and `chips` for the tray, MCP and the CLI. It gains `ref` (from `row.ref`) and `extra`. `wake_on` and `snooze_when` stay kinds, worded by the clients with `UNTIL` as today. GitHub's other fields (ci, review, draft, verdict, preflight, stack, team_ask, blocks) move into `extra` in one step that changes every reader with them (step 13).

## 8. Migration: small commits straight on main

Every commit keeps `npm run check` green and changes nothing you see. From step 2 on, test/plugin.test.ts runs a fake in-memory source (`notes:1` ids), and each step grows it: kept by the prune, added by ref, a board, a snooze, a blocker, a resolution, a write. It's the guard that the core stops assuming GitHub. Every step that moves a function edits its AGENTS.md "Where a change goes" row in the same commit, since other agents work from that map.

Steps 2 to 5 do what any plugin design needs, whatever its shape: items carry their source, the prune is per source, refs and fetch are per source, board membership is per source, and context is the source's. They land as methods on today's `Connector`, named for what they do today, and they fix no Plugin vocabulary. The steps after them are this design's, and they keep adding to `Connector` until step 28 renames it.

0. Let the Effect migration finish what it still has: it changes the same `Desk` signatures, and the steps below use its errors.
1. Add docs/plugins.md.
2. **Items carry their source; the prune is per source.** The id's prefix is the source, so there's no column and no data migration. Add `Head`, with `Item extends Head`. `putItems` writes `node_id ?? ""` and `detail_at ?? now`. `pruneItems(source, before, keep)` deletes only that source's rows. Only the test fake needs it until Q. Test: a `notes:1` row outlives GitHub's 14-day prune.
3. **Refs and fetch per source:** `Connector.refOf(text, held)` and `fetchOne`, which answers the stored id. `normRef`, `REF`, `resolve`'s matching, `itemId`'s regex and `hold`'s split move into github.ts. `hold`, `resolve` and `itemId` loop over `connectors`, with today's words and statuses.
4. **Board membership per source:** boards get an optional `source`, one the desk runs, and `Connector.boardIds(board, scope, loaded)` answers `Members`; `loaded` is the config being computed (a preview's, or the desk's), whose signals GitHub's `{close_authors}` reads, as its pass does. `compute()` stops calling `gh.queriesFor` (desk.ts:1053) and reading `hits`, `kept` and `queries`. `KEEP_RESOLVED` becomes the core's. config.ts's query check applies to GitHub's boards.
5. **Context:** `Desk.me()` and `ctx` delegate to the connector, and init's first config comes from it. `agentKey`, `searchKey` and `github.poll_seconds` are still read in desk.ts.
6. **`look()`, part 1:** `fields`, `activity` (others only), `since` (today's `waiting_since`), `freed`, `waits_since` and `resolved()`. `Entry` keeps GitHub's typed `analysis` beside `lens` until step 26, and each later step removes one group of its reads. `compute`, ingest's flips and `classify` read the lens; quiet is the later of updated_at and `since` (pinned by a new test).
7. **Waits:** `until`, `happened` and `waits` (`UNTIL`). `act("snooze")` stores the plugin's key and refuses in `waits`' words. Card and the clients don't change.
8. **Blocking:** `blocked`. GitHub keeps `dependencies()`, and `blocks` stays in its fields. The hand-back hold, the hoist's hold, `blockedOrder` and Merging's blocked rows read the lens. `Desk.seat(id, snap)` (:1217) gains `demoted`, `listed`, `status` and `merging`. `trackBlocked` moves into github.ts, calls `desk.seat`, runs where it runs today (after the core's moves, before `notifyNew`), and records its events under `desk` as today.
9. **Your agent's hooks:** `yours`, `needs` (you and agent), `handoff` and `LookAt.merging`. Merging's membership reads `yours`. The three hand-back and hoist gates stay the core's, `rebaseConflicts` reads `needs.by = "agent"`, and `act("inflight")` keeps its checks in today's order. Test: your agent hands back a PR no board lists and nobody pinned, and it comes back on top of Now. The hoist, hand-back, hold and rebase tests pass unchanged.
10. **Order:** pin the order and cap tests. Then add `part`, `weight` (the caps' weight), `capped` and `arrive`, read by `byPart`, the caps (rules.ts:215, 223), `top()` and `notifyNew()`. `shown:` becomes generic.
11. **`row(item, lens, seat)`:** `card()` fills `title`, `kind`, `by`, `stage`, `cta` and `actions` from it, and gains `ref`. `Row.rank` carries `queueOrder`'s PR terms, reading `seat.demoted`; handed back first stays the core's. `oneLinePerStack` reads `fold`, and the stack views are built in `row` from `seat`.
12. **The tray:** electron's `cardLabel` (electron/lib.ts:344) reads `Card.ref`. A change under electron/ needs a rebuilt app (`npm run dist:mac`), so this lands on its own.
13. **`row.extra`:** GitHub's other card fields move into it, `blocks` included. Every reader changes with it: CardRow, Review (depFacts), Inflight, view.ts:373-382 (a row's facts), `handsOff()` in view.ts for Detail.tsx and RowMenu.tsx (`draft` and `review` gate Hand off for merge), mcp.ts and cli.ts. Run `npm run shots` for queue, later, review, merging and the row menu, in light, dark and each theme.
14. **Events.** `ActivityKind` becomes `string` in the core, and GitHub keeps its union. `wake()` replaces `wakeFor`; `record()` and the held hand-back's prefix call it. `coordinator.wake` takes any held id, and `message()` uses `item.url`.
15. **`Desk.write` with approve.** `canApprove` moves into GitHub's `write`, and the Review view keeps `approve: { ok, reason }`. Tests: its refusals keep their words, a second press is `Busy`, a comment sent while an approve is on its way goes through, and a failed read-again still answers the url.
16. **The More menu, ready and Ask reviewers through `Desk.write`:** draft is `keep`, reopen is `restore`, and each read-again is `then`; ready's reviewers are `next`. `Desk.actions()` becomes GitHub's `row.actions`. Tests: someone else's comment brought in by the read-again still brings a closed or readied item back; a refused ready is still read again; a refused request_reviews answers `ReviewersNotAsked` with the ready logged and kept; every write route answers 403 to anything but the window.
17. **Reply, comment and a comment on a line through `Desk.write`,** each with today's lock and words. Test: two replies on two conversations go at once.
18. **`src/claude.ts`:** the Claude helpers move there. The judge, automations, your agent, the AI review and conversations call them as today.
19. **The AI review's state onto GitHub's connector:** `generating`, `aiErrors`, `aiFailures`, `aiPaused`, kv `review:` and `pr:`. The tests that watch them (docs/effect.md, "The fields tests watch") read them there.
20. **The AI review's pump:** `pumpAi` and warming run in `react({ on: "synced" })` and `react({ on: "added", id })`; `status().paused`; `retryAgents` calls `react({ on: "retry", only })`.
21. **The Review page's Desk methods and their routes** move into GitHub's file, with the same routes.
22. **Conversations move into GitHub** (`src/conversation.ts`, `replyOnly`), with their tests.
23. **The judge:** `Lens.judge` and `brief()`. The core appends who pinned it, then `blocked by <ref>`. A test asserts the keys equal `judgeKey`'s, pinned and blocked items included.
24. **`agent`, `about()` and `detail()`.** The automations' lists are assembled from your agent's, the core's and GitHub's, and a test checks they equal today's exactly. Your agent's list stays in coordinator.ts.
25. **`Host` replaces `Desk` inside GitHub,** introduced with its one user. `ingest` and `record` become `put` (trackBlocked's events with no items and `source: "desk"`), and the AI review calls `host.claude`. `reschedule` and `searchKey` become GitHub's `react({ on: "settings" })`, which compares its own keys; `agentKey` stays. Overview's `rate_limit` moves into GitHub's `status().detail`, and TopBar.tsx:45 and cli.ts:306 read it there.
26. **`desk.gh` and `Entry.analysis` go,** with the codemod docs/effect.md describes (oxc-parser and magic-string) for the roughly 275 `desk.gh` reads in 18 test files, test/helpers/desk.ts included, since tsconfig includes test/.
27. **GitHub's settings move to their own file,** spread into `SETTINGS`.
28. **`DeskOptions.plugins` and `writers`,** with `startServer` building `[(host) => github(host, { api, review, writes: !!writer })]` and `{ github: writer }` from its `writer` option. `Connector` is renamed `Plugin`, `refOf` and `fetchOne` become `ref` (with `fetch` beside `id` in its answer), and `boardIds` becomes `members`, dropping `loaded`: GitHub's `{close_authors}` reads `github.close_collaborator_min` and `github.bots` from `host.settings`, its pass's too, so while config.toml has errors a changed setting's searches run on the next pass, where today they wait for a config that parses. The same codemod covers the `new Desk(` sites.
29. **A pure `git mv`** into `src/plugins/github/`: connectors/github*, github/, signals, resolve, stage, deps, stacks, review, conversation and areas. Add one test that desk.ts, rules.ts, judge.ts, automations.ts, coordinator.ts and store.ts import nothing from src/plugins/, and that plugins never call `putState`, `logAction` or `addActivity`. In AGENTS.md, the product principle says the desk (src/desk.ts, over each plugin's lens) decides what's on the queue, its order and what notifies, and the write rule's path becomes `src/plugins/github/write.ts`.

Then each decision you take is one commit, which changes its guarding tests on purpose and drops the field or member that kept today's behaviour.

## 9. Decisions for you

Each has the answer we recommend and today's behaviour as the conservative answer, with what keeping it costs. The migration lands the conservative answer.

**Seen on the main page.**

- **D1. A needed PR merging counts as activity.** Recommended: yes. GitHub folds the time the PR it needs merged into `activity`. Done and "until activity" already end on that today (test/desk.test.ts:1022). What's new: your PR gets the new dot when its blocker merges, and "+1" counts it; boards sorted "updated" (My PRs, Mentions, Collaborators) move it up; and the item page's "active … ago" counts it. `Lens.judge` keeps others' activity only, as the judge's queue reads it (judge.ts:378), so nothing is judged again. _Conservative:_ `freed` (+1 field).
- **D2. One "waiting since".** Recommended: yes. GitHub's `since` becomes what Blocked uses today: when it got blocked, if it's blocked; otherwise, for your PR waiting on reviewers, when you last asked; otherwise today's request time or created_at. What changes, for your PRs only: their age outside Blocked (Now, Today, Later, FYI and Merging rows) counts from that time instead of from when you opened them; a board sorted "waiting" orders them by it; and their quiet days, the hoist's included, count from it too. Others' PRs are unchanged. _Conservative:_ `waits_since` (+1 field). Guards: test/desk.test.ts:1075 and :1213.
- **D3. One weight orders a part and decides who keeps a capped slot.** Recommended: yes. GitHub's weight follows `queueOrder`: a close look of the current commit -3, of an earlier commit -2, your PR approved and green -1, the rest 0, someone else's PR with red CI 1, and a skip 2. What changes over a cap: a stale "look" keeps its slot before unreviewed PRs (they tie today); an unreviewed PR and a skim tie (the unreviewed one wins today); a stale skip leaves first (today it counts as unreviewed); others' red-CI PRs leave before skims; and your approved, green PRs keep their slot before your other PRs (rule order decides today). Capped cards no longer sort right after the close looks, and a capped skip shows the cap's words instead of "the AI says skip it" (rules.ts:223). _Conservative:_ `capped` and `Row.rank` (+1 lens field, +1 row field). Guard: test/rules.test.ts:102.
- **Q. Agents' questions become the second plugin.** Recommended: yes, after D1 to D3, since it's your own example of a source. One visible step adds src/plugins/questions.ts:
  - **Items.** `questions:<hex>` items take kv `inquiries`' place, imported once, with today's cap. They're put quietly, so desk_events doesn't change.
  - **Asking.** `ask(body, resolve)` keeps `Desk.inquire`'s checks and words. server.ts wires it to `POST /api/inquiries`, passes `desk.itemId` as `resolve` (the item is still checked last), and notifies in today's words.
  - **Lens.** While a question is open: `needs: { by: "you", why: "<from> asks" }`, part `"asks"` (before "back"), `arrive: "silent"`, and `refuse` in place of `handoff`, covering done, snooze, mute, pin and hand off, in words saying your agent waits on your answer.
  - **Answering.** Answer and Dismiss keep their own route, not `Desk.write`. `answer()` reads the item without the config check, so you can answer while config.toml has errors (a test). server.ts passes the answer to your agent as today, and nothing enters the action log.
  - **What you'd see:** the tray menu, `desk ls` and desk_list list open questions as Now items, and `QueueView.inquiries` goes. The rows and `InquiryPage` look the same.
  - **What it adds to the core:** part "asks", `refuse` for `handoff`, and the hoist passing part "asks" with no board and never quiet, as questions are today. _Conservative:_ questions stay in desk.ts, as today, at no cost.

**For agents only.** Each is one commit, on your yes.

- **D4. Snooze words come only from what's offered now.** Recommended: yes. Today desk_act refuses a snooze until a kind the item doesn't offer now with 409 "can't wait until it's approved; it can until …". With D4 it's refused as an unreadable snooze time (400). The window is unchanged, since it offers only what `until` lists. _Conservative:_ `waits` (+1 member).
- **D5. blocked and unblocked events say source `github`** instead of `desk`. Recommended: yes. Only desk_events shows it. _Conservative:_ `put`'s `source` option.

**Offered, not assumed.**

- **F1. Tools on automations**. Recommended: yes, last. An automation gets `tools?: string[]`: tools you allow it beyond the desk's and the plugins'. An agent's edit already leaves it off until you turn it on, and the deny list still wins. _Conservative:_ not built.
- **F2. An automation as a source's prefilter**. Recommended: yes, last, as one rule key: `{ when = "…", bucket = "judge", judge = "<automation>" }`. The run gets the items, fenced, with its prompt and tools, and answers `{ bucket, why }` per item. Its answers are kept like the judge's, keyed by `Lens.judge` and the automation's `updated_at`. Floors and `final` bind them, and they never answer Blocked. That is the brief's "a Claude Code session with tools and a prompt" deciding what reaches you. _Conservative:_ not built; the judge with policy.md does it.

**Settled.** Ids carry their source in the prefix. The blocking fields stay `pr.blocked*`, so config.toml is never rewritten. AI takes things off your desk only by sorting them into FYI. Plugins are code in this repo, listed in `startServer`. There's one policy.md. The desk's own moves stay code over `needs`. Merging takes only what a plugin calls `yours`, which is your own PRs today.
