// The coordinator: one background Claude Code session (`claude --bg`) the desk starts on the first hand-off, ask or w, and
// keeps running after that. It wakes it with one line per batch of what changed on PRs in Merging, or at once with the
// owner's ask. Claude's own daemon runs it, so a desk restart leaves it be.
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Desk } from "./desk.ts";
import { claudeCommand, claudeMissing, claudeSpawn, runCommand } from "./review.ts";
import type { ActivityEvent, Ask, CoordinatorView } from "./types.ts";
import { detached, report } from "./sentry.ts";

export const NAME = "Review Desk coordinator";
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
  "You are my Review Desk coordinator: the desk keeps you running and wakes you with a message when something changes on a PR in Merging. Follow the Coordinator section of the review-desk skill.";
const PR = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
const PERMISSION = { bypass: "bypassPermissions", default: "default" } as const;
type Mode = keyof typeof PERMISSION;
// The desk's news for the owner's PR that's ready to merge but conflicts: it's in Merging only until GitHub sees it mergeable.
export const REBASE =
  "ready to merge but conflicts: rebase it onto its base, run what's runnable, push with --force-with-lease to its own branch, don't merge it; hand it back if it can't rebase cleanly";

// <home>/<name>, whose project settings keep every rule of deny beside the owner's own.
export function denyDir(home: string, name: string, deny: string[]): string {
  const dir = path.join(home, name);
  const file = path.join(dir, ".claude", "settings.json");
  const s = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { permissions?: { deny?: string[] } }) : {};
  const have = s.permissions?.deny ?? [];
  const missing = deny.filter((r) => !have.includes(r));
  if (missing.length > 0) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const next = { ...s, permissions: { ...s.permissions, deny: [...have, ...missing] } };
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  }
  return dir;
}

interface Agent {
  id: string;
  sessionId: string;
  cwd: string;
  kind: string;
  status?: string; // only while it runs: idle, busy, shell, waiting
  pid?: number; // only while it runs
  startedAt?: number;
}

const claude = (args: string[], cwd?: string) =>
  runCommand(claudeSpawn(claudeCommand(), args), { cwd, timeout: 60_000, missing: claudeMissing(claudeCommand()) });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The owner's words as they wrote them (they're trusted); what they were on only as its id and URLs.
export function askLine(a: Ask, url: string | null): string {
  const about = [
    a.item_id ? `about ${a.item_id}${url ? ` (${url})` : ""}` : "",
    a.thread_url ? `on the thread ${a.thread_url}` : "",
  ].filter(Boolean);
  return `My ask ${a.id}${about.length ? `, ${about.join(", ")}` : ""}: "${a.text}" Answer it with desk_answer.`;
}

// What wakes it, in its words; null for what doesn't (its own pushes, CI starting).
export function wakeFor(e: Pick<ActivityEvent, "kind" | "data">): string | null {
  if (e.kind === "ci") return e.data.to === "green" ? "CI passed" : e.data.to === "red" ? "CI failed" : null;
  if (e.kind === "reviewed")
    return e.data.state === "approved" ? "approved" : e.data.state === "changes_requested" ? "changes requested" : "new review";
  if (e.kind === "commented") return "new comment";
  if (e.kind === "conflict") return "merge conflict";
  return null;
}

