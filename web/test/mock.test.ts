// Runs the mock API and checks it speaks the shapes the UI relies on.
import "../../test/helpers/no-agent.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  AiReview,
  ActivityPage,
  AutomationView,
  AgentStatus,
  BoardView,
  ConfigError,
  FieldDoc,
  FocusView,
  InflightView,
  InquiryView,
  ItemDetail,
  Overview,
  PreviewResult,
  QueueView,
  ReviewFile,
  ReviewView,
  SettingsView,
} from "../../src/types.ts";
import { CLAUDE_PAUSED, lineAt, parseReview } from "../../src/review.ts";
import { automationBody } from "../../src/automation-body.ts";
import { createApp } from "../../src/server.ts";
import { setup } from "../../test/helpers/desk.ts";
import { run } from "../../test/helpers/run.ts";

const ORDER = ["failing", "cancelled", "running", "passing", "skipped"];

// A mock of its own, on a free port: its first line says where.
async function startMock(): Promise<{ base: string; stop: () => void }> {
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../mock/server.ts", import.meta.url))],
    {
      env: { ...process.env, MOCK_PORT: "0" },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const [line] = (await once(child.stdout, "data")) as [Buffer];
  return {
    base: line.toString().match(/http:\/\/[\d.:]+/)![0],
    stop: () => {
      child.kill();
    },
  };
}
let base = "";
let stop = () => {};

before(async () => {
  ({ base, stop } = await startMock());
});
after(() => {
  stop();
});

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T is the caller's claim about the reply shape, like call<T> in web/src/api.ts
async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(base + path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json" },
  });
  return { status: res.status, data: (await res.json()) as T };
}

test("overview, focus and every board", async () => {
  const { data: o } = await call<Overview>("GET", "/api/overview");
  assert.deepEqual(
    o.spaces.map((s) => s.name),
    ["Work", "Personal"],
  );
  const boards = o.spaces.flatMap((s) => s.boards);
  assert.deepEqual(
    boards.map((b) => b.id),
    ["work-review", "work-mine", "work-mentions", "personal-review", "personal-mine"],
  );
  const { data: f } = await call<FocusView>("GET", "/api/focus");
  assert.equal(f.sections.now.length, o.focus.now);
  assert.ok(f.sections.now.every((c) => c.bucket === "now" && c.status === "active"));

  let total = 0;
  for (const b of boards) {
    const { data: v } = await call<BoardView>("GET", `/api/boards/${b.id}`);
    const cards = [...Object.values(v.sections).flat(), ...v.hidden, ...v.cleared];
    total += cards.length;
    assert.equal(v.sections.now.length, b.counts.now);
    assert.equal(v.cleared.length, b.counts.cleared);
    assert.ok(cards.every((c) => c.board === b.id && c.boards.includes(b.id)));
  }
  assert.ok(total >= 25, `~30 cards (less your PRs in Merging), got ${total}`);
  // Filtered items aren't on the board (src/rules.ts), not under "hidden".
  const { data: wr } = await call<BoardView>("GET", "/api/boards/work-review");
  assert.ok(![...Object.values(wr.sections).flat(), ...wr.hidden].some((c) => c.id === "acme/web#2279"));
  assert.deepEqual(await call("GET", "/api/boards/nope"), { status: 404, data: { error: "unknown board", tag: "NotFound" } });
});

// Before the tests below act on cards, while the queue is as the mock starts.
test("the queue's cards carry pre-flight in every state", async () => {
  const { data: q } = await call<QueueView>("GET", "/api/queue");
  const top = [...q.sections.now, ...q.sections.today];
  const of = (id: string) => top.find((c) => c.id === id)!;
  assert.ok(
    top.every((c) => c.preflight),
    "every card in the queue",
  );
  assert.ok([...q.sections.later, ...q.sections.fyi].every((c) => !c.preflight));
  const ready = top.filter((c) => c.preflight?.state === "ready");
  const theirs = top.filter((c) => c.kind === "pr" && c.author !== "me");
  assert.ok(ready.length > theirs.length / 2, "most of other people's PRs are ready");
  assert.ok(ready.every((c) => c.preflight!.summary && c.preflight!.verdict && c.preflight!.risk && c.preflight!.concerns!.length <= 2));
  assert.deepEqual(
    ["acme/web#2301", "acme/api#4099", "acme/ml-pipeline#307"].map((id) => of(id).preflight?.state),
    ["running", "stale", "queued"],
  );
  assert.ok(of("acme/api#4099").preflight?.summary, "a stale one still has the older review to skim");
  assert.ok(ready.some((c) => c.preflight!.risk === "high" && c.preflight!.concerns!.length === 2));
  assert.ok(
    ready.some((c) => c.preflight!.summary!.length > 400),
    "one long summary",
  );
  assert.deepEqual(of("acme/worker#860").preflight, { state: "none" }, "an issue");
  assert.equal(of("me/notes-app#12").preflight?.state, "none");

  const quiet = q.sections.later.find((c) => c.id === "acme/api#4040")!;
  assert.equal(quiet.demoted, "quiet for 3 weeks");
  assert.ok(top.length > 12);
  assert.equal(q.paused, null);
});

