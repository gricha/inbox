# Errors are Effects

Every failure the desk expects travels as a typed value in an [Effect](https://effect.website) (`effect` 4.x), not as a
thrown exception or a rejected promise. A function that can fail says how in its type, `Effect.Effect<A, E>`, and the
places that finally answer for a failure (an HTTP response, a CLI exit, a toast) are few and named below.

Effect ships a guide for agents: `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/`. Read them, or the
`.d.ts` files, for API names: Effect 4 renamed much of v3 (`Effect.catch` not `catchAll`, `Effect.result` not
`either`, `Effect.callback` not `async`, `Effect.forkDetach` not `forkDaemon`, `Context` not `ServiceMap`). Where they
differ from this file (Schema errors, `Context.Service`/`Layer`/`ManagedRuntime`, `Effect.log*`), this file wins: no
services, `Data.TaggedError`, the desk's own `log`.

## Failures and defects

- A **failure** is something the desk expects and someone acts on: GitHub refused, `claude` isn't logged in, a file is
  missing, a ref matches two PRs, the rules have errors. It's a tagged error class in the error channel, so `catchTag`
  can recover from it and the compiler knows who still has to.
- A **defect** is a bug or a broken invariant: a `!` that was wrong, an unknown expression node, SQLite failing under
  the desk, the desk's home or `desk.db` failing to open. It stays untyped (a throw inside Effect code, or
  `Effect.die`) and ends at a boundary as a logged and reported 500, a crash line or a toast. Don't promote invariants
  into the error channel: they'd leak into every signature without anyone able to act on them. `Store` stays plain
  synchronous code for this reason.
- What isn't there isn't a failure: `null`, `undefined` or `Option` when absence is normal (no last action, no such
  setting). What's collected isn't one either: `parseConfig`'s and `putSettings`' `ConfigError[]`, a view's `ai_error`
  or `sync_error` text and `{ ok: false, errors }` answers stay data.
- A timeout is a failure (it's stored and shown: "no answer in 6 minutes, so it was stopped"). Interruption (the desk
  stopping, a client going away) isn't: it's never stored, shown or reported.
- A notification never fails what sent it: `notify` and `openUrl` ignore what `execFile` refuses as well as what it
  fails with. Deliberate change, with a test: text `execFile` refuses before starting anything (a NUL byte) now
  does nothing too, where it threw into the coordinator's or an automation's bookkeeping.

## Defining errors

- Server-side errors live in `src/errors.ts`, grouped by family: the HTTP refusals, the desk's own server
  (`ListenFailed`), the rules' expressions, files, child processes, Claude Code, GitHub. The UI's own (the desk
  unreachable, an API refusal) live in `web/src/api.ts`; the CLI's and MCP's client's (`DeskDown`, `DeskNoAnswer`,
  `DeskApiError` with the desk's `tag` and `reason`) in `src/client.ts`; the CLI's `UsageError` and `CliError` in
  `src/cli.ts`, MCP's `ToolInputError` in `src/mcp.ts`. Tags are unique across families: GitHub's 403 is
  `GitHubForbidden`, never `Forbidden`.
- `Data.TaggedError("Tag")<{ ...fields }>`. Not `Schema.TaggedError`: nothing needs decoding, and Schema costs the UI's
  bundle about 14 KB.
- Every error has a message the owner can read, in fixed words (tests, toasts, the CLI and the stored `*_error` fields
  show them verbatim): pass `message`, or give the class `override get message()`. An empty message erases a stored
  error (the coordinator's `coordinator_error`), so never leave one empty. A command whose caller has words of its own
  keeps them: `CommandNotFound`'s `hint` is its whole message, and `CommandFailed` and `CommandTimeout` take a `summary`
  ("codex failed: … Run it yourself: …", "launchctl bootstrap failed: …"). Deliberate change, with a test: a
  `CommandFailed` whose stderr is blank says "<command> exited with <code or signal>", and a `ClaudeApiError` with no
  words "claude failed: API error <status>" (both were empty).
- `cause` is only ever the original error object, kept as is when wrapping one: Sentry dedupes on its identity. Words
  that aren't an error go in a field of their own (Claude's login `detail`).
