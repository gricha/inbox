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
  CoordinatorView,
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
import { parseReview } from "../../src/review.ts";

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
  assert.ok(total >= 25, `~30 cards (less your PRs in flight), got ${total}`);
  // Filtered items aren't on the board (src/rules.ts), not under "hidden".
  const { data: wr } = await call<BoardView>("GET", "/api/boards/work-review");
  assert.ok(![...Object.values(wr.sections).flat(), ...wr.hidden].some((c) => c.id === "acme/web#2279"));
  assert.equal((await call("GET", "/api/boards/nope")).status, 404);
});

// Before the tests below act on cards, while the queue is as the mock starts.
test("the queue's cards carry pre-flight in every state, your PRs say what's next, and Today folds", async () => {
  const { data: q } = await call<QueueView>("GET", "/api/queue");
  const top = [...q.sections.now, ...q.sections.today];
  const of = (id: string) => top.find((c) => c.id === id)!;
  assert.ok(
    top.every((c) => c.preflight),
    "every Now and Today card",
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
  assert.equal(of("me/notes-app#12").next, "3 unresolved threads: d hands it to a babysitter");
  assert.equal(of("acme/api#4110").next, "Enter opens In flight to answer it");
  assert.equal(of("acme/worker#875").next, "approved and green: o opens it on GitHub to merge");

  const quiet = q.sections.later.find((c) => c.id === "acme/api#4040")!;
  assert.equal(quiet.demoted, "quiet for 3 weeks");
  assert.ok(q.sections.today.length >= 8 && q.today_cards === 5, "Today folds");
  assert.equal(q.ai_paused, null);
  assert.equal((await call<FocusView>("GET", "/api/focus")).data.today_cards, 5);
});

test("AI reviews paused: the queue says so once, cards wait as paused, and resuming runs them again", async () => {
  await call("POST", "/api/mock/ai-paused", { paused: true });
  const { data: q } = await call<QueueView>("GET", "/api/queue");
  assert.equal(q.ai_paused, "Claude Code isn't logged in. Run `claude auth login` in a terminal.");
  const state = (id: string) => [...q.sections.now, ...q.sections.today].find((c) => c.id === id)?.preflight?.state;
  assert.deepEqual(["acme/web#2301", "acme/api#4099", "acme/ml-pipeline#307", "acme/api#4127"].map(state), [
    "paused",
    "paused",
    "paused",
    "ready",
  ]);
  assert.match((await call<SettingsView>("GET", "/api/settings")).data.paused.ai?.why ?? "", /^AI reviews are paused: Claude Code/);
  await call("POST", "/api/mock/ai-paused", { paused: false });
  const { data: back } = await call<QueueView>("GET", "/api/queue");
  assert.equal(back.ai_paused, null);
  assert.equal(back.sections.now.find((c) => c.id === "acme/web#2301")?.preflight?.state, "running");
});

test("item detail resolves short refs and explains placement", async () => {
  const { data: d } = await call<ItemDetail>("GET", `/api/item?id=${encodeURIComponent("api#4127")}`);
  assert.equal(d.item.id, "acme/api#4127");
  const review = d.placements.find((p) => p.board === "work-review")!;
  assert.equal(review.rule_bucket, "now");
  assert.equal(review.bucket, "today");
  assert.match(review.demoted ?? "", /Now was full/);
  assert.deepEqual(
    review.trace.map((t) => [t.index, t.matched]),
    [
      [-1, true],
      [0, true],
    ],
  );
  assert.match(d.handoff_prompt, /acme\/api#4127/);
  assert.equal((await call("GET", "/api/item?id=nope%231")).status, 404);
});

test("act, undo and the cap reflow", async () => {
  const { data: r } = await call<{ ok: true; undo_seq: number }>("POST", "/api/act", { id: "acme/api#4099", action: "done" });
  let { data: v } = await call<BoardView>("GET", "/api/boards/work-review");
  assert.ok(v.cleared.some((c) => c.id === "acme/api#4099" && c.status === "done"));
  assert.ok(
    v.sections.now.some((c) => c.id === "acme/api#4127"),
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

test("agents: status for the selected driver, and connect", async () => {
  const { data: a } = await call<AgentStatus>("GET", "/api/agents");
  assert.equal(a.driver, "claude-code");
  assert.equal(a.mcp?.connected, true);
  assert.equal(a.skill?.state, "missing");
  const { data: c } = await call<AgentStatus>("POST", "/api/agents/connect", {});
  assert.equal(c.skill?.state, "installed");
  await call("PUT", "/api/settings", { set: { "agent.driver": "none" } });
  assert.deepEqual((await call<AgentStatus>("GET", "/api/agents")).data, { driver: "none", mcp: null, skill: null });
  await call("PUT", "/api/settings", { reset: ["agent.driver"] });
});

test("resolved items sit apart from the queue's groups and boards; items carry their recent activity", async () => {
  const { data: q } = await call<QueueView>("GET", "/api/queue");
  assert.deepEqual(
    q.resolved.map((c) => [c.id, c.why, c.resolved]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [
      ["acme/api#4093", "approved by dana", "approved by dana"],
      ["acme/web#2284", "merged", "merged"],
      ["acme/web#2292", "you approved", "you approved"],
      ["acme/worker#868", "no longer requested", "no longer requested"],
      ["acme/worker#871", "merged", "merged"],
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

test("policy and coordinator: a policy with its judge, the coordinator's log, and what it did for the top bar", async () => {
  const { data: p } = await call<PolicyDoc>("GET", "/api/policy");
  assert.ok(p.text.trim());
  assert.equal(p.judge.state, "idle");
  assert.equal((await call("PUT", "/api/policy", { text: "x", base: "stale" })).status, 409);
  const { data: saved } = await call<{ ok: boolean; hash: string }>("PUT", "/api/policy", { text: p.text, base: p.hash });
  assert.notEqual(saved.hash, p.hash);

  const { data: o } = await call<Overview>("GET", "/api/overview");
  assert.deepEqual(o.coordinator.acted?.counts, { snooze: 3 });
  assert.deepEqual(o.coordinator.acted?.buckets, ["fyi", "fyi", "fyi"]);
  const { data: v } = await call<CoordinatorView>("GET", "/api/coordinator");
  assert.equal(v.status.state, "idle");
  assert.ok(v.status.command?.includes(`--resume ${v.status.session_id}`));
  const acts = v.log.filter((e) => e.kind === "act");
  assert.equal(acts.length, 3);
  const { data: q } = await call<QueueView>("GET", "/api/queue");
  for (const a of acts)
    assert.ok(
      q.cleared.some((c) => c.id === a.item_id && c.status === "snoozed"),
      `${a.item_id} is snoozed`,
    );

  // Undoing one from the log takes it out of the top bar's count.
  await call("POST", "/api/undo", { seq: acts[0]!.undo_seq });
  const { data: undone } = await call<CoordinatorView>("GET", "/api/coordinator");
  assert.equal(undone.log.find((e) => e.seq === acts[0]!.seq)?.undone, true);
  assert.deepEqual((await call<Overview>("GET", "/api/overview")).data.coordinator.acted?.counts, { snooze: 2 });
  await call("POST", "/api/coordinator/note", { text: "from the test" });
  assert.equal((await call<CoordinatorView>("GET", "/api/coordinator")).data.log[0]?.text, "from the test");
});

test("in flight: the lane's states, needs-you cards at the top of Now, send and take back", async () => {
  const { data: lane } = await call<InflightView>("GET", "/api/inflight");
  const row = (id: string) => lane.rows.find((r) => r.card.id === id)!;
  assert.deepEqual(
    lane.rows.map((r) => [r.card.id, r.needs_you !== null, r.sitter.state]),
    [
      ["acme/api#4122", true, "done"],
      ["oss/tinyhttp#205", true, "blocked"],
      ["acme/api#4110", true, "waiting"],
      ["acme/web#2295", false, "running"],
      ["acme/api#4105", false, "idle"],
      ["acme/worker#871", false, "done"],
    ],
  );
  assert.equal(row("oss/tinyhttp#205").sitter.text, "no local clone of oss/tinyhttp");
  assert.equal(row("acme/worker#871").state, "merged");
  const { data: q } = await call<QueueView>("GET", "/api/queue");
  const now = q.sections.now.filter((c) => c.inflight).map((c) => [c.id, c.why]);
  assert.deepEqual(now.slice(0, 3), [
    ["acme/api#4122", "in flight: reply ready to send"],
    ["acme/api#4110", `babysitter asks: ${row("acme/api#4110").escalation!.question}`],
    ["oss/tinyhttp#205", "in flight: no local clone of oss/tinyhttp, so no babysitter"],
  ]);
  assert.ok(![...q.sections.today, ...q.sections.later, ...q.cleared].some((c) => c.id === "acme/web#2295"), "the babysitter has it");
  const { data: o } = await call<Overview>("GET", "/api/overview");
  assert.deepEqual(o.inflight, { total: 5, needs_you: 3 });

  const id = encodeURIComponent("acme/api#4122");
  const draft = row("acme/api#4122").drafts[0]!;
  assert.equal((await call("POST", `/api/inflight/${id}/send`, { draft_id: draft.id })).status, 200);
  assert.equal((await call("POST", `/api/inflight/${id}/send`, { draft_id: draft.id })).status, 404);
  const { data: sent } = await call<InflightView>("GET", "/api/inflight");
  assert.equal(sent.rows.find((r) => r.card.id === "acme/api#4122")?.needs_you, null);

  assert.equal((await call("POST", "/api/act", { id: "acme/api#4127", action: "inflight" })).status, 409, "not your PR");
  const { data: back } = await call<{ undo_seq: number }>("POST", "/api/act", { id: "acme/web#2295", action: "takeback" });
  const { data: q2 } = await call<QueueView>("GET", "/api/queue");
  assert.ok(
    Object.values(q2.sections)
      .flat()
      .some((c) => c.id === "acme/web#2295" && !c.inflight),
  );
  await call("POST", "/api/undo", { seq: back.undo_seq });
});
