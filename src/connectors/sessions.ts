// Sessions: the owner's Claude Code and Codex sessions on this machine that need them, blocked on an answer or stalled.
// Read only: `claude agents --json --all`, the tail of each transcript, the desktop app's session records and Codex's
// threads. Any shape it doesn't know gives no item, never a wrong one; nothing it reads is kept beyond a one-line excerpt.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Result } from "effect";
import type { SessionKind } from "../types.ts";

export const TAIL = 64 * 1024; // bytes of a transcript or rollout read, from its end
const QUIET = 25 * 60_000; // busy with nothing written this long: stalled (a weak signal)
const LINE = 160;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const filled = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const parse = (text: string): unknown =>
  Result.getOrElse(Result.try({ try: (): unknown => JSON.parse(text), catch: () => null }), () => null);

// One line of what it said: whitespace folded, cut at LINE.
function oneLine(text: string): string {
  const t = text.replaceAll(/\s+/g, " ").trim();
  return t.length > LINE ? `${t.slice(0, LINE - 1)}…` : t;
}

// ---------------------------------------------------------------- claude agents --json

export interface AgentRow {
  sessionId: string;
  cwd: string;
  kind: "interactive" | "background";
  id?: string; // background only: the short id stop and attach take
  name?: string;
  state?: string; // background: working, blocked, done, failed, stopped
  status?: string; // while its process runs: busy, waiting, idle
  waitingFor?: string;
  pid?: number;
  startedAt?: number;
}

// null: not a list. A row without the fields every row has is dropped.
export function parseAgents(out: string): AgentRow[] | null {
  const listed = parse(out);
  if (!Array.isArray(listed)) return null;
  return listed.flatMap((x): AgentRow[] => {
    const o = obj(x);
    const sessionId = str(o?.sessionId);
    const cwd = str(o?.cwd);
    const kind = o?.kind;
    if (!o || !sessionId || !cwd || (kind !== "interactive" && kind !== "background")) return [];
    const row: AgentRow = { sessionId, cwd, kind };
    for (const k of ["id", "name", "state", "status", "waitingFor"] as const) if (str(o[k])) row[k] = str(o[k]);
    for (const k of ["pid", "startedAt"] as const) if (num(o[k]) !== undefined) row[k] = num(o[k]);
    return [row];
  });
}

// ---------------------------------------------------------------- a transcript's tail

// The last `bytes` of a file, from its first whole line; null when it can't be read.
export function readTail(file: string, bytes = TAIL): string | null {
  const read = Result.try({
    try: () => {
      const fd = fs.openSync(file, "r");
      const size = fs.fstatSync(fd).size;
      const at = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - at);
      fs.readSync(fd, buf, 0, buf.length, at);
      fs.closeSync(fd);
      const text = buf.toString("utf8");
      return at > 0 ? text.slice(text.indexOf("\n") + 1) : text;
    },
    catch: () => null,
  });
  return Result.getOrElse(read, () => null);
}

interface ApiError {
  error: string; // rate_limit, authentication_failed, billing_error, overloaded, unknown…
  status: number | null;
  resets_at: number | null; // ms
  text: string;
}

// What a transcript's tail says about the main thread's last turn.
export interface Tail {
  end: "turn" | "open" | "error" | "interrupted"; // ended normally, left open, ended on an API error, stopped by you
  key: string; // the last main-thread event's uuid
  at: string; // its timestamp
  written: string; // the last event's of any kind
  pending: { name: string; line: string } | null; // a tool call with no result yet
  question: string | null; // an AskUserQuestion with no answer
  error: ApiError | null;
  text: string | null; // the last assistant text of a turn that ended normally
  retrying: boolean; // the last event is a retry of a failed API call
  title: string | null;
  branch: string | null;
  cwd: string | null;
  entrypoint: string | null; // "cli" for a terminal's
}

const toolLine = (name: string, input: Record<string, unknown> | null): string => {
  const said = ["description", "command", "file_path", "path", "url", "pattern", "prompt"].map((k) => str(input?.[k])).find(Boolean);
  return oneLine(said ? `${name}: ${said}` : name);
};

const blocks = (m: Record<string, unknown> | null): Record<string, unknown>[] =>
  Array.isArray(m?.content)
    ? (m.content as unknown[]).flatMap((b) => {
        const o = obj(b);
        return o ? [o] : [];
      })
    : [];