- The not-logged-in error's whole message is `NOT_LOGGED_IN`: `retryAgents`, `paused()` and the judge match it by suffix
  in the stored `aiErrors`, `aiPaused.why` and `judge.error`.
- The HTTP family carries its status as a getter. `isDeskHttpError` (by class) and `errorBody` turn one into the wire's
  `{ error, tag, candidates?, reason? }`.

### The HTTP family, site by site

| Tag                 | Status | Where                                                                                                                |
| ------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| `BadRequest`        | 400    | what you sent: the routes' `need { … }`, `line`/`paragraphs`/`parseUntil`, hold's unreadable ref, automations' `set` |
| `Forbidden`         | 403    | the host/origin/cross-site middleware, `fromUi`, the desk-window-only routes, an agent's hand-off                    |
| `NotFound`          | 404    | resolve's unknown or unreadable ref, a board, an ask, an inquiry, an automation, an `/api/*` route, `fromUi`'s loop  |
| `AmbiguousRef`      | 409    | resolve's ref matching several items, with `candidates`                                                              |
| `Stale`             | 409    | `putPolicy`'s and `putConfig`'s stale base, approve's and `githubAct`'s stale head                                   |
| `Busy`              | 409    | a held `approving`/`sending` lock                                                                                    |
| `Conflict`          | 409    | every other state that refuses: in Merging, not yours, already answered, your agent is off, no GitHub writer         |
| `Upstream`          | 502    | a GitHub write or read the desk passes on, your agent not starting (`cause`: the original error)                     |
| `ReviewersNotAsked` | 502    | ready for review landed, asking the reviewers didn't: nothing is rolled back                                         |
| `Unavailable`       | 503    | `reason: "starting"` (the first sync), `reason: "config"` (the rules have errors)                                    |

Recoveries: `itemId` catches `NotFound` by its tag (plus the exact-id check); `hold` catches `NotFound` and lets
`AmbiguousRef` and `Unavailable` through; `inquiryView` turns any `DeskHttpError` into `card: null`. A file the desk
writes or reads for a request (`replaceFile`, config.toml, policy.md, settings.json) fails with `FsError` in Node's
words, which a route answers as a logged 500. A stale base (`putPolicy`, `putConfig`) or head (`approve`, `githubAct`)
answers 409 `Stale`, and a held lock 409 `Busy`; the UI shows any of them by its words. The GitHub writes, `hold` and
`reviewers` keep GitHub's error as `Upstream`'s `cause`, one `report()` hasn't sent, so Sentry sees each 502.

Deliberate changes, each with a test: `reviewers` answers `Upstream` 502 with GitHub's words (was a 500);
`wakeCoordinator`'s refused argument is a `BadRequest` like `ask`'s (was a 500); `focus` and `askAbout` with broken
rules answer `Unavailable` "config" (was a TypeError 500); a body that isn't a JSON object at the routes that parse one
(`json`) is a `BadRequest` "the body must be a JSON object" (was a 500), and `bodyOf`, for the routes that say what they
need of it, reads JSON `null` or an array as `{}` too. `Unavailable` and `ReviewersNotAsked` say "config has errors:
<path>: <msg>; …", "desk is starting; the first sync can take a minute" and "Marked it ready, but GitHub didn't ask for
the reviews: …". Additive, with a test: an `/api/*` path the desk doesn't route, and one under `/api` or `/health` that
`fromUi` won't pass to Vite, answer `{ error: "not found", tag: "NotFound" }` (there was no tag), and the
host/origin/cross-site middleware's 403s carry `Forbidden`.

## Writing Effect code

