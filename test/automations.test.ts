// Automations: the owner's instructions run on a schedule by their own Claude Code, read only; what a run lists lands on
// the desk with its why, and what the owner dealt with stays dealt with. Never the real claude: a fake in a temp dir.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { dueAt, nextAt, parseSchedule, type Schedule } from "../src/automations.ts";
import { Desk } from "../src/desk.ts";
import { createApp } from "../src/server.ts";
import type { Automation } from "../src/types.ts";
import { reviewAsk, setup, teamPing } from "./helpers/desk.ts";
import { makeItem, NOW } from "./helpers/items.ts";
import { run as runFx, runSync } from "./helpers/run.ts";

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++)
    await new Promise((r) => {
      setTimeout(r, 10);
    });
  assert.ok(cond(), "timed out waiting");
}

const DESK = { origin: "http://localhost:47823", "sec-fetch-site": "same-origin" };
const WARDEN = {
  name: "Warden issues",
  schedule: "weekdays 09:00",
  prompt: "Look at getsentry/warden's new issues; put the ones that need me on my desk.",
};

test("a schedule is days and local times, or hourly; anything else says how to write it", () => {
  assert.deepEqual(parseSchedule("daily 09:00"), { days: [0, 1, 2, 3, 4, 5, 6], times: [540] });
  assert.deepEqual(parseSchedule(" Weekdays 9:30 "), { days: [1, 2, 3, 4, 5], times: [570] });
  assert.deepEqual(parseSchedule("thu,mon 17:30"), { days: [1, 4], times: [1050] });
  assert.deepEqual(parseSchedule("monday 08:00"), { days: [1], times: [480] });
  assert.deepEqual(parseSchedule("weekdays 13:00,09:00,13:00"), { days: [1, 2, 3, 4, 5], times: [540, 780] });
  assert.deepEqual(
    (parseSchedule("daily Hourly") as Schedule).times,
    Array.from({ length: 24 }, (_, h) => h * 60),
  );
  for (const bad of [
    "9am",
    "daily",
    "daily 25:00",
    "daily 09:60",
    "mo 09:00",
    "funday 09:00",
    "mon,,thu 09:00",
    "daily 09:00,",
    "daily 09:00, 13:00",
    "daily half-hourly",
  ])
    assert.equal(typeof parseSchedule(bad), "string", bad);
});

test("it was last due at the latest matching time at or before now, and next at the first after", () => {
  const wed10 = new Date(2026, 10, 4, 10, 0); // a Wednesday
  const s = (x: string) => parseSchedule(x) as Schedule;
  assert.deepEqual(dueAt(s("daily 09:00"), wed10), new Date(2026, 10, 4, 9, 0));
  assert.deepEqual(dueAt(s("daily 11:00"), wed10), new Date(2026, 10, 3, 11, 0));
  assert.deepEqual(dueAt(s("mon 09:00"), wed10), new Date(2026, 10, 2, 9, 0));
  const sun = new Date(2026, 10, 8, 12, 0);
  assert.deepEqual(dueAt(s("weekdays 09:00"), sun), new Date(2026, 10, 6, 9, 0), "Friday's");
  assert.deepEqual(nextAt(s("weekdays 09:00"), sun), new Date(2026, 10, 9, 9, 0), "Monday's");
  assert.deepEqual(nextAt(s("daily 10:00"), wed10), new Date(2026, 10, 5, 10, 0), "not the one at now");
  assert.deepEqual(dueAt(s("weekdays 08:00,09:30,13:00"), wed10), new Date(2026, 10, 4, 9, 30), "the latest of the day's");
  assert.deepEqual(nextAt(s("weekdays 08:00,09:30,13:00"), wed10), new Date(2026, 10, 4, 13, 0));
  assert.deepEqual(
    nextAt(s("weekdays 08:00,09:30"), new Date(2026, 10, 6, 10, 0)),
    new Date(2026, 10, 9, 8, 0),
    "Friday's done: Monday's first",
  );
  assert.deepEqual(dueAt(s("weekdays hourly"), new Date(2026, 10, 4, 10, 59)), new Date(2026, 10, 4, 10, 0));
  assert.deepEqual(nextAt(s("weekdays hourly"), new Date(2026, 10, 4, 10, 0)), new Date(2026, 10, 4, 11, 0));
  assert.deepEqual(dueAt(s("weekdays hourly"), new Date(2026, 10, 8, 12, 0)), new Date(2026, 10, 6, 23, 0), "Sunday: Friday's last");
});

