// The coordinator: one background Claude Code session (`claude --bg`) the desk starts on the first hand-off, ask or w, and
// keeps running after that. It wakes it with one line per batch of what changed on PRs in Merging, or at once with the
// owner's ask. Claude's own daemon runs it, so a desk restart leaves it be.
import fs from "node:fs";
import path from "node:path";
import { Effect, Result } from "effect";
import type { Desk } from "./desk.ts";
import { ClaudeBadOutput, CommandBadOutput, fsError, messageOf, type CommandError, type FsError, type UnsafeArgument } from "./errors.ts";
import { claudeCommand, claudeMissing, claudeSpawn, runCommand } from "./review.ts";
import {
  COORDINATOR_NAME,
  isCoordinator,
  type ActivityEvent,
  type Ask,
  type AskAbout,
  type AskLines,
  type CoordinatorView,
} from "./types.ts";
import { report } from "./sentry.ts";

const NAME = COORDINATOR_NAME;
const KEY = "coordinator_bg"; // "coordinator" holds the old desk-run coordinator's state
const NEWS = "coordinator_news"; // kept so a desk restart or a failed start doesn't drop it
const ASKS = "coordinator_asks"; // the owner's asks it hasn't been told yet, as their lines
const ERROR = "coordinator_error"; // why it last couldn't run; kept so a desk restart doesn't notify again
const FRESH = 15_000; // how often Merging may look for its claude.ai link until it has one
// It reads CI logs and comments anyone can write; these keep injected text from posting or rewriting as the owner.
// gh api whole: it POSTs whenever a field is passed, with no -X.
export const DENY = [
  "Bash(gh pr comment:*)",
  "Bash(gh pr review:*)",
  "Bash(gh pr ready:*)",
  "Bash(gh pr edit:*)",
  "Bash(gh issue comment:*)",
  "Bash(gh api:*)",
  "Bash(git push --force:*)", // same as "git push --force *", so --force-with-lease passes
  "Bash(git push -f:*)",
  "Bash(git push * -f*)", // the flag after the branch; " --f" isn't matched, so --force-with-lease still passes
  "Bash(git push * --force)",
  "Bash(git push * --force *)",
  "Bash(git push * +*)", // a +branch refspec forces too
  "Bash(gh pr close:*)", // close and reopen take --comment
  "Bash(gh pr reopen:*)",
  "Bash(gh pr create:*)",
  "Bash(gh issue close:*)",
  "Bash(gh issue reopen:*)",
  "Bash(gh issue create:*)",
  "Bash(gh issue edit:*)",
];
// Every message is one line of ids, URLs, kinds and the owner's asks: never PR text, and an argument cmd.exe can pass (claudeSpawn).
const ROLE =
  "You are my Inbox coordinator: the desk keeps you running and wakes you with a message when something changes on a PR in Merging, or when I ask you something in the desk. Follow the Coordinator section of the inbox skill.";
const PR = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
const PERMISSION = { bypass: "bypassPermissions", default: "default" } as const;
type Mode = keyof typeof PERMISSION;
// The desk's news for the owner's PR that's ready to merge but conflicts: it's in Merging only until GitHub sees it mergeable.
export const REBASE =
  "ready to merge but conflicts: rebase it onto its base, run what's runnable, push with --force-with-lease to its own branch, don't merge it; hand it back if it can't rebase cleanly";

// <home>/<name>, whose project settings keep every deny rule beside the owner's own; ones that don't parse fail in the parser's words.
export const denyDir = Effect.fnUntraced(function* (home: string, name: string, deny: string[]): Effect.fn.Return<string, FsError> {
  const dir = path.join(home, name);
  const file = path.join(dir, ".claude", "settings.json");
  type Settings = { permissions?: { deny?: string[] } };
  const s: Settings = fs.existsSync(file)
    ? yield* Effect.try({ try: () => JSON.parse(fs.readFileSync(file, "utf8")) as Settings, catch: fsError("read", file) })
    : {};
  const have = s.permissions?.deny ?? [];
  const missing = deny.filter((r) => !have.includes(r));
  if (missing.length > 0) {
    yield* Effect.try({ try: () => fs.mkdirSync(path.dirname(file), { recursive: true }), catch: fsError("mkdir", path.dirname(file)) });
    const next = { ...s, permissions: { ...s.permissions, deny: [...have, ...missing] } };
    yield* Effect.try({
      try: () => {
        fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
      },
      catch: fsError("write", file),
    });
  }
  return dir;
});