- A function that can fail returns `Effect.Effect<A, E>`, with no requirements (`R` is `never`). Its body is
  `Effect.gen`, or `Effect.fn("name")` / `Effect.fnUntraced` for a reusable function. In a class, an entry point that
  wants a span is a field: `readonly approve = Effect.fn("Desk.approve")({ self: this }, function* (id: string) { … })`;
  other methods return `Effect.gen({ self: this }, function* () { … })`.
- Costs: `Effect.fn` about 3.4 µs a call (it captures a stack), `Effect.gen` 0.9 µs, `Effect.fnUntraced` 0.3 µs, a
  failure 8 µs. Fine per request; never on something called per item, per row, per rule or per store read. Pure, total
  code stays plain functions: `compute`, `card`, `analyze`, `normalize`, `snapshot`, the view and format helpers, the
  parsers' insides. A cheap synchronous check called per row returns a `Result`; Effect code lifts it with
  `yield* Effect.fromResult(r)` (v4 can't `yield*` a `Result` or an `Option`).
- Fail with `return yield* new SomeError({ … })`: the `return` tells TypeScript nothing runs after it. Never `throw` a
  tagged error inside a generator body, a `map`/`sync` callback or a `catch:` handler: it becomes a defect, a 500 and a
  Sentry report instead of a 409. `throw` inside Effect code is for bugs only.
- A body with no `yield*` isn't a generator (lint's `require-yield`): use `Effect.sync`, `Effect.succeed` or a plain
  function. `Effect.void`, not `Effect.succeed(undefined)`. An `Effect.suspend` returning either a fail or a success
  annotates its return type. Declare `signal` in a callback or `tryPromise` only when it's used.