// null: no main-thread turn in it, or one it can't read.
export function readTranscript(text: string): Tail | null {
  let last: { e: Record<string, unknown>; type: "user" | "assistant" } | null = null;
  let written = "";
  let title: string | null = null;
  let branch: string | null = null;
  let cwd: string | null = null;
  let entrypoint: string | null = null;
  let retrying = false;
  let turnText: string | null = null;
  let interrupted = false;
  const pending = new Map<string, { name: string; input: Record<string, unknown> | null }>();
  for (const line of text.split("\n")) {
    const e = obj(parse(line));
    if (!e) continue;
    const type = e.type;
    written = str(e.timestamp) ?? written;
    branch = str(e.gitBranch) ?? branch;
    cwd = str(e.cwd) ?? cwd;
    entrypoint = str(e.entrypoint) ?? entrypoint;
    if (type === "custom-title") title = str(e.customTitle) ?? title;
    if (type === "agent-name") title = title ?? str(e.agentName) ?? null;
    if (e.isSidechain === true) continue;
    if (type === "system") {
      if (e.subtype === "api_error") retrying = true;
      continue;
    }
    if ((type !== "user" && type !== "assistant") || e.isMeta === true) continue;
    retrying = false;
    const m = obj(e.message);
    if (type === "user") {
      const bs = blocks(m);
      for (const b of bs) if (b.type === "tool_result" && str(b.tool_use_id)) pending.delete(str(b.tool_use_id)!);
      const said = typeof m?.content === "string" ? m.content : bs.flatMap((b) => (b.type === "text" ? (str(b.text) ?? []) : [])).join(" ");
      interrupted = said.includes("[Request interrupted by user");
      if (said || bs.length) turnText = null;
    } else {
      for (const b of blocks(m)) {
        if (b.type === "tool_use" && str(b.id)) pending.set(str(b.id)!, { name: str(b.name) ?? "a tool", input: obj(b.input) });
        if (b.type === "text" && str(b.text)) turnText = str(b.text)!;
      }
      interrupted = false;
    }
    last = { e, type };
  }
  if (!last) return null;
  const e = last.e;
  const m = obj(e.message);
  const key = str(e.uuid);
  const at = str(e.timestamp);
  if (!key || !at) return null;
  const tail: Tail = {
    end: "open",
    key,
    at,
    written: written || at,
    pending: null,
    question: null,
    error: null,
    text: null,
    retrying,
    title,
    branch,
    cwd,
    entrypoint,
  };
  if (last.type === "user") return { ...tail, end: interrupted ? "interrupted" : "open" };
  if (e.isApiErrorMessage === true) {
    const quota = obj(e.quotaLimits);
    const resets = num(quota?.resetsAt);
    const said = blocks(m)
      .flatMap((b) => (b.type === "text" ? (str(b.text) ?? []) : []))
      .join(" ");
    const error = {
      error: str(e.error) ?? "unknown",
      status: num(e.apiErrorStatus) ?? null,
      resets_at: resets ? resets * 1000 : null,
      text: oneLine(said),
    };
    return { ...tail, end: "error", error };
  }
  const stop = m?.stop_reason;
  if (stop === "end_turn") return { ...tail, end: "turn", text: turnText };
  if (stop === "tool_use" && pending.size) {
    const [tool] = [...pending.values()].slice(-1);
    const asked = tool!.name === "AskUserQuestion" ? obj((tool!.input?.questions as unknown[] | undefined)?.[0]) : null;
    return {
      ...tail,
      pending: { name: tool!.name, line: toolLine(tool!.name, tool!.input) },
      question: asked ? oneLine(str(asked.question) ?? "") || null : null,
    };
  }
  return null; // a stop it doesn't know
}

// ---------------------------------------------------------------- the desktop app's records

export interface DesktopRecord {
  local_id: string;
  session_id: string; // its transcript's
  title: string;
  cwd: string;
  archived: boolean;
  active_at: number;
  summary: { category: string; detail: string; uuid: string } | null; // the app's own read of the last turn
  error_mark: { category: string; at: number; pending: boolean } | null;
  turn_at: number; // lastTurnEdgeAt
}