interface Agent {
  id: string;
  sessionId: string;
  cwd: string;
  kind: string;
  name?: string;
  status?: string; // only while it runs: idle, busy, shell, waiting
  pid?: number; // only while it runs
  startedAt?: number;
}

// A minute at most; what cmd.exe can't pass fails before anything starts. Interrupted, it stops the command and waits for it.
const claude = (args: string[], cwd?: string): Effect.Effect<string, CommandError> =>
  Effect.flatMap(claudeSpawn(claudeCommand(), args), (s) =>
    runCommand(s, { cwd, timeout: 60_000, missing: claudeMissing(claudeCommand()) }),
  );

// What a run fails with: a claude command, what it printed, or the coordinator's folder.
type RunError = CommandError | CommandBadOutput | ClaudeBadOutput | FsError;

// The id claude says it backgrounded.
function backgrounded(out: string): Effect.Effect<string, ClaudeBadOutput> {
  const id = /backgrounded\W+([\w-]+)/.exec(out)?.[1];
  if (id) return Effect.succeed(id);
  const message = `claude didn't background it: ${out.trim().split("\n").at(-1) ?? ""}`;
  return Effect.fail(new ClaudeBadOutput({ message, excerpt: out.slice(0, 500) }));
}

// kill(pid, 0) refuses a process that's gone.
const alive = (pid: number) => Result.isSuccess(Result.try({ try: () => process.kill(pid, 0), catch: () => null }));

const span = (s: "new" | "old") => (s === "old" ? "removed " : "");
// Where lines are, by number and side only: the file's name is PR text, so desk_ask gives it.
export function linesText(l: AskLines): string {
  const s = l.start;
  const at = !s
    ? `${span(l.side)}line ${l.line}`
    : s.side === l.side
      ? `${span(l.side)}lines ${s.line}-${l.line}`
      : `${span(s.side)}line ${s.line} to ${span(l.side)}line ${l.line}`;
  return l.note ? `Claude's note at ${at}` : at;
}
const WHOSE = { mine: "my PR ", theirs: "someone else's PR ", issue: "the issue " };
const READ_ONLY = ", read only: don't push to it or post on it";
function stateText(b: AskAbout): string {
  if (b.merging) return ", in Merging";
  const done = b.state === "open" ? "" : `, ${b.state}`;
  if (b.whose === "theirs") return `${done}${READ_ONLY}`;
  return b.whose === "mine" && !done ? ", not handed off" : done;
}
// The owner's words as they wrote them (they're trusted), on one line (cmd.exe can't pass a newline); the rest in the desk's words, never PR text.
export function askLine(a: Ask, about: AskAbout | null): string {
  const l = a.lines;
  const parts = [
    // An item that left the desk fails closed: nothing says it's yours any more.
    a.item_id
      ? `about ${about ? `${WHOSE[about.whose]}${a.item_id} (${about.url})${stateText(about)}` : `${a.item_id}, not on the desk now${READ_ONLY}`}`
      : "",
    a.thread_url ? `on the thread ${a.thread_url}` : "",
    l ? `on ${linesText(l)} of its diff (desk_ask ${a.id} says where)` : "",
  ].filter(Boolean);
  return `My ask ${a.id}${parts.length ? `, ${parts.join(", ")}` : ""}: "${a.text.replaceAll(/\s+/g, " ")}" Answer it with desk_answer.`;
}

