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
  ItemDetail,
  Overview,
  PreviewResult,
  QueueView,
  SettingsView,
} from "../../src/types.ts";

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
  assert.ok(total >= 30, `~30 cards, got ${total}`);
  // Filtered items aren't on the board (src/rules.ts), not under "hidden".
  const { data: wr } = await call<BoardView>("GET", "/api/boards/work-review");
  assert.ok(![...Object.values(wr.sections).flat(), ...wr.hidden].some((c) => c.id === "acme/web#2279"));
  assert.equal((await call("GET", "/api/boards/nope")).status, 404);
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
