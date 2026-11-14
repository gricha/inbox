// The coordinator: one background Claude Code session (`claude --bg`) the desk starts on the first hand-off, ask or w, and
// keeps running after that. It wakes it with one line per batch of what changed on PRs in Merging, or at once with the
// owner's ask. Claude's own daemon runs it, so a desk restart leaves it be. On Codex it's one `codex exec` session, each
// wake a `codex exec resume` turn the desk runs as its child and waits on, one at a time; on OpenCode, `opencode run`
// and `opencode run --session`, the same way.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect, Result, Schema } from "effect";
import type { Desk } from "./desk.ts";
import { parse } from "smol-toml";
import { kill, OWN_GROUP, track } from "./children.ts";
import {
  ClaudeApiError,
  ClaudeBadOutput,
  ClaudeNotLoggedIn,
  CommandBadOutput,
  CommandFailed,
  CommandNotFound,
  CodexUntrusted,
  fsError,
  messageOf,
  type ClaudeError,
  type CommandError,
  type FsError,
  type UnsafeArgument,
} from "./errors.ts";
import { oldHome, ownersHome } from "./home.ts";
import { answerOf, askOf } from "./jobs.ts";
import { decode, field, isRecord, num, oneOf, str, strings } from "./narrow.ts";
import {
  CODEX_DOWN,
  claudeCommand,
  claudeMissing,
  claudeSpawn,
  codexCommand,
  codexError,
  codexMcp,
  codexMissing,
  codexThread,
  deskMcp,
  OPENCODE_DOWN,
  opencodeCommand,
  opencodeConfig,
  opencodeError,
  opencodeFailure,
  opencodeMissing,
  opencodeRunArgs,
  opencodeSession,
  runCommand,
} from "./review.ts";
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
import { reviewOptional } from "./stage.ts";

const NAME = COORDINATOR_NAME;
const KEY = "coordinator_bg"; // "coordinator" holds the old desk-run coordinator's state
const NEWS = "coordinator_news"; // kept so a desk restart or a failed start doesn't drop it
const ASKS = "coordinator_asks"; // the owner's asks it hasn't been told yet, as their lines
const ERROR = "coordinator_error"; // why it last couldn't run; kept so a desk restart doesn't notify again
const FRESH = 15_000; // how often Merging may look for its claude.ai link until it has one
const CODEX_KEY = "coordinator_codex"; // its Codex session, kept beside Claude Code's so switching back finds each
const OPENCODE_KEY = "coordinator_opencode"; // and its OpenCode session
const TURN = 60 * 60_000; // a wake on Codex or OpenCode is one turn the desk waits on; past this it's stopped
// Off on Codex: what reaches past the desk and your shell (apps and plugins bring their own MCP servers, browsers, the screen).
const CODEX_OFF = ["apps", "plugins", "browser_use", "browser_use_external", "in_app_browser", "computer_use"].flatMap((f) => [
  "--disable",
  f,
]);
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
// The deny list as Codex rules: its prefix rules only, since Codex matches a command's leading words and nothing after them.
const CODEX_RULES = [
  "# Inbox writes this file on every wake: your agent's deny list as Codex rules. Rules of yours go in another file here.",
  ...DENY.flatMap((r) => {
    const words = /^Bash\(([^*:]+):\*\)$/.exec(r)?.[1]?.split(" ");
    return words ? [`prefix_rule(pattern = ${JSON.stringify(words)}, decision = "forbidden")`] : [];
  }),
  "",
].join("\n");

// The deny list as OpenCode's bash rules, which match the whole command (each part of a && chain), flags after the branch too.
export const OPENCODE_RULES: Record<string, string> = Object.fromEntries(
  DENY.map((r) => [r.replace(/^Bash\((.*)\)$/, "$1").replace(/:\*$/, " *"), "deny"]),
);

// A turn the desk runs as its child: how its agent's events name the session and say a failure, and its error words.
interface TurnKind {
  command: string;
  missing: string;
  id: (line: string) => string | null;
  failed: (line: string) => string | null;
  down: RegExp;
  error: (why: string) => ClaudeNotLoggedIn | ClaudeApiError;
}