test("logged out: the queue says Claude is paused once, cards wait, every agent says why, and resuming runs them again", async () => {
  await call("POST", "/api/mock/ai-paused", { paused: true });
  const { data: q } = await call<QueueView>("GET", "/api/queue");
  const loggedOut = "Claude Code isn't logged in. Run `claude auth login` in a terminal.";
  assert.deepEqual(q.paused, { who: "claude", why: CLAUDE_PAUSED });
  const state = (id: string) => [...q.sections.now, ...q.sections.today].find((c) => c.id === id)?.preflight?.state;
  assert.deepEqual(["acme/web#2301", "acme/api#4099", "acme/ml-pipeline#307", "acme/api#4127"].map(state), [
    "paused",
    "paused",
    "paused",
    "ready",
  ]);
  const { paused } = (await call<SettingsView>("GET", "/api/settings")).data;
  assert.match(paused.ai?.why ?? "", /^Claude Code/);
  // The judge is the same Claude Code: it says it failed on the login, and when it tries again.
  const { judge } = (await call<SettingsView>("GET", "/api/settings")).data;
  assert.deepEqual([judge.state, judge.error, !!judge.retry_at], ["error", loggedOut, true]);
  await call("POST", "/api/mock/ai-paused", { paused: false });
  const { data: back } = await call<QueueView>("GET", "/api/queue");
  assert.equal(back.paused, null);
  assert.equal((await call<SettingsView>("GET", "/api/settings")).data.judge.state, "idle");
  // At work: the judge judging.
  await call("POST", "/api/mock/agents-busy", { busy: true });
  assert.equal((await call<SettingsView>("GET", "/api/settings")).data.judge.state, "running");
  await call("POST", "/api/mock/agents-busy", { busy: false });
  assert.equal([...back.sections.now, ...back.sections.today].find((c) => c.id === "acme/web#2301")?.preflight?.state, "running");
});

test("item detail resolves short refs and explains placement", async () => {
  // Over the board's Now cap, the one with no review yet gives way to the close looks.
  const { data: d } = await call<ItemDetail>("GET", `/api/item?id=${encodeURIComponent("web#2301")}`);
  assert.equal(d.item.id, "acme/web#2301");
  const review = d.placements.find((p) => p.board === "work-review")!;
  assert.equal(review.rule_bucket, "now");
  assert.equal(review.bucket, "today");
  assert.match(review.demoted ?? "", /are urgent already$/);
  assert.deepEqual(
    review.trace.map((t) => [t.index, t.matched]),
    [
      [-1, true],
      [0, false], // blocked by another PR
      [1, true],
    ],
  );
  assert.match(d.handoff_prompt, /acme\/web#2301/);
  assert.ok(d.item.paths?.length, "a PR carries its changed files");
  assert.deepEqual(d.signals.pr.paths, d.item.paths, "and rules read them as pr.paths");
  assert.equal((await call("GET", "/api/item?id=nope%231")).status, 404);
});

test("act, undo and the cap reflow", async () => {
  const { data: r } = await call<{ ok: true; undo_seq: number }>("POST", "/api/act", { id: "acme/api#4099", action: "done" });
  let { data: v } = await call<BoardView>("GET", "/api/boards/work-review");
  assert.ok(v.cleared.some((c) => c.id === "acme/api#4099" && c.status === "done"));
  assert.ok(
    v.sections.now.some((c) => c.id === "acme/web#2301"),
    "a freed NOW slot promotes the demoted card",
  );

  const { data: u } = await call<{ ok: true; id: string }>("POST", "/api/undo", { seq: r.undo_seq });
  assert.equal(u.id, "acme/api#4099");
  ({ data: v } = await call<BoardView>("GET", "/api/boards/work-review"));
  assert.ok(v.sections.now.some((c) => c.id === "acme/api#4099"));

  await call("POST", "/api/act", { id: "acme/api#4099", action: "snooze", until: "activity" });
  ({ data: v } = await call<BoardView>("GET", "/api/boards/work-review"));
  const snoozed = v.cleared.find((c) => c.id === "acme/api#4099")!;
  assert.equal(snoozed.status, "snoozed");
  assert.equal(snoozed.snooze_until, null);
  await call("POST", "/api/act", { id: "acme/api#4099", action: "restore" });
});

test("config preview reports moves and errors; save applies", async () => {
  const { data: cfg } = await call<{ path: string; text: string }>("GET", "/api/config");
  const red = `when = 'pr.ci == "red"'\nbucket = "later"`;
  assert.ok(cfg.text.includes(red));
  const edited = cfg.text.replace(red, `when = 'pr.ci == "red"'\nbucket = "today"`);

  const { data: p } = await call<PreviewResult>("POST", "/api/config/preview", { text: edited });
  assert.deepEqual(p.errors, []);
  const wr = p.boards.find((b) => b.id === "work-review")!;
  assert.deepEqual(
    wr.moved.map((m) => [m.id, m.from, m.to]),
    [["acme/web#2290", "later", "today"]],
  );

  const { data: bad } = await call<PreviewResult>("POST", "/api/config/preview", { text: edited.replace("pr.approvals", "pr.aprovals") });
  assert.equal(bad.errors[0]?.path, "boards[0].rules[7].when");
  assert.match(bad.errors[0]?.message ?? "", /did you mean "pr\.approvals"/);

  const { data: saved } = await call<{ ok: boolean }>("PUT", "/api/config", { text: edited });
  assert.equal(saved.ok, true);
  const { data: v } = await call<BoardView>("GET", "/api/boards/work-review");
  assert.ok(v.sections.today.some((c) => c.id === "acme/web#2290"));
  await call("PUT", "/api/config", { text: cfg.text });
});

test("fields, status and the event stream", async () => {
  const { data: fields } = await call<FieldDoc[]>("GET", "/api/fields");
  assert.ok(fields.some((f) => f.path === "me.requested_direct" && f.type === "boolean"));
  const { data: s } = await call<{ text: string }>("GET", "/api/status");
  assert.match(s.text, /^desk ●\d+ ◐\d+ \+\d+$/);

  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /^event: update\ndata: \{"rev":\d+\}/);
  await call("POST", "/api/act", { id: "acme/api#4099", action: "pin" });
  const next = new TextDecoder().decode((await reader.read()).value);
  assert.match(next, /event: update/);
  ctrl.abort();
  await call("POST", "/api/act", { id: "acme/api#4099", action: "unpin" });
});