- **An Effect nobody runs does nothing**, and no check catches it (TypeScript 7 can't load Effect's language service).
  When a function's return type becomes an Effect, the same commit visits every call site (`git grep -n '\bname('`) and
  yields or runs each one.
- Promise APIs: `Effect.tryPromise({ try: (signal) => fetch(url, { signal }), catch: (cause) => new X({ … }) })`. Always
  pass `catch`: the one-argument `Effect.try(fn)` / `Effect.tryPromise(fn)` fail with `UnknownError`, "An error occurred
  in Effect.try", and those words would reach the owner. Never `Effect.promise` for something that can fail in an
  expected way: its rejection becomes a defect.
- Throwing synchronous APIs (fs, `JSON.parse` of what someone else wrote): `Effect.try({ try, catch })`.
- A synchronous caller (`readSettings`, a cache made in a constructor) runs an Effect with `Effect.runSync` only while
  it has no async step: over a `tryPromise` or `callback` it throws `AsyncFiberError` when it runs, so an Effect a sync
  caller runs stays on the fs sync APIs.
- Child processes and emitters: `Effect.callback((resume) => { …; return cleanup })`. The cleanup runs only when the
  fiber is interrupted (a timeout, the desk stopping), and interruption waits for it. So the `close` handler itself
  clears the child's timer and listeners, then calls `resume` once; the cleanup kills the group through `children.ts`'s
  `kill` and waits for `close` (bounded by SIGKILL after the grace period), so an interrupted run has exited before its
  fiber ends. A child's own timeout stays an unref'd `setTimeout` inside the callback. `children.ts` tracks every child,
  so `desk.close()` reaches whole process groups.
- Retries: GitHub reads retry with
  `Effect.retry(Schedule.exponential(delay, 3).pipe(Schedule.setInputType<E>(), Schedule.while(({ input }) => retryable(input)), Schedule.upTo({ times: 2 }), Schedule.tap(({ input, attempt }) => Effect.sync(() => log(`${input.message}; retry ${attempt}/2`)))))`:
  3 attempts, the delay then 3× it, no jitter, a log line for each retry. Not the `{ times, while }` options together
  with a tapping schedule (it logs retries that never happen). Never retry a GitHub write: a timed-out one may have
  landed. Deliberate change, with a test: a rate limit's `Retry-After` sent as a date is read as one, and one that can't
  be read waits a minute (it was a `RangeError`).
- Timeouts: `Effect.timeout(d)` fails with `TimeoutError`; map it to the domain error and its words.
- **Effect's timers keep the process up**: a fiber left in `Effect.sleep` or a `Schedule` keeps `node --test` from
  exiting, silently. Periodic loops (the connector's poll and feed, the judge's backoff, the coordinator's ticker,
  automations' minute) keep their unref'd Node timer and fork one runner Effect per tick. `Effect.sleep`, `Schedule` and
  `timeout` are for waits inside one run: retries, the activity long-poll.
- **A write and what the desk records after it are one `Effect.uninterruptible` region**: the GitHub write (approve,
  reply, comment, inline, ready and asking reviewers, the More menu's), then `logWrite`, `doneAfterWrite`/`act`/`undo`,
  `wrote`, and `ask`'s rollback. A request going away never cancels a write the desk started or skips its bookkeeping;
  the write's own timeout still applies inside it. Never `restore` around the write.
- Locks (`approving`, `sending`): taken before the region, released with `Effect.ensuring` after it; a held lock fails
  at once with `Busy`, never queues. The region (`Desk.locked`) is the lock's check, the write, its bookkeeping and the
  release, so nothing can interrupt it between taking the lock and the write.
- Caches and singleflight: never `Effect.cached` where a failure must be retried (it caches failures). A keyed cache
  (`prContext` by the PR's id, node and `updated_at`, the GitHub token) is
  `Cache.makeWith(lookup, { capacity, timeToLive: (exit) => (Exit.isFailure(exit) ? Duration.zero : Duration.infinity) })`,
  with `Cache.invalidate` on a 401 (the token) or after your reply (`prContext`). Work shared by callers who may leave
  (an AI review, `fetching`) is forked through the runner and completes a `Deferred` kept in its Map, so
  `generating.has(id)` and `.size` stay synchronous; callers `Deferred.await` it, and the fiber deletes the entry (and
  does its bookkeeping) before it completes the Deferred, which keeps no failure: the next caller starts a fresh run
  (`Desk.shared`). The desk stopping interrupts the fiber, which ends its callers with it; a stopped desk starts none
  and ends them at once.
- Interruption records nothing: no `onExit`, `ensuring` or `onInterrupt` writes the store or notifies (a cut automation
  run keeps `done_at: null`, so the next start marks it cut). Finalizers only kill children, clear timers and release
  locks. An `ensuring` inside a write's uninterruptible region never sees an interruption: `markReady`'s and
  `askReviewers`' refresh of the PR, forked whatever GitHub said, is one.

## No throw, no catch

Outside these exceptions there is no `throw`, `try`/`catch`, `.catch(` or `Promise.reject` for an expected failure:

- `throw` for a defect, `!` assertions and `throw new Error("unreachable: …")` stay.
- A module's private recursive parser or evaluator may throw to unwind and convert once, at its exported edge, to a
  `Result` or an Effect (`expr.ts`'s `compile` and `Compiled.eval`, with `Result.try`).
- `electron/preload.cjs`: sandboxed CommonJS, it can't load `effect`.
- Tests and the shots' Playwright steps are `node:test` / Playwright code: they run Effects through
  `test/helpers/run.ts`.

Recover with `Effect.catchTag`/`catchTags` for a specific failure, `Effect.catch` for every typed one. `Effect.ignore`
only where the desk deliberately ignores a failure (with a one-line why), and `Effect.catchCause` only at a boundary or
a loop's pass.

## Background work

`desk.runner.fork(what, effect, item?)` (`src/runner.ts`) is the only way the desk starts work nobody waits on: a sync
after a reload, the loops' passes, an AI review, the judge, the coordinator's run, an automation, the `gh.refresh` after
a write. It runs each in a trace of its own (a fiber keeps the context it was forked in, so a loop forked from a
request would carry that request's trace), logs `Cause.pretty` and reports a failure or a defect under `what`, says
nothing about interruption or anything that ends after `stop()`, and `stop()` interrupts every fiber. From Effect code:
`Effect.sync(() => desk.runner.fork(…))`.

- Each site handles its expected failures itself (stores its `*_error`, logs in its own words, calls
  `report(err, what)` once), so the runner mostly sees bugs.
- Deliberate change, with tests: the desk stopping interrupts the coordinator's run and an automation's run in flight,
  which then record, notify and report nothing (the coordinator's kept going and wrote to the closed store; an
  automation's reported a spurious "stopped"). A cut automation run keeps `done_at: null`.
- A loop's pass catches a defect (`Effect.catchCause`, log and report) and keeps its schedule: a desk that hit a bug in
  one sync keeps syncing, where an unhandled rejection used to end it.
- Deliberate change, with a test: the full pass after a write's refresh (approve, a reply, a comment, a line's comment)
  runs in the refresh's own fiber, `gh.refresh(id)` and then every connector's `reconcile`, so the desk stopping
  interrupts it (it ran in a nested `Effect.runPromise` the runner didn't hold, which kept going into the closed store).
- Deliberate change, with a test: what fails one of an automation's items (`push`'s refusal) is still that item's
  error, and the run goes on; a bug in `push` fails the run, reported and notified once (it was the item's error, never
  reported).
- `Effect.runFork` and `Effect.forkDetach` appear nowhere else in `src/` (a forked failure nobody observes vanishes),
  `Effect.forkChild` never for work that must outlive its caller (it's interrupted when the caller ends), and never
  `void Effect.runPromise(…)` (an unhandled rejection ends the desk). A promise nobody waits on is a lint error, `void`
  included (`typescript/no-floating-promises` without `ignoreVoid`; `.oxlintrc.json` says where): fork its work
  through the runner, await it, or, only where dropping it is right, handle it with a one-line why.
- `desk.sync()` runs its pass in its caller's fiber (tests and `init` await it); only the timers' passes and `POST
/api/sync`'s are forked.
- Deliberate change, with a test: a file the desk watches (policy.md, settings.json, config.toml) that changed on disk is
  read again through the runner (`Desk.edited`), so one it can't read is logged (`config.toml failed: …`) and reported,
  and the desk keeps what it had (it was an uncaught exception from the watcher, which ended the desk).
- An AI review (`runAi`) keeps what fails it, a bug too, as that commit's `aiErrors` in its words, reported once and
  logged with the login's own words when it's `ClaudeNotLoggedIn` (told by its tag); `retryAgents` and `paused()`
  read the stored words by suffix. `aiReview` answers it as `Upstream` 502 with it as the cause.

## Boundaries

Each runs an Effect whose failures it answers for, and nothing gets past it unhandled.

- **HTTP** (`src/server.ts`): a route runs its Effect with `Effect.runPromiseExit`, through `respond(c, effect, { log, read? })`,
  every route (one that can't fail through `Effect.sync`, the static files, `fromUi` and the SSE stream as the
  `Response` they build, which `respond` passes on); the host/origin/cross-site middleware runs its check with
  `Effect.runSyncExit` and answers its `Forbidden` the same way, and `onError` sees only a bug. Only reads and waits (GET views,
  `/api/activity`, the SSE streams) pass `{ signal: c.req.raw.signal }`, so a client going away interrupts them; a write
  and any work shared with other callers never take the request's signal: nor does opening a PR (`GET /api/review/:id`),
  which starts its AI review and Claude's read once its diff and conversation are in; its `?ahead=1` prefetch does. A
  `DeskHttpError` answers with its status and `errorBody`. An interrupt-only exit (`Cause.hasInterruptsOnly`) means the client left: answer `new Response(null,
{ status: 499 })`, log and report nothing. Any other failure or a defect is a 500 `{ error, tag: "Internal" }`, logged
  with `Cause.pretty`. For an answer of 500 or more (Internal, `Upstream`, `ReviewersNotAsked`) the route sets
  `c.error` to `Cause.squash(exit.cause)` (the failure itself, never a Cause) before returning, so the Sentry middleware
  decides: it reports a 5xx except a 503 or one whose cause `report()` already sent.
- **Background**: the runner, above.
- **CLI** (`src/cli.ts`): `main` runs one Effect and maps its exit. `UsageError` (and parseArgs' `ERR_PARSE_ARGS_*`,
  turned into one where parseArgs is called) exits 2 with `desk: <msg>` and "run 'desk help' for usage". `DeskDown`
  prints its message alone, exit 1. Any other failure, or a defect, prints `desk: <message>`, exit 1. stdout is flushed
  before `process.exit`. `DeskApiError`'s message ends in " — candidates: a, b"; a client timeout (`DeskNoAnswer`) says
  "The operation was aborted due to timeout". `ls` lists the boards on a `NotFound` and `config` works offline on
  `DeskDown`, both by tag. `status --short` ends in `Effect.catchCause`: whatever happens it prints a status word, exit
  0, and tells a config error from starting by the 503's `reason`. `serve` yields `startDesk`, and refreshes the
  skill through the desk's runner.
- **MCP** (`src/mcp.ts`): a tool's failure is its `isError` text; a defect is also logged (the desk's log at `/mcp`,
  stderr for `desk mcp`). Tools take no signal: `desk_inquiry`'s wait is an `Effect.sleep` loop of at most a minute.
- **Electron** (`electron/main.ts`): an IPC handler runs its Effect and rejects with a plain `Error(message)` (only the
  message survives the structured clone). Callbacks that must answer synchronously (`will-quit`, `desktop:theme`'s
  `returnValue`, `will-navigate`, the window-open handler) stay plain code and fork only their async tail.
  `ipcAnswer` (`electron/lib.ts`) is that boundary: `Forbidden` "not allowed" for a page that isn't the desk's, `BadRequest`
  "no such theme", and a bug logged too. The app's own failures live in `electron/lib.ts` (`DeskCallFailed`, `DeskFailed`,
  `ElectronRefused`, `NoFreePort`), beside `FsError` and `CommandFailed`. What it starts and nobody waits on (its start,
  following the desk, the tray's refresh, a link or Settings it opens, Sync now, a start page, quitting) goes through one
  runner, `appRunner(log)`: src's `Runner`, logging to desk.log and reporting if the app ever reports. A start page the next
  load supersedes (`ERR_ABORTED`) is no failure. Following the desk's events is a loop whose pass logs a bug and goes on.
  Quitting closes the desk or stops the checkout's, each failure logged, then `app.exit(0)` whatever happened. A file the
  app keeps for itself (window.json, theme.json, live.json) that's missing or isn't JSON reads as `null` (`readJson`); a
  pid that's gone or a log line it can't write is nothing (`tryOr`, `quietly`). Deliberate changes, each with a test: a
  node that `spawn` refuses at once (a NUL byte in its path) is a failure the restart loop of the desk from a checkout
  handles like one that fails to start (it threw: an uncaught exception in the main process, or `startSource` rejecting),
  and `commandOutput` gives no output for one (it rejected); what fails the app's background work (`startSource`, a login
  item Linux refused, a link the OS didn't open, Settings or Sync now) is logged as `<what> failed: …`, where it was an
  unhandled rejection or ignored.
- **UI** (`web/src`): `api.ts` answers with Effects failing with the UI's own tagged errors. Components run them through
  one helper, `runUi(effect, { signal? })`: `Effect.runPromiseExit`, ignoring an interrupt-only exit, reporting any
  other uncaught cause to Sentry, never rejecting. Reads pass their effect's signal; writes pass none, so an unmount
  never interrupts a write.

### The wire

An error answers `{ error, tag, candidates?, reason? }`. `tag` and `reason` are additive: every reader (the client, the
CLI, MCP, the UI) decodes `tag ?? fromStatus(status)` (400 BadRequest, 403 Forbidden, 404 NotFound, 409 AmbiguousRef
with candidates else Conflict, 502 Upstream, 503 Unavailable, else Internal), and a 503's `reason ?? (error includes
"config" ? "config" : "starting")`, so an older desk still reads right. A 409 from PUT `/api/policy` or `/api/config` is
`Stale` whatever its tag; a reply that isn't JSON (the UI-starting page, a proxy's error page) is the desk unreachable.

## Desk's shape

- `new Desk(opts)` is a constructor; its I/O failing (the home, `desk.db`) is a startup defect that `startServer`'s
  caller shows. A `settings.json` it can't read is a problem on the Settings page: the constructor, the file's watcher
  and the desktop app read it once with `readSettings`, which folds `loadSettings`' `FsError` into the errors and gives
  the text it read (`null` for one it couldn't). Deliberate change, with a test: one that can't be read (a directory)
  threw from the constructor, and from the watcher. `init()` returns an Effect: GitHub's viewer failing, a first config
  it can't write for want of your GitHub context (`Upstream`, "couldn't read your GitHub context to write a first
  config: …") or a file it can't read or write (`FsError`) fails it, and `startServer`'s caller shows the words.
  `startDesk` is the Effect (failing with `ListenFailed`, "port N is in use; is desk already running? (url)", too);
  `startServer` runs it for a caller that awaits it (the desktop app) and rejects with the failure itself, and its
  `close()` is a Promise. A port it can't listen on stops the desk it made, as init failing does, so a retry leaves no
  store open. `stop()` is synchronous: it interrupts the runner's fibers, unwatches the files and closes the store.
  `close()` is an Effect that stops the desk at once and also waits for `stopAll()`.
- Internal helpers that run after a snapshot (`top`, `summary`, `card`, `queueCard`, `needsCards`, `compute`) assert the
  config (`this.loaded!`, a defect); only an entry point checks it as a failure (`requireConfig`, or `resolve`, which
  checks it first). The hooks the connectors call (`synced`, `rebaseConflicts`, `handBackUnasked`, `trackBlocked`,
  `notifyNew`, `pumpAi`) stay `void` and never fail: a check they share with a request keeps a non-failing core
  (`handBackUnasked` calls `sendBack`, the core `handBack` runs after validating).
- The desk's synchronous layer (the validators, `act`, `undo`, the views, the inquiries, the policy, settings and config
  writes) answers with Effects that have no async step, so a test can `runSync` one.
- The fields tests watch keep their types: `coordinator.flushing` (a `Promise<void> | null` that never rejects),
  `automations.running` (a Map whose values keep `.p`), `judge.running` and `judge.timer`, the connector's `syncing`,
  `polling`, `pausedUntil` and `feedError`, the desk's `generating` (`.has`, `.size`), `warming`, `waiters`,
  `aiErrors` and `aiPaused`. A change that drops one rewrites the tests that read it.

## Testing

- `test/helpers/run.ts`: `await run(desk.approve(...))`, `runSync(desk.act(...))`; for a refusal
  `assert.equal((await failure(desk.act(...)))._tag, "Conflict")`. `run` and `runSync` throw the typed failure itself
  (so `assert.throws(…, { status: 409 })` still reads), but fail the test on a defect: a tagged error thrown where it
  should have been yielded doesn't pass as a refusal.
- Fakes of the desk's injection points (GitHub, its writer, the review deps, the coordinator) return Effects:
  `Effect.succeed(x)`, `Effect.fail(new GitHubHttpError({ … }))`. An interface changes in the commit that changes its
  implementation, which updates every fake, monkeypatch, stub and script that implements or calls it.
- Mock timers with `t.mock.timers.enable({ apis: ["setTimeout"] })` (add `"Date"` if needed), never the default set:
  Effect's scheduler yields on `setImmediate`. `tick()` resumes a sleeping fiber synchronously.
- TypeScript 7 has no JS API (no `ts.createSourceFile`, no ts-morph): a codemod over many call sites uses `oxc-parser`
  and `magic-string` from `node_modules`, and typechecks with `npm run typecheck`.
