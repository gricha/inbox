// The work Claude owes the owner, kept in the store so a desk restart forgets none of it: each AI review of a PR, each
// of their asks to their agent, and each answer of theirs to an agent's question until whoever asked reads it. What the
// desk tracks in memory (Desk.generating, the coordinator's asks) writes through it, so "Claude is reviewing it" is true
// exactly while its job runs, and a loop on the desk's runner sees each one through.
import { Effect } from "effect";
import type { Desk } from "./desk.ts";
import { CommandTimeout } from "./errors.ts";
import { JOB_ATTEMPTS as ATTEMPTS, type Ask, type Job } from "./types.ts";

const MINUTE = 60_000;
const BACKOFF = [2 * MINUTE, 10 * MINUTE]; // after a review's first and second failed try
const REVIEW_TIMEOUT = 15 * MINUTE; // its two claude calls stop at 5 minutes each, its diff's three reads at 30 s
const ASK_WAIT = [5 * MINUTE, 15 * MINUTE, 30 * MINUTE]; // unanswered this long after it went to your agent, which is idle
const ANSWER_WAIT = 30 * MINUTE; // your answer unread this long: the session that asked has probably ended
const KEPT = 24 * 60 * MINUTE; // a done job, a failed ask, and an answer you were told is unread
export const GONE = "its run ended without an answer";
export const askOf = (line: string): string | undefined => /^My ask (\w+)/.exec(line)?.[1];
// Your answer to your agent's own question, as answerInquiry() words its wake line.
export const answerOf = (line: string): string | undefined => /^My answer to your question (\w+)/.exec(line)?.[1];

export class Jobs {
  private desk: Desk;
  private rows: Map<string, Job>; // the store's, by kind and key, in the order they were first kept
  timer: NodeJS.Timeout | null = null;

  // A review the desk was in when it stopped never finishes: it's queued again, and that try doesn't count. An ask stays
  // as it was: your agent has it, and a desk restart leaves it running.
  constructor(desk: Desk) {
    this.desk = desk;
    this.rows = new Map(desk.store.jobs().map((j) => [`${j.kind} ${j.key}`, j]));
    for (const j of this.list())
      if (j.kind === "ai_review" && j.state === "running")
        this.change(j.kind, j.key, { state: "queued", attempts: Math.max(0, j.attempts - 1), retry_at: null });
  }

  get(kind: Job["kind"], key: string): Job | null {
    return this.rows.get(`${kind} ${key}`) ?? null;
  }

  list(): Job[] {
    return [...this.rows.values()];
  }

  // Queued and due: its wait, if a try failed, is over.
  due(kind: Job["kind"]): Job[] {
    const now = this.desk.now().toISOString();
    return this.list().filter((j) => j.kind === kind && j.state === "queued" && (!j.retry_at || j.retry_at <= now));
  }

  // Waiting for whoever runs it next (an ask, for your agent to be idle); `fresh`: you asked, so its tries start over.
  queue(kind: Job["kind"], key: string, item: string | null, fresh = false): void {
    const was = this.get(kind, key);
    const now = this.iso();
    this.change(kind, key, {
      item,
      state: "queued",
      queued_at: now,
      finished_at: null,
      retry_at: null,
      ...((fresh || !was) && { attempts: 0 }),
    });
  }

  // A try starts. One of another commit, one after it was done, or one you asked for (`fresh`) starts its tries over.
  begin(kind: Job["kind"], key: string, o: { item?: string | null; head?: string | null; fresh?: boolean } = {}): void {
    const was = this.get(kind, key);
    const moved = o.head !== undefined && was?.head !== o.head;
    const over = !was || !!o.fresh || moved || was.state === "done";
    this.change(kind, key, {
      ...(o.item !== undefined && { item: o.item }),
      ...(o.head !== undefined && { head: o.head }),
      ...(moved && { error: null }), // another commit's error isn't this one's
      state: "running",
      attempts: over ? 1 : was.attempts + 1,
      started_at: this.iso(),
      finished_at: null,
      retry_at: null,
    });
  }

  done(kind: Job["kind"], key: string): void {
    if (this.get(kind, key)) this.change(kind, key, { state: "done", finished_at: this.iso(), retry_at: null, error: null });
  }

  // A try failed: it's queued again after its backoff, or failed for good once it's had ATTEMPTS.
  tried(kind: Job["kind"], key: string, error: string): void {
    const was = this.get(kind, key);
    if (!was) return;
    const wait = BACKOFF[was.attempts - 1];
    if (was.attempts < ATTEMPTS && wait !== undefined)
      this.change(kind, key, { state: "queued", retry_at: new Date(this.desk.now().getTime() + wait).toISOString(), error });
    else this.fail(kind, key, error);
  }

  // A try the agent's own failure took (its login, its limit): not the job's, so it isn't counted, and it's owed again at `until`.
  held(kind: Job["kind"], key: string, error: string, until: number): void {
    const was = this.get(kind, key);
    if (!was) return;
    this.change(kind, key, { state: "queued", attempts: Math.max(0, was.attempts - 1), retry_at: new Date(until).toISOString(), error });
  }

  fail(kind: Job["kind"], key: string, error: string): void {
    this.change(kind, key, { state: "failed", finished_at: this.iso(), retry_at: null, error });
  }