function codexFailure(line: string): string | null {
  const e = Result.getOrNull(Result.try({ try: (): unknown => JSON.parse(line), catch: () => null }));
  const type = field(e, "type");
  const message = str(field(e, "message"));
  if (type === "error" && message !== undefined) return message;
  if (type === "turn.failed") return str(field(field(e, "error"), "message")) ?? "codex failed";
  return null;
}

const turnKind = (agent: "codex" | "opencode"): TurnKind =>
  agent === "codex"
    ? {
        command: codexCommand(),
        missing: codexMissing(codexCommand()),
        id: codexThread,
        failed: codexFailure,
        down: CODEX_DOWN,
        error: codexError,
      }
    : {
        command: opencodeCommand(),
        missing: opencodeMissing(opencodeCommand()),
        id: opencodeSession,
        failed: opencodeFailure,
        down: OPENCODE_DOWN,
        error: opencodeError,
      };

// Every message is one line of ids, URLs, kinds and the owner's asks: never PR text, and an argument cmd.exe can pass (claudeSpawn).
const ROLE =
  "You are my Inbox coordinator: the desk keeps you running and wakes you with a message when something changes on a PR in Merging, or when I ask you something in the desk. Follow the Coordinator section of the inbox skill.";
const PR = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
const PERMISSION = { bypass: "bypassPermissions", default: "default" } as const;
type Mode = keyof typeof PERMISSION;
// The desk's own fact on news for a PR whose repo needs no review (pr.review_optional).
export const NO_REVIEW =
  "its repo needs no review, so merging it once CI passes is expected and low stakes: don't ask for or wait on a review";
// The desk's news for the owner's PR that's ready to merge but conflicts: it's in Merging only until GitHub sees it mergeable.
export const REBASE =
  "ready to merge but conflicts: rebase it onto its base, run what's runnable, push with --force-with-lease to its own branch, don't merge it; hand it back if it can't rebase cleanly";

// <home>/<name>, whose project settings keep every deny rule beside the owner's own; ones that don't parse fail in the parser's words.
export const denyDir = Effect.fnUntraced(function* (home: string, name: string, deny: string[]): Effect.fn.Return<string, FsError> {
  const dir = path.join(home, name);
  const file = path.join(dir, ".claude", "settings.json");
  const s: unknown = fs.existsSync(file)
    ? yield* Effect.try({ try: (): unknown => JSON.parse(fs.readFileSync(file, "utf8")), catch: fsError("read", file) })
    : {};
  const permissions = field(s, "permissions");
  const denied = field(permissions, "deny");
  const have: unknown[] = Array.isArray(denied) ? denied : [];
  const missing = deny.filter((r) => !have.includes(r));
  if (missing.length > 0) {
    yield* Effect.try({ try: () => fs.mkdirSync(path.dirname(file), { recursive: true }), catch: fsError("mkdir", path.dirname(file)) });
    const next = { ...(isRecord(s) ? s : {}), permissions: { ...(isRecord(permissions) ? permissions : {}), deny: [...have, ...missing] } };
    yield* Effect.try({
      try: () => {
        fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
      },
      catch: fsError("write", file),
    });
  }
  return dir;
});

export interface Agent {
  id: string;
  sessionId: string;
  cwd: string;
  kind: string;
  name?: string;
  status?: string; // only while it runs: idle, busy, shell, waiting
  pid?: number; // only while it runs
  startedAt?: number;
}

const SAVED = Schema.Struct({
  id: Schema.String,
  url: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(Schema.Literals(["bypass", "default", "unknown"])),
});
const STATUSES = ["busy", "shell", "waiting", "idle", "stopped"] as const;

