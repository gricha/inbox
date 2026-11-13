// The Sessions source: Claude Code and Codex sessions on this machine that need you, read from fixtures shaped like 2.1.321's
// files (claude agents --json, transcripts, the desktop app's records) and codex-cli 0.154's state_5.sqlite and rollouts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { Effect } from "effect";
import {
  classify,
  codexThreads,
  KICK,
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
import { createApp } from "../src/server.ts";
import { setup } from "./helpers/desk.ts";
import { NOW } from "./helpers/items.ts";
import { failure, run } from "./helpers/run.ts";

const posix = { skip: process.platform === "win32" };
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
const background = (state: string): AgentRow => ({ sessionId: "s", cwd: "/w", kind: "background", state });
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
  assert.equal(says(seen({ kind: "background", row: background("blocked") })), "blocked: needs you");
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
  assert.equal(says(seen({ kind: "background", tail: bash, row: background("stopped") })), null, "you stopped it");
  assert.equal(says(seen({ row: live({ status: "busy" }), tail: bash })), null, "busy and writing");
  const quiet = NOW.getTime() - 30 * MIN;
  assert.equal(says(seen({ row: live({ status: "busy" }), tail: bash, written: quiet })), "stalled: no progress");
  const fifteen = seen({ row: live({ status: "busy" }), tail: bash, written: NOW.getTime() - 15 * MIN });
  assert.equal(says(fifteen), null);
  assert.equal(classify(fifteen, NOW.getTime(), 10 * MIN)?.key.endsWith("no progress"), true, "sessions.quiet_minutes at 10");
  assert.equal(says(seen({ row: live({ status: "busy" }), tail: tailOf(l.prompt("go"), l.retry()), written: quiet })), null, "retrying");
  assert.equal(
    says(seen({ row: live({ status: "busy" }), tail: tailOf(l.tool("a", "Task", { prompt: "dig" })), written: quiet })),
    null,
    "a subagent at work",
  );
  assert.equal(says(seen({ kind: "background", row: background("failed") })), "stalled: failed");
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

// A machine's sessions, in a temp dir, with a claude that answers agents --json, the classifier's -p and --resume.
function machine(c: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "desk-machine-")));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "claude"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const log = (k, v) => fs.appendFileSync(path.join(__dirname, k), JSON.stringify(v) + "\\n");
if (args[0] === "-p") {
  const prompt = fs.readFileSync(0, "utf8");
  log("asks", prompt);
  console.log(JSON.stringify({ type: "result", is_error: false, structured_output: { blocked: /Should I push/.test(prompt) } }));
  process.exit(0);
}
log("calls", { args, cwd: process.cwd() });
if (args[0] === "agents") process.stdout.write(fs.readFileSync(path.join(__dirname, "agents.json"), "utf8"));
else if (args[0] === "--resume") console.log("backgrounded · kick01 · resumed");
`,
    { mode: 0o755 },
  );
  const was = process.env.DESK_CLAUDE;
  process.env.DESK_CLAUDE = path.join(bin, "claude");
  const claudeHome = path.join(root, ".claude");
  const desktop = path.join(root, "claude-code-sessions");
  const codex = path.join(root, ".codex");
  const work = path.join(root, "work");
  fs.mkdirSync(path.join(desktop, "org", "acct"), { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  c.after(() => {
    process.env.DESK_CLAUDE = was;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const read = (k: string) =>
    fs.existsSync(path.join(bin, k))
      ? fs
          .readFileSync(path.join(bin, k), "utf8")
          .trim()
          .split("\n")
          .map((x) => JSON.parse(x) as unknown)
      : [];
  return {
    roots: { claude: claudeHome, desktop: [desktop], codex },
    work,
    agents: (rows: Record<string, unknown>[]) => {
      fs.writeFileSync(path.join(bin, "agents.json"), JSON.stringify(rows));
    },
    transcript: (id: string, ls: string[], mins = 0) => {
      const dir = path.join(claudeHome, "projects", "-work");
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, `${id}.jsonl`);
      fs.writeFileSync(f, ls.join("\n") + "\n");
      const t = new Date(Date.now() + mins * MIN);
      fs.utimesSync(f, t, t);
    },
    desktop: (o: Record<string, unknown>) => {
      fs.writeFileSync(path.join(desktop, "org", "acct", `${String(o.sessionId)}.json`), JSON.stringify(o));
    },
    calls: () => read("calls") as { args: string[]; cwd: string }[],
    asks: () => read("asks"),
  };
}

async function deskOn(c: TestContext, m: ReturnType<typeof machine>) {
  const opened: string[] = [];
  const logged: string[] = [];
  const t = await setup([], {
    settings: { "policy.judge": false },
    desk: { sessions: m.roots, open: (url) => Effect.sync(() => void opened.push(url)), log: (x) => void logged.push(x) },
  });
  c.after(t.cleanup);
  // Its clock is the real one: what it reads carries the files' own times.
  t.setNow(new Date());
  return { ...t, opened, logged, poll: () => run(t.desk.sessions.poll()) };
}

const S = {
  bg: "11111111-0000-4000-8000-000000000001",
  cli: "22222222-0000-4000-8000-000000000002",
  ask: "33333333-0000-4000-8000-000000000003",
  hint: "44444444-0000-4000-8000-000000000004",
  coord: "55555555-0000-4000-8000-000000000005",
  own: "66666666-0000-4000-8000-000000000006",
  desk: "77777777-0000-4000-8000-000000000007",
  dead: "88888888-0000-4000-8000-000000000008",
};

test(
  "sessions that need you lead the Inbox, blocked first; the desk's own aren't there, and a directional question never is",
  posix,
  async (c) => {
    const m = machine(c);
    const t = await deskOn(c, m);
    const L = (id: string, cwd = m.work) => lines(id, cwd, Date.now());
    const home = t.home;
    fs.mkdirSync(path.join(home, "agent"), { recursive: true });
    m.agents([
      { id: "bg01", cwd: m.work, kind: "background", startedAt: 1, sessionId: S.bg, name: "Migrate the store", state: "working" },
      {
        pid: process.pid,
        cwd: m.work,
        kind: "interactive",
        startedAt: 1,
        sessionId: S.cli,
        name: "fix-flake",
        status: "waiting",
        waitingFor: "permission prompt",
      },
      { pid: process.pid, cwd: m.work, kind: "interactive", startedAt: 1, sessionId: S.ask, name: "ship", status: "idle" },
      { pid: process.pid, cwd: m.work, kind: "interactive", startedAt: 1, sessionId: S.hint, name: "docs", status: "idle" },
      {
        id: "co01",
        cwd: path.join(home, "coordinator"),
        kind: "background",
        startedAt: 1,
        sessionId: S.coord,
        name: "Inbox coordinator",
        state: "blocked",
      },
      {
        pid: process.pid,
        cwd: path.join(home, "agent"),
        kind: "interactive",
        startedAt: 1,
        sessionId: S.own,
        status: "waiting",
        waitingFor: "input needed",
      },
    ]);
    const bg = L(S.bg);
    m.transcript(S.bg, [bg.prompt("go"), bg.apiError("overloaded", 529)]);
    const cli = L(S.cli);
    m.transcript(S.cli, [cli.prompt("go"), cli.tool("t1", "Bash", { command: "git push", description: "Push the branch" })]);
    const ask = L(S.ask);
    m.transcript(S.ask, [ask.prompt("go"), ask.said("All green.\nShould I push to main?"), ask.stopHook()]);
    const hint = L(S.hint);
    m.transcript(S.hint, [hint.prompt("go"), hint.said("Done.\nWant me to also add a changelog entry?")]);
    const coord = L(S.coord, path.join(home, "coordinator"));
    m.transcript(S.coord, [coord.tool("q", "AskUserQuestion", { questions: [{ question: "Merge?" }] })]);
    // A terminal's session that died mid-turn, in no list; and the desktop app's, which says it's blocked.
    const dead = L(S.dead);
    m.transcript(S.dead, [dead.prompt("go"), dead.tool("t9", "Edit", { file_path: "src/a.ts" })]);
    const dk = L(S.desk);
    m.transcript(S.desk, [dk.prompt("go"), dk.said("I need the staging token to go on.")]);
    m.desktop({
      sessionId: "local_abc",
      cliSessionId: S.desk,
      title: "Staging deploy",
      cwd: m.work,
      isArchived: false,
      lastActivityAt: Date.now(),
      lastTurnEdgeAt: Date.now(),
      postTurnSummary: {
        status_category: "blocked",
        status_detail: "Needs the staging token",
        needs_action: "token",
        summarizes_uuid: "x",
      },
    });

    await t.poll();
    const q = await run(t.desk.queue());
    assert.deepEqual(
      q.sessions.map((s) => [s.kind, s.name, s.state, s.reason, s.actions.join(",")]),
      [
        ["cli", "fix-flake", "blocked", "needs permission: Bash", ""],
        ["cli", "ship", "blocked", "asked a question", ""],
        ["desktop", "Staging deploy", "blocked", "needs you", "open"],
        ["background", "Migrate the store", "stalled", "API overloaded", "kick"],
        ["cli", "work", "stalled", "stopped mid-turn", "resume"],
      ],
    );
    const flake = q.sessions[0]!;
    assert.deepEqual([flake.excerpt, flake.branch, flake.cwd, flake.alive], ["Bash: Push the branch", "feature/x", m.work, true]);
    assert.equal(q.sessions[1]!.excerpt, "Should I push to main?");
    assert.equal(q.sessions[2]!.open_url, "claude://claude.ai/epitaxy/local_abc");
    assert.equal(m.asks().length, 2, "the model read the two questions: blocking and directional");
    assert.ok(
      (m.asks() as string[]).every((p) => p.length < 3000),
      "only the last message",
    );
    assert.equal((await run(t.desk.focus())).sessions.length, 5);
    assert.equal((await run(t.desk.overview())).focus.sessions, 5);

    await t.poll();
    assert.equal(m.asks().length, 2, "asked once per message");

    // Moving on resolves it: the permission granted and the tool ran, the dead one finished, and the background one removed
    // (claude rm), which its job still names.
    fs.mkdirSync(path.join(m.roots.claude, "jobs", "bg01"), { recursive: true });
    fs.writeFileSync(path.join(m.roots.claude, "jobs", "bg01", "state.json"), JSON.stringify({ state: "stopped", sessionId: S.bg }));
    m.agents([
      { pid: process.pid, cwd: m.work, kind: "interactive", startedAt: 1, sessionId: S.cli, name: "fix-flake", status: "busy" },
      { pid: process.pid, cwd: m.work, kind: "interactive", startedAt: 1, sessionId: S.ask, name: "ship", status: "idle" },
    ]);
    m.transcript(S.cli, [cli.prompt("go"), cli.tool("t1", "Bash", { command: "git push" }), cli.result("t1")]);
    m.transcript(S.dead, [dead.prompt("go"), dead.said("Finished.")]);
    await t.poll();
    assert.deepEqual(
      (await run(t.desk.queue())).sessions.map((s) => s.name),
      ["ship", "Staging deploy"],
    );
  },
);

test(
  "done hides a session until it moves on; snooze and mute too, each undone like any item, and nothing else applies",
  posix,
  async (c) => {
    const m = machine(c);
    const t = await deskOn(c, m);
    const base = Date.now();
    m.agents([{ id: "bg01", cwd: m.work, kind: "background", startedAt: 1, sessionId: S.bg, name: "Migrate", state: "blocked" }]);
    const ask = (q: string, from: number) => lines(S.bg, m.work, from).tool("q", "AskUserQuestion", { questions: [{ question: q }] });
    m.transcript(S.bg, [ask("Drop the old table?", base)]);
    await t.poll();
    const id = `session:${S.bg}`;
    const active = async () => (await run(t.desk.focus())).sessions.map((s) => s.id);
    assert.deepEqual(await active(), [id]);
    const done = await run(t.desk.act(id, "done"));
    assert.deepEqual(await active(), []);
    assert.equal((await run(t.desk.queue())).sessions[0]?.status, "done");
    await run(t.desk.undo(done.undo_seq));
    assert.deepEqual(await active(), [id], "undone");
    await run(t.desk.act(id, "done"));
    await t.poll();
    assert.deepEqual(await active(), [], "still done: nothing new");
    // It asks again, after the done: back on the Inbox.
    t.setNow(new Date(base + 120 * MIN));
    m.transcript(S.bg, [ask("Keep a backup?", base + 120 * MIN)]);
    await t.poll();
    assert.deepEqual(await active(), [id], "back once it moved on");
    await run(t.desk.act(id, "snooze", "3h"));
    assert.deepEqual(await active(), []);
    assert.equal((await run(t.desk.queue())).sessions[0]?.status, "snoozed");
    t.setNow(new Date(base + 320 * MIN));
    assert.deepEqual(await active(), [id], "the snooze is over");
    await run(t.desk.act(id, "mute"));
    assert.deepEqual(await active(), []);
    await run(t.desk.act(id, "unmute"));
    assert.deepEqual(await active(), [id]);
    assert.equal(
      (await failure(t.desk.act(id, "inflight"))).message,
      "a session takes done, snooze, mute, unmute and restore; not inflight",
    );
    assert.equal(
      (await failure(t.desk.act(id, "snooze", "ci"))).message,
      "a session snoozes until a time; done brings it back when it moves on",
    );
    assert.equal((await failure(t.desk.act("session:nope", "done"))).message, 'no session "session:nope" needs you now');
  },
);

test(
  "Kick resumes a background session in its own folder with the exact arguments, never while it runs or before its rate limit resets",
  posix,
  async (c) => {
    const m = machine(c);
    const t = await deskOn(c, m);
    const l = lines(S.bg, m.work);
    const resets = Date.now() + 90 * MIN;
    const row = { id: "bg01", cwd: m.work, kind: "background", startedAt: 1, sessionId: S.bg, name: "Migrate", state: "working" };
    m.agents([row, { pid: process.pid, cwd: m.work, kind: "interactive", sessionId: S.cli, name: "term", status: "busy" }]);
    m.transcript(S.bg, [l.prompt("go"), l.apiError("rate_limit", 429, Math.floor(resets / 1000))]);
    const tl = lines(S.cli, m.work);
    m.transcript(S.cli, [tl.prompt("go"), tl.tool("t", "Bash", { command: "make" })], -40);
    await t.poll();
    const id = `session:${S.bg}`;
    const card = await run(t.desk.session(id));
    assert.deepEqual([card.reason, card.actions], [`rate limited until ${untilText(resets, Date.now())}`, ["kick"]]);
    assert.equal(
      (await failure(t.desk.kickSession(id))).message,
      `Migrate is rate limited until ${untilText(resets, Date.now())}; kick it after that`,
    );
    const term = await run(t.desk.session(`session:${S.cli}`));
    assert.deepEqual([term.reason, term.actions], ["no progress", []]);
    assert.equal((await failure(t.desk.kickSession(term.id))).message, "term can't be started from the desk: it runs in a terminal");

    t.setNow(new Date(resets + MIN));
    // Its process came back in the meantime: the look before starting it says so.
    m.agents([{ ...row, pid: process.pid, status: "idle" }]);
    assert.equal(
      (await failure(t.desk.kickSession(id))).message,
      `Migrate is running (process ${process.pid}), so the desk won't start a second copy; open it instead`,
    );
    m.agents([row]);
    const before = m.calls().length;
    const res = await run(t.desk.kickSession(id));
    assert.deepEqual(res.args, ["--resume", S.bg, "--bg", KICK]);
    assert.deepEqual(m.calls().slice(before), [
      { args: ["agents", "--json", "--all"], cwd: m.calls()[before]!.cwd },
      { args: ["--resume", S.bg, "--bg", "Continue where you left off."], cwd: m.work },
    ]);
    assert.ok(!m.calls().some((x) => x.args[0] === "stop"), "nothing to stop: no process");
    const logged = t.desk.store.db.prepare("SELECT action FROM events WHERE item_id = ?").all(id);
    assert.deepEqual(
      logged.map((x) => x.action),
      ["kick"],
      "in the action log",
    );
    assert.ok(t.logged.some((x) => x === `sessions: kicked ${S.bg} in ${m.work}`));
  },
);