export function readDesktopRecord(text: string): DesktopRecord | null {
  const o = obj(parse(text));
  const local = str(o?.sessionId);
  const session = str(o?.cliSessionId);
  if (!o || !local?.startsWith("local_") || !session) return null;
  const s = obj(o.postTurnSummary);
  const mark = obj(o.priorErrorMark);
  return {
    local_id: local,
    session_id: session,
    title: str(o.title) ?? "",
    cwd: str(o.cwd) ?? "",
    archived: o.isArchived === true,
    active_at: num(o.lastActivityAt) ?? 0,
    summary:
      s && str(s.status_category)
        ? { category: str(s.status_category)!, detail: str(s.status_detail) ?? "", uuid: str(s.summarizes_uuid) ?? "" }
        : null,
    error_mark:
      mark && str(mark.category) ? { category: str(mark.category)!, at: num(mark.at) ?? 0, pending: mark.hadPendingTurn === true } : null,
    turn_at: num(o.lastTurnEdgeAt) ?? 0,
  };
}

// ---------------------------------------------------------------- Codex

export interface CodexThread {
  id: string;
  rollout: string;
  cwd: string;
  title: string;
  branch: string | null;
  updated_at: number; // ms
}

const CODEX_COLUMNS = ["id", "rollout_path", "cwd", "title", "git_branch", "updated_at_ms", "source", "archived"];

// Opened read only and immutable, so Codex's own writes never wait on it. Its own runs (codex exec, sub-agents) aren't yours.
export function codexThreads(file: string, since: number): CodexThread[] | null {
  if (!fs.existsSync(file)) return [];
  const read = Result.try({
    try: () => {
      const db = new DatabaseSync(`file:${file}?immutable=1`, { readOnly: true });
      const cols = new Set(
        db
          .prepare("PRAGMA table_info(threads)")
          .all()
          .map((c) => c.name),
      );
      const rows = CODEX_COLUMNS.every((c) => cols.has(c))
        ? db
            .prepare(
              "SELECT id, rollout_path, cwd, title, git_branch, updated_at_ms FROM threads WHERE archived = 0 AND source IN ('cli', 'vscode') AND updated_at_ms >= ?",
            )
            .all(since)
        : null;
      db.close();
      return rows;
    },
    catch: () => null,
  });
  const rows = Result.getOrElse(read, () => null);
  if (!rows) return null;
  return rows.flatMap((r): CodexThread[] => {
    const id = str(r.id);
    const rollout = str(r.rollout_path);
    const at = num(r.updated_at_ms);
    if (!id || !rollout || at === undefined) return [];
    return [{ id, rollout, cwd: str(r.cwd) ?? "", title: str(r.title) ?? "", branch: filled(r.git_branch) ?? null, updated_at: at }];
  });
}

export interface CodexTail {
  end: "complete" | "open" | "aborted";
  key: string;
  at: string;
  text: string | null; // task_complete's last_agent_message
}

export function readRollout(text: string): CodexTail | null {
  let out: CodexTail | null = null;
  for (const line of text.split("\n")) {
    const e = obj(parse(line));
    const p = obj(e?.payload);
    const at = str(e?.timestamp);
    if (!e || e.type !== "event_msg" || !p || !at) continue;
    const key = `${at}:${num(e.ordinal) ?? ""}`;
    if (p.type === "task_started") out = { end: "open", key, at, text: null };
    else if (p.type === "task_complete") out = { end: "complete", key, at, text: str(p.last_agent_message) ?? null };
    else if (p.type === "turn_aborted") out = { end: "aborted", key, at, text: null };
  }
  return out;
}

// ---------------------------------------------------------------- deciding

// One session as read this pass.
export interface Seen {
  kind: SessionKind;
  session_id: string;
  local_id?: string; // the desktop app's
  short_id?: string; // a background one's
  name: string;
  cwd: string;
  branch: string | null;
  row: AgentRow | null;
  tail: Tail | null;
  codex: CodexTail | null;
  desktop: DesktopRecord | null;
  written: number | null; // the transcript's mtime
}

export type Verdict =
  | { state: "blocked" | "stalled"; reason: string; excerpt: string; since: string; resets_at: number | null; key: string }
  | { ask: string; since: string; key: string; excerpt: string };

const WAITING: Record<string, string> = {
  "permission prompt": "needs permission",
  "input needed": "needs your input",
  "sandbox request": "needs sandbox access",
  "worker request": "needs a worker approved",
  "dialog open": "has a dialog open",
};

const pad = (n: number) => String(n).padStart(2, "0");
// Local time; a day of the week when it's not today.
export function untilText(at: number, now: number): string {
  const d = new Date(at);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return new Date(now).toDateString() === d.toDateString() ? hm : `${d.toLocaleDateString("en-US", { weekday: "short" })} ${hm}`;
}

