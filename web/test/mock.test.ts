// Runs the mock API and checks it speaks the shapes the UI relies on.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  AiReview,
  ActivityPage,
  AgentStatus,
  BoardView,
  ConfigError,
  FieldDoc,
  FocusView,
  InflightView,
  InquiryView,
  ItemDetail,
  Overview,
  PolicyDoc,
  PreviewResult,
  QueueView,
  ReviewFile,
  ReviewView,
  SettingsView,
} from "../../src/types.ts";
import { CLAUDE_PAUSED, lineAt, parseReview } from "../../src/review.ts";

const ORDER = ["failing", "cancelled", "running", "passing", "skipped"];

const child = spawn(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../mock/server.ts", import.meta.url))],
  {
    env: { ...process.env, MOCK_PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  },
);
let base = "";

before(async () => {
  const [line] = (await once(child.stdout, "data")) as [Buffer];
  base = line.toString().match(/http:\/\/[\d.:]+/)![0];
});
after(() => {
  child.kill();
});

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T is the caller's claim about the reply shape, like call<T> in web/src/api.ts
async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(base + path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
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
test("the queue's cards carry pre-flight in every state, and the queue folds", async () => {
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
  assert.ok(top.length > 12 && q.cards === 10, "the queue folds");
  assert.equal(q.paused, null);
  assert.equal((await call<FocusView>("GET", "/api/focus")).data.cards, 10);
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
  const { judge } = (await call<PolicyDoc>("GET", "/api/policy")).data;
  assert.deepEqual([judge.state, judge.error, !!judge.retry_at], ["error", loggedOut, true]);
  await call("POST", "/api/mock/ai-paused", { paused: false });
  const { data: back } = await call<QueueView>("GET", "/api/queue");
  assert.equal(back.paused, null);
  assert.equal((await call<PolicyDoc>("GET", "/api/policy")).data.judge.state, "idle");
  // At work: the judge judging.
  await call("POST", "/api/mock/agents-busy", { busy: true });
  assert.equal((await call<PolicyDoc>("GET", "/api/policy")).data.judge.state, "running");
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
  assert.match(bad.errors[0]?.message ?? "", /did you mean pr\.approvals/);

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
  const { data: p } = await call<PreviewResult>("POST", "/api/config/preview", { text: `poll_seconds = 60\n${cfg.text}` });
  assert.match(p.errors[0]?.message ?? "", /moved to Settings/);
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
    [
      ["acme/web#2284", "merged", "merged"],
      ["acme/web#2292", "you approved", "you approved"],
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
  assert.deepEqual([red.line, red.failing], ["3 failing, 1 running of 11 checks", true]);
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
  assert.equal((await checks("acme/api#4127"))?.line, "CI passing · 11 checks");
  assert.equal((await checks("acme/web#2301"))?.line, "3 running of 11 checks");
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
  assert.ok(v.ai && v.ai.notes.length > 2 && !v.ai_stale);
  const { data: py } = await call<ReviewView>("GET", `/api/review/${encodeURIComponent("acme/ml-pipeline#311")}`);
  assert.ok(py.ai);
  // parseReview moves a note it can't place to line 0; every canned note, quoting its own line, must stay where it was put.
  const quoted = (ai: AiReview, files: ReviewFile[]) => ({
    ...ai,
    concerns: [],
    notes: ai.notes.map((n) => ({ ...n, quote: lineAt(files, n) })),
  });
  assert.deepEqual(parseReview(quoted(v.ai, v.files), v.files).notes, v.ai.notes);
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
  // The test file's note keeps it in the reading list, after what Claude ranked.
  assert.deepEqual(
    v.order.chunks.map((h) => [h.rank, h.level, h.path, h.why === ""]),
    [
      [1, "look", "src/planner/plan.ts", false],
      [2, "look", "src/routes/query.ts", false],
      [3, "skim", "src/planner/stream.ts", false],
      [4, "skim", "test/planner/stream.test.ts", true],
    ],
  );
  // What Claude left out stays in view, marked Skip; only the desk's own calls fold.
  assert.deepEqual(
    v.order.skipped.map((h) => [h.level, h.path]),
    [
      ["skip", "src/planner/plan.ts"],
      ["skip", "docs/api/query.md"],
    ],
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

test("policy: a policy with its judge, saved against its hash", async () => {
  const { data: p } = await call<PolicyDoc>("GET", "/api/policy");
  assert.ok(p.text.trim());
  assert.equal(p.judge.state, "idle");
  const stale = await call<{ tag: string }>("PUT", "/api/policy", { text: "x", base: "stale" });
  assert.deepEqual([stale.status, stale.data.tag], [409, "Stale"]);
  const { data: saved } = await call<{ ok: boolean; hash: string }>("PUT", "/api/policy", { text: p.text, base: p.hash });
  assert.notEqual(saved.hash, p.hash);
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

test("Blocked as a tree: api#1294's chain, 3 deep under billing#2300, saying once what it waits on, Merging's marked; dana's api#1301; web#2306 and a diamond on it", async () => {
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
  const drafts = [...q.sections.now, ...q.sections.today, ...q.sections.later].filter((c) => c.draft && c.author === "me");
  assert.ok(drafts.length > 0);
  assert.ok(drafts.every((c) => c.cta === "ready"));
  assert.ok(![...q.sections.now, ...q.sections.today].some((c) => c.cta === "ready" && (!c.draft || c.author !== "me")));
  const id = encodeURIComponent(drafts[0]!.id);
  const ready = await call<{ done: boolean }>("POST", `/api/review/${id}/ready`);
  assert.deepEqual([ready.status, ready.data.done], [200, false], "nobody's asked to review it: it stays on your desk");
  assert.equal((await call("POST", `/api/review/${id}/ready`)).status, 409, "not a draft any more");
  const next = encodeURIComponent(drafts[1]!.id);
  assert.equal((await call<{ done: boolean }>("POST", `/api/review/${next}/ready`, { users: ["U_dana"] })).data.done, true);
});

test("the More menu's GitHub writes: the cards say which, and the mock takes them like the desk", async () => {
  const card = async (id: string) => (await call<ItemDetail>("GET", `/api/item?id=${encodeURIComponent(id)}`)).data.card;
  assert.deepEqual((await card("acme/worker#875")).actions, ["close", "draft", "merge"], "yours, approved and green");
  assert.deepEqual((await card("acme/api#4127")).actions, ["request_changes"], "someone else's");
  assert.equal((await card("acme/web#2295")).actions, undefined, "in Merging");
  const gh = (id: string, action: string) => call("POST", "/api/github", { id, action });
  assert.equal((await gh("acme/api#4127", "close")).status, 409, "not yours");
  assert.equal((await gh("acme/worker#875", "close")).status, 200);
  assert.deepEqual((await card("acme/worker#875")).actions, ["reopen"]);
  assert.equal((await gh("acme/worker#875", "reopen")).status, 200);
  assert.deepEqual((await card("acme/worker#875")).actions, ["close", "draft", "merge"]);
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