// A fake claude: records each call's args, cwd and prompt, and answers with `answer`, or a login error while `fail` exists.
function fakeClaude(c: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-fake-auto-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(
    bin,
    `#!/bin/sh
d="$(dirname "$0")"
n=$(($(cat "$d/count" 2>/dev/null || echo 0) + 1)); echo $n > "$d/count"
printf '%s\\n' "$@" > "$d/args.$n"; pwd > "$d/cwd.$n"; cat > "$d/stdin.$n"
while [ -f "$d/hold" ]; do sleep 0.02; done
if [ -f "$d/fail" ]; then echo '{"type":"result","is_error":true,"result":"Failed to authenticate. API Error: 401"}'; exit 1; fi
cat "$d/answer"
`,
  );
  fs.chmodSync(bin, 0o755);
  const was = process.env.DESK_CLAUDE;
  process.env.DESK_CLAUDE = bin;
  c.after(() => {
    process.env.DESK_CLAUDE = was;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
  return {
    answer: (summary: string, items: { ref: string; why: string }[]) => {
      fs.writeFileSync(
        path.join(dir, "answer"),
        JSON.stringify({ type: "result", is_error: false, session_id: "sess-1", structured_output: { summary, items } }),
      );
    },
    raw: (envelope: string) => {
      fs.writeFileSync(path.join(dir, "answer"), envelope);
    },
    hold: (on: boolean) => {
      if (on) fs.writeFileSync(path.join(dir, "hold"), "");
      else fs.rmSync(path.join(dir, "hold"), { force: true });
    },
    fail: () => {
      fs.writeFileSync(path.join(dir, "fail"), "");
    },
    calls: () => (fs.existsSync(path.join(dir, "count")) ? Number(read("count")) : 0),
    args: (n: number) => read(`args.${n}`).split("\n"),
    cwd: (n: number) => read(`cwd.${n}`).trim(),
    stdin: (n: number) => read(`stdin.${n}`),
  };
}

const http =
  (app: ReturnType<typeof createApp>) =>
  (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(`http://127.0.0.1:47823${p}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

test("a run puts what it lists on the desk with its why; what's on your queue, dealt with or resolved stays as it is", async (c) => {
  const fake = fakeClaude(c);
  const t = await setup([reviewAsk(1), reviewAsk(2), reviewAsk(3), teamPing(4), reviewAsk(5)], {
    settings: { "policy.judge": false, "notify.quiet": "" },
  });
  c.after(t.cleanup);
  await runFx(t.desk.sync());
  t.gh.items.set("acme/other#9", makeItem({ repo: "acme/other", number: 9, kind: "issue", author: "dave", title: "Crash on start" }));
  runSync(t.desk.act("api#2", "done"));
  await runFx(t.desk.add("api#3"));
  const five = t.gh.items.get("acme/api#5")!;
  t.gh.items.set(five.id, { ...five, state: "closed", updated_at: new Date(Date.parse(five.updated_at) + 60_000).toISOString() });
  await runFx(t.desk.sync());
  const card = (id: string) => runSync(t.desk.item(id)).card;
  assert.ok(!["now", "today"].includes(card("acme/api#4").bucket), "a team ping is sorted away");
  fake.answer("Read 12 new issues; a few need you.", [
    { ref: "https://github.com/acme/other/issues/9", why: "a crash on start since 0.9, three reports" },
    { ref: "acme/api#4", why: "the team ping is about the loader you own" },
    { ref: "acme/api#1", why: "asks you about the retry budget" },
    { ref: "acme/api#2", why: "still open" },
    { ref: "acme/api#3", why: "you pinned it" },
    { ref: "acme/api#5", why: "closed yesterday" },
    { ref: "https://github.com/acme/nope/pull/1/files", why: "gone" },
  ]);
  const a = runSync(t.desk.automations.set("warden", WARDEN, true));
  assert.equal(a.on, true, "yours is on");
  const run = await t.desk.automations.run(a, "now").p;

  assert.equal(run.error, null);
  assert.equal(run.summary, "Read 12 new issues; a few need you.");
  assert.equal(run.session, "sess-1");
  assert.deepEqual(
    run.items.map((x) => [x.item_id, x.outcome]),
    [
      ["acme/other#9", "added"],
      ["acme/api#4", "added"],
      ["acme/api#1", "kept"],
      ["acme/api#2", "left"],
      ["acme/api#3", "kept"],
      ["acme/api#5", "resolved"],
      ["acme/nope#1", "failed"],
    ],
  );
  assert.equal(card("acme/other#9").why, "Warden issues: a crash on start since 0.9, three reports");
  assert.equal(card("acme/api#4").bucket, "today", "its pin lifts it, as yours would");
  assert.equal(card("acme/api#4").why, "Warden issues: the team ping is about the loader you own");
  assert.notEqual(card("acme/api#1").why, "Warden issues: asks you about the retry budget", "on your queue by its own rule");
  assert.equal(runSync(t.desk.item("acme/api#1")).state.pinned, false);
  assert.equal(card("acme/api#2").status, "done", "done stays done");
  assert.notEqual(card("acme/api#3").why, "Warden issues: you pinned it", "your own pin keeps its why");
  assert.equal(runSync(t.desk.item("acme/api#5")).state.pinned, false, "nobody needs a closed one");
  assert.deepEqual(t.notes, ["2 on your desk, couldn't add 1"]);
  assert.deepEqual(
    t.desk.automations.view()[0]!.runs.map((r) => r.id),
    [run.id],
  );

  // Dealing with what it added ends its pin; undo brings it back.
  const { undo_seq } = runSync(t.desk.act("other#9", "done"));
  assert.equal(runSync(t.desk.item("acme/other#9")).state.pinned, false);
  runSync(t.desk.undo(undo_seq));
  assert.equal(runSync(t.desk.item("acme/other#9")).state.pinned, true);

  // Your own Claude Code with what your settings allow and read-only tools; nothing else, never asking.
  const args = fake.args(1);
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  const allowed = args[args.indexOf("--allowedTools") + 1]!.split(",");
  for (const r of ["Read", "Bash(gh issue list:*)", "Bash(gh search:*)", "mcp__review-desk__desk_list"]) assert.ok(allowed.includes(r), r);
  assert.ok(!allowed.some((r) => /merge|comment|desk_add|Write|Edit/.test(r)), allowed.join());
  assert.ok(args.includes("--json-schema") && !args.includes("bypassPermissions"));
  assert.ok(!args.includes("--strict-mcp-config") && !args.includes("--tools"), "your MCP servers, as your settings allow them");
  assert.equal(fs.realpathSync(fake.cwd(1)), fs.realpathSync(path.join(t.home, "automations")));
  const deny = (
    JSON.parse(fs.readFileSync(path.join(t.home, "automations", ".claude", "settings.json"), "utf8")) as { permissions: { deny: string[] } }
  ).permissions.deny;
  for (const r of [
    "Bash(gh pr comment:*)",
    "Bash(gh api:*)",
    "Bash(gh pr merge:*)",
    "Bash(git push:*)",
    "Write",
    "Edit",
    "mcp__review-desk__desk_add",
  ])
    assert.ok(deny.includes(r), r);
  assert.match(fake.stdin(1), /Look at getsentry\/warden's new issues/);
  assert.match(fake.stdin(1), /Read only\. Never write anywhere/);
  assert.match(fake.stdin(1), /This is its first run/);

  // The next run hears what the desk took from the last one, never a ref it couldn't.
  await t.desk.automations.run(a, "now").p;
  assert.match(fake.stdin(2), /it listed acme\/other#9, acme\/api#4, acme\/api#1, acme\/api#2, acme\/api#3, acme\/api#5\./);
  assert.doesNotMatch(fake.stdin(2), /nope/);
});

test("a run with no answer, or one deleted while it runs, adds nothing; a run it was cut off in runs again", async (c) => {
  const fake = fakeClaude(c);
  const t = await setup([], { settings: { "policy.judge": false, "notify.quiet": "" } });
  c.after(t.cleanup);
  await runFx(t.desk.sync());
  const a = runSync(t.desk.automations.set("warden", WARDEN, true));
  fake.raw('{"type":"result","is_error":false,"result":"I looked around."}');
  const empty = await t.desk.automations.run(a, "now").p;
  assert.equal(empty.error, "the run gave no answer: no summary and no list");

  t.gh.items.set("acme/other#9", makeItem({ repo: "acme/other", number: 9, kind: "issue", author: "dave" }));
  fake.answer("One.", [{ ref: "acme/other#9", why: "a crash" }]);
  fake.hold(true);
  const going = t.desk.automations.run(a, "now").p;
  await until(() => fake.calls() === 2);
  runSync(t.desk.automations.remove("warden"));
  fake.hold(false);
  await going;
  assert.equal(t.desk.snapshot().entries.has("acme/other#9"), false, "nothing added");
  assert.deepEqual(t.desk.automations.runs(), []);

  // Wednesday's 9:00 run was cut off by a restart at 9:06: the desk runs it again when it starts.
  t.setNow(new Date(2026, 10, 4, 9, 6));
  fake.answer("Nothing needs you.", []);
  t.desk.store.set("automations", [
    { ...WARDEN, schedule: "daily 09:00", id: "warden", on: true, by: "you", updated_at: new Date(2026, 10, 3).toISOString() },
  ]);
  const cut = {
    id: "r1",
    automation: "warden",
    trigger: "schedule",
    at: new Date(2026, 10, 4, 9, 0, 5).toISOString(),
    done_at: null,
    error: null,
    summary: "",
    items: [],
    session: null,
  };
  t.desk.store.set("automation_runs", [cut]);
  t.desk.automations.start();
  await until(() => t.desk.automations.running.size === 0 && fake.calls() === 3);
  const runs = t.desk.automations.view()[0]!.runs;
  assert.match(runs[1]!.error ?? "", /the desk stopped during this run/);
  assert.equal(runs[0]!.error, null, "and ran again");
});

test("a run that fails says so, under the automation and in a notification", async (c) => {
  const fake = fakeClaude(c);
  const t = await setup([], { settings: { "policy.judge": false, "notify.quiet": "" } });
  c.after(t.cleanup);
  await runFx(t.desk.sync());
  fake.fail();
  const a = runSync(t.desk.automations.set("warden", WARDEN, true));
  const run = await t.desk.automations.run(a, "now").p;
  assert.match(run.error ?? "", /claude auth login|authenticate/i);
  assert.equal(t.desk.automations.view()[0]!.runs[0]!.error, run.error);
  assert.equal(t.notes.length, 1);
});

test("what fails an item is its error and the run goes on; a bug putting one on the desk is the run's, said once", async (c) => {
  const fake = fakeClaude(c);
  const t = await setup([reviewAsk(1)], { settings: { "policy.judge": false, "notify.quiet": "" } });
  c.after(t.cleanup);
  await runFx(t.desk.sync());
  fake.answer("Two things.", [
    { ref: "what", why: "unreadable" },
    { ref: "acme/api#1", why: "asks you" },
  ]);
  const a = runSync(t.desk.automations.set("warden", WARDEN, true));
  const ok = await t.desk.automations.run(a, "now").p;
  assert.deepEqual(
    ok.items.map((x) => [x.item_id, x.outcome, x.error ?? null]),
    [
      ["what", "failed", `can't read "what"; use owner/repo#123 or a GitHub URL`],
      ["acme/api#1", "kept", null],
    ],
  );
  // Deliberate change: a bug in push was that item's error, never reported; it fails the run, reported and notified once.
  t.desk.push = () => Effect.die(new TypeError("entries.get(...) is undefined"));
  const bug = await t.desk.automations.run(a, "now").p;
  assert.equal(bug.error, "entries.get(...) is undefined");
  assert.deepEqual(bug.items, []);
  assert.equal(t.notes.at(-1), "entries.get(...) is undefined");
});