test("only the desk's window kicks or opens a session; anyone may read one", posix, async (c) => {
  const m = machine(c);
  const t = await deskOn(c, m);
  m.agents([]);
  const l = lines(S.desk, m.work);
  m.transcript(S.desk, [l.prompt("go"), l.said("Blocked.")]);
  m.desktop({
    sessionId: "local_abc",
    cliSessionId: S.desk,
    title: "Deploy",
    cwd: m.work,
    isArchived: false,
    lastActivityAt: Date.now(),
    lastTurnEdgeAt: 0,
    postTurnSummary: { status_category: "blocked", status_detail: "Needs a token", summarizes_uuid: "x" },
  });
  await t.poll();
  const app = createApp(t.desk, 47823);
  const id = encodeURIComponent(`session:${S.desk}`);
  const post = (what: string, headers: Record<string, string> = {}) =>
    app.request(`http://127.0.0.1:47823/api/sessions/${id}/${what}`, { method: "POST", headers });
  assert.equal((await post("kick")).status, 403);
  assert.equal((await post("open")).status, 403);
  assert.deepEqual(t.opened, []);
  const page = { origin: "http://localhost:47823", "sec-fetch-site": "same-origin" };
  assert.equal((await post("open", page)).status, 200);
  assert.deepEqual(t.opened, ["claude://claude.ai/epitaxy/local_abc"]);
  assert.equal((await post("kick", page)).status, 409, "a desktop session is the app's: Open only");
  const read = await app.request(`http://127.0.0.1:47823/api/sessions/${id}`);
  assert.equal(((await read.json()) as { name: string }).name, "Deploy");
});

