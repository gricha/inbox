// The coordinator in bypass mode, and its run's errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { createApp } from "../src/server.ts";
import { myPr, setup } from "./helpers/desk.ts";
import { failure, run, runSync } from "./helpers/run.ts";
import { posix, until, settle, starts, resumes, stops, ROLE, coordinated, NAME, ids, copying } from "./helpers/coordinator.ts";

test("bypass on: it starts in bypass mode, and wakes resume it with no flags, so it keeps that mode", posix, async (c) => {
  const t = await coordinated(c, { "agent.coordinator_bypass": true });
  runSync(t.desk.act("web#3", "inflight"));
  await until(() => t.said().length === 1 && runSync(t.desk.inflight()).coordinator.url !== null);
  assert.deepEqual(starts(t.fake.calls()), [
    [
      "--bg",
      "--name",
      NAME,
      "--remote-control",
      NAME,
      "--permission-mode",
      "bypassPermissions",
      `${ROLE} In Merging: acme/web#3 (https://github.com/acme/web/pull/3): handed off.`,
    ],
  ]);
  assert.equal(t.desk.coordinator.saved()?.mode, "bypass");
  t.event(3, "commented");
  await until(() => t.said().length === 2);
  assert.deepEqual(resumes(t.fake.calls()), [
    ["--resume", "c0ffee01-1111-2222", "--bg", "In Merging: acme/web#3 (https://github.com/acme/web/pull/3): new comment."],
  ]);
  assert.deepEqual(ids(t), [["c0ffee01", "bypassPermissions", true]]);
});

test(
  "toggling bypass makes one copy in the new mode with its history, right away, and wakes resume the copy flag-free",
  posix,
  async (c) => {
    const t = await coordinated(c);
    runSync(t.desk.act("web#3", "inflight"));
    await until(() => t.said().length === 1 && runSync(t.desk.inflight()).coordinator.url !== null);
    await t.desk.coordinator.flushing;
    assert.deepEqual(
      starts(t.fake.calls())[0]!.slice(0, 6),
      [
        "--bg",
        "--name",
        NAME,
        "--remote-control",
        NAME,
        `${ROLE} In Merging: acme/web#3 (https://github.com/acme/web/pull/3): handed off.`,
      ],
      "off: no mode passed",
    );
    runSync(t.desk.putSettings({ set: { "agent.coordinator_bypass": true } }));
    await until(() => runSync(t.desk.inflight()).coordinator.url === "https://claude.ai/code/session_01Fakec0ffee02");
    assert.deepEqual(stops(t.fake.calls()), [["stop", "c0ffee01"]]);
    assert.deepEqual(resumes(t.fake.calls()), [[...copying("c0ffee01"), "bypassPermissions"]]);
    assert.deepEqual(ids(t), [
      ["c0ffee01", "default", false],
      ["c0ffee02", "bypassPermissions", true],
    ]);
    assert.deepEqual(t.desk.coordinator.saved(), { id: "c0ffee02", mode: "bypass", url: "https://claude.ai/code/session_01Fakec0ffee02" });
    assert.equal(t.said().length, 1, "its history, and no turn");
    t.event(3, "commented");
    await until(() => t.said().length === 2);
    assert.deepEqual(resumes(t.fake.calls()).at(-1), ["--resume", "c0ffee02-1111-2222", "--bg", t.said()[1]]);

    runSync(t.desk.putSettings({ set: { "agent.coordinator_bypass": false } }));
    await until(() => t.desk.coordinator.saved()?.id === "c0ffee03");
    assert.deepEqual(resumes(t.fake.calls()).at(-1), [...copying("c0ffee02"), "default"]);
    t.event(3, "ci", { from: "pending", to: "red" });
    await until(() => t.said().length === 3);
    assert.deepEqual(resumes(t.fake.calls()).at(-1), ["--resume", "c0ffee03-1111-2222", "--bg", t.said()[2]]);
    assert.deepEqual(ids(t).at(-1), ["c0ffee03", "default", true]);
    assert.equal(t.fake.sessions().length, 3, "one copy per change");
  },
);

