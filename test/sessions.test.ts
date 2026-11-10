// The Sessions source: Claude Code and Codex sessions on this machine that need you, read from fixtures shaped like 2.1.321's
// files (claude agents --json, transcripts, the desktop app's records) and codex-cli 0.154's state_5.sqlite and rollouts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  classify,
  codexThreads,
  parseAgents,
  readDesktopRecord,
  readRollout,
  readTail,
  readTranscript,
  TAIL,
  untilText,
  type AgentRow,
  type Seen,
} from "../src/connectors/sessions.ts";
import { NOW } from "./helpers/items.ts";
const MIN = 60_000;
const at = (mins: number) => new Date(NOW.getTime() + mins * MIN).toISOString();

// One transcript's lines, in the order claude writes them, a minute apart from an hour before `base`.
function lines(sessionId: string, cwd: string, base = NOW.getTime()) {
  let n = 0;
  let t = -60;
  const ev = (o: Record<string, unknown>) =>
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      uuid: `${sessionId.slice(0, 4)}-u${n++}-${base}`,
      timestamp: new Date(base + (t += 1) * MIN).toISOString(),
      userType: "external",
      entrypoint: "cli",
      cwd,
      sessionId,
      version: "2.1.321",
      gitBranch: "feature/x",
      ...o,
    });
  const msg = (role: string, content: unknown, stop?: string) => ({ role, content, ...(stop && { stop_reason: stop }) });
  return {
    prompt: (text: string) => ev({ type: "user", message: msg("user", text) }),
    result: (id: string) => ev({ type: "user", message: msg("user", [{ type: "tool_result", tool_use_id: id, content: "ok" }]) }),
    thinking: () => ev({ type: "assistant", message: msg("assistant", [{ type: "thinking", thinking: "" }], "end_turn") }),
    said: (text: string) => ev({ type: "assistant", message: msg("assistant", [{ type: "text", text }], "end_turn") }),
    tool: (id: string, name: string, input: Record<string, unknown>) =>
      ev({ type: "assistant", message: msg("assistant", [{ type: "tool_use", id, name, input }], "tool_use") }),
    sidechain: () => ev({ type: "assistant", isSidechain: true, message: msg("assistant", [{ type: "text", text: "sub" }], "end_turn") }),
    apiError: (error: string, status: number, resetsAt?: number) =>
      ev({
        type: "assistant",
        isApiErrorMessage: true,
        error,
        apiErrorStatus: status,
        ...(resetsAt && { quotaLimits: { status: "rejected", resetsAt, rateLimitType: "five_hour", isUsingOverage: false } }),
        message: { model: "<synthetic>", ...msg("assistant", [{ type: "text", text: `API Error: ${status} ${error}` }], "stop_sequence") },
      }),
    stopHook: () => ev({ type: "system", subtype: "stop_hook_summary", hookCount: 1 }),
    retry: () => ev({ type: "system", subtype: "api_error", level: "error", retryAttempt: 2, maxRetries: 10, retryInMs: 4000 }),
    interrupted: () => ev({ type: "user", message: msg("user", [{ type: "text", text: "[Request interrupted by user]" }]) }),
    title: (customTitle: string) => JSON.stringify({ type: "custom-title", customTitle, sessionId }),
    odd: () => ev({ type: "assistant", message: msg("assistant", [{ type: "text", text: "?" }], "pause_turn") }),
  };
}

const tailOf = (...ls: string[]) => readTranscript(ls.join("\n") + "\n");

