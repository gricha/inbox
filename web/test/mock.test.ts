// Runs the mock API and checks it speaks the shapes the UI relies on.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  ActivityPage,
  AgentStatus,
  BoardView,
  ConfigError,
  FieldDoc,
  FocusView,
  InflightView,
  ItemDetail,
  Overview,
  PolicyDoc,
  PreviewResult,
  QueueView,
  ReviewView,
  SettingsView,
} from "../../src/types.ts";
import { CLAUDE_PAUSED, parseReview } from "../../src/review.ts";

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
  assert.equal((await call("GET", "/api/boards/nope")).status, 404);
});

// Before the tests below act on cards, while the queue is as the mock starts.
test("the queue's cards carry pre-flight in every state, your PRs say what's next, and the queue folds", async () => {
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
  assert.deepEqual([of("acme/worker#860").preflight, of("acme/worker#860").next], [{ state: "none" }, undefined], "an issue");
  assert.equal(of("me/notes-app#12").preflight?.state, "none");
  assert.equal(of("me/notes-app#12").next, "3 unresolved threads: m hands it off for merge");
  // Enter and o are on every card's keys, so a next step that would only name them is left out.
  assert.equal(of("acme/worker#875").next, undefined);
  assert.deepEqual([of("acme/api#3051").checks_failed?.length, of("acme/api#3051").checks_optional?.length], [2, 1]);
  assert.equal(of("acme/worker#860").last_event?.kind, "commented", "an issue's latest event");

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
      [0, true],
    ],
  );
  assert.match(d.handoff_prompt, /acme\/web#2301/);
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
  assert.equal(bad.errors[0]?.path, "boards[0].rules[6].when");
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
  assert.ok(s.github.orgs.some((o) => o.space === null));
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

test("review view: canned diffs whose notes sit on real lines, and approve as a no-op", async () => {
  const { data: v } = await call<ReviewView>("GET", `/api/review/${encodeURIComponent("acme/api#4127")}`);
  assert.equal(v.card.id, "acme/api#4127");
  assert.deepEqual([v.item.additions, v.item.deletions, v.item.changed_files], [62, 7, 5], "the header matches the files");
  assert.ok(v.ai && v.ai.notes.length > 2 && !v.ai_stale);
  const { data: py } = await call<ReviewView>("GET", `/api/review/${encodeURIComponent("acme/ml-pipeline#311")}`);
  assert.ok(py.ai);
  // parseReview moves a note it can't place to line 0; every canned note must stay where it was put.
  assert.deepEqual(parseReview(v.ai, v.files).notes, v.ai.notes);
  assert.deepEqual(parseReview(py.ai, py.files).notes, py.ai.notes);
  for (const f of [...v.files, ...py.files]) {
    for (const h of (f.patch ?? "").matchAll(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@.*\n((?:[ +-].*(?:\n|$))*)/gm)) {
      const lines = h[3]!.split("\n").filter((l) => l !== "");
      const counted = (c: string) => lines.filter((l) => l[0] === " " || l[0] === c).length;
      assert.deepEqual([counted("-"), counted("+")], [Number(h[1] ?? 1), Number(h[2] ?? 1)], `${f.path}: ${h[0].split("\n")[0]}`);
    }
  }
  assert.deepEqual(v.approve, { ok: true, reason: null });
  const url = `/api/review/${encodeURIComponent("acme/api#4127")}/approve`;
  assert.equal((await call("POST", url, { head_oid: "an-older-commit" })).status, 409, "only the commit you read");
  const { data: ok } = await call<{ ok: boolean; url: string }>("POST", url, { head_oid: v.item.head_oid });
  assert.equal(ok.ok, true);
  const { data: again } = await call<ReviewView>("GET", `/api/review/${encodeURIComponent("api#4127")}`);
  assert.equal(again.approve.reason, "you approved this commit");
  assert.equal(again.card.resolved, "you approved", "like the desk, your approval resolves it");
  assert.deepEqual([again.activity[0]?.kind, again.activity[0]?.actor], ["resolved", "me"]);
  const mine = await call<{ error: string }>("POST", `/api/review/${encodeURIComponent("me/dotfiles#41")}/approve`, { head_oid: "x" });
  assert.equal(mine.status, 409);
});

test("policy: a policy with its judge, saved against its hash", async () => {
  const { data: p } = await call<PolicyDoc>("GET", "/api/policy");
  assert.ok(p.text.trim());
  assert.equal(p.judge.state, "idle");
  assert.equal((await call("PUT", "/api/policy", { text: "x", base: "stale" })).status, 409);
  const { data: saved } = await call<{ ok: boolean; hash: string }>("PUT", "/api/policy", { text: p.text, base: p.hash });
  assert.notEqual(saved.hash, p.hash);
});

test("Merging: what each waits on and the coordinator's note, handed back at the top of Now, hand off and back to desk", async () => {
  const { data: lane } = await call<InflightView>("GET", "/api/inflight");
  const row = (id: string) => lane.rows.find((r) => r.card.id === id)!;
  assert.deepEqual(
    lane.rows.map((r) => [r.card.id, r.waits_on]),
    [
      ["acme/api#4122", "waits on a second look from dana"],
      ["acme/web#2295", "waits on a CI fix"],
      ["acme/api#4110", "waits on a merge conflict fix"],
      ["acme/api#4105", "waits on a review from sam, @backend and 4 more"],
      ["acme/worker#871", null],
    ],
  );
  assert.equal(row("acme/worker#871").state, "merged");
  assert.match(row("acme/api#4122").note?.text ?? "", /^Pushed 4be71c2/);
  assert.equal(row("acme/api#4105").note, null);
  const { data: q } = await call<QueueView>("GET", "/api/queue");
  const all = [...Object.values(q.sections).flat(), ...q.hidden, ...q.cleared, ...q.resolved];
  assert.ok(!all.some((c) => c.inflight), "Merging has them");
  assert.deepEqual(
    q.sections.now.slice(0, 1).map((c) => c.id),
    ["oss/tinyhttp#205"],
  );
  assert.match(q.sections.now[0]!.why, /^handed back: /);
  const { data: o } = await call<Overview>("GET", "/api/overview");
  assert.deepEqual(o.inflight, { total: 4 });

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

test("your own draft carries one call to action, Ready for review, and the mock takes it", async () => {
  const { data: q } = await call<QueueView>("GET", "/api/queue");
  const drafts = [...q.sections.now, ...q.sections.today, ...q.sections.later].filter((c) => c.draft && c.author === "me");
  assert.ok(drafts.length > 0);
  assert.ok(drafts.every((c) => c.cta === "ready"));
  assert.ok(![...q.sections.now, ...q.sections.today].some((c) => c.cta && (!c.draft || c.author !== "me")));
  const id = encodeURIComponent(drafts[0]!.id);
  assert.equal((await call("POST", `/api/review/${id}/ready`)).status, 200);
  assert.equal((await call("POST", `/api/review/${id}/ready`)).status, 409, "not a draft any more");
});