test(
  "bypass is the default: one started in default mode becomes a bypass copy when the desk next starts, with no turn",
  posix,
  async (c) => {
    const t = await coordinated(c);
    runSync(t.desk.act("web#3", "inflight"));
    await until(() => t.said().length === 1 && runSync(t.desk.inflight()).coordinator.url !== null);
    await t.desk.coordinator.flushing;
    t.desk.stop();
    const file = path.join(t.home, "settings.json");
    const { "agent.coordinator_bypass": _, ...rest } = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify(rest));
    const desk = await t.restart();
    await until(() => desk.coordinator.saved()?.id === "c0ffee02");
    assert.deepEqual(resumes(t.fake.calls()), [[...copying("c0ffee01"), "bypassPermissions"]]);
    assert.deepEqual(ids(t), [
      ["c0ffee01", "default", false],
      ["c0ffee02", "bypassPermissions", true],
    ]);
    assert.equal(desk.coordinator.saved()?.mode, "bypass");
    assert.equal(t.said().length, 1, "its history, and no turn");
  },
);

test("a coordinator saved before the bypass setting is default: resumed with no flags", posix, async (c) => {
  const t = await coordinated(c);
  runSync(t.desk.act("web#3", "inflight"));
  await until(() => t.said().length === 1 && runSync(t.desk.inflight()).coordinator.url !== null);
  await t.desk.coordinator.flushing;
  const { mode: _, ...old } = t.desk.coordinator.saved()!;
  t.desk.store.set("coordinator_bg", old);
  t.event(3, "commented");
  await until(() => t.said().length === 2);
  await t.desk.coordinator.flushing;
  assert.deepEqual(resumes(t.fake.calls()), [["--resume", "c0ffee01-1111-2222", "--bg", t.said()[1]]]);
  assert.deepEqual(ids(t), [["c0ffee01", "default", true]]);
  assert.equal(t.desk.coordinator.saved()?.mode, "default");
});

test("bypass turned on: a busy coordinator is left to work; one waiting on a permission prompt switches", posix, async (c) => {
  const t = await coordinated(c);
  runSync(t.desk.act("web#3", "inflight"));
  await until(() => t.said().length === 1 && runSync(t.desk.inflight()).coordinator.url !== null);
  await t.desk.coordinator.flushing;
  t.fake.busy(true);
  runSync(t.desk.putSettings({ set: { "agent.coordinator_bypass": true } }));
  await settle();
  await t.desk.coordinator.flushing;
  assert.deepEqual([...stops(t.fake.calls()), ...resumes(t.fake.calls())], []);
  t.fake.busy("waiting");
  t.desk.coordinator.flush(); // the 5-minute check
  await t.desk.coordinator.flushing;
  const nudge = "I'd like you to look at Merging now.";
  assert.deepEqual(resumes(t.fake.calls()), [[...copying("c0ffee01"), "bypassPermissions", nudge]]);
  assert.equal(t.desk.coordinator.saved()?.id, "c0ffee02");
  assert.deepEqual(t.said().slice(1), [nudge], "the copy picks its cut-off work back up");
});

test("a coordinator started before the rename to Inbox goes on as one copy under the new name, at its next wake", posix, async (c) => {
  const t = await coordinated(c);
  runSync(t.desk.act("web#3", "inflight"));
  await until(() => t.said().length === 1 && runSync(t.desk.inflight()).coordinator.url !== null);
  await t.desk.coordinator.flushing;
  t.fake.name("c0ffee01", "Review Desk coordinator");
  t.event(3, "commented");
  await until(() => t.said().length === 2);
  const news = "In Merging: acme/web#3 (https://github.com/acme/web/pull/3): new comment.";
  assert.deepEqual(resumes(t.fake.calls()), [[...copying("c0ffee01"), "default", news]]);
  assert.deepEqual(
    t.fake.sessions().map((s) => [s.id, s.name]),
    [
      ["c0ffee01", "Review Desk coordinator"],
      ["c0ffee02", NAME],
    ],
  );
  await until(() => t.desk.coordinator.saved()?.id === "c0ffee02");
  // A name of the owner's own choosing stays: only the old name is the desk's to change.
  t.fake.name("c0ffee02", "my merger");
  t.event(3, "reviewed");
  await until(() => t.said().length === 3);
  assert.deepEqual(resumes(t.fake.calls()).at(-1), [
    "--resume",
    "c0ffee02-1111-2222",
    "--bg",
    "In Merging: acme/web#3 (https://github.com/acme/web/pull/3): new review.",
  ]);
  assert.equal(t.fake.sessions().length, 2);
});