test("on its schedule it runs once per due time, not for ones before you set it, and not while it's off", async (c) => {
  const fake = fakeClaude(c);
  fake.answer("Nothing needs you.", []);
  const t = await setup([], { settings: { "policy.judge": false } });
  c.after(t.cleanup);
  await runFx(t.desk.sync());
  const now = new Date(2026, 10, 4, 10, 0); // Wednesday 10:00 local
  t.setNow(now);
  const a = (o: Partial<Automation>): Automation => ({
    id: "warden",
    name: "Warden",
    schedule: "daily 09:00",
    prompt: "look",
    on: true,
    by: "you",
    updated_at: new Date(2026, 10, 3, 12, 0).toISOString(),
    ...o,
  });
  const settle = async () => {
    for (let i = 0; i < 50 && t.desk.automations.running.size; i++)
      await Promise.all([...t.desk.automations.running.values()].map((r) => r.p));
  };
  t.desk.store.set("automations", [a({ on: false })]);
  t.desk.automations.tick();
  await settle();
  assert.equal(fake.calls(), 0, "off");
  t.desk.store.set("automations", [a({ updated_at: new Date(2026, 10, 4, 9, 30).toISOString() })]);
  t.desk.automations.tick();
  await settle();
  assert.equal(fake.calls(), 0, "today's 9:00 was before you set it");
  t.desk.store.set("automations", [a({})]);
  t.desk.automations.tick();
  await settle();
  t.desk.automations.tick();
  await settle();
  assert.equal(fake.calls(), 1, "today's 9:00, once");
  t.setNow(new Date(2026, 10, 6, 9, 5)); // the desk slept through Thursday's
  t.desk.automations.tick();
  await settle();
  assert.equal(fake.calls(), 2, "one catch-up, not one per missed day");
});