// The last line of a message that asks something.
const askLine = (text: string) =>
  oneLine(
    text
      .split("\n")
      .map((l) => l.trim())
      .findLast((l) => l.includes("?")) ?? text,
  );

function errorVerdict(err: ApiError, t: Tail, now: number): Extract<Verdict, { state: string }> | null {
  const base = { since: t.at, key: t.key, excerpt: err.text, resets_at: null };
  if (err.error === "authentication_failed" || err.status === 401) return { ...base, state: "blocked", reason: "login expired" };
  if (err.error === "billing_error" || err.status === 402) return { ...base, state: "blocked", reason: "billing problem" };
  if (err.error === "rate_limit" || err.status === 429) {
    const later = err.resets_at && err.resets_at > now ? err.resets_at : null;
    return {
      ...base,
      state: "stalled",
      reason: later ? `rate limited until ${untilText(later, now)}` : "rate limited",
      resets_at: err.resets_at,
    };
  }
  if (err.error === "overloaded" || err.status === 529) return { ...base, state: "stalled", reason: "API overloaded" };
  if ((err.status ?? 0) >= 500) return { ...base, state: "stalled", reason: `API error ${err.status}` };
  return null;
}

export function classify(s: Seen, now: number): Verdict | null {
  const { row, tail: t, desktop: d } = s;
  const live = !!row?.pid && !!row.status;
  if (s.codex) {
    const c = s.codex;
    if (c.end === "complete" && c.text?.includes("?")) return { ask: c.text, since: c.at, key: c.key, excerpt: askLine(c.text) };
    const idle = now - Date.parse(c.at);
    if (c.end === "open" && (s.written ?? 0) < now - QUIET && idle > QUIET)
      return { state: "stalled", reason: "no progress", excerpt: "", since: c.at, resets_at: null, key: `${c.key}:quiet` };
    return null;
  }
  const since = t?.at ?? new Date(row?.startedAt ?? d?.active_at ?? now).toISOString();
  const key = t?.key ?? since;
  const v = (state: "blocked" | "stalled", reason: string, excerpt = "", resets_at: number | null = null): Verdict => ({
    state,
    reason,
    excerpt,
    since,
    resets_at,
    key: `${key}:${reason}`,
  });
  if (live && row.status === "waiting") {
    const what = WAITING[row.waitingFor ?? ""] ?? "waiting on you";
    const tool = t?.pending;
    if (t?.question) return v("blocked", "asked a question", t.question);
    if (row.waitingFor === "permission prompt" && tool) return v("blocked", `${what}: ${tool.name}`, tool.line);
    return v("blocked", what, tool?.line ?? "");
  }
  if (t?.question) return v("blocked", "asked a question", t.question);
  if (t?.pending?.name === "ExitPlanMode") return v("blocked", "waiting on plan approval");
  if (t?.end === "error" && t.error) {
    const e = errorVerdict(t.error, t, now);
    if (e) return { ...e, key: `${e.key}:${e.reason}` };
  }
  if (row?.state === "blocked") return v("blocked", "needs you", t?.text ? askLine(t.text) : "");
  if (row?.state === "failed") return v("stalled", "failed");
  if (d?.summary?.category === "blocked" && (!t || t.end === "turn")) return v("blocked", "needs you", oneLine(d.summary.detail));
  if (d?.error_mark?.pending && d.error_mark.at >= d.turn_at)
    return v("stalled", d.error_mark.category === "query_error" ? "turn failed" : "stopped mid-turn");
  if (t?.end === "open" && !live && row?.state !== "stopped") return v("stalled", "stopped mid-turn", t.pending?.line ?? "");
  // Weak: busy, nothing written for a while, not retrying, no subagent at work.
  const quiet = s.written === null ? 0 : now - s.written;
  if (live && row.status === "busy" && t && !t.retrying && quiet > QUIET && !["Task", "Agent"].includes(t.pending?.name ?? ""))
    return { ...v("stalled", "no progress", t.pending?.line ?? ""), since: new Date(s.written!).toISOString() };
  // A turn that ended asking something, where nothing else read it: the model says whether it waits on you.
  if (t?.end === "turn" && t.text?.includes("?") && live && row.status === "idle" && s.kind === "cli")
    return { ask: t.text, since, key, excerpt: askLine(t.text) };
  return null;
}