test("claude rm of the coordinator after bypass changes starts a fresh one, not a copy a change left stopped", posix, async (c) => {
  const t = await coordinated(c);
  runSync(t.desk.act("web#3", "inflight"));
  await until(() => t.said().length === 1 && runSync(t.desk.inflight()).coordinator.url !== null);
  await t.desk.coordinator.flushing;
  runSync(t.desk.putSettings({ set: { "agent.coordinator_bypass": true } }));
  await until(() => runSync(t.desk.inflight()).coordinator.url === "https://claude.ai/code/session_01Fakec0ffee02");
  await t.desk.coordinator.flushing;
  runSync(t.desk.putSettings({ set: { "agent.coordinator_bypass": false } }));
  await until(() => runSync(t.desk.inflight()).coordinator.url === "https://claude.ai/code/session_01Fakec0ffee03");
  await t.desk.coordinator.flushing;
  t.fake.owner("rm", "c0ffee03");
  t.event(3, "commented");
  await until(() => t.desk.coordinator.saved()?.id === "c0ffee04");
  assert.deepEqual(ids(t), [
    ["c0ffee01", "default", false],
    ["c0ffee02", "bypassPermissions", false],
    ["c0ffee04", "default", true],
  ]);
  assert.deepEqual(t.said(), [`${ROLE} In Merging: acme/web#3 (https://github.com/acme/web/pull/3): new comment.`]);
  assert.equal(t.desk.coordinator.saved()?.mode, "default");
});

test("a running coordinator the desk didn't see start gets the setting's mode on its next launch", posix, async (c) => {
  const t = await coordinated(c, { "agent.coordinator_bypass": true });
  runSync(t.desk.act("web#3", "inflight"));
  await until(() => t.said().length === 1 && runSync(t.desk.inflight()).coordinator.url !== null);
  await t.desk.coordinator.flushing;
  t.desk.store.set("coordinator_bg", null); // the desk stopped before claude said it backgrounded it
  runSync(t.desk.putSettings({ set: { "agent.coordinator_bypass": false } }));
  await until(() => t.desk.coordinator.saved()?.id === "c0ffee02");
  assert.deepEqual(resumes(t.fake.calls()), [[...copying("c0ffee01"), "default"]]);
  assert.deepEqual(ids(t), [
    ["c0ffee01", "bypassPermissions", false],
    ["c0ffee02", "default", true],
  ]);
});

test("a refused bypass shows in Merging and notifies once; turning it off resumes the old one as it was", posix, async (c) => {
  const t = await coordinated(c, { "notify.quiet": "" });
  runSync(t.desk.act("web#3", "inflight"));
  await until(() => t.said().length === 1 && runSync(t.desk.inflight()).coordinator.url !== null);
  await t.desk.coordinator.flushing;
  t.fake.nobypass(true);
  runSync(t.desk.putSettings({ set: { "agent.coordinator_bypass": true } }));
  await until(() => runSync(t.desk.inflight()).coordinator.error === "Bypass permissions mode is disabled");
  t.desk.coordinator.flush();
  await t.desk.coordinator.flushing;
  assert.equal(resumes(t.fake.calls()).length, 2, "it tried again");
  assert.deepEqual(t.notes, ["Bypass permissions mode is disabled"], "notified once");
  runSync(t.desk.putSettings({ set: { "agent.coordinator_bypass": false } }));
  await until(() => runSync(t.desk.inflight()).coordinator.error === null);
  assert.deepEqual(resumes(t.fake.calls()).at(-1), ["--resume", "c0ffee01-1111-2222", "--bg"]);
  assert.deepEqual(ids(t), [["c0ffee01", "default", true]]);
});