test("an agent drafts or changes one, but only you turn it on, run it before that, or delete it", async (c) => {
  const fake = fakeClaude(c);
  fake.answer("Nothing needs you.", []);
  const t = await setup([], { settings: { "policy.judge": false } });
  c.after(t.cleanup);
  await runFx(t.desk.sync());
  const req = http(createApp(t.desk, 47823));
  const body = (o: Record<string, unknown> = {}) => ({ ...WARDEN, ...o });

  const drafted = await req("PUT", "/api/automations/warden", body({ on: true }));
  assert.equal(drafted.status, 200);
  assert.deepEqual(
    ((await drafted.json()) as { automation: Automation }).automation.on,
    false,
    "an agent's draft is off, whatever it asks",
  );
  assert.equal(runSync(t.desk.automations.get("warden")).by, "an agent");
  const draft = await req("POST", "/api/automations/warden/run");
  assert.deepEqual(
    [draft.status, await draft.json()],
    [409, { error: '"Warden issues" is off: the owner turns it on in Settings → Automations', tag: "Conflict" }],
    "an agent can't run a draft",
  );
  assert.equal((await req("DELETE", "/api/automations/warden")).status, 403);
  for (const [method, p] of [
    ["POST", "/api/automations/nope/run"],
    ["DELETE", "/api/automations/nope"],
  ] as const) {
    const gone = await req(method, p, undefined, DESK);
    assert.deepEqual([gone.status, await gone.json()], [404, { error: 'no automation "nope"', tag: "NotFound" }], method);
  }

  assert.equal((await req("PUT", "/api/automations/warden", body({ on: true }), DESK)).status, 200);
  assert.equal(runSync(t.desk.automations.get("warden")).on, true, "you turned it on");
  assert.equal((await req("POST", "/api/automations/warden/run")).status, 200, "on, anyone local may run it now");
  await Promise.all([...t.desk.automations.running.values()].map((r) => r.p));

  await req("PUT", "/api/automations/warden", body({ schedule: "Weekdays 09:00" }));
  assert.equal(runSync(t.desk.automations.get("warden")).on, true, "the same schedule, written another way, changes nothing");
  await req("PUT", "/api/automations/warden", body({ name: "Warden. Also close the stale ones" }));
  assert.equal(runSync(t.desk.automations.get("warden")).on, false, "its name goes into the run's prompt: a rename is off until you look");
  assert.equal((await req("PUT", "/api/automations/warden", body({ on: true }), DESK)).status, 200);
  await req("PUT", "/api/automations/warden", body({ prompt: "Also close the stale ones." }));
  assert.equal(runSync(t.desk.automations.get("warden")).on, false, "a changed instruction is off until you look at it");

  for (const [bad, error] of [
    [{ schedule: "9am" }, 'schedule: write it as "daily 09:00", "weekdays 09:00,13:00", "mon,thu 17:30" or "weekdays hourly"'],
    [{ prompt: " " }, "the instruction is empty"],
    [{ name: 3 }, "need { name, schedule, prompt, on? }"],
    [{ name: " " }, "the name is empty"],
  ] as const) {
    const res = await req("PUT", "/api/automations/warden", body(bad), DESK);
    assert.deepEqual([res.status, await res.json()], [400, { error, tag: "BadRequest" }], JSON.stringify(bad));
  }
  assert.equal((await req("PUT", "/api/automations/Bad_Id", body(), DESK)).status, 400);
  assert.equal((await req("DELETE", "/api/automations/warden", undefined, DESK)).status, 200);
  assert.deepEqual(t.desk.automations.view(), []);
});