test("a transcript's tail says how its last turn ended, whatever partial lines and subagents it holds", () => {
  const l = lines("aaaa-1", "/w");
  const ended = tailOf("{partial", l.prompt("go"), l.thinking(), l.said("Done. Tests pass."), l.stopHook(), "not json");
  assert.deepEqual(
    [ended?.end, ended?.text, ended?.branch, ended?.cwd, ended?.entrypoint],
    ["turn", "Done. Tests pass.", "feature/x", "/w", "cli"],
  );
  const bash = tailOf(l.prompt("go"), l.tool("t1", "Bash", { command: "npm test", description: "Run the tests" }));
  assert.deepEqual([bash?.end, bash?.pending], ["open", { name: "Bash", line: "Bash: Run the tests" }]);
  assert.equal(tailOf(l.tool("t1", "Bash", {}), l.result("t1"))?.end, "open", "a tool's result: mid-turn");
  const q = tailOf(l.tool("q1", "AskUserQuestion", { questions: [{ question: "Push to main or open a PR?", options: [] }] }));
  assert.equal(q?.question, "Push to main or open a PR?");
  assert.equal(
    tailOf(l.tool("q1", "AskUserQuestion", { questions: [{ question: "Which?" }] }), l.result("q1"))?.question,
    null,
    "answered",
  );
  const rl = tailOf(l.prompt("go"), l.apiError("rate_limit", 429, 1_793_000_000));
  assert.deepEqual([rl?.end, rl?.error?.error, rl?.error?.resets_at], ["error", "rate_limit", 1_793_000_000_000]);
  assert.equal(tailOf(l.prompt("go"), l.retry())?.retrying, true);
  assert.equal(tailOf(l.prompt("go"), l.interrupted())?.end, "interrupted");
  assert.equal(tailOf(l.said("Done."), l.sidechain())?.text, "Done.", "a subagent's lines aren't the main thread's");
  assert.equal(tailOf(l.title("Fix the flake"), l.said("ok"))?.title, "Fix the flake");
  assert.equal(tailOf(l.odd()), null, "a stop it doesn't know: no state");
  assert.equal(tailOf("garbage", l.stopHook()), null, "no main-thread turn");
});

test("only the tail is read: the last 64 KB, from a whole line", (c) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-sessions-"));
  c.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, "s.jsonl");
  const l = lines("bbbb-1", "/w");
  fs.writeFileSync(file, Array.from({ length: 2000 }, () => l.prompt("x".repeat(100))).join("\n") + "\n" + l.said("Last.") + "\n");
  const text = readTail(file)!;
  assert.ok(fs.statSync(file).size > 3 * TAIL && text.length <= TAIL);
  assert.ok(text.startsWith("{"), "from the first whole line");
  assert.equal(readTranscript(text)?.text, "Last.");
  assert.equal(readTail(path.join(dir, "gone.jsonl")), null);
});

test("claude agents --json: rows without what every row has are dropped, and anything but a list reads as nothing", () => {
  assert.equal(parseAgents("{}"), null);
  assert.equal(parseAgents("not json"), null);
  const rows = parseAgents(
    JSON.stringify([
      { id: "ab12", cwd: "/w", kind: "background", startedAt: 1, sessionId: "s1", name: "n", state: "blocked" },
      { pid: 42, cwd: "/w", kind: "interactive", sessionId: "s2", status: "waiting", waitingFor: "permission prompt" },
      { cwd: "/w", kind: "interactive" },
      { cwd: "/w", kind: "teammate", sessionId: "s3" },
      null,
    ]),
  );
  assert.deepEqual(rows, [
    { sessionId: "s1", cwd: "/w", kind: "background", id: "ab12", name: "n", state: "blocked", startedAt: 1 },
    { sessionId: "s2", cwd: "/w", kind: "interactive", status: "waiting", waitingFor: "permission prompt", pid: 42 },
  ]);
});

const seen = (o: Partial<Seen>): Seen => ({
  kind: "cli",
  session_id: "s",
  name: "n",
  cwd: "/w",
  branch: null,
  row: null,
  tail: null,
  codex: null,
  desktop: null,
  written: NOW.getTime(),
  ...o,
});
const live = (o: Partial<AgentRow> = {}): AgentRow => ({ sessionId: "s", cwd: "/w", kind: "interactive", pid: 1, status: "idle", ...o });
const says = (s: Seen, now = NOW.getTime()) => {
  const v = classify(s, now);
  return v && ("state" in v ? `${v.state}: ${v.reason}` : `ask: ${v.excerpt}`);
};