test("settings: schema, save, reject and reset", async () => {
  type Put = { ok: boolean; errors: ConfigError[]; settings: SettingsView };
  const { data: s } = await call<SettingsView>("GET", "/api/settings");
  assert.ok(s.defs.length > 0 && s.defs.every((d) => d.key in s.values && s.sections.some((x) => x.id === d.section)));
  assert.equal(s.github.login, "me");
  assert.equal(s.github.orgs[0]?.org, "acme");
  assert.equal(s.github.orgs[0]?.space, "Work");
  // The rest land in the catch-all, Personal (-org:acme), as the desk works it out.
  assert.equal(s.github.catch_all, "Personal");
  assert.ok(s.github.orgs.slice(1).length && s.github.orgs.slice(1).every((o) => o.space === "Personal"));
  assert.ok(s.overridden.includes("github.poll_seconds"));

  const { data: bad } = await call<Put>("PUT", "/api/settings", { set: { "github.poll_seconds": 5, "notify.enabled": false } });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors, [{ path: "github.poll_seconds", message: "must be at least 30" }]);
  assert.equal(bad.settings.values["notify.enabled"], true, "nothing is written when any value is invalid");

  const { data: good } = await call<Put>("PUT", "/api/settings", { set: { "notify.enabled": false, "github.bots": ["a", "b[bot]"] } });
  assert.equal(good.ok, true);
  assert.deepEqual(good.settings.values["github.bots"], ["a", "b[bot]"]);
  assert.ok(good.settings.overridden.includes("notify.enabled"));

  const { data: back } = await call<Put>("PUT", "/api/settings", { set: { "notify.enabled": true }, reset: ["github.poll_seconds"] });
  assert.equal(back.settings.values["github.poll_seconds"], 90);
  assert.ok(!back.settings.overridden.includes("notify.enabled"), "the default value isn't stored");
  assert.ok(!back.settings.overridden.includes("github.poll_seconds"));
  await call("PUT", "/api/settings", { set: { "github.poll_seconds": 60, "github.bots": ["acme-junior"] } });

  // Settings no longer live in config.toml.
  const { data: cfg } = await call<{ text: string }>("GET", "/api/config");
  assert.ok(!/^\s*(poll_seconds|\[signals\])/m.test(cfg.text));
});

test("agents: Claude Code's status, and connect", async () => {
  const { data: a } = await call<AgentStatus>("GET", "/api/agents");
  assert.equal(a.driver, "claude-code");
  assert.equal(a.mcp?.connected, true);
  assert.equal(a.skill?.state, "missing");
  const { data: c } = await call<AgentStatus>("POST", "/api/agents/connect", {});
  assert.equal(c.skill?.state, "installed");
});