test("w says so when claude can't start it", async (c) => {
  // Known gap: cmd.exe says "The system cannot find the path specified." for a missing claude, which isn't read as not found.
  if (process.platform === "win32") c.todo("Windows: a missing claude by path isn't CommandNotFound yet");
  const logs: string[] = [];
  const t = await setup([myPr(3)], {
    settings: { "policy.judge": false, "review.auto_ai": false },
    desk: {
      log: (m) => {
        logs.push(m);
      },
    },
  });
  c.after(t.cleanup);
  const res = await createApp(t.desk, 47823).request("http://127.0.0.1:47823/api/coordinator/wake", { method: "POST" });
  assert.equal(res.status, 502);
  assert.ok(
    logs.some((l) => l.startsWith("coordinator: /nonexistent/claude not found")),
    logs.join("\n"),
  );
  const e = await failure(t.desk.wakeCoordinator());
  assert.equal(e._tag, "Upstream");
  assert.match(String((e as { cause?: Error }).cause?.message), /not found/, "what stopped its run is the cause");
  assert.equal(runSync(t.desk.inflight()).coordinator.id, null);
});

test("a claude agents --json that isn't a list is bad output in words of its own, kept as the run's error", posix, async (c) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-coord-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, "#!/bin/sh\necho null\n");
  fs.chmodSync(bin, 0o755);
  const was = process.env.DESK_CLAUDE;
  process.env.DESK_CLAUDE = bin;
  const t = await setup([myPr(3)], { settings: { "policy.judge": false, "review.auto_ai": false, "agent.coordinator": true } });
  c.after(async () => {
    await t.cleanup();
    process.env.DESK_CLAUDE = was;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const e = await failure(t.desk.coordinator.find());
  assert.deepEqual([e._tag, e.message], ["CommandBadOutput", "claude agents --json didn't print a list"]);
  assert.ok(e._tag === "CommandBadOutput" && !("cause" in e), "no cause, since nothing failed: its words are a field of their own");
  await run(t.desk.coordinator.run());
  assert.equal(t.desk.coordinator.error(), "claude agents --json didn't print a list");
});

test("a bug with no words in the coordinator's run is kept and notified in the desk's, never as an empty error", async (c) => {
  const t = await setup([myPr(3)], {
    settings: { "policy.judge": false, "review.auto_ai": false, "agent.coordinator": true, "notify.quiet": "" },
  });
  c.after(t.cleanup);
  t.desk.coordinator.find = () => Effect.die(new Error());
  await run(t.desk.coordinator.run());
  assert.equal(t.desk.coordinator.error(), "your agent's run failed");
  assert.deepEqual(t.notes, ["your agent's run failed"], "notified once");
});

test(
  "a model and an effort are passed at its start; changing one makes a copy that runs with it, and wakes stay flag-free",
  posix,
  async (c) => {
    const t = await coordinated(c, { "agent.coordinator_model": "opus", "agent.coordinator_effort": "high" });
    assert.deepEqual(t.desk.coordinator.options(), { agent: "claude-code", bypass: false, model: "opus", effort: "high" });
    runSync(t.desk.act("web#3", "inflight"));
    await until(() => t.said().length === 1 && runSync(t.desk.inflight()).coordinator.url !== null);
    await t.desk.coordinator.flushing;
    assert.deepEqual(starts(t.fake.calls())[0]!.slice(0, 9), [
      "--bg",
      "--name",
      NAME,
      "--remote-control",
      NAME,
      "--model",
      "opus",
      "--effort",
      "high",
    ]);
    assert.equal(t.desk.coordinator.saved()?.runs, "opus|high");
    t.event(3, "commented");
    await until(() => t.said().length === 2);
    assert.deepEqual(resumes(t.fake.calls()), [
      ["--resume", "c0ffee01-1111-2222", "--bg", "In Merging: acme/web#3 (https://github.com/acme/web/pull/3): new comment."],
    ]);
    runSync(t.desk.putSettings({ set: { "agent.coordinator_model": "sonnet" } }));
    await until(() => t.desk.coordinator.saved()?.runs === "sonnet|high");
    const copy = resumes(t.fake.calls()).at(-1)!;
    assert.deepEqual(copy.slice(copy.indexOf("--model")), ["--model", "sonnet", "--effort", "high"]);
  },
);

test("a model the setting's own check would refuse is never passed to the agent", posix, async (c) => {
  const t = await coordinated(c);
  t.desk.settings = { ...t.desk.settings, "agent.coordinator_model": "opus; rm -rf ~", "agent.coordinator_effort": "HIGH!" };
  assert.deepEqual(t.desk.coordinator.runs(), { model: "", effort: "" });
});
