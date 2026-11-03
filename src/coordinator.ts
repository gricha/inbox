// The coordinator: one background Claude Code session (`claude --bg`) the desk starts on the first hand-off, ask or w, and
// keeps running after that. It wakes it with one line per batch of what changed on PRs in Merging, or at once with the
// owner's ask. Claude's own daemon runs it, so a desk restart leaves it be.
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Desk } from "./desk.ts";
import { claudeCommand, claudeMissing, claudeSpawn, runCommand } from "./review.ts";
import type { ActivityEvent, Ask, CoordinatorView } from "./types.ts";

const NAME = "Review Desk coordinator";
const KEY = "coordinator_bg"; // "coordinator" holds the old desk-run coordinator's state
const NEWS = "coordinator_news"; // kept so a desk restart or a failed start doesn't drop it
const ASKS = "coordinator_asks"; // the owner's asks it hasn't been told yet, as their lines
const FRESH = 15_000; // how often Merging may look for its claude.ai link until it has one
// It reads CI logs and comments anyone can write; these keep injected text from posting or rewriting as the owner.
// gh api whole: it POSTs whenever a field is passed, with no -X.
const DENY = [
  "Bash(gh pr comment:*)",
  "Bash(gh pr review:*)",
  "Bash(gh pr ready:*)",
  "Bash(gh pr edit:*)",
  "Bash(gh issue comment:*)",
  "Bash(gh api:*)",
  "Bash(git push --force:*)",
  "Bash(git push -f:*)",
];
// Every message is one line of ids, URLs, kinds and the owner's asks: never PR text, and an argument cmd.exe can pass (claudeSpawn).
const ROLE =
  "You are my Review Desk coordinator: the desk keeps you running and wakes you with a message when something changes on a PR in Merging. Follow the Coordinator section of the review-desk skill.";
const PR = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

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

  constructor(desk: Desk) {
    this.desk = desk;
  }

  get on(): boolean {
    return this.desk.settings["agent.coordinator"];
  }

  saved(): { id: string; url?: string } | null {
    return this.desk.store.get(KEY) as { id: string; url?: string } | null;
  }

  // [PR id, what changed], oldest first; only appended to until delivered.
  news(): [string, string][] {
    return (this.desk.store.get(NEWS) as [string, string][] | null) ?? [];
  }

  asks(): string[] {
    return (this.desk.store.get(ASKS) as string[] | null) ?? [];
  }

  // The desk home's coordinator directory, with the deny list as its project settings unless the owner wrote their own.
  dir(): string {
    const dir = path.join(this.desk.home, "coordinator");
    const file = path.join(dir, ".claude", "settings.json");
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ permissions: { deny: DENY } }, null, 2) + "\n");
    }
    return dir;
  }

  view(): CoordinatorView {
    const s = this.saved();
    if (s && !s.url && this.on && Date.now() - this.checked > FRESH) void this.flush();
    return { on: this.on, id: s?.id ?? null, url: s?.url ?? null };
  }

  // Desk start: the one it has is picked up, and checked every few minutes so one that crashed or was stopped comes back.
  start(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      void this.flush();
    }, this.every);
    this.ticker.unref();
    void this.flush();
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
    return (async () => {
      await this.flushing;
      await this.flush();
    })();
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
      void this.flush();
    }, this.batch);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.ticker) clearInterval(this.ticker);
    this.timer = null;
    this.ticker = null;
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

  // A failure keeps what's waiting for the next wake or check.
  async run(): Promise<void> {
    try {
      await this.stopping; // on again right after off: its process must be gone first, or the resume starts a copy
      if (!this.on) return;
      const a = await this.find();
      const news = this.news(); // after looking, so a wake that came meanwhile isn't left to the next check
      const asks = this.asks();
      const waiting = news.length > 0 || asks.length > 0 || this.asked;
      // Busy, in a shell or waiting on a permission: it stays queued.
      if (waiting && (!a?.status || a.status === "idle")) {
        const text = this.message(news, asks);
        this.asked = false;
        // Created only with something to deliver: a scratch desk's would reach the owner's desk through its MCP tools.
        if (!a) await this.launch(["--bg", "--name", NAME, "--remote-control", NAME, `${ROLE} ${text}`]);
        else {
          await this.halt(a);
          await this.launch(["--resume", a.sessionId, "--bg", text]);
        }
        this.desk.store.set(NEWS, this.news().slice(news.length));
        this.desk.store.set(ASKS, this.asks().slice(asks.length));
      } else if (a && !a.pid) await this.launch(["--resume", a.sessionId, "--bg"]); // no prompt, so no turn
      const s = this.saved();
      if (s && !s.url) {
        const url = /https:\/\/claude\.ai\/code\/session_\w+/.exec(await claude(["logs", s.id]).catch(() => ""))?.[0];
        if (url) {
          this.desk.store.set(KEY, { id: s.id, url });
          this.desk.changed();
        }
      }
      this.schedule();
    } catch (e) {
      this.asked = false;
      this.desk.log(`coordinator: ${(e as Error).message}`);
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
  async launch(args: string[]): Promise<void> {
    const out = await claude(args, this.dir());
    const id = /backgrounded\W+([\w-]+)/.exec(out)?.[1];
    if (!id) throw new Error(`claude didn't background it: ${out.trim().split("\n").at(-1) ?? ""}`);
    if (id !== this.saved()?.id) {
      this.desk.store.set(KEY, { id });
      this.desk.changed();
    }
    const note = /^note: .*/m.exec(out)?.[0];
    this.desk.log(`coordinator: ${args[0] === "--bg" ? "created" : "resumed"} ${id}${note ? ` (${note})` : ""}`);
  }

  // Its row in claude agents: the id the desk keeps, else the latest in its directory (a start the desk didn't see finish).
  async find(): Promise<Agent | null> {
    const all = (JSON.parse(await claude(["agents", "--json", "--all"])) as Agent[]).filter((a) => a.kind === "background");
    const dir = this.dir();
    const here = new Set([dir, fs.realpathSync(dir)]);
    const saved = this.saved();
    const a =
      all.find((x) => x.id === saved?.id) ??
      all
        .filter((x) => here.has(x.cwd))
        .sort((x, y) => (x.startedAt ?? 0) - (y.startedAt ?? 0))
        .at(-1) ??
      null;
    if (a?.id !== saved?.id) {
      this.desk.store.set(KEY, a && { id: a.id });
      this.desk.changed();
    }
    this.checked = Date.now();
    return a;
  }
}