test("blocked and stalled are read from what the session shows, and anything else is no item", () => {
  const l = lines("cccc-1", "/w");
  const bash = tailOf(l.prompt("go"), l.tool("t1", "Bash", { command: "rm -rf build" }));
  assert.equal(
    says(seen({ row: live({ status: "waiting", waitingFor: "permission prompt" }), tail: bash })),
    "blocked: needs permission: Bash",
  );
  assert.equal(
    says(seen({ row: live({ status: "waiting", waitingFor: "sandbox request" }), tail: bash })),
    "blocked: needs sandbox access",
  );
  assert.equal(says(seen({ row: live({ status: "waiting", waitingFor: "dialog open" }) })), "blocked: has a dialog open");
  const q = tailOf(l.tool("q", "AskUserQuestion", { questions: [{ question: "Which branch?" }] }));
  assert.equal(says(seen({ tail: q })), "blocked: asked a question");
  assert.equal(says(seen({ tail: tailOf(l.tool("p", "ExitPlanMode", { plan: "…" })) })), "blocked: waiting on plan approval");
  assert.equal(says(seen({ tail: tailOf(l.apiError("authentication_failed", 401)) })), "blocked: login expired");
  assert.equal(
    says(seen({ kind: "background", row: { ...live(), kind: "background", pid: undefined, status: undefined, state: "blocked" } })),
    "blocked: needs you",
  );
  const reset = NOW.getTime() + 2 * 3_600_000;
  assert.equal(
    says(seen({ tail: tailOf(l.apiError("rate_limit", 429, reset / 1000)) })),
    `stalled: rate limited until ${untilText(reset, NOW.getTime())}`,
  );
  assert.equal(
    says(seen({ tail: tailOf(l.apiError("rate_limit", 429, (NOW.getTime() - MIN) / 1000)) })),
    "stalled: rate limited",
    "reset already",
  );
  assert.equal(says(seen({ tail: tailOf(l.apiError("overloaded", 529)) })), "stalled: API overloaded");
  assert.equal(says(seen({ tail: tailOf(l.apiError("unknown", 400)) })), null, "a request it got wrong isn't stalled");
  assert.equal(says(seen({ tail: bash })), "stalled: stopped mid-turn", "a turn left open, no process");
  assert.equal(
    says(
      seen({ kind: "background", tail: bash, row: { ...live(), kind: "background", pid: undefined, status: undefined, state: "stopped" } }),
    ),
    null,
    "you stopped it",
  );
  assert.equal(says(seen({ row: live({ status: "busy" }), tail: bash })), null, "busy and writing");
  const quiet = NOW.getTime() - 30 * MIN;
  assert.equal(says(seen({ row: live({ status: "busy" }), tail: bash, written: quiet })), "stalled: no progress");
  assert.equal(says(seen({ row: live({ status: "busy" }), tail: tailOf(l.prompt("go"), l.retry()), written: quiet })), null, "retrying");
  assert.equal(
    says(seen({ row: live({ status: "busy" }), tail: tailOf(l.tool("a", "Task", { prompt: "dig" })), written: quiet })),
    null,
    "a subagent at work",
  );
  assert.equal(
    says(seen({ kind: "background", row: { ...live(), kind: "background", pid: undefined, status: undefined, state: "failed" } })),
    "stalled: failed",
  );
  assert.equal(says(seen({ tail: tailOf(l.prompt("go"), l.interrupted()) })), null, "you interrupted it");
  // A turn that ended normally: only a question, in a running terminal, goes to the model.
  assert.equal(says(seen({ row: live(), tail: tailOf(l.said("Done.\nShould I push it?")) })), "ask: Should I push it?");
  assert.equal(says(seen({ row: live(), tail: tailOf(l.said("Done, tests pass.")) })), null);
  assert.equal(
    says(seen({ kind: "background", row: { ...live(), kind: "background" }, tail: tailOf(l.said("Should I push?")) })),
    null,
    "its state read it",
  );
});