// A background agent's row in claude agents --json; another kind, or one without its ids, isn't one.
function backgroundAgent(x: unknown): Agent | null {
  const id = str(field(x, "id"));
  const sessionId = str(field(x, "sessionId"));
  const cwd = str(field(x, "cwd"));
  if (field(x, "kind") !== "background" || id === undefined || sessionId === undefined || cwd === undefined) return null;
  const name = str(field(x, "name"));
  const status = str(field(x, "status"));
  const pid = num(field(x, "pid"));
  const startedAt = num(field(x, "startedAt"));
  return {
    id,
    sessionId,
    cwd,
    kind: "background",
    ...(name !== undefined && { name }),
    ...(status !== undefined && { status }),
    ...(pid !== undefined && { pid }),
    ...(startedAt !== undefined && { startedAt }),
  };
}

// A minute at most; what cmd.exe can't pass fails before anything starts. Interrupted, it stops the command and waits for it.
export const claude = (args: string[], cwd?: string): Effect.Effect<string, CommandError> =>
  Effect.flatMap(claudeSpawn(claudeCommand(), args), (s) =>
    runCommand(s, { ...(cwd !== undefined && { cwd }), timeout: 60_000, missing: claudeMissing(claudeCommand()) }),
  );

// What a run fails with: a claude command, what it printed, or the coordinator's folder.
type RunError = CommandError | CommandBadOutput | ClaudeError | CodexUntrusted | FsError;

// The id claude says it backgrounded.
function backgrounded(out: string): Effect.Effect<string, ClaudeBadOutput> {
  const id = /backgrounded\W+([\w-]+)/.exec(out)?.[1];
  if (id) return Effect.succeed(id);
  const message = `claude didn't background it: ${out.trim().split("\n").at(-1) ?? ""}`;
  return Effect.fail(new ClaudeBadOutput({ message, excerpt: out.slice(0, 500) }));
}

// kill(pid, 0) refuses a process that's gone.
export const alive = (pid: number) => Result.isSuccess(Result.try({ try: () => process.kill(pid, 0), catch: () => null }));

// --resume continues a session (same id and history) only once its process has exited, and only with no other flag.
export function halt(a: Pick<Agent, "id" | "status" | "pid">): Effect.Effect<void, CommandError> {
  return Effect.gen(function* () {
    if (a.status) yield* claude(["stop", a.id]);
    for (let i = 0; a.pid && i < 50 && alive(a.pid); i++) yield* Effect.sleep(200);
  });
}

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
    a.fix ? `Make PR with fix: open a draft PR with this fix (desk_ask ${a.id} says where)` : "",
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