test("resolved items sit apart from the queue's groups and boards; items carry their recent activity", async () => {
  const { data: q } = await call<QueueView>("GET", "/api/queue");
  assert.deepEqual(
    q.resolved.map((c) => [c.id, c.why, c.resolved]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    // What was in Now or Today, asked of you, or yours to resolve: the hidden one and your in-flight PR resolve silently.
    // web#2292, which you approved, heads a chain: Blocked has it while its steps wait.
    [
      ["acme/web#2284", "merged", "merged"],
      ["acme/worker#868", "no longer requested", "no longer requested"],
    ],
  );
  const elsewhere = new Set([...Object.values(q.sections).flat(), ...q.hidden, ...q.cleared].map((c) => c.id));
  assert.ok(!q.resolved.some((c) => elsewhere.has(c.id)));
  const { data: wr } = await call<BoardView>("GET", "/api/boards/work-review");
  assert.ok(![...Object.values(wr.sections).flat(), ...wr.hidden, ...wr.cleared].some((c) => c.resolved));

  const { data: d } = await call<ItemDetail>("GET", `/api/item?id=${encodeURIComponent("worker#875")}`);
  assert.ok(d.activity.length >= 5);
  assert.ok(
    d.activity.every((e, i) => i === 0 || d.activity[i - 1]!.seq > e.seq),
    "newest first",
  );

  const { data: page } = await call<ActivityPage>("GET", "/api/activity?after=0&limit=5");
  assert.deepEqual(
    page.events.map((e) => e.seq),
    [1, 2, 3, 4, 5],
  );
  assert.equal(page.last_seq, 5);
  const { data: o } = await call<Overview>("GET", "/api/overview");
  assert.deepEqual(
    o.connectors.map((c) => [c.id, c.name]),
    [["github", "GitHub"]],
  );
});

test("a review's checks agree with its PR's CI: failing first on a red one, with one running and the rest passing", async () => {
  const checks = async (id: string) => (await call<ReviewView>("GET", `/api/review/${encodeURIComponent(id)}?ahead=1`)).data.checks;
  const red = (await checks("oss/tinyhttp#205"))!;
  assert.deepEqual([red.said, red.tone], ["Checks failing", "bad"]);
  const states = red.list.map((c) => c.state);
  assert.deepEqual(
    states,
    states.toSorted((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)),
    "what's wrong first",
  );
  for (const state of ["failing", "running", "passing", "skipped"]) assert.ok(states.includes(state as (typeof states)[number]), state);
  assert.ok(
    red.list.every((c) => c.url.startsWith("https://")),
    "each links to its page",
  );
  assert.deepEqual(
    red.list.find((c) => c.name === "visual diff"),
    {
      name: "visual diff",
      state: "failing",
      optional: true,
      url: "https://github.com/oss/tinyhttp/runs/20521",
    },
  );
  assert.equal((await checks("acme/api#4127"))?.said, "Checks passing");
  assert.equal((await checks("acme/web#2301"))?.said, "Checks running");
  // Merging's failing check is the review's.
  const { data: lane } = await call<InflightView>("GET", "/api/inflight");
  const flying = lane.rows.find((r) => r.failing.length)!;
  const listed = (await checks(flying.card.id))!.list.filter((c) => c.state === "failing" && !c.optional);
  assert.deepEqual(
    listed.map((c) => c.name),
    flying.failing,
  );
});

test("a review's reviewers and merge line come from its PR's reviews, requests and conflict", async () => {
  const view = async (id: string) => (await call<ReviewView>("GET", `/api/review/${encodeURIComponent(id)}?ahead=1`)).data;
  const asked = await view("acme/api#4099");
  assert.deepEqual([asked.reviewers.line, asked.reviewers.changes], ["Changes requested by you · waiting on @backend", true]);
  assert.deepEqual(
    asked.reviewers.list.map((r) => `${r.who}: ${r.state}`),
    ["you: changes requested", "@backend: asked", "sam: commented"],
  );
  assert.equal(asked.merge, null);
  assert.equal((await view("acme/worker#875")).reviewers.line, "Approved by marco");
  assert.equal((await view("acme/web#2303")).reviewers.line, "Nobody's asked");
  assert.equal((await view("acme/api#4110")).merge, "Merge conflict with main");
});

test("review view: canned diffs whose notes sit on real lines, and approve as a no-op", async () => {
  const { data: v } = await call<ReviewView>("GET", `/api/review/${encodeURIComponent("acme/api#4127")}`);
  assert.equal(v.card.id, "acme/api#4127");
  assert.deepEqual([v.item.additions, v.item.deletions, v.item.changed_files], [62, 7, 5], "the header matches the files");
  assert.ok(v.ai && v.ai.notes.length >= 2 && !v.ai_stale);
  const { data: py } = await call<ReviewView>("GET", `/api/review/${encodeURIComponent("acme/ml-pipeline#311")}`);
  assert.ok(py.ai);
  // parseReview moves a note it can't place to line 0; every canned note, quoting its own line, must stay where it was put.
  const quoted = (ai: AiReview, files: ReviewFile[]) => ({
    ...ai,
    concerns: [],
    notes: ai.notes.map((n) => ({ ...n, quote: lineAt(files, n) })),
  });
  // 4127's notes are its deep review's, each flagged by kind; the agent's own answer has no flag to parse.
  assert.deepEqual(
    parseReview(quoted(v.ai, v.files), v.files).notes,
    v.ai.notes.map((n) => ({ path: n.path, line: n.line, side: n.side, body: n.body })),
  );
  assert.deepEqual(parseReview(quoted(py.ai, py.files), py.files).notes, py.ai.notes);
  for (const f of [...v.files, ...py.files]) {
    for (const h of (f.patch ?? "").matchAll(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@.*\n((?:[ +-].*(?:\n|$))*)/gm)) {
      const lines = h[3]!.split("\n").filter((l) => l !== "");
      const counted = (c: string) => lines.filter((l) => l[0] === " " || l[0] === c).length;
      assert.deepEqual([counted("-"), counted("+")], [Number(h[1] ?? 1), Number(h[2] ?? 1)], `${f.path}: ${h[0].split("\n")[0]}`);
    }
  }
  assert.deepEqual(v.approve, { ok: true, reason: null });
  const url = `/api/review/${encodeURIComponent("acme/api#4127")}/approve`;
  const older = await call<{ tag: string }>("POST", url, { head_oid: "an-older-commit" });
  assert.deepEqual([older.status, older.data.tag], [409, "Stale"], "only the commit you read");
  const { data: ok } = await call<{ ok: boolean; url: string }>("POST", url, { head_oid: v.item.head_oid });
  assert.equal(ok.ok, true);
  const { data: again } = await call<ReviewView>("GET", `/api/review/${encodeURIComponent("api#4127")}`);
  assert.equal(again.approve.reason, "you approved this commit");
  assert.equal(again.card.resolved, "you approved", "like the desk, your approval resolves it");
  assert.deepEqual([again.activity[0]?.kind, again.activity[0]?.actor], ["resolved", "me"]);
  const mine = await call<{ error: string; tag: string }>("POST", `/api/review/${encodeURIComponent("me/dotfiles#41")}/approve`, {
    head_oid: "x",
  });
  assert.deepEqual([mine.status, mine.data.tag], [409, "Conflict"]);
});

test("review view: the desk's reading order for a ranked review, a capped one, nothing worth a look, and an old one", async () => {
  const view = async (id: string) => (await call<ReviewView>("GET", `/api/review/${encodeURIComponent(id)}`)).data;
  const v = await view("acme/api#4127");
  const py = await view("acme/ml-pipeline#311");
  // The canned rankings name real hunks: parsing them again keeps them as they are.
  for (const x of [v, py]) {
    const raw = x.ai!.chunks!.ranked.map(({ id, level, why }) => ({ id, level, why }));
    assert.deepEqual(parseReview({ ...x.ai, chunks: raw }, x.files).chunks, x.ai!.chunks);
  }
  // 4127's deep review: its steps' hunks in their order, the one no step names skipped.
  assert.deepEqual(
    v.order.chunks.map((h) => [h.rank, h.level, h.path]),
    [
      [1, "look", "src/planner/stream.ts"],
      [2, "look", "src/planner/plan.ts"],
      [3, "look", "src/planner/plan.ts"],
      [4, "look", "src/routes/query.ts"],
      [5, "look", "test/planner/stream.test.ts"],
    ],
  );
  assert.deepEqual(
    v.order.skipped.map((h) => [h.level, h.path]),
    [["skip", "docs/api/query.md"]],
  );
  assert.deepEqual(v.order.rest, []);
  assert.equal(new Set(v.order.notes).size, v.ai!.notes.length, "every note once");
  assert.ok(py.order.rest.some((r) => r.why.startsWith("no text diff") && !r.hunks.length));

  const big = await view("acme/worker#879");
  assert.deepEqual([big.order.chunks.length, big.order.unread.length], [20, 5]);
  const none = await view("oss/calendar-ui#310");
  assert.deepEqual([none.order.ranked, none.order.chunks.length], [true, 0]);
  const old = await view("friends/garden-sensors#18");
  assert.equal(old.order.ranked, false, "written before ranking: today's order");
  assert.ok(old.order.chunks.length && old.order.chunks.every((h) => h.level === null));
  const stale = await view("acme/api#4099");
  assert.deepEqual([stale.ai_stale, stale.order.ranked, stale.order.notes], [true, false, []]);
});

test("stacks: the queue lists each once with its chain, and a member no board lists opens in review", async () => {
  const { data: q } = await call<QueueView>("GET", "/api/queue");
  const all = Object.values(q.sections).flat();
  assert.deepEqual(
    all.filter((c) => c.stack).map((c) => [c.id, c.stack]),
    [
      // 4152 and 4153 are in Merging, never on the queue: 4154 stands for the stack.
      ["acme/api#4154", { id: "acme/api#4150", pos: 3, size: 6, folded: ["acme/api#4155", "acme/api#4156", "acme/api#4157"] }],
      ["acme/worker#890", { id: "acme/worker#890", pos: 1, size: 3, folded: ["acme/worker#891"] }],
      ["oss/calendar-ui#310", { id: "oss/calendar-ui#310", pos: 1, size: 3, folded: ["oss/calendar-ui#311", "oss/calendar-ui#312"] }],
    ],
  );
  assert.deepEqual(
    q.cleared.filter((c) => c.stack).map((c) => [c.id, c.stack]),
    [
      ["acme/api#4091", { id: "acme/api#4091", pos: 1, size: 2 }],
      ["acme/api#4092", { id: "acme/api#4091", pos: 2, size: 2 }],
    ],
    "a stack snoozed whole is in Cleared, every PR",
  );
  assert.deepEqual(Object.keys(q.stacks).toSorted(), ["acme/api#4091", "acme/api#4150", "acme/worker#890", "oss/calendar-ui#310"]);
  assert.equal(q.stacks["acme/api#4091"]?.current, "acme/api#4091");
  assert.deepEqual(
    q.stacks["acme/worker#890"]?.forks.map((m) => [m.number, m.parent, m.bucket]),
    [[893, "acme/worker#890", null]],
    "a fork off the bottom, asked of nobody",
  );
  const mine = q.stacks["acme/api#4150"]!;
  assert.deepEqual([mine.current, mine.up, mine.down, mine.forks], ["acme/api#4154", "acme/api#4155", "acme/api#4153", []]);
  assert.deepEqual(
    mine.line.map((m) => [m.number, m.state, m.draft, m.ci, m.review, m.bucket]),
    [
      [4150, "merged", false, "green", "required", null],
      [4151, "merged", false, "green", "required", null],
      [4152, "open", false, "green", "approved", null],
      [4153, "open", false, "red", "required", null],
      [4154, "open", false, "green", "changes_requested", "now"],
      [4155, "open", false, "green", "required", "fyi"],
      [4156, "open", true, "red", "required", "later"],
      [4157, "open", true, "green", "required", "fyi"],
    ],
  );
  const { data: top } = await call<ReviewView>("GET", `/api/review/${encodeURIComponent("acme/worker#892")}`);
  assert.deepEqual(
    [top.stack?.current, top.stack?.up, top.stack?.down, top.card.stack],
    ["acme/worker#892", null, "acme/worker#891", { id: "acme/worker#890", pos: 3, size: 3 }],
  );
  const { data: fork } = await call<ReviewView>("GET", `/api/review/${encodeURIComponent("acme/worker#893")}`);
  assert.deepEqual(
    [fork.stack?.line.map((m) => m.number), fork.stack?.forks.map((m) => m.number), fork.stack?.down, fork.card.stack],
    [[890, 893], [891, 892], "acme/worker#890", { id: "acme/worker#890", pos: 2, size: 2 }],
  );
});

test("Merging: what each waits on and the coordinator's note, handed back at the top of Now, hand off and back to desk", async () => {
  const { data: lane } = await call<InflightView>("GET", "/api/inflight");
  const row = (id: string) => lane.rows.find((r) => r.card.id === id)!;
  assert.deepEqual(
    lane.rows.map((r) => [r.card.id, r.waits_on]),
    [
      ["acme/api#4122", "waits on a second look from dana"],
      ["acme/api#4152", "ready to merge"],
      ["acme/api#4153", "waits on a CI fix"], // with the PR below it in its stack
      ["acme/web#2295", "waits on a CI fix"],
      ["acme/api#4110", "waits on a merge conflict fix"],
      ["acme/api#4105", "waits on a review from sam, @backend and 4 more"],
      ["acme/billing#2301", "waits on api#1294 to merge first"],
      ["acme/worker#871", null],
    ],
  );
  assert.deepEqual(
    lane.stacks["acme/api#4150"]?.line.map((m) => [m.number, m.state, m.current]),
    [
      [4150, "merged", false],
      [4151, "merged", false],
      [4152, "open", true],
      [4153, "open", false],
      [4154, "open", false],
      [4155, "open", false],
      [4156, "open", false],
      [4157, "open", false],
    ],
  );
  assert.equal(row("acme/worker#871").state, "merged");
  assert.match(row("acme/api#4122").note?.text ?? "", /^Pushed 4be71c2/);
  assert.equal(row("acme/api#4105").note, null);
  const { data: q } = await call<QueueView>("GET", "/api/queue");
  const all = [...Object.values(q.sections).flat(), ...q.hidden, ...q.cleared, ...q.resolved];
  assert.deepEqual(
    all.filter((c) => c.inflight).map((c) => [c.id, q.sections.blocked.includes(c)]),
    [["acme/billing#2301", true]],
    "Merging has them; Blocked also lists the one another PR blocks",
  );
  assert.deepEqual(
    q.sections.now.slice(0, 1).map((c) => c.id),
    ["oss/tinyhttp#205"],
  );
  assert.match(q.sections.now[0]!.why, /^handed back: /);
  assert.equal(q.sections.now[0]!.stage, "handed back", "its row says so, as the desk's does");
  const { data: o } = await call<Overview>("GET", "/api/overview");
  assert.deepEqual(o.inflight, { total: 7 });

  const act = (id: string, action: string) => call("POST", "/api/act", { id, action });
  assert.equal((await act("acme/api#4127", "inflight")).status, 409, "not your PR");
  assert.equal((await act("acme/web#2295", "takeback")).status, 200);
  const { data: q2 } = await call<QueueView>("GET", "/api/queue");
  assert.ok(
    Object.values(q2.sections)
      .flat()
      .some((c) => c.id === "acme/web#2295" && !c.inflight),
  );
  assert.equal((await act("acme/web#2295", "inflight")).status, 200);
});

test("Blocked as a tree: api#1294's chain, 3 deep under billing#2300, saying once what it waits on, Merging's marked; a chain you approved; dana's api#1301; web#2306 and a diamond on it", async () => {
  const silo = "waits on your reply to dana, then a review from sam, kai and 6 more";
  const { data: q } = await call<QueueView>("GET", "/api/queue");
  assert.deepEqual(
    q.sections.blocked.map((c) => [c.id, c.why, c.depth, c.inflight]),
    [
      ["acme/billing#2298", `needs api#1294, which ${silo}`, 0, false],
      ["acme/billing#2299", "needs api#1294", 0, false],
      ["acme/billing#2300", "needs api#1294", 0, false],
      ["acme/billing#2302", "needs billing#2300", 1, false],
      ["acme/billing#2303", "needs billing#2302", 2, false],
      ["acme/billing#2301", "in Merging \u00b7 needs api#1294", 0, true],
      ["acme/web#2292", "is approved, for marco to merge", 0, false], // a chain's head you approved: its steps wait on marco
      ["acme/api#1301", "needs api#1299, which waits on a review from kai", 0, false],
      ["acme/web#2306", "waits on a review from sam, @backend and 1 more", 0, false],
      ["acme/web#2307", "needs web#2306", 1, false],
      ["acme/web#2308", "needs web#2306", 1, false],
      ["acme/web#2309", "needs web#2307 and web#2308", 2, false],
    ],
  );
  const held = q.sections.blocked[0]!;
  assert.deepEqual(
    [held.stage, held.blocker, held.handed_back],
    ["blocked", { id: "acme/api#1294", ref: "api#1294", waits: silo }, undefined],
  );
  assert.equal(q.sections.blocked[2]!.stage, "blocked", "waiting for review, but blocked");
  const page = [...q.sections.now, ...q.sections.today];
  assert.ok(!page.some((c) => c.blocker), "a held hand-back, and a review asked of you by name, wait in Blocked");
  assert.equal(page[0]!.id, "oss/tinyhttp#205", "a hand-back nothing blocks is still back to you");
  const root = q.sections.today.find((c) => c.id === "acme/api#1294")!;
  assert.deepEqual(
    [root.why, root.cta, root.blocks],
    [
      `blocks billing#2298, billing#2299 and 4 more; it ${silo}`,
      "reply",
      ["billing#2298", "billing#2299", "billing#2300", "billing#2301", "billing#2302", "billing#2303"],
    ],
  );

  const { data: lane } = await call<InflightView>("GET", "/api/inflight");
  const row = lane.rows.find((r) => r.card.id === "acme/billing#2301")!;
  assert.deepEqual([row.waits_on, row.blocked_by], ["waits on api#1294 to merge first", { ref: "api#1294", waits: silo }]);
  // The rule that put it in Blocked is final: Claude isn't asked, though the judge is on.
  const { data: d } = await call<ItemDetail>("GET", `/api/item?id=${encodeURIComponent("acme/api#1301")}`);
  const p = d.placements.find((x) => x.board === "work-review")!;
  assert.deepEqual([p.bucket, p.rule, p.judge], ["blocked", 0, undefined]);
  const { data: other } = await call<ItemDetail>("GET", `/api/item?id=${encodeURIComponent("acme/api#4127")}`);
  assert.ok(other.placements.find((x) => x.board === "work-review")!.judge, "a rule that isn't final is sorted by Claude");
});

test("your own draft carries one call to action, Ready for review, and the mock takes it", async () => {
  const { data: q } = await call<QueueView>("GET", "/api/queue");
  const drafts = [...q.sections.now, ...q.sections.today, ...q.sections.later].filter((c) => c.draft && c.by === "you");
  assert.ok(drafts.length > 0);
  assert.ok(drafts.every((c) => c.cta === "ready"));
  assert.ok(
    drafts.some((c) => c.author === "acme-junior[bot]"),
    "a bot's draft opened for you is yours too",
  );
  assert.ok(![...q.sections.now, ...q.sections.today].some((c) => c.cta === "ready" && (!c.draft || c.by !== "you")));
  const id = encodeURIComponent(drafts[0]!.id);
  const ready = await call<{ done: boolean }>("POST", `/api/review/${id}/ready`);
  assert.deepEqual([ready.status, ready.data.done], [200, false], "nobody's asked to review it: it stays on your desk");
  assert.equal((await call("POST", `/api/review/${id}/ready`)).status, 409, "not a draft any more");
  const next = encodeURIComponent(drafts[1]!.id);
  assert.equal((await call<{ done: boolean }>("POST", `/api/review/${next}/ready`, { users: ["U_dana"] })).data.done, true);
});

test("the More menu's GitHub writes: the cards say which, and the mock takes them like the desk", async () => {
  const card = async (id: string) => (await call<ItemDetail>("GET", `/api/item?id=${encodeURIComponent(id)}`)).data.card;
  assert.deepEqual((await card("acme/worker#875")).actions, ["close", "draft", "rerequest", "merge"], "yours, approved and green");
  assert.deepEqual((await card("acme/api#4127")).actions, ["request_changes", "unrequest"], "someone else's, asked of you by name");
  assert.equal((await card("acme/web#2295")).actions, undefined, "in Merging");
  const gh = (id: string, action: string) => call("POST", "/api/github", { id, action });
  assert.equal((await gh("acme/api#4127", "close")).status, 409, "not yours");
  assert.equal((await gh("acme/worker#875", "close")).status, 200);
  assert.deepEqual((await card("acme/worker#875")).actions, ["reopen"]);
  assert.equal((await gh("acme/worker#875", "reopen")).status, 200);
  assert.deepEqual((await card("acme/worker#875")).actions, ["close", "draft", "rerequest", "merge"]);
});

test("an answer nobody picked up: Claude's work lists it with who asked, its question says so, one that was read says when, and a new answer is owed", async () => {
  const work = async () => (await call<InflightView>("GET", "/api/inflight")).data.work.filter((w) => w.kind === "answer");
  assert.deepEqual(
    (await work()).map((w) => [w.key, w.state, w.from, w.title, w.error]),
    [
      [
        "q3ab5e17",
        "failed",
        "seer: code mode research",
        "Rerun the baseline arm, or compare against last week's numbers?",
        "that session has probably ended",
      ],
    ],
  );
  const read = async (id: string) => (await call<InquiryView>("GET", `/api/inquiries/${id}`)).data.answer?.read_at;
  assert.equal(await read("q3ab5e17"), null);
  assert.equal(typeof (await read("q4f00d42")), "string");
  assert.equal((await call("POST", "/api/inquiries/q2bead00/answer", { text: "The core one first" })).status, 200);
  assert.equal(await read("q2bead00"), null);
  assert.deepEqual(
    (await work()).map((w) => [w.key, w.state]),
    [
      ["q2bead00", "queued"],
      ["q3ab5e17", "failed"],
    ],
  );
});

test("POST /api/mock/clock winds the mock's clock back to its start, where the shots start each shot", async () => {
  const { data } = await call<{ t0: number }>("GET", "/api/mock/clock");
  const stamped = async () =>
    Date.parse((await call<ReviewView>("GET", `/api/review/${encodeURIComponent("acme/api#4154")}?ahead=1`)).data.item.detail_at);
  await new Promise((r) => {
    setTimeout(r, 1200);
  });
  assert.ok((await stamped()) - data.t0 >= 1200, "real time until wound back");
  await call("POST", "/api/mock/clock");
  assert.ok((await stamped()) - data.t0 < 1000);
});

test("one reviewer of your PR removed or asked again, as the review's sidebar does", async () => {
  const id = encodeURIComponent("acme/api#4154");
  const who = async () => (await call<ReviewView>("GET", `/api/review/${id}?ahead=1`)).data.reviewers.list.map((r) => r.who);
  const one = (login: string, act: string, pr = id) => call("POST", `/api/review/${pr}/reviewer`, { login, act });
  assert.equal((await call("POST", `/api/review/${id}/reviewers`, { users: ["U_dana"], keep: true })).status, 200);
  assert.ok((await who()).includes("dana"));
  assert.equal((await one("dana", "remove")).status, 200);
  assert.ok(!(await who()).includes("dana"));
  assert.equal((await one("dana", "rerequest")).status, 200);
  assert.ok((await who()).includes("dana"));
  assert.equal((await one("dana", "remove")).status, 200);
  assert.equal((await one("dana", "remove", encodeURIComponent("acme/api#4127"))).status, 409, "not yours");
});

// Every call<…>("METHOD", "/api/…") in web/src/api.ts, its ${…} filled in: a ternary of two words takes the first.
const windowCalls = (): { method: string; path: string }[] =>
  [
    ...fs.readFileSync(new URL("../src/api.ts", import.meta.url), "utf8").matchAll(/call<[\s\S]*?>\("(GET|POST|PUT|DELETE)", ([^\n]*)/g),
  ].flatMap(([, method, rest]) =>
    [
      ...rest!
        .replaceAll(/\$\{[^}?]*\?\s*"([^"]*)"\s*:\s*"[^"]*"\}/g, "$1")
        .replaceAll(/\$\{[^}]*\}/g, "x")
        .matchAll(/["`](\/api\/[^"`]*)["`]/g),
    ].map(([, path]) => ({ method: method!, path: path! })),
  );