export class Coordinator {
  desk: Desk;
  batch = 60_000; // what lands within this goes in one message
  every = 5 * 60_000; // how often the desk checks it's still running: one `claude agents`, no turn
  asked = false; // w in Merging
  timer: NodeJS.Timeout | null = null;
  ticker: NodeJS.Timeout | null = null;
  flushing: Promise<void> | null = null;
  stopping: Promise<void> | null = null;
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
    if (why && !was && this.desk.mayNotify()) this.desk.notify("Coordinator can't run", why);
  }

  // The desk home's coordinator directory; its project settings keep every rule of the deny list, beside the owner's own.
  dir(): string {
    return denyDir(this.desk.home, "coordinator", DENY);
  }

  view(): CoordinatorView {
    const s = this.saved();
    if (s && !s.url && this.on && Date.now() - this.checked > FRESH) void this.flush();
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
      detached(() => void this.flush());
    }, this.every);
    this.ticker.unref();
    void this.flush();
    this.watch(); // an ask from before a restart still waits
  }

  // A hand-off, or news on a PR in Merging.
  wake(id: string, what: string): void {
    if (!this.on || !PR.test(id)) return;
    const news = this.news();
    if (!news.some(([i, w]) => i === id && w === what)) this.desk.store.set(NEWS, [...news, [id, what]]);
    this.schedule();
  }

  // The owner's ask goes now, not with the next batch: once a run in progress is done, and once it's idle.
  tell(line: string): Promise<void> {
    claudeSpawn(claudeCommand(), [line]); // throws on what cmd.exe can't pass
    this.desk.store.set(ASKS, [...this.asks(), line]);
    this.watch();
    return this.again();
  }

  // While one of your asks waits on its answer, what it's doing is looked at often, so the composer can say: on it,
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
      if (!this.flushing) detached(() => void this.find().catch(() => null));
    }, this.watchEvery);
    this.watching.unref();
  }

  untell(line: string): void {
    this.desk.store.set(
      ASKS,
      this.asks().filter((l) => l !== line),
    );
  }

  // w in Merging: start it, or have it look now.
  now(): Promise<void> {
    if (this.flushing) return this.flushing; // a second w while one runs would wake it twice
    this.asked = true;
    return this.flush();
  }

  schedule(): void {
    if (this.timer || this.desk.stopped || !this.on || !(this.news().length || this.asks().length || this.asked)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      detached(() => void this.flush());
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
  stop(): Promise<void> {
    this.desk.store.set(NEWS, null);
    this.desk.store.set(ASKS, null);
    this.asked = false;
    this.stopping = (async () => {
      await this.flushing;
      if (!this.saved()) return;
      try {
        const a = await this.find();
        if (a) await this.halt(a);
      } catch (e) {
        this.desk.log(`coordinator: ${(e as Error).message}`);
      }
    })();
    return this.stopping;
  }

  // Picks it up, resumes it if it stopped, and hands it what's waiting once it's idle; looks again a batch later while it works.
  flush(): Promise<void> {
    this.flushing ??= this.run();
    return this.flushing;
  }

  // The run in progress may have read the asks or settings before they changed.
  async again(): Promise<void> {
    await this.flushing;
    await this.flush();
  }

  // A failure keeps what's waiting for the next wake or check.
  async run(): Promise<void> {
    try {
      await this.stopping; // on again right after off: its process must be gone first, or the resume starts a copy
      if (!this.on) return;
      const a = await this.find();
      this.checked = Date.now(); // here, not in find(): the watch's looks mustn't hold off the link lookup
      const news = this.news(); // after looking, so a wake that came meanwhile isn't left to the next check
      const asks = this.asks();
      const waiting = news.length > 0 || asks.length > 0 || this.asked;
      const idle = !a?.status || a.status === "idle";
      const mode: Mode = this.desk.settings["agent.coordinator_bypass"] ? "bypass" : "default";
      const flags = ["--permission-mode", PERMISSION[mode]];
      // A resumed session keeps the mode it started with; passing one makes claude start a copy with its history, so only to change it.
      const switching = !!a && (this.saved()?.mode ?? "default") !== mode;
      // A copy may not keep its original's name and Remote Control, so the switch passes them again.
      const resume = a ? ["--resume", a.sessionId, "--bg", ...(switching ? ["--name", NAME, "--remote-control", NAME, ...flags] : [])] : [];
      // Stuck on a permission prompt is why bypass gets turned on: it switches now, and the copy gets a turn to carry on.
      const stuck = switching && a?.status === "waiting";
      // Busy, in a shell or waiting on a permission: it stays queued.
      if ((waiting && idle) || stuck) {
        const text = this.message(news, asks);
        this.asked = false;
        // Created only with something to deliver: a scratch desk's would reach the owner's desk through its MCP tools.
        if (!a)
          await this.launch(
            ["--bg", "--name", NAME, "--remote-control", NAME, ...(mode === "bypass" ? flags : []), `${ROLE} ${text}`],
            mode,
          );
        else {
          await this.halt(a);
          await this.launch([...resume, text], mode);
        }
        this.desk.store.set(NEWS, this.news().slice(news.length));
        this.desk.store.set(ASKS, this.asks().slice(asks.length));
        this.saw("busy"); // it has a turn now; the next look says how it goes
      } else if (a && (!a.pid || (switching && idle))) {
        await this.halt(a);
        await this.launch(resume, mode); // no prompt, so no turn
      }
      const s = this.saved();
      if (s && !s.url) {
        const url = /https:\/\/claude\.ai\/code\/session_\w+/.exec(await claude(["logs", s.id]).catch(() => ""))?.[0];
        if (url) {
          this.desk.store.set(KEY, { ...s, url });
          this.desk.changed();
        }
      }
      this.failure = null;
      this.failed(null);
      this.schedule();
    } catch (e) {
      this.asked = false;
      this.failure = e;
      if (!this.desk.stopped) report(e, "coordinator"); // not when the desk stopping killed it
      this.desk.log(`coordinator: ${(e as Error).message}`);
      this.failed((e as Error).message.trim());
    } finally {
      this.flushing = null;
    }
  }

  // --resume continues it (same id and history) only once its process has exited, and only with no other flag.
  async halt(a: Agent): Promise<void> {
    if (a.status) await claude(["stop", a.id]);
    for (let i = 0; a.pid && i < 50 && alive(a.pid); i++) await sleep(200);
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
  async launch(args: string[], mode: Mode): Promise<void> {
    const out = await claude(args, this.dir());
    const id = /backgrounded\W+([\w-]+)/.exec(out)?.[1];
    if (!id) throw new Error(`claude didn't background it: ${out.trim().split("\n").at(-1) ?? ""}`);
    const s = this.saved();
    if (id !== s?.id || mode !== s.mode) {
      this.desk.store.set(KEY, id === s?.id ? { ...s, mode } : { id, mode });
      this.desk.changed();
    }
    const note = /^note: .*/m.exec(out)?.[0];
    this.desk.log(`coordinator: ${args[0] === "--bg" ? "created" : "resumed"} ${id}${note ? ` (${note})` : ""}`);
  }

  // Its row in claude agents: the id it keeps, else the latest running one here (a start it didn't see finish; not one a switch stopped).
  async find(): Promise<Agent | null> {
    const all = (JSON.parse(await claude(["agents", "--json", "--all"])) as Agent[]).filter((a) => a.kind === "background");
    const dir = this.dir();
    const here = new Set([dir, fs.realpathSync(dir)]);
    const saved = this.saved();
    const a =
      all.find((x) => x.id === saved?.id) ??
      all
        .filter((x) => here.has(x.cwd) && x.pid)
        .sort((x, y) => (x.startedAt ?? 0) - (y.startedAt ?? 0))
        .at(-1) ??
      null;
    if (a?.id !== saved?.id) {
      // The desk didn't see its mode, so the next launch sets the setting's.
      this.desk.store.set(KEY, a && { id: a.id, mode: "unknown" });
      this.desk.changed();
    }
    this.saw(a ? (a.pid ? ((a.status as CoordinatorView["status"]) ?? "idle") : "stopped") : null);
    return a;
  }

  saw(status: CoordinatorView["status"]): void {
    if (status === this.status) return;
    this.status = status;
    this.desk.changed();
  }
}