// A Codex start or wake: bypass is no sandbox and no approvals; else it writes in its folder and reaches the network,
// never asking. `codex exec resume` takes no --sandbox or -C, so a wake sets the sandbox by config and runs in the folder.
function codexArgs(dir: string, mcp: string[], bypass: boolean, id: string | undefined, text: string): string[] {
  const sandbox = bypass
    ? ["--dangerously-bypass-approvals-and-sandbox"]
    : [
        ...(id ? ["-c", 'sandbox_mode="workspace-write"'] : ["--sandbox", "workspace-write"]),
        "-c",
        "sandbox_workspace_write.network_access=true",
        "-c",
        'approval_policy="never"',
      ];
  const fence = ["--skip-git-repo-check", ...CODEX_OFF, ...mcp];
  return id
    ? ["exec", "resume", "--json", ...sandbox, ...fence, id, text]
    : ["exec", "--json", ...sandbox, "-C", dir, ...fence, `${ROLE} ${text}`];
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
  following: NodeJS.Timeout | null = null;
  watchEvery = 10_000; // while an ask of yours waits on its answer
  activityEvery = 2_000; // and how often its transcript is read for what it's doing, while it works
  activity: string[] = [];
  session: { sessionId: string; cwd: string } | null = null; // its row's, from the last look
  failure: unknown = null; // the last run's, already reported: the routes' "didn't start" carries it
  turn: ChildProcess | null = null; // on Codex or OpenCode: the wake in flight
  turnOf: TurnKind | null = null; // and whose it is

  constructor(desk: Desk) {
    this.desk = desk;
  }

  get on(): boolean {
    return this.desk.settings["agent.coordinator"];
  }

  // The agent whose turns the desk runs itself (Codex, OpenCode); null: Claude Code's daemon runs them.
  get own(): "codex" | "opencode" | null {
    const a = this.desk.agent();
    return a === "claude-code" ? null : a;
  }

  // The chosen agent's session. A record from before the bypass setting has no mode: that session was started in default.
  saved(): typeof SAVED.Type | null {
    const key = this.own === "codex" ? CODEX_KEY : this.own === "opencode" ? OPENCODE_KEY : KEY;
    return Result.getOrNull(decode(SAVED, this.desk.store.get(key)));
  }

  // [PR id, what changed], oldest first; only appended to until delivered.
  news(): [string, string][] {
    const kept = this.desk.store.get(NEWS);
    return (Array.isArray(kept) ? kept : []).flatMap((n): [string, string][] => {
      const [id, what] = strings(n) ?? [];
      return id !== undefined && what !== undefined ? [[id, what]] : [];
    });
  }

  asks(): string[] {
    return strings(this.desk.store.get(ASKS)) ?? [];
  }

  error(): string | null {
    return str(this.desk.store.get(ERROR)) ?? null;
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
    if (s && !s.url && this.on && !this.own && Date.now() - this.checked > FRESH) this.flush();
    const own = this.turn ? "busy" : s ? "idle" : null; // nothing of Codex's or OpenCode's runs between its turns
    return {
      on: this.on,
      id: s?.id ?? null,
      url: s?.url ?? null,
      error: this.on ? this.error() : null,
      status: this.on ? (this.own ? own : this.status) : null,
      queued: this.asks().flatMap((l) => askOf(l) ?? []),
      activity: this.on && !this.own && (this.status === "busy" || this.status === "shell") ? this.activity : [],
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
    return Effect.map(claudeSpawn(this.own ? turnKind(this.own).command : claudeCommand(), [line]), () => {
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
      // A look that fails: the next run says why. Codex's and OpenCode's state is the desk's own turn.
      if (!this.flushing && !this.own) this.desk.runner.fork("coordinator", Effect.ignore(this.find()));
    }, this.watchEvery);
    this.watching.unref();
    this.follow();
  }

  // While it works, its transcript's latest steps, read every few seconds, for the chat to show in place of "On it".
  follow(): void {
    if (this.following || this.desk.stopped) return;
    this.following = setInterval(() => {
      if (!this.watching) {
        clearInterval(this.following!);
        this.following = null;
        return;
      }
      const busy = this.status === "busy" || this.status === "shell";
      const lines = busy && this.session && !this.own ? activityOf(readTail(transcriptPath(this.session))) : [];
      if (lines.join("\n") === this.activity.join("\n")) return;
      this.activity = lines;
      this.desk.changed();
    }, this.activityEvery);
    this.following.unref();
  }

  // Answered while it waited to go again (the desk asked again while your agent was on it): it never goes.
  answered(id: string): void {
    const left = this.asks().filter((l) => askOf(l) !== id);
    if (left.length !== this.asks().length) this.desk.store.set(ASKS, left);
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
    const stop = Effect.gen({ self: this }, function* () {
      if (flushing) yield* Effect.promise(() => flushing);
      if (this.turn) kill(this.turn);
      if (!this.saved() || this.own) return;
      const a = yield* this.find();
      if (a) yield* this.halt(a);
    });
    this.stopping = this.fork(
      stop.pipe(
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
      const own = this.own;
      if (own) {
        yield* this.runOwn(own);
        return;
      }
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
        for (const l of asks) {
          const id = askOf(l);
          if (id) this.desk.jobs.begin("ask", id); // it has your ask now: its job runs until it answers
          const answered = answerOf(l);
          if (answered) yield* Effect.ignore(this.desk.answerRead(answered)); // this wake is how it reads your answer
        }
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

  halt(a: Agent): Effect.Effect<void, CommandError> {
    return halt(a);
  }

  message(news: [string, string][], asks: string[]): string {
    const by = new Map<string, Set<string>>();
    for (const [id, what] of news) by.set(id, (by.get(id) ?? new Set()).add(what));
    const lines = [...by].map(([id, what]) => {
      const [, repo, n] = PR.exec(id)!;
      const item = this.desk.store.itemsById([id]).get(id);
      const free = item && reviewOptional(item) ? ` (${NO_REVIEW})` : "";
      return `${id} (https://github.com/${repo}/pull/${n}): ${[...what].join(", ")}${free}`;
    });
    const parts = [...asks, ...(lines.length ? [`In Merging: ${lines.join("; ")}.`] : [])];
    return parts.length ? parts.join(" ") : "I'd like you to look at Merging now.";
  }

  // Keeps the id claude says it backgrounded: a copy's, if it made one.
  launch(args: string[], mode: Mode): Effect.Effect<void, CommandError | FsError | ClaudeBadOutput> {
    return Effect.gen({ self: this }, function* () {
      const dir = yield* this.dir();
      // Only the owner's own desk: a scratch desk (a test) never touches their Claude Code config.
      if (ownersHome(this.desk.home) && carryTrust(path.join(oldHome(), "coordinator"), dir))
        this.desk.log(`coordinator: trusted ${dir}, as you trusted its folder before the move`);
      const out = yield* claude(args, dir);
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
      const all = listed.flatMap((x: unknown) => backgroundAgent(x) ?? []);
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
      // claude resumes a session only from its own folder: one from the old home's (before it moved to ~/.inbox, by its
      // name, or the link the move left, which opens this one) is let go; one working in another folder, a worktree, isn't,
      // even once that's removed.
      const its = (cwd: string) => Result.getOrElse(Result.try({ try: () => fs.realpathSync(cwd), catch: () => null }), () => null);
      if (a?.cwd && !here.has(a.cwd) && (a.cwd === path.join(oldHome(), "coordinator") || its(a.cwd) === real)) {
        this.desk.log(`coordinator: ${a.id} ran in ${a.cwd}, not ${dir}, so the next wake starts a fresh one here`);
        yield* this.halt(a);
        a = null;
      }
      if (a?.id !== saved?.id) {
        // The desk didn't see its mode, so the next launch sets the setting's.
        this.desk.store.set(KEY, a && { id: a.id, mode: "unknown" });
        this.desk.changed();
      }
      this.session = a && { sessionId: a.sessionId, cwd: a.cwd };
      const status = a?.pid ? oneOf(STATUSES, a.status) : undefined;
      if (a?.pid && !status) this.desk.log(`coordinator: ${a.id} says "${String(a.status)}", which the desk doesn't know: shown as idle`);
      this.saw(a ? (a.pid ? (status ?? "idle") : "stopped") : null);
      return a;
    });
  }

  // On Codex or OpenCode: what waits goes as one turn, started in its folder the first time and resumed after; while a
  // turn runs, it stays queued, and the turn's end delivers it.
  runOwn(agent: "codex" | "opencode"): Effect.Effect<void, RunError> {
    return Effect.gen({ self: this }, function* () {
      if (this.turn) return;
      const news = this.news();
      const asks = this.asks();
      if (!news.length && !asks.length && !this.asked) return;
      const text = this.message(news, asks);
      this.asked = false;
      const id = this.saved()?.id;
      const url = yield* deskMcp(this.desk.mcpUrl);
      const bypass = this.desk.settings["agent.coordinator_bypass"];
      const kind = turnKind(agent);
      let started: string;
      if (agent === "codex") {
        const dir = yield* this.codexDir();
        const mcp = yield* codexMcp(kind.command, dir, { url });
        started = yield* this.ownTurn(kind, codexArgs(dir, mcp, bypass, id, text), dir);
      } else {
        const dir = yield* this.dir();
        const config = yield* opencodeConfig(kind.command, dir, () => ({ bash: OPENCODE_RULES }), { url });
        const args = opencodeRunArgs(NAME, id);
        // Nobody is there to answer what your config asks about: with bypass it's approved (--auto), without it refused.
        const said = id ? text : `${ROLE} ${text}`;
        started = yield* this.ownTurn(kind, [...args, ...(bypass ? ["--auto"] : []), said], dir, { OPENCODE_CONFIG_CONTENT: config });
      }
      if (started !== id) this.desk.store.set(agent === "codex" ? CODEX_KEY : OPENCODE_KEY, { id: started });
      this.desk.log(`coordinator: ${id ? "woke" : "created"} ${started} on ${agent === "codex" ? "Codex" : "OpenCode"}`);
      this.desk.store.set(NEWS, this.news().slice(news.length));
      this.desk.store.set(ASKS, this.asks().slice(asks.length));
      for (const l of asks) {
        const ask = askOf(l);
        if (ask) this.desk.jobs.begin("ask", ask);
        const answered = answerOf(l);
        if (answered) yield* Effect.ignore(this.desk.answerRead(answered));
      }
      this.failure = null;
      this.failed(null);
      this.desk.changed();
    });
  }

  // Its folder with the deny list as Codex rules in .codex/rules, which Codex reads only once you trust the folder.
  codexDir(): Effect.Effect<string, FsError | CodexUntrusted> {
    return Effect.gen({ self: this }, function* () {
      const dir = yield* this.dir();
      const rules = path.join(dir, ".codex", "rules");
      const file = path.join(rules, "inbox.rules");
      yield* Effect.try({
        try: () => {
          fs.mkdirSync(rules, { recursive: true });
          if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== CODEX_RULES) fs.writeFileSync(file, CODEX_RULES);
        },
        catch: fsError("write", file),
      });
      const real = yield* Effect.try({ try: () => fs.realpathSync(dir), catch: fsError("realpath", dir) });
      const config = path.join(process.env.CODEX_HOME?.trim() ? process.env.CODEX_HOME : path.join(os.homedir(), ".codex"), "config.toml");
      const read = Result.try({ try: () => parse(fs.readFileSync(config, "utf8")), catch: () => null });
      const projects = field(Result.getOrNull(read), "projects");
      const trust = (d: string) => field(field(projects, d), "trust_level") === "trusted";
      if (!trust(real) && !trust(dir)) return yield* new CodexUntrusted({ dir: real, config });
      return dir;
    });
  }

  // Started once the agent names its session (codex's first event, any of opencode's); the rest of the turn runs as the
  // desk's child, and its end says how it went and delivers what queued meanwhile. Interrupted before that, it stops it.
  ownTurn(
    kind: TurnKind,
    args: string[],
    dir: string,
    env?: Record<string, string>,
  ): Effect.Effect<string, CommandError | ClaudeError | UnsafeArgument> {
    const command = kind.command;
    return Effect.flatMap(claudeSpawn(command, args), (s) =>
      Effect.callback<string, CommandError | ClaudeError>((resume) => {
        const made = Result.try({
          try: () =>
            spawn(s.file, s.args, {
              cwd: dir,
              shell: s.shell,
              detached: OWN_GROUP,
              windowsHide: true,
              stdio: ["ignore", "pipe", "pipe"],
              ...(env && { env: { ...process.env, ...env } }),
            }),
          catch: (cause) => cause,
        });
        if (Result.isFailure(made)) {
          resume(Effect.fail(new CommandFailed({ command, code: null, signal: null, stderr: "", cause: made.failure })));
          return Effect.void;
        }
        const child = made.success;
        track(child);
        let id: string | null = null;
        let rest = "";
        let stderr = "";
        let said: string | null = null; // the turn's failure, in its events
        let missing = false;
        let over = false;
        let closed = false;
        const timer = setTimeout(() => {
          over = true;
          kill(child);
        }, TURN);
        timer.unref();
        const read = (line: string) => {
          said = kind.failed(line) ?? said;
          if (id) return;
          id = kind.id(line);
          if (!id) return;
          this.turn = child;
          this.turnOf = kind;
          this.desk.changed();
          resume(Effect.succeed(id));
        };
        child.stdout.setEncoding("utf8").on("data", (d: string) => {
          const lines = (rest + d).split("\n");
          rest = lines.pop() ?? "";
          for (const l of lines) read(l);
        });
        child.stderr.setEncoding("utf8").on("data", (d: string) => {
          stderr = (stderr + d).slice(-8192);
        });
        child.on("error", (e: NodeJS.ErrnoException) => {
          missing = e.code === "ENOENT";
        });
        child.once("close", (code, sig) => {
          closed = true;
          clearTimeout(timer);
          if (rest) read(rest);
          const why = over
            ? "your agent's turn ran over an hour, so the desk stopped it"
            : (said ?? (code === 0 ? null : stderr.trim() || `${path.basename(command)} exited with ${code ?? sig}`));
          if (id) {
            this.turnEnded(why);
            return;
          }
          if (missing) resume(Effect.fail(new CommandNotFound({ command, hint: kind.missing })));
          else if (why && kind.down.test(why)) resume(Effect.fail(kind.error(why)));
          else if (said) resume(Effect.fail(new ClaudeApiError({ message: said })));
          else resume(Effect.fail(new CommandFailed({ command, code, signal: sig, stderr: stderr.trim() })));
        });
        return Effect.callback<void>((done) => {
          clearTimeout(timer);
          if (closed) {
            done(Effect.void);
            return;
          }
          child.once("close", () => {
            done(Effect.void);
          });
          kill(child);
        });
      }),
    );
  }

  // A Codex or OpenCode turn ended: what it failed with is shown as a run's error, and what queued meanwhile goes now.
  turnEnded(why: string | null): void {
    const kind = this.turnOf;
    this.turn = null;
    this.turnOf = null;
    if (this.desk.stopped || !this.on) return; // turned off: stop() ended it
    if (why) {
      const e = kind?.down.test(why) ? kind.error(why) : new ClaudeApiError({ message: why });
      this.broke(e, e.message);
    }
    this.desk.changed();
    this.desk.runner.fork(
      "coordinator",
      Effect.promise(() => this.again()),
    );
  }

  saw(status: CoordinatorView["status"]): void {
    if (status === this.status) return;
    this.status = status;
    this.desk.changed();
  }
}

// The home's move to ~/.inbox left Claude Code's trust on the coordinator's old folder: the owner's yes there carries over to
// the new one, once, so it starts as before. A folder never trusted is still the owner's to trust; this grants nothing new.
export function carryTrust(from: string, to: string, file = claudeConfig()): boolean {
  const read = Result.try({ try: (): unknown => JSON.parse(fs.readFileSync(file, "utf8")), catch: () => null });
  const conf = Result.getOrNull(read);
  const projects = field(conf, "projects");
  const accepted = (d: string) => field(field(projects, d), "hasTrustDialogAccepted") === true;
  if (!isRecord(projects) || !accepted(from) || accepted(to)) return false;
  const was = projects[to];
  projects[to] = { ...(isRecord(was) ? was : {}), hasTrustDialogAccepted: true };
  const tmp = `${file}.inbox-${process.pid}`;
  return Result.isSuccess(
    Result.try({
      try: () => {
        fs.writeFileSync(tmp, JSON.stringify(conf, null, 2));
        fs.renameSync(tmp, file);
      },
      catch: () => null,
    }),
  );
}

const claudeConfig = () => path.join(process.env.CLAUDE_CONFIG_DIR?.trim() ? process.env.CLAUDE_CONFIG_DIR : os.homedir(), ".claude.json");

// ---------------------------------------------------------------------------- what it's doing

const TAIL = 256 * 1024; // of its transcript, read for its latest steps
const STEPS = 5;
const STEP_LEN = 140;

// Where Claude Code keeps a session's transcript: its projects folder, by its folder with every other character a dash.
export function transcriptPath(s: { sessionId: string; cwd: string }): string {
  const home = process.env.CLAUDE_CONFIG_DIR?.trim() ? process.env.CLAUDE_CONFIG_DIR : path.join(os.homedir(), ".claude");
  return path.join(home, "projects", s.cwd.replaceAll(/[^A-Za-z0-9]/g, "-"), `${s.sessionId}.jsonl`);
}

// The file's last TAIL bytes from its first whole line; "" when it isn't there (yet).
function readTail(file: string): string {
  return Result.getOrElse(
    Result.try({
      try: () => {
        const fd = fs.openSync(file, "r");
        try {
          const size = fs.fstatSync(fd).size;
          const at = Math.max(0, size - TAIL);
          const buf = Buffer.alloc(size - at);
          fs.readSync(fd, buf, 0, buf.length, at);
          const text = buf.toString("utf8");
          return at === 0 ? text : text.slice(text.indexOf("\n") + 1);
        } finally {
          fs.closeSync(fd);
        }
      },
      catch: () => "",
    }),
    () => "",
  );
}

// Its steps since the latest prompt it was given, as Claude Code lists them: each tool it used, said plainly, and what it
// said along the way; the last STEPS.
export function activityOf(jsonl: string): string[] {
  let steps: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const entry = Result.getOrNull(Result.try({ try: (): unknown => JSON.parse(line), catch: () => null }));
    const type = field(entry, "type");
    const content = field(field(entry, "message"), "content");
    if (type === "user") {
      // A prompt, not a tool's result coming back: a new turn starts.
      const prompt = typeof content === "string" || (Array.isArray(content) && content.some((b) => field(b, "type") !== "tool_result"));
      if (prompt && field(entry, "isMeta") !== true) steps = [];
      continue;
    }
    if (type !== "assistant" || !Array.isArray(content)) continue;
    for (const b of content) {
      const kind = field(b, "type");
      const said =
        kind === "tool_use" ? step(str(field(b, "name")) ?? "", field(b, "input")) : kind === "text" ? str(field(b, "text")) : undefined;
      const one = said?.replaceAll(/\s+/g, " ").trim();
      if (one) steps.push(one.length > STEP_LEN ? `${one.slice(0, STEP_LEN - 1)}…` : one);
    }
  }
  return steps.slice(-STEPS);
}

const base = (p: string | undefined) => (p ? path.basename(p) : "");

// One tool use, said plainly.
function step(name: string, input: unknown): string {
  const s = (k: string) => str(field(input, k)) ?? "";
  switch (name) {
    case "Bash":
      return s("description") || `Ran ${s("command")}`;
    case "Read":
      return `Read ${base(s("file_path"))}`;
    case "Edit":
    case "MultiEdit":
      return `Edited ${base(s("file_path"))}`;
    case "Write":
      return `Wrote ${base(s("file_path"))}`;
    case "Grep":
      return `Searched for ${s("pattern")}`;
    case "Glob":
      return `Looked for ${s("pattern")}`;
    case "WebFetch":
      return `Fetched ${s("url")}`;
    case "WebSearch":
      return `Searched the web for ${s("query")}`;
    case "Agent":
    case "Task":
      return `Started an agent: ${s("description")}`;
    case "TodoWrite":
      return "Updated its plan";
    case "ToolSearch":
      return "Loaded its tools";
  }
  const desk = /^mcp__\w+__desk_(\w+)$/.exec(name)?.[1];
  if (desk) {
    const what = s("ref") || s("item") || s("ask_id");
    const done = DESK_STEPS[desk];
    return done ? `${done}${what && desk !== "answer" ? ` ${what}` : ""}` : `desk_${desk}${what ? ` ${what}` : ""}`;
  }
  return name.replace(/^mcp__\w+?__/, "");
}

const DESK_STEPS: Record<string, string> = {
  brief: "Read the AI review of",
  item: "Looked at",
  ask: "Read your ask",
  answer: "Wrote its answer",
  merging: "Looked at Merging",
  note: "Noted on",
  events: "Read what changed",
  list: "Read your Inbox",
};