// The routes src/server.ts serves, as METHOD and a pattern: :id is one segment, :id{re} its own pattern, ${…} one segment.
const deskRoutes = (): { method: string; re: RegExp }[] =>
  [
    ...fs.readFileSync(new URL("../../src/server.ts", import.meta.url), "utf8").matchAll(/app\.(get|post|put|delete)\(["`](\/[^"`]*)["`]/g),
  ].map(([, method, route]) => ({
    method: method!.toUpperCase(),
    re: new RegExp(
      `^${route!
        .replaceAll(/:\w+\{(.+?)\}(?=\/|$)/g, "($1)")
        .replaceAll(/:\w+/g, "[^/]+")
        .replaceAll(/\$\{\w+\}/g, "[^/]+")}$`,
    ),
  }));

test("the mock answers every route the window calls, and the desk serves each one", async (c) => {
  const calls = windowCalls();
  assert.ok(calls.length > 70, `read ${calls.length} calls from api.ts`);
  const routes = deskRoutes();
  const unserved = calls.filter((x) => !routes.some((r) => r.method === x.method && r.re.test(x.path.split("?")[0]!)));
  assert.deepEqual(unserved, [], "routes the window calls that src/server.ts has no handler for");
  // Its own mock: these calls change what it holds.
  const mock = await startMock();
  c.after(mock.stop);
  const missing: string[] = [];
  for (const { method, path } of calls) {
    const res = await fetch(mock.base + path, {
      method,
      ...(method === "GET" ? {} : { body: "{}" }),
      headers: { "content-type": "application/json" },
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.status === 404 && JSON.stringify(body).includes('"error":"not found"')) missing.push(`${method} ${path}`);
  }
  assert.deepEqual(missing, []);
});

test("an automation saved to the mock reads back as the desk's does, every key of its body", async (c) => {
  const t = await setup([], { settings: { "policy.judge": false } });
  c.after(t.cleanup);
  await run(t.desk.sync());
  const app = createApp(t.desk, 47823);
  const body = {
    name: "Mail",
    events: ["ci", "commented"],
    prompt: "Read my mail.",
    when: "!author.bot",
    can: ["add", "fyi"],
    mcp: ["gmail"],
    buttons: [
      { label: "Open in Gmail", do: "open" },
      { label: "Draft a reply", do: "ask", prompt: "Draft a reply." },
    ],
    icon: "receipt",
    type: 'type Email = { kind: "bill" | "personal"; sender: string }',
    rules: [
      { when: "item.kind == 'bill'", do: "urgent" },
      { ask: "Is it a newsletter?", do: "drop" },
    ],
    on: false,
  };
  const both = async (b: object) => {
    const put = await app.request("http://127.0.0.1:47823/api/automations/parity", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(b),
    });
    assert.equal(put.status, 200, await put.clone().text());
    assert.equal((await call("PUT", "/api/automations/parity", b)).status, 200);
    const desk = ((await (await app.request("http://127.0.0.1:47823/api/automations")).json()) as AutomationView[]).find(
      (a) => a.id === "parity",
    )!;
    const mock = (await call<AutomationView[]>("GET", "/api/automations")).data.find((a) => a.id === "parity")!;
    assert.deepEqual(automationBody(mock), automationBody(desk));
    return automationBody(desk);
  };
  assert.deepEqual(await both(body), { schedule: "", decide: undefined, rule: undefined, ...body });
  // Left out, on stays as it was, on both.
  const { on: _, ...edit } = body;
  assert.equal((await both({ ...edit, name: "Mail and more" })).on, false);
  await call("DELETE", "/api/automations/parity");
});
