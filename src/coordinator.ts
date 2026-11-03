// The coordinator: one background Claude Code session (`claude --bg`) kept running while the setting is on. The desk creates
// it once and picks it up after that, and messages it on its inbox socket: one line per batch of what changed on PRs in
// Merging, or at once with the owner's ask. Claude's own daemon runs it, so a desk restart leaves it be.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Desk } from "./desk.ts";
import { claudeCommand, claudeMissing, claudeSpawn, runCommand } from "./review.ts";
import type { ActivityEvent, Ask, CoordinatorView } from "./types.ts";

const NAME = "Review Desk coordinator";
const KEY = "coordinator_bg"; // "coordinator" holds the old desk-run coordinator's state
const NEWS = "coordinator_news"; // kept so a desk restart or a failed delivery doesn't drop it
const ASKS = "coordinator_asks"; // the owner's asks it hasn't been told yet, as their lines
const FRESH = 15_000; // how often Merging may look for its claude.ai link until it has one
// Where a running session listens: <root>/cc-socks(-n)/<pid>.sock. Windows has none of these, so it's stopped and resumed.
const ROOTS = process.getuid ? ["/tmp", "/private/tmp", `/run/user/${process.getuid()}`] : [];
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
  "You are my Review Desk coordinator: the desk keeps you running and messages you when something changes on a PR in Merging. Follow the Coordinator section of the review-desk skill.";
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
type Running = Agent & { pid: number };

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

// One line on its socket is a message from the owner: a busy session reads it between steps, an idle one starts a turn.
function post(file: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(file, () => {
      s.end(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
    });
    s.setTimeout(10_000, () => {
      s.destroy(new Error("its inbox didn't take the message"));
    });
    s.on("error", reject);
    s.on("close", () => {
      resolve();
    });
  });
}

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
  socks = ROOTS;
  asked = false; // w in Merging
  timer: NodeJS.Timeout | null = null;
  ticker: NodeJS.Timeout | null = null;
  flushing: Promise<void> | null = null;
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

  // Desk start: running from now on, and checked every few minutes so one that crashed or was stopped comes back.
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

  // The owner's ask goes now, not with the next batch: once a delivery in progress is done.
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

  // w in Merging: have it look now (and start it, if it isn't running).
  now(): Promise<void> {
    if (this.flushing) return this.flushing; // a second w while one runs would message it twice
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
  async stop(): Promise<void> {
    this.desk.store.set(NEWS, null);
    this.desk.store.set(ASKS, null);
    this.asked = false;
    await this.flushing;
    if (!this.saved()) return;
    try {
      const a = await this.find();
      if (a?.pid) await claude(["stop", a.id]);
    } catch (e) {
      this.desk.log(`coordinator: ${(e as Error).message}`);
    }
  }

  // Makes sure it runs and hands it what's waiting.
  flush(): Promise<void> {
    this.flushing ??= this.run();
    return this.flushing;
  }

  // A failure keeps what's waiting for the next wake or check.
  async run(): Promise<void> {
    try {
      if (!this.on) return;
      const a = await this.ensure();
      const news = this.news();
      const asks = this.asks();
      if (news.length || asks.length || this.asked) {
        this.asked = false;
        await this.send(a, this.message(news, asks));
        this.desk.store.set(NEWS, this.news().slice(news.length));
        this.desk.store.set(ASKS, this.asks().slice(asks.length));
      }
      if (!this.saved()?.url) {
        const url = /https:\/\/claude\.ai\/code\/session_\w+/.exec(await claude(["logs", a.id]).catch(() => ""))?.[0];
        if (url) {
          this.desk.store.set(KEY, { id: a.id, url });
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

  // Running: picked up as it is. Stopped or crashed: resumed, which starts no turn. Never made, or removed: created.
  async ensure(): Promise<Running> {
    let a = await this.find();
    if (a?.pid) return a as Running;
    // --resume continues it (same id and history) only with no other flag; with them it starts a copy.
    if (a) await this.launch(["--resume", a.sessionId, "--bg"]);
    else await this.launch(["--bg", "--name", NAME, "--remote-control", NAME, ROLE]);
    for (let i = 0; i < 25 && !a?.pid; i++) {
      a = await this.find();
      if (!a?.pid) await sleep(200);
    }
    if (!a?.pid) throw new Error("claude started it, but it isn't running");
    return a as Running;
  }

  async send(a: Running, text: string): Promise<void> {
    const inbox = await this.inbox(a.pid);
    if (inbox) return post(inbox, text);
    // No inbox: stopped, then resumed with the message once its process has exited.
    await claude(["stop", a.id]);
    for (let i = 0; i < 50 && alive(a.pid); i++) await sleep(200);
    await this.launch(["--resume", a.sessionId, "--bg", text]);
  }

  // Its socket; a session that just started takes a moment to open it.
  async inbox(pid: number): Promise<string | null> {
    for (let i = 0; this.socks.length && i < 50; i++) {
      for (const root of this.socks) {
        const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter((n) => /^cc-socks(-\d+)?$/.test(n)) : [];
        const file = dirs.map((d) => path.join(root, d, `${pid}.sock`)).find((f) => fs.existsSync(f));
        if (file) return file;
      }
      await sleep(200);
    }
    return null;
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
