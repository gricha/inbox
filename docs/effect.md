# Errors are Effects

Every failure the desk expects is a typed value in an [Effect](https://effect.website) (`effect` 4.x), never a thrown
exception or a rejected promise. A function that can fail says how in its type, `Effect.Effect<A, E>`. A few named
[boundaries](#boundaries) answer for what fails.

For API names, read `node_modules/effect/AGENTS.md`, `node_modules/effect/ai-docs/` or the `.d.ts` files. Effect 4
renamed much of v3: `Effect.catch` (not `catchAll`), `Effect.result` (not `either`), `Effect.callback` (not `async`),
`Effect.forkDetach` (not `forkDaemon`), `Context` (not `ServiceMap`). Where Effect's guide differs, this file wins: no
services (`Context.Service`, `Layer`, `ManagedRuntime`), `Data.TaggedError` not Schema errors, the desk's own `log` not
`Effect.log*`.

## Failures and defects

- **A failure is expected, and someone acts on it**: GitHub refused, `claude` isn't logged in, a file is missing, a ref
  matches two PRs. It's a tagged error in the error channel, so `catchTag` can recover and the compiler tracks who must.
- **A defect is a bug or a broken invariant**: a wrong `!`, an unknown expression node, SQLite failing, the home or
  `desk.db` failing to open. It stays untyped (a `throw` inside Effect code, or `Effect.die`) and ends at a boundary as a
  logged, reported 500, a crash line or a toast. Why: invariants in the error channel leak into every signature with
  nobody able to act. That's why `Store` stays plain synchronous code.
- **Absence isn't a failure.** Use `null`, `undefined` or `Option`.
- **Collected problems are data**: `ConfigError[]` from `parseConfig`/`putSettings`, a view's `ai_error` or
  `sync_error`, `{ ok: false, errors }` answers.
- **A timeout is a failure** (stored and shown). **Interruption is not**: the desk stopping or a client leaving is never
  stored, shown or reported.
- **A notification never fails its sender**: `notify` and `openUrl` ignore whatever `execFile` refuses or fails with.

## Defining errors

| Errors                                                                                                           | File              |
| ---------------------------------------------------------------------------------------------------------------- | ----------------- |
| The server's: HTTP refusals, `ListenFailed`, expressions, files, child processes, agents, decision model, GitHub | `src/errors.ts`   |
| The UI's (desk unreachable, an API refusal)                                                                      | `web/src/api.ts`  |
| The CLI's and MCP's client: `DeskDown`, `DeskNoAnswer`, `DeskApiError`                                           | `src/client.ts`   |
| `UsageError`, `CliError`                                                                                         | `src/cli.ts`      |
| `ToolInputError`                                                                                                 | `src/mcp.ts`      |
| The desktop app's: `DeskCallFailed`, `DeskFailed`, `ElectronRefused`, `NoFreePort`                               | `electron/lib.ts` |

- **Use `Data.TaggedError("Tag")<{ ...fields }>`.** Not `Schema.TaggedError`: nothing needs decoding, and Schema adds
  about 14 KB to the UI's bundle.
- **Tags are unique across families.** GitHub's 403 is `GitHubHttpError` with its `status`, or `GitHubRateLimited` for a
  read's rate limit. Never `Forbidden`.
- **Every error has a message the owner can read, in fixed words, never empty.** Why: tests, toasts, the CLI and stored
  `*_error` fields show it verbatim, and an empty message erases a stored error. Pass `message` or override
  `get message()`, with a fallback that's never blank (`CommandFailed` with blank stderr: "<command> exited with
  <code>").
- **A caller with its own words keeps them**: `CommandNotFound`'s `hint`, a `summary` on `CommandFailed` and
  `CommandTimeout`.
- **`cause` is only the original error object, unchanged.** Why: Sentry dedupes on its identity. Other words get their
  own field (`detail`).
- **The not-logged-in message is fixed text** (`NOT_LOGGED_IN`, `CODEX_NOT_LOGGED_IN`, `OPENCODE_NOT_LOGGED_IN`). Why:
  `retryAgents`, `paused()` and the judge match it by suffix in stored errors.
- **The HTTP family carries `status` as a getter.** `isDeskHttpError` (by class, not tag) and `errorBody` turn one into
  [the wire](#the-wire)'s body.

### The HTTP family, site by site

| Tag                 | Status | Raised by                                                                                                      |
| ------------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| `BadRequest`        | 400    | what you sent: a route's `need { … }`, an unreadable ref in `hold`, a body that isn't a JSON object (`json()`) |
| `Unauthorized`      | 401    | another device (through `tailscale serve`) with no token this desk issued, or a revoked one                    |
| `Forbidden`         | 403    | the host/origin/cross-site middleware, `fromUi`, the desk-window-only routes, an agent's hand-off              |
| `NotFound`          | 404    | an unknown ref, board, ask, inquiry, automation or `/api/*` route                                              |
| `TooManyRequests`   | 429    | pairing past five tries a minute (`Remote.trade`)                                                              |
| `AmbiguousRef`      | 409    | a ref matching several items, with `candidates`                                                                |
| `Stale`             | 409    | a stale base (`putConfig`) or head (`approve`, `githubAct`)                                                    |
| `Busy`              | 409    | a held `approving` or `sending` lock                                                                           |
| `Conflict`          | 409    | any other state that refuses: in Merging, not yours, already answered, your agent is off                       |
| `Upstream`          | 502    | a GitHub write or read the desk passes on, your agent not starting (`cause`: the original error)               |
| `ReviewersNotAsked` | 502    | ready for review landed but asking reviewers didn't; nothing is rolled back                                    |
| `Unavailable`       | 503    | `reason: "starting"` (the first sync) or `"config"` (the rules have errors)                                    |

- A file read or written for a request fails with `FsError` in Node's words: a logged 500.
- The GitHub writes, `hold` and `reviewers` keep GitHub's error as `Upstream`'s `cause`, so Sentry sees each 502.

## Writing Effect code

- **Shape.** Return `Effect.Effect<A, E>` with `R` as `never`. The body is `Effect.gen`, or `Effect.fn("name")` /
  `Effect.fnUntraced` for a reusable function. A class method returns `Effect.gen({ self: this }, function* () { … })`
  (`Desk.approve`).
- **Keep Effect off hot paths.** Per call: `Effect.fn` ~3.4 µs, `Effect.gen` 0.9 µs, `Effect.fnUntraced` 0.3 µs, a
  failure 8 µs. Fine per request; never per item, row, rule or store read. Pure code stays plain functions (`compute`,
  `card`, `analyze`, `normalize`, the view helpers). A cheap per-row check returns a `Result`; lift it with
  `yield* Effect.fromResult(r)` (v4 can't `yield*` a `Result` or `Option`).
- **Fail with `return yield* new SomeError({ … })`.** The `return` tells TypeScript nothing runs after it.
- **Never `throw` a tagged error** in a generator, a `map`/`sync` callback or a `catch:` handler. Why: it becomes a
  defect, a 500 and a Sentry report instead of, say, a 409.
- **No generator without `yield*`** (lint's `require-yield`): use `Effect.sync`, `Effect.succeed` or a plain function.
  `Effect.void`, not `Effect.succeed(undefined)`.
- **An Effect nobody runs does nothing**, and no check catches it (TypeScript 7 can't load Effect's language service).
  When a return type becomes an Effect, visit every call site in the same commit (`git grep -n '\bname('`).
- **Promises: `Effect.tryPromise` with a `catch`, always.**
  `Effect.tryPromise({ try: (signal) => fetch(url, { signal }), catch: (cause) => new X({ … }) })`. Why: without
  `catch` it fails with `UnknownError` "An error occurred in Effect.try", and those words reach the owner. Never
  `Effect.promise` for something that can fail: its rejection becomes a defect.
- **Throwing sync APIs** (fs, `JSON.parse` of someone else's text): `Effect.try({ try, catch })`; for files,
  `catch: fsError("write", file)`.
- **`Effect.runSync` only over an Effect with no async step.** Why: over `tryPromise` or `callback` it throws
  `AsyncFiberError`. So an Effect a sync caller runs (`readSettings`) stays on fs sync APIs.
- **Child processes: `Effect.callback((resume) => { …; return cleanup })`, through `children.ts`.**
  - The `close` handler clears the child's timer and listeners, then calls `resume` once.
  - The cleanup runs only on interruption. It kills the process group (`children.ts`'s `kill`) and waits for `close`
    (SIGKILL after a grace period), so an interrupted run has exited before its fiber ends.
  - The child's own timeout is an unref'd `setTimeout` inside the callback.
  - Never `execFile`'s `signal` option: it can SIGTERM the desk's own process group.
- **Retries: GitHub reads only, never writes** (a timed-out write may have landed). The schedule, in
  `src/github/client.ts`:
  ```ts
  Schedule.exponential(delay, 3).pipe(
    Schedule.setInputType<E>(),
    Schedule.while(({ input }) => retryable(input)),
    Schedule.upTo({ times: 2 }),
    Schedule.tap(({ input, attempt }) => Effect.sync(() => log(`${input.message}; retry ${attempt}/2`))),
  );
  ```
  Don't use the `{ times, while }` options with a tapping schedule: it logs retries that never happen.
- **Timeouts belong to the request**: `AbortSignal.timeout` in a fetch, an unref'd timer in a child's callback. Map what
  it fails with to the domain error. No `Effect.timeout`.
- **Effect's timers keep the process up.** A fiber left in `Effect.sleep` or a `Schedule` silently keeps `node --test`
  from exiting. So periodic loops (the connector's poll, the judge, the coordinator's ticker, automations) use an
  unref'd Node timer and fork one runner Effect per tick. `Effect.sleep` and `Schedule` are only for waits inside one
  run (retries, `halt`, `desk_inquiry`'s minute).
- **A GitHub write and its bookkeeping are one `Effect.uninterruptible` region**: the write, then `logWrite`,
  `doneAfterWrite`/`act`/`undo`, `wrote`, `ask`'s rollback. Why: a client leaving must never cancel a started write or
  skip its record. Never `restore` around the write.
- **Locks (`approving`, `sending`)** are taken at the start of that region (`Desk.locked`) and released by its
  `Effect.ensuring`. A held lock fails at once with `Busy`; it never queues.
- **Never `Effect.cached` where a failure must be retried**: it caches failures. Use
  `Cache.makeWith(lookup, { capacity, timeToLive: (exit) => (Exit.isFailure(exit) ? Duration.zero : Duration.infinity) })`,
  with `Cache.invalidate` when the value goes stale (a 401 for the token).
- **Shared work (`Desk.shared`)**: work several callers wait on, any of whom may leave (an AI review, `fetching`), is
  forked through the runner and completes a `Deferred` kept in a Map; callers `Deferred.await` it. The fiber deletes the
  entry before completing, and keeps no failure, so the next caller starts fresh.
- **Interruption records nothing.** No `onExit`, `ensuring` or `onInterrupt` writes the store or notifies. Finalizers
  only kill children, clear timers and release locks.

## No throw, no catch

No `throw`, `try`/`catch`, `.catch(` or `Promise.reject` for an expected failure. Exceptions:

- `throw` for a defect: `!` assertions, `throw new Error("unreachable: …")`.
- A private recursive parser may throw to unwind, converting once at its exported edge (`expr.ts`, with `Result.try`).
- `Store.tx`'s rollback rethrows the defect it caught.
- `electron/preload.cjs`: sandboxed CommonJS, it can't load `effect`.
- Tests may use `Effect.runPromiseExit`, `runFork` or `runPromise` directly to assert on an exit, hold or interrupt a
  fiber, or expect a rejection.
- `scripts/` are plain Node, Electron and Playwright tools.

To recover: `Effect.catchTag`/`catchTags` for a specific failure, `Effect.catch` for every typed one. `Effect.ignore`
only where ignoring is deliberate, with a one-line why. `Effect.catchCause` only at a boundary or in a loop's pass.

## Background work

`desk.runner.fork(what, effect, item?)` (`src/runner.ts`) is the only way the desk starts work nobody waits on. From
Effect code: `Effect.sync(() => desk.runner.fork(…))`. The runner:

- runs each fork in its own trace (a fiber keeps the context it was forked in, so a loop forked from a request would
  carry its trace);
- logs `Cause.pretty` and reports any failure or defect under `what`;
- stays quiet about interruption and anything ending after `stop()`;
- `stop()` interrupts every fiber, synchronously.

Rules:

- **Each site handles its expected failures** (stores its `*_error`, logs in its words, `report(err, what)` once), so
  the runner mostly sees bugs. Example: `runAi` keeps any failure as that commit's `aiErrors`.
- **A loop's pass catches a defect** (`Effect.catchCause`, log, report) and keeps its schedule.
- **No other way to fork.** No `Effect.runFork` or `Effect.forkDetach` elsewhere in `src/` (an unobserved failure
  vanishes). No `Effect.forkChild` for work that must outlive its caller. No `void Effect.runPromise(…)` (an unhandled
  rejection ends the desk).
- **A promise nobody waits on is a lint error, `void` included** (`typescript/no-floating-promises` without
  `ignoreVoid`; `.oxlintrc.json` says where). Fork it, await it, or handle it with a one-line why.
- **Stopping interrupts everything in flight** (a sync, a write's refresh, the coordinator's run, an automation's run),
  which then records, notifies and reports nothing.

## Boundaries

Each boundary runs an Effect and answers for whatever fails.

- **HTTP** (`src/server.ts`): every route runs through `respond(c, effect, { log, read? })`.
  - A `DeskHttpError` answers with its status and `errorBody`.
  - An interrupt-only exit (`Cause.hasInterruptsOnly`) means the client left: 499, nothing logged or reported.
  - Anything else is a 500 `{ error, tag: "Internal" }`, logged with `Cause.pretty`.
  - For 500 and up the route sets `c.error = Cause.squash(exit.cause)`. The Sentry middleware reports a 5xx unless it's
    a 503 or `report()` already sent its cause.
  - Only reads and waits pass the request's signal (`read: true`), so a client leaving interrupts them. Writes and work
    shared with other callers never do; nor does opening a PR (`GET /api/review/:id`), which starts its AI review.
  - The host/origin/cross-site middleware answers its `Forbidden` the same way (`Effect.runSyncExit`). `onError` sees
    only bugs.
- **Background**: the runner, above.
- **CLI** (`src/cli.ts`): `main` runs one Effect and maps its exit. `UsageError` exits 2 with
  `desk: <msg>` and "run 'desk help' for usage". `DeskDown` prints its message alone, exit 1. Anything else prints
  `desk: <message>`, exit 1. stdout is flushed before `process.exit`. `status --short` always prints a status word,
  exit 0.
- **MCP** (`src/mcp.ts`): a tool's failure is its `isError` text; a defect is also logged. Tools take no signal.
- **Electron** (`electron/main.ts`):
  - `ipcAnswer` (`electron/lib.ts`) runs an IPC handler's Effect and rejects with a plain `Error(message)` (only the
    message survives the structured clone).
  - Callbacks that must answer synchronously (`will-quit`, `will-navigate`, the window-open handler) stay plain code and
    fork only their async tail.
  - Work nobody waits on goes through one runner, `appRunner(log)`, logging to desk.log.
  - A file the app keeps for itself (window.json, theme.json, live.json) that's missing or not JSON reads as `null`
    (`readJson`).
- **UI** (`web/src`): components run `api.ts`'s Effects through `runUi(effect, { signal? })` (`Effect.runCallback`),
  which ignores an interrupt-only exit and logs and reports any other uncaught cause. It returns nothing, so there's no
  promise to drop. Reads pass a signal; writes don't, so an unmount never interrupts a write.

### The wire

An error answers `{ error, tag, candidates?, reason? }`. Every reader (the client, the CLI, MCP, the UI) decodes
`tag ?? BY_STATUS[status]` (409 with candidates is `AmbiguousRef`; unknown is `Internal`), and a 503's
`reason ?? (error includes "config" ? "config" : "starting")`, so an older desk without tags still reads right. In the
UI, a 409 from PUT `/api/config` is `Stale` whatever its tag, and a reply that isn't JSON means the desk
is unreachable.

## Desk's shape

- **`new Desk(opts)`** is a plain constructor; its I/O failing (the home, `desk.db`) is a startup defect.
- **`init()` and `startDesk` return Effects.** `startDesk` also fails with `ListenFailed`. `startServer` runs it for a
  caller that awaits it (the desktop app) and rejects with the failure itself.
- **`stop()` is synchronous**: it interrupts the runner, unwatches files and closes the store. Under a write in flight,
  the write's lock closes the store when it ends (`closeIfIdle`). **`close()`** is an Effect that also waits for that.
- **A stopped desk starts no new write**: `notStopped` ends it as interrupted (a 499) before it reads the store.
- **Config checks.** Helpers that run after a snapshot (`card`, `compute`, …) assert the config (`this.loaded!`, a
  defect). Only an entry point checks it as a failure (`requireConfig`).
- **The connectors' hooks never fail** (`synced`, `trackBlocked`, `notifyNew`, `pumpAi`, …): they stay `void`. A check
  shared with a request keeps a non-failing core.
- **The synchronous layer** (validators, `act`, `undo`, views, settings and config writes) answers with Effects that
  have no async step, so a test can `runSync` one.
- **The fields tests watch keep their types**: `coordinator.flushing` (a `Promise<void> | null` that never rejects),
  `automations.running` (a Map whose values keep `.p`), `judge.running`, `judge.timer`, the connector's `syncing`,
  `polling`, `pausedUntil` and `feedError`, the desk's `generating` (`.has`, `.size`), `warming`, `waiters`, `aiErrors`
  and `aiPaused`. A change that drops one rewrites the tests that read it.

## Testing

- **Run Effects with `test/helpers/run.ts`**: `await run(desk.approve(...))`, `runSync(desk.act(...))`, and for a
  refusal `(await failure(desk.act(...)))._tag`. `run` throws the typed failure but fails the test on a defect, so a
  tagged error thrown instead of yielded can't pass as a refusal.
- **Fakes return Effects** (`Effect.succeed(x)`, `Effect.fail(new GitHubHttpError({ … }))`). An interface changes in the
  same commit as every fake, stub and script that implements or calls it.
- **Mock only `setTimeout`**: `t.mock.timers.enable({ apis: ["setTimeout"] })` (plus `"Date"` if needed). Why: Effect's
  scheduler yields on `setImmediate`.
- **Codemods**: TypeScript 7 has no JS API (no ts-morph). Use `oxc-parser` and `magic-string` from `node_modules`, then
  `npm run typecheck`.