// What wakes it, in its words; null for what doesn't (its own pushes, CI starting).
export function wakeFor(e: Pick<ActivityEvent, "kind" | "data">): string | null {
  if (e.kind === "ci") return e.data.to === "green" ? "CI passed" : e.data.to === "red" ? "CI failed" : null;
  if (e.kind === "reviewed")
    return e.data.state === "approved" ? "approved" : e.data.state === "changes_requested" ? "changes requested" : "new review";
  if (e.kind === "commented") return "new comment";
  if (e.kind === "conflict") return "merge conflict";
  if (e.kind === "unblocked")
    return e.data.merged
      ? `unblocked: ${String(e.data.merged)} merged`
      : e.data.closed
        ? `needs ${String(e.data.closed)}, closed without merging`
        : "unblocked";
  return null;
}

export class Coordinator {
  desk: Desk;
  batch = 60_000; // what lands within this goes in one message
  every = 5 * 60_000; // how often the desk checks it's still running: one `claude agents`, no turn
  asked = false; // Wake it or Start it now in Merging
  timer: NodeJS.Timeout | null = null;
  ticker: NodeJS.Timeout | null = null;
  flushing: Promise<void> | null = null; // the run in flight, forked through the desk's runner; it settles, never rejecting
  stopping: Promise<void> | null = null; // turning it off: its process stopping, which a run waits for
  checked = 0;
  status: CoordinatorView["status"] = null;
  watching: NodeJS.Timeout | null = null;
  watchEvery = 10_000; // while an ask of yours waits on its answer
  failure: unknown = null; // the last run's, already reported: the routes' "didn't start" carries it

  constructor(desk: Desk) {
    this.desk = desk;
  }

  get on(): boolean {
    return this.desk.settings["agent.coordinator"];
  }

  // A record from before the bypass setting has no mode: that session was started in default.
  saved(): { id: string; url?: string; mode?: Mode | "unknown" } | null {
    return this.desk.store.get(KEY) as { id: string; url?: string; mode?: Mode | "unknown" } | null;
  }

  // [PR id, what changed], oldest first; only appended to until delivered.
  news(): [string, string][] {
    return (this.desk.store.get(NEWS) as [string, string][] | null) ?? [];
  }

  asks(): string[] {
    return (this.desk.store.get(ASKS) as string[] | null) ?? [];
  }

  error(): string | null {
    return (this.desk.store.get(ERROR) as string | null) ?? null;
  }

  // Shown in Merging until a run succeeds, and notified once: news waits on it, and the log alone went unseen for hours.
  failed(why: string | null): void {
    if (this.desk.stopped) return;
    const was = this.error();
    if (was === why) return;
    this.desk.store.set(ERROR, why);
    this.desk.changed();
    if (why && !was && this.desk.mayNotify()) this.desk.notify("Your agent can't run", why);
  }

  // The desk home's coordinator directory; its project settings keep every rule of the deny list, beside the owner's own.
  dir(): Effect.Effect<string, FsError> {
    return denyDir(this.desk.home, "coordinator", DENY);
  }

  view(): CoordinatorView {
    const s = this.saved();
    if (s && !s.url && this.on && Date.now() - this.checked > FRESH) this.flush();
    return {
      on: this.on,
      id: s?.id ?? null,
      url: s?.url ?? null,
      error: this.on ? this.error() : null,
      status: this.on ? this.status : null,
      queued: this.asks().flatMap((l) => /^My ask (\w+)/.exec(l)?.[1] ?? []),
    };
  }