  drop(kind: Job["kind"], key: string): void {
    if (this.rows.delete(`${kind} ${key}`)) this.desk.store.dropJob(kind, key);
  }

  start(): void {
    if (this.timer || this.desk.stopped) return;
    this.timer = setInterval(() => {
      this.desk.runner.fork(
        "jobs",
        Effect.sync(() => {
          this.tick();
        }),
      );
    }, MINUTE);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // The loop's pass, every minute: a review past its time, or whose run is gone, is a failed try; an ask your agent stopped
  // without answering goes to it again, once per wait; an answer of yours nobody read in half an hour, you're told once;
  // what's owed for nothing on the desk now goes. Then the AI reviews' retries whose wait is over start, before anything new.
  tick(): void {
    const desk = this.desk;
    if (desk.stopped) return;
    const now = desk.now().getTime();
    let moved = false;
    for (const j of this.list()) {
      if (j.kind === "ask") this.ask(j, now);
      else if (j.kind === "answer") this.answer(j, now);
      else this.review(j, now);
      if (this.get(j.kind, j.key) !== j) moved = true;
    }
    if (moved) desk.changed();
    desk.pumpAi();
  }

  private review(j: Job, now: number): void {
    const desk = this.desk;
    if (j.state === "running") {
      const live = desk.generating.has(j.key);
      if (!live) desk.aiGone(j.key);
      else if (now - Date.parse(j.started_at!) >= REVIEW_TIMEOUT)
        desk.aiStop(j.key, new CommandTimeout({ command: "claude", timeoutMs: REVIEW_TIMEOUT }));
      return;
    }
    if (!desk.loaded) return;
    const it = desk.snapshot().entries.get(j.key)?.item;
    // Merged, closed or gone, or a commit since that this wasn't of: nothing more is owed.
    if (!it || it.state !== "open" || (j.state !== "queued" && j.head !== it.head_oid)) this.drop(j.kind, j.key);
    else if (j.state === "done" && now - Date.parse(j.finished_at!) > KEPT) this.drop(j.kind, j.key);
    // With AI reviews off nothing tries on its own: a failed try is failed, with Try again in its review.
    else if (j.state === "queued" && j.error && !desk.autoAiOn()) this.fail(j.kind, j.key, j.error);
  }

  private ask(j: Job, now: number): void {
    const desk = this.desk;
    const a = desk.asks().find((x) => x.id === j.key);
    const over = (j.state === "done" || j.state === "failed") && now - Date.parse(j.finished_at!) > KEPT;
    if (!a || over) this.drop(j.kind, j.key);
    else if (a.answer) {
      if (j.state !== "done") this.done(j.kind, j.key);
    } else if (j.state === "running" || j.state === "queued") {
      if (desk.coordinator.on) this.again(j, a, now);
      else this.fail(j.kind, j.key, "your agent is off: Settings → Agent");
    }
  }

  // Your answer to an agent's question: done once whoever asked reads it. Nothing pushes it there, so unread past its wait
  // it's failed and you're told, once; in quiet hours, when they end.
  private answer(j: Job, now: number): void {
    const desk = this.desk;
    const q = desk.inquiries().find((x) => x.id === j.key);
    const over = j.state !== "queued" && now - Date.parse(j.finished_at!) > KEPT;
    const late = j.state === "queued" && now - Date.parse(j.queued_at) >= ANSWER_WAIT;
    if (!q?.answer || over) this.drop(j.kind, j.key);
    else if (q.answer.read_at) {
      if (j.state !== "done") this.done(j.kind, j.key);
    } else if (late && (desk.mayNotify() || !desk.settings["notify.enabled"])) desk.answerUnread(q);
  }

  // Handed over and unanswered: once its wait is over with your agent idle, it goes again, or it's failed after ATTEMPTS.
  private again(j: Job, a: Ask, now: number): void {
    const c = this.desk.coordinator;
    if (j.state === "queued") return; // it gets it once it's idle
    // On it or on something else, unable to run, or about to be told it again: never asked twice.
    const idle = c.status === "idle" || c.status === "stopped" || c.status === null;
    if (!idle || c.flushing || c.error() !== null || c.asks().some((l) => askOf(l) === a.id)) return;
    if (now - Date.parse(j.started_at!) < (ASK_WAIT[j.attempts - 1] ?? ASK_WAIT.at(-1)!)) return;
    if (j.attempts >= ATTEMPTS) this.fail(j.kind, j.key, `your agent stopped without answering it, ${j.attempts} times`);
    else if (!a.item_id || this.desk.loaded) this.desk.resendAsk(a); // what it's about is read from the snapshot
  }

  private iso(): string {
    return this.desk.now().toISOString();
  }

  // Kept in memory and in the store; nothing once the desk has stopped, since its store may be closed.
  private change(kind: Job["kind"], key: string, to: Partial<Job>): void {
    if (this.desk.stopped) return;
    const job: Job = {
      kind,
      key,
      item: null,
      head: null,
      state: "queued",
      attempts: 0,
      queued_at: this.iso(),
      started_at: null,
      finished_at: null,
      retry_at: null,
      error: null,
      ...this.get(kind, key),
      ...to,
    };
    this.rows.set(`${kind} ${key}`, job);
    this.desk.store.putJob(job);
  }
}