test("with sessions.ask off, a turn that ends asking something isn't read by the model, and isn't on the Inbox", posix, async (c) => {
  const m = machine(c);
  const t = await deskOn(c, m);
  fs.writeFileSync(path.join(t.home, "settings.json"), JSON.stringify({ "policy.judge": false, "sessions.ask": false }));
  await run(t.desk.reloadSettings());
  m.agents([{ pid: process.pid, cwd: m.work, kind: "interactive", sessionId: S.ask, name: "ship", status: "idle" }]);
  const l = lines(S.ask, m.work, Date.now());
  m.transcript(S.ask, [l.prompt("go"), l.said("All green.\nShould I push to main?")]);
  await t.poll();
  assert.deepEqual([m.asks().length, (await run(t.desk.focus())).sessions.length], [0, 0]);
});

test("off in Settings, it reads nothing and shows nothing", posix, async (c) => {
  const m = machine(c);
  const t = await deskOn(c, m);
  m.agents([{ id: "bg01", cwd: m.work, kind: "background", sessionId: S.bg, state: "failed" }]);
  await t.poll();
  assert.equal((await run(t.desk.focus())).sessions.length, 1);
  fs.writeFileSync(path.join(t.home, "settings.json"), JSON.stringify({ "policy.judge": false, "sessions.enabled": false }));
  await run(t.desk.reloadSettings());
  assert.equal((await run(t.desk.focus())).sessions.length, 0);
  const calls = m.calls().length;
  await t.poll();
  assert.equal(m.calls().length, calls, "no claude agents while it's off");
});