test("the desktop app's own read of a turn and its error mark, and Codex's open or questioning turn", () => {
  const rec = (o: Record<string, unknown>) =>
    readDesktopRecord(
      JSON.stringify({
        sessionId: "local_1",
        cliSessionId: "s",
        title: "T",
        cwd: "/w",
        isArchived: false,
        lastActivityAt: 1,
        lastTurnEdgeAt: 10,
        ...o,
      }),
    );
  assert.equal(readDesktopRecord("{}"), null);
  assert.equal(readDesktopRecord(JSON.stringify({ sessionId: "nope", cliSessionId: "s" })), null);
  const blocked = rec({
    postTurnSummary: { status_category: "blocked", status_detail: "Needs a token", needs_action: "x", summarizes_uuid: "u" },
  });
  assert.equal(says(seen({ kind: "desktop", desktop: blocked })), "blocked: needs you");
  assert.equal(says(seen({ kind: "desktop", desktop: rec({ postTurnSummary: { status_category: "completed" } }) })), null);
  const mark = rec({ priorErrorMark: { source: "x", category: "process_interrupted", at: 20, hadPendingTurn: true } });
  assert.equal(says(seen({ kind: "desktop", desktop: mark })), "stalled: stopped mid-turn");
  assert.equal(
    says(seen({ kind: "desktop", desktop: rec({ priorErrorMark: { category: "query_error", at: 5, hadPendingTurn: true } }) })),
    null,
    "before its last turn",
  );

  const roll = (...events: [string, Record<string, unknown>][]) =>
    readRollout(events.map(([ts, payload], i) => JSON.stringify({ timestamp: ts, type: "event_msg", payload, ordinal: i })).join("\n"));
  const open = roll([at(-60), { type: "task_started", turn_id: "1" }]);
  assert.equal(says(seen({ kind: "codex", codex: open, written: NOW.getTime() - 60 * MIN })), "stalled: no progress");
  assert.equal(says(seen({ kind: "codex", codex: open, written: NOW.getTime() - 5 * MIN })), null, "written to lately");
  const asked = roll([at(-9), { type: "task_started" }], [at(-8), { type: "task_complete", last_agent_message: "Merge it now?" }]);
  assert.equal(says(seen({ kind: "codex", codex: asked })), "ask: Merge it now?");
  assert.equal(
    says(
      seen({ kind: "codex", codex: roll([at(-9), { type: "task_started" }], [at(-8), { type: "turn_aborted", reason: "interrupted" }]) }),
    ),
    null,
  );
  assert.equal(readRollout("nothing\n{}"), null);
});

test("Codex's threads come from its index, read only: yours, unarchived and recent; its own runs and a changed table are left out", (c) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-codex-"));
  c.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, "state_5.sqlite");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, git_branch TEXT, updated_at_ms INTEGER, source TEXT, archived INTEGER, preview TEXT)",
  );
  const add = db.prepare("INSERT INTO threads VALUES (?, ?, '/w', 'Title', 'main', ?, ?, ?, '')");
  add.run("t1", "/r1", NOW.getTime(), "cli", 0);
  add.run("t2", "/r2", NOW.getTime(), "vscode", 0);
  add.run("t3", "/r3", NOW.getTime(), "exec", 0);
  add.run("t4", "/r4", NOW.getTime(), "cli", 1);
  add.run("t5", "/r5", NOW.getTime() - 9 * 24 * 3_600_000, "cli", 0);
  add.run("t6", "/r6", NOW.getTime(), '{"subagent":{"other":"guardian"}}', 0);
  db.close();
  const before = fs.readFileSync(file);
  assert.deepEqual(
    codexThreads(file, NOW.getTime() - 3 * 24 * 3_600_000)?.map((t) => [t.id, t.branch]),
    [
      ["t1", "main"],
      ["t2", "main"],
    ],
  );
  assert.deepEqual(fs.readFileSync(file), before, "untouched");
  assert.deepEqual(codexThreads(path.join(dir, "none.sqlite"), 0), []);
  const other = path.join(dir, "other.sqlite");
  const o = new DatabaseSync(other);
  o.exec("CREATE TABLE threads (id TEXT)");
  o.close();
  assert.equal(codexThreads(other, 0), null, "a table it doesn't know");
});