  // Desk start: the one it has is picked up, and checked every few minutes so one that crashed or was stopped comes back.
  start(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      this.flush();
    }, this.every);
    this.ticker.unref();
    this.flush();
    this.watch(); // an ask from before a restart still waits
  }

  // A hand-off, or news on a PR in Merging.
  wake(id: string, what: string): void {
    if (!this.on || !PR.test(id)) return;
    const news = this.news();
    if (!news.some(([i, w]) => i === id && w === what)) this.desk.store.set(NEWS, [...news, [id, what]]);
    this.schedule();
  }

  // Your ask goes now, not with the next batch: what cmd.exe can't pass fails before it's kept; what it gives waits for the run.
  tell(line: string): Effect.Effect<Effect.Effect<void>, UnsafeArgument> {
    return Effect.map(claudeSpawn(claudeCommand(), [line]), () => {
      this.desk.store.set(ASKS, [...this.asks(), line]);
      this.watch();
      return this.ran(this.again());
    });
  }

  // The run a caller waits on; the desk stopping ended it, so the caller ends as interrupted: nothing kept or reported.
  ran(p: Promise<void>): Effect.Effect<void> {
    return Effect.flatMap(
      Effect.promise(() => p),
      () => (this.desk.stopped ? Effect.interrupt : Effect.void),
    );
  }

  // While one of your asks waits on its answer, what it's doing is looked at often, so the chat can say: on it,
  // waiting on a permission, or stopped without answering. One `claude agents`, no turn.
  watch(): void {
    if (this.watching || this.desk.stopped) return;
    this.watching = setInterval(() => {
      const since = new Date(Date.now() - 30 * 60_000).toISOString();
      if (!this.on || !this.desk.asks().some((a) => !a.answer && a.at > since)) {
        clearInterval(this.watching!);
        this.watching = null;
        return;
      }
      if (!this.flushing) this.desk.runner.fork("coordinator", Effect.ignore(this.find())); // a look that fails: the next run says why
    }, this.watchEvery);
    this.watching.unref();
  }

  untell(line: string): void {
    this.desk.store.set(
      ASKS,
      this.asks().filter((l) => l !== line),
    );
  }

  // Wake it or Start it now in Merging: start it, or have it look now.
  now(): Promise<void> {
    // a second w while one runs would wake it twice
    if (!this.flushing) {
      this.asked = true;
      this.flush();
    }
    return this.flushing ?? Promise.resolve();
  }

  schedule(): void {
    if (this.timer || this.desk.stopped || !this.on || !(this.news().length || this.asks().length || this.asked)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.batch);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.ticker) clearInterval(this.ticker);
    if (this.watching) clearInterval(this.watching);
    this.timer = null;
    this.ticker = null;
    this.watching = null;
  }

  // Turned off in Settings: stopped, its history kept for when it's turned on again.
  stop(): void {
    this.desk.store.set(NEWS, null);
    this.desk.store.set(ASKS, null);
    this.asked = false;
    const flushing = this.flushing;
    const halt = Effect.gen({ self: this }, function* () {
      if (flushing) yield* Effect.promise(() => flushing);
      if (!this.saved()) return;
      const a = yield* this.find();
      if (a) yield* this.halt(a);
    });
    this.stopping = this.fork(
      halt.pipe(
        Effect.catch((e) =>
          Effect.sync(() => {
            this.desk.log(`coordinator: ${e.message}`);
          }),
        ),
      ),
    );
  }

  // Picks it up, resumes it if it stopped, and hands it what's waiting once it's idle; looks again a batch later while it works.
  // One run at a time, forked through the desk's runner: the desk stopping interrupts it, and what was waiting stays.
  flush(): void {
    if (this.flushing) return;
    let ended = false; // a run that ends before its first wait (it's off) has ended already
    const p = this.fork(this.run(), () => {
      ended = true;
      this.flushing = null;
    });
    if (!ended) this.flushing = p;
  }

  // Forked through the desk's runner; what it gives settles, never rejecting, once the fiber ends, however it ends.
  fork(effect: Effect.Effect<void>, ended: () => void = () => {}): Promise<void> {
    let resolve = () => {};
    const p = new Promise<void>((r) => {
      resolve = r;
    });
    const end = () => {
      ended();
      resolve();
    };
    if (!this.desk.runner.fork("coordinator", Effect.ensuring(effect, Effect.sync(end)))) end();
    return p;
  }

  // The run in progress may have read the asks or settings before they changed.
  async again(): Promise<void> {
    await this.flushing;
    this.flush();
    await this.flushing;
  }

  // Never fails: what fails it, a bug too, keeps what's waiting, says why in Merging, and is kept for the routes' "didn't start".
  run(): Effect.Effect<void> {
    const body: Effect.Effect<void, RunError> = Effect.gen({ self: this }, function* () {
      // On again right after off: its process must be gone first, or the resume starts a copy.
      const stopping = this.stopping;
      if (stopping) yield* Effect.promise(() => stopping);
      if (!this.on) return;
      const a = yield* this.find();
      this.checked = Date.now(); // here, not in find(): the watch's looks mustn't hold off the link lookup
      const news = this.news(); // after looking, so a wake that came meanwhile isn't left to the next check
      const asks = this.asks();
      const waiting = news.length > 0 || asks.length > 0 || this.asked;
      const idle = !a?.status || a.status === "idle";
      const mode: Mode = this.desk.settings["agent.coordinator_bypass"] ? "bypass" : "default";
      const flags = ["--permission-mode", PERMISSION[mode]];
      // A resumed session keeps the mode it started with; passing one makes claude start a copy with its history, so only to change it.
      const changing = !!a && (this.saved()?.mode ?? "default") !== mode;
      // One started under its name from before the rename to Inbox goes on as a copy under the new one, as a switch does.
      const switching = changing || (!!a?.name && a.name !== NAME && isCoordinator(a.name));
      // A copy may not keep its original's name and Remote Control, so the switch passes them again.
      const resume = a ? ["--resume", a.sessionId, "--bg", ...(switching ? ["--name", NAME, "--remote-control", NAME, ...flags] : [])] : [];
      // Stuck on a permission prompt is why bypass gets turned on: it switches now, and the copy gets a turn to carry on.
      const stuck = changing && a?.status === "waiting";
      // Busy, in a shell or waiting on a permission: it stays queued.
      if ((waiting && idle) || stuck) {
        const text = this.message(news, asks);
        this.asked = false;
        // Created only with something to deliver: a scratch desk's would reach the owner's desk through its MCP tools.
        if (!a)
          yield* this.launch(
            ["--bg", "--name", NAME, "--remote-control", NAME, ...(mode === "bypass" ? flags : []), `${ROLE} ${text}`],
            mode,
          );
        else {
          yield* this.halt(a);
          yield* this.launch([...resume, text], mode);
        }
        this.desk.store.set(NEWS, this.news().slice(news.length));
        this.desk.store.set(ASKS, this.asks().slice(asks.length));
        this.saw("busy"); // it has a turn now; the next look says how it goes
      } else if (a && (!a.pid || (switching && idle))) {
        yield* this.halt(a);
        yield* this.launch(resume, mode); // no prompt, so no turn
      }
      const s = this.saved();
      if (s && !s.url) {
        // The link is best effort: a lookup that fails looks again on the next run.
        const logs = yield* claude(["logs", s.id]).pipe(Effect.orElseSucceed(() => ""));
        const url = /https:\/\/claude\.ai\/code\/session_\w+/.exec(logs)?.[0];
        if (url) {
          this.desk.store.set(KEY, { ...s, url });
          this.desk.changed();
        }
      }
      this.failure = null;
      this.failed(null);
      this.schedule();
    });
    return body.pipe(
      Effect.catchDefect((bug) =>
        Effect.sync(() => {
          this.broke(bug, messageOf(bug).trim() || "your agent's run failed");
        }),
      ),
      Effect.catch((e) =>
        Effect.sync(() => {
          this.broke(e, e.message);
        }),
      ),
    );
  }

  // What stopped a run: reported once, logged, kept for the routes, and shown in Merging.
  broke(e: unknown, message: string): void {
    this.asked = false;
    this.failure = e;
    if (!this.desk.stopped) report(e, "coordinator");
    this.desk.log(`coordinator: ${message}`);
    this.failed(message.trim());
  }

  // --resume continues it (same id and history) only once its process has exited, and only with no other flag.
  halt(a: Agent): Effect.Effect<void, CommandError> {
    return Effect.gen(function* () {
      if (a.status) yield* claude(["stop", a.id]);
      for (let i = 0; a.pid && i < 50 && alive(a.pid); i++) yield* Effect.sleep(200);
    });
  }

  message(news: [string, string][], asks: string[]): string {
    const by = new Map<string, Set<string>>();
    for (const [id, what] of news) by.set(id, (by.get(id) ?? new Set()).add(what));
    const lines = [...by].map(([id, what]) => {
      const [, repo, n] = PR.exec(id)!;
      return `${id} (https://github.com/${repo}/pull/${n}): ${[...what].join(", ")}`;
    });
    const parts = [...asks, ...(lines.length ? [`In Merging: ${lines.join("; ")}.`] : [])];
    return parts.length ? parts.join(" ") : "I'd like you to look at Merging now.";
  }

  // Keeps the id claude says it backgrounded: a copy's, if it made one.
  launch(args: string[], mode: Mode): Effect.Effect<void, CommandError | FsError | ClaudeBadOutput> {
    return Effect.gen({ self: this }, function* () {
      const out = yield* claude(args, yield* this.dir());
      const id = yield* backgrounded(out);
      const s = this.saved();
      if (id !== s?.id || mode !== s.mode) {
        this.desk.store.set(KEY, id === s?.id ? { ...s, mode } : { id, mode });
        this.desk.changed();
      }
      const note = /^note: .*/m.exec(out)?.[0];
      this.desk.log(`coordinator: ${args[0] === "--bg" ? "created" : "resumed"} ${id}${note ? ` (${note})` : ""}`);
    });
  }

  // Its row in claude agents: the id it keeps, else the latest running one here (a start it didn't see finish; not one a switch stopped).
  find(): Effect.Effect<Agent | null, CommandError | CommandBadOutput | FsError> {
    return Effect.gen({ self: this }, function* () {
      const out = yield* claude(["agents", "--json", "--all"]);
      const listed = yield* Effect.try({
        try: (): unknown => JSON.parse(out),
        catch: (cause) => new CommandBadOutput({ command: claudeCommand(), cause }),
      });
      if (!Array.isArray(listed))
        return yield* new CommandBadOutput({ command: claudeCommand(), detail: "claude agents --json didn't print a list" });
      const all = (listed as (Agent | null)[]).filter((a): a is Agent => a?.kind === "background");
      const dir = yield* this.dir();
      const real = yield* Effect.try({ try: () => fs.realpathSync(dir), catch: fsError("realpath", dir) });
      const here = new Set([dir, real]);
      const saved = this.saved();
      let a =
        all.find((x) => x.id === saved?.id) ??
        all
          .filter((x) => here.has(x.cwd) && x.pid)
          .sort((x, y) => (x.startedAt ?? 0) - (y.startedAt ?? 0))
          .at(-1) ??
        null;
      // claude resumes a session only from its own folder: one from the old home's (before it moved to ~/.inbox, a folder
      // gone or the link the move left, which opens this one) is let go; one working in another folder, a worktree, isn't.
      const its = (cwd: string) => Result.getOrElse(Result.try({ try: () => fs.realpathSync(cwd), catch: () => null }), () => null);
      if (a?.cwd && !here.has(a.cwd) && [null, real].includes(its(a.cwd))) {
        this.desk.log(`coordinator: ${a.id} ran in ${a.cwd}, not ${dir}, so the next wake starts a fresh one here`);
        yield* this.halt(a);
        a = null;
      }
      if (a?.id !== saved?.id) {
        // The desk didn't see its mode, so the next launch sets the setting's.
        this.desk.store.set(KEY, a && { id: a.id, mode: "unknown" });
        this.desk.changed();
      }
      this.saw(a ? (a.pid ? ((a.status as CoordinatorView["status"]) ?? "idle") : "stopped") : null);
      return a;
    });
  }

  saw(status: CoordinatorView["status"]): void {
    if (status === this.status) return;
    this.status = status;
    this.desk.changed();
  }
}