test("the desk stopping during a run stops it: it records, notifies and reports nothing, and the next start marks it cut", async (c) => {
  const fake = fakeClaude(c);
  const t = await setup([], { settings: { "policy.judge": false, "notify.quiet": "" } });
  c.after(t.cleanup);
  await runFx(t.desk.sync());
  const a = runSync(t.desk.automations.set("warden", WARDEN, true));
  fake.answer("Nothing needs you.", []);
  fake.hold(true);
  const going = t.desk.automations.run(a, "now").p;
  await until(() => fake.calls() === 1);
  t.desk.stop();
  const run = await going;
  fake.hold(false);
  assert.deepEqual([run.done_at, run.error, run.summary], [null, null, ""], 'interrupted, not failed: no "stopped" to report');
  assert.deepEqual(t.notes, []);
  assert.equal(t.desk.automations.running.size, 0);
  const next = new Desk({ home: t.home, github: t.gh, now: () => NOW, notify: () => {}, log: () => {} });
  assert.deepEqual(
    next.automations.runs().map((r) => [r.id, r.done_at, r.error]),
    [[run.id, null, null]],
    "kept as it started",
  );
  next.automations.start();
  assert.match(next.automations.runs()[0]!.error ?? "", /the desk stopped during this run/);
  next.stop();
});
