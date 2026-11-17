// The coordinator's runs stopping, and your asks of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { denyDir, DENY } from "../src/coordinator.ts";
import { Desk } from "../src/desk.ts";
import { createApp } from "../src/server.ts";
import type { Ask, AsksView } from "../src/types.ts";
import { myPr, setup } from "./helpers/desk.ts";
import { NOW } from "./helpers/items.ts";
import { failure, failureSync, run, runSync } from "./helpers/run.ts";
import { posix, until, settle, starts, resumes, stops, ROLE, AGENT_ROLE, coordinated, OWNER, asking } from "./helpers/coordinator.ts";

test(
  "the desk stopping interrupts a run in flight: its claude is stopped, and nothing starts, is kept or notifies after",
  posix,
  async (c) => {
    const t = await coordinated(c, { "notify.quiet": "" });
    t.fake.hold(true);
    runSync(t.desk.act("web#3", "inflight"));
    await until(() => t.fake.calls().length === 1);
    const flushing = t.desk.coordinator.flushing;
    assert.ok(flushing, "the batch's run is looking");
    const logs: string[] = [];
    t.desk.log = (m) => {
      logs.push(m);
    };
    t.desk.stop();
    t.fake.hold(false); // a run that kept going would start one now
    const at = Date.now();
    await flushing;
    assert.ok(Date.now() - at < 5_000, "it ended with its claude, not after its minute");
    await settle(300);
    assert.equal(t.desk.coordinator.flushing, null);
    assert.deepEqual(t.fake.calls(), [["agents", "--json", "--all"]], "it went no further");
    assert.deepEqual([t.fake.sessions(), t.notes, logs], [[], [], []], "and wrote nothing to the closed store");
    const next = new Desk({ home: t.home, github: t.gh, now: () => NOW, notify: () => {}, log: () => {} });
    assert.deepEqual(
      [next.coordinator.error(), next.coordinator.news()],
      [null, [["acme/web#3", "handed off"]]],
      "what it was given stays",
    );
    next.stop();
  },
);

test(
  "an ask and Wake it waiting on your agent's run when the desk stops end as interrupted: 499, nothing logged or written after",
  posix,
  async (c) => {
    const t = await coordinated(c, { "notify.quiet": "" });
    t.fake.hold(true);
    const app = createApp(t.desk, 49401);
    const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
      app.request(`http://127.0.0.1:49401${p}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const asked = post("/api/ask", { text: "rebase it" }, OWNER);
    await until(() => t.fake.calls().length === 1);
    const woke = post("/api/coordinator/wake", {});
    await until(() => t.fake.calls().length === 2); // the coordinator's look for Wake it, apart from your agent's
    const logs: string[] = [];
    t.desk.log = (m) => {
      logs.push(m);
    };
    await settle(50);
    t.desk.stop();
    t.fake.hold(false);
    const [a, w] = await Promise.all([asked, woke]);
    assert.deepEqual([a.status, w.status], [499, 499], 'they were 500s: the closed store\'s "database is not open"');
    await settle(300);
    assert.deepEqual(logs, []);
    // One look each: your agent for the ask, the coordinator for Wake it.
    assert.deepEqual(
      [t.fake.calls(), t.fake.sessions(), t.notes],
      [
        [
          ["agents", "--json", "--all"],
          ["agents", "--json", "--all"],
        ],
        [],
        [],
      ],
      "it went no further",
    );
    const next = new Desk({ home: t.home, github: t.gh, now: () => NOW, notify: () => {}, log: () => {} });
    assert.deepEqual(
      [next.asks().map((x) => x.text), next.yourAgent.asks().length],
      [["rebase it"], 1],
      "the ask stays for the next desk's run, as before the stop",
    );
    next.stop();
  },
);

test(
  "what cmd.exe can't pass to your agent is refused before anything is kept: an ask and Wake it answer 400, your answer to its question logs it",
  posix,
  async (c) => {
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
    await run(t.desk.sync());
    const app = createApp(t.desk, 49401);
    const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
      app.request(`http://127.0.0.1:49401${p}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const ask = {
      id: "a1",
      at: NOW.toISOString(),
      text: "rebase & merge it",
      item_id: null,
      thread_id: null,
      thread_url: null,
      lines: null,
      answer: null,
    };
    t.desk.store.set("asks", [ask]);
    const question = runSync(
      t.desk.inquire({ question: "Rebase #3?", from: "Inbox coordinator", context: "x ".repeat(120), item: "web#3" }),
    );
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" }); // claude.cmd, which only cmd.exe starts
    try {
      const told = failureSync(t.desk.coordinator.tell("a & b"));
      assert.equal(told._tag, "UnsafeArgument");
      assert.match(told.message, /^can't start .+ through cmd\.exe: % ! \^ & \| < > aren't allowed$/);
      assert.deepEqual(t.desk.coordinator.asks(), [], "nothing kept");
      const asked = await post("/api/ask", { text: "rebase & merge it" }, OWNER);
      assert.deepEqual([asked.status, ((await asked.json()) as { tag: string }).tag], [400, "BadRequest"]);
      assert.deepEqual(t.desk.asks(), [ask], "the ask isn't kept");
      const woke = await post("/api/coordinator/wake", { ask: "a1" });
      const body = (await woke.json()) as { error: string; tag: string };
      assert.deepEqual([woke.status, body.tag, body.error], [400, "BadRequest", told.message], "as an ask is: it was a 500");
      assert.equal((await failure(t.desk.wakeCoordinator("a1"))).message, told.message);
      runSync(t.desk.answerInquiry(question.id, "yes & then merge"));
      assert.ok(logs.includes(`coordinator: couldn't pass on your answer to ${question.id}: ${told.message}`), logs.join("\n"));
      assert.ok(runSync(t.desk.inquiry(question.id)).answer, "your answer is kept");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    assert.deepEqual(t.desk.coordinator.asks(), []);
  },
);

test("your answer to your agent's own question is picked up when the wake hands it over, not while it's busy", posix, async (c) => {
  const t = await coordinated(c);
  runSync(t.desk.act("web#3", "inflight"));
  await until(() => t.said().length === 1);
  await settle();
  t.fake.busy(true);
  const q = runSync(
    t.desk.inquire({ question: "Rebase #3 onto main?", from: "Inbox coordinator", context: "x ".repeat(120), item: "web#3" }),
  );
  runSync(t.desk.answerInquiry(q.id, "Yes"));
  await settle();
  assert.equal(runSync(t.desk.inquiry(q.id)).answer?.read_at, null, "it's on something else: your answer waits");
  assert.deepEqual(
    runSync(t.desk.inflight()).work.map((w) => [w.kind, w.state, w.from]),
    [["answer", "queued", "Inbox coordinator"]],
  );
  t.fake.busy(false);
  await until(() => !!runSync(t.desk.inquiry(q.id)).answer?.read_at);
  assert.equal(t.said().at(-1), `My answer to your question ${q.id} ("Rebase #3 onto main?"): "Yes"`);
  assert.equal(t.desk.jobs.get("answer", q.id)?.state, "done");
  assert.deepEqual(runSync(t.desk.inflight()).work, []);
});

test("coordinator settings that don't parse fail its folder as their read, in the parser's words", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-deny-"));
  const file = path.join(home, "coordinator", ".claude", "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ nope");
  const e = await failure(denyDir(home, "coordinator", DENY));
  assert.deepEqual([e._tag, e.op, e.path], ["FsError", "read", file]);
  assert.match(e.message, /JSON/);
  fs.writeFileSync(file, "{}");
  assert.equal(await run(denyDir(home, "coordinator", DENY)), path.join(home, "coordinator"));
  fs.rmSync(home, { recursive: true });
});

test(
  "an ask is kept and wakes your agent at once, a session apart from the coordinator: the owner's words, the item's id and URL and the thread's, no PR text",
  posix,
  async (c) => {
    const t = await coordinated(c);
    t.desk.yourAgent.batch = 60_000; // an ask doesn't wait for it
    const api = asking(t);
    const thread = "https://github.com/acme/web/pull/3#discussion_r9";
    const res = await api.ask({
      text: "i think we addressed it in follow up,\nyou can dismiss this item",
      item_id: "web#3",
      thread_id: "PRRT_9",
      thread_url: thread,
    });
    assert.equal(res.status, 200);
    const { ask } = (await res.json()) as { ask: Ask };
    assert.deepEqual(
      { ...ask, id: "", at: "" },
      {
        id: "",
        at: "",
        text: "i think we addressed it in follow up,\nyou can dismiss this item",
        item_id: "acme/web#3",
        thread_id: "PRRT_9",
        thread_url: thread,
        lines: null,
        answer: null,
      },
    );
    assert.deepEqual(t.said(), [
      `${AGENT_ROLE} My ask ${ask.id}, about my PR acme/web#3 (https://github.com/acme/web/pull/3), not handed off, on the thread ${thread}: "i think we addressed it in follow up, you can dismiss this item" Answer it with desk_answer.`,
    ]);
    assert.ok(!t.fake.calls().flat().join(" ").includes("Ignore previous"), "never PR text");
    const listed = await api.list();
    assert.deepEqual([listed.on, listed.asks], [true, [ask]]);
    assert.deepEqual(listed.coordinator.queued, [], "handed over at once");
    await settle();

    // Running and idle, the next one resumes it right away; with no item, it's only the words.
    const next = ((await (await api.ask({ text: "and confirm marco's comment is addressed" })).json()) as { ask: Ask }).ask;
    await until(() => t.said().length === 2);
    assert.equal(t.said()[1], `My ask ${next.id}: "and confirm marco's comment is addressed" Answer it with desk_answer.`);
    assert.equal(starts(t.fake.calls()).length, 1);

    // Busy, it waits, then goes.
    await settle();
    t.desk.yourAgent.batch = 30;
    t.desk.coordinator.batch = 30;
    t.fake.busy(true);
    const later = ((await (await api.ask({ text: "snooze web#4 until monday" })).json()) as { ask: Ask }).ask;
    await settle();
    assert.equal(resumes(t.fake.calls()).length, 1, "nothing reaches it while it works");
    t.fake.busy(false);
    await until(() => t.said().length === 3);
    assert.equal(t.said()[2], `My ask ${later.id}: "snooze web#4 until monday" Answer it with desk_answer.`);

    // A hand-off goes to the coordinator, a session of its own, never in your agent's messages.
    runSync(t.desk.act("web#4", "inflight"));
    await until(() => t.fake.sessions().length === 2);
    const [agent, coordinator] = t.fake.sessions();
    assert.deepEqual([agent!.name, coordinator!.name], ["Inbox agent", "Inbox coordinator"]);
    assert.deepEqual(coordinator!.said, [`${ROLE} In Merging: acme/web#4 (https://github.com/acme/web/pull/4): handed off.`]);
    assert.equal(agent!.said.length, 3);
    await settle();
    assert.deepEqual(t.desk.coordinator.news(), []);
    assert.equal((await run(t.desk.reviewView("web#3"))).asks.length, 1, "the PR's review shows its own asks");
  },
);

test(
  "a new chat lets your agent's session go: its answered asks are kept out of sight, unanswered ones dropped, and the next ask starts a fresh session",
  posix,
  async (c) => {
    const t = await coordinated(c);
    const api = asking(t);
    const first = ((await (await api.ask({ text: "is CI green?", item_id: "web#3" })).json()) as { ask: Ask }).ask;
    await until(() => t.fake.sessions().length === 1);
    assert.equal((await api.answer(first.id, "Yes.")).status, 200);
    const second = ((await (await api.ask({ text: "and the conflict?" })).json()) as { ask: Ask }).ask;
    assert.equal((await api.fresh({}, {})).status, 403, "curl, the CLI and agents");
    const res = await api.fresh();
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as AsksView).asks, [], "the new chat is empty");
    assert.deepEqual(
      t.desk.asks().map((a) => a.id),
      [first.id],
      "the one it hadn't answered is let go",
    );
    assert.equal((await api.answer(second.id, "late")).status, 404);
    await t.desk.yourAgent.stopping;
    assert.equal(t.desk.yourAgent.saved(), null);
    assert.equal(stops(t.fake.calls()).length, 1, "the old session is stopped");
    const third = ((await (await api.ask({ text: "what's first today?" })).json()) as { ask: Ask }).ask;
    await until(() => t.fake.sessions().length === 2);
    assert.deepEqual(t.said(), [`${AGENT_ROLE} My ask ${third.id}: "what's first today?" Answer it with desk_answer.`]);
    assert.deepEqual(
      (await api.list()).asks.map((a) => a.id),
      [third.id],
    );
    const none = await api.fresh({ agent: "opencode" });
    assert.equal(none.status, 409, "an agent that isn't installed is refused");
    assert.match(((await none.json()) as { error: string }).error, /^OpenCode isn't installed\. Run /);
    assert.equal(t.desk.agent(), "claude-code");
    assert.equal((await api.fresh({ agent: "emacs" })).status, 400);
  },
);

test("an ask comes only from the desk's own window, and only while the coordinator is on", posix, async (c) => {
  const t = await coordinated(c);
  const api = asking(t);
  const body = { text: "dismiss it", item_id: "web#3" };
  assert.equal((await api.ask(body, {})).status, 403, "curl, the CLI and agents");
  assert.equal((await api.ask(body, { ...OWNER, origin: "https://evil.example" })).status, 403);
  assert.equal((await api.ask(body, { ...OWNER, "sec-fetch-site": "none" })).status, 403, "an Origin alone isn't the desk's page");
  assert.equal((await api.ask({ text: "  " }, OWNER)).status, 400);
  assert.equal((await api.ask({ text: "hi", item_id: "web#99" }, OWNER)).status, 404);
  assert.equal((await api.ask({ text: "hi", item_id: "web#3", thread_url: "https://evil.example/x" }, OWNER)).status, 400);
  runSync(t.desk.putSettings({ set: { "agent.coordinator": false } }));
  assert.equal((await api.ask(body)).status, 409);
  const listed = await api.list();
  assert.deepEqual([listed.on, listed.asks], [false, []]);
  await settle();
  assert.deepEqual(t.fake.calls(), [], "nothing started or woke it");
});

test(
  "desk_answer keeps the answer on its ask and notifies the owner once, outside quiet hours; an unknown ask is a 404",
  posix,
  async (c) => {
    const t = await coordinated(c, { "notify.quiet": "" });
    const api = asking(t);
    const { ask } = (await (await api.ask({ text: "is dana's comment addressed?", item_id: "web#3" })).json()) as { ask: Ask };
    await until(() => t.fake.sessions().length === 1);
    const rev = t.desk.rev;
    const res = await api.answer(ask.id, "Yes: 4be71c2 handles the\nempty list, with a test.");
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { ask: Ask }).ask.answer, {
      text: "Yes: 4be71c2 handles the\nempty list, with a test.",
      at: NOW.toISOString(),
    });
    assert.ok(t.desk.rev > rev, "the window hears of it");
    assert.deepEqual(t.notes, ["acme/web#3: Yes: 4be71c2 handles the empty list, with a test."]);
    assert.deepEqual((await api.list()).asks[0]!.answer?.text, "Yes: 4be71c2 handles the\nempty list, with a test.");
    assert.equal((await api.answer("nope", "hi")).status, 404);
    assert.equal((await api.answer(ask.id, " ")).status, 400);
    assert.equal((await api.answer(ask.id, "Also rebased it.")).status, 200);
    assert.equal(t.notes.length, 1, "only its first answer notifies");
    const h = NOW.getHours();
    runSync(t.desk.putSettings({ set: { "notify.quiet": `${h}:00-${h + 1}:00` } }));
    const quiet = ((await (await api.ask({ text: "anything left for me today?" })).json()) as { ask: Ask }).ask;
    assert.equal((await api.answer(quiet.id, "No.")).status, 200);
    assert.equal(t.notes.length, 1, "quiet hours");
  },
);

test(
  "an answer keeps its paragraphs, lists and code, drops what's invisible, and notifies with its first paragraph outside code; past its limit it's refused, not cut",
  posix,
  async (c) => {
    const t = await coordinated(c, { "notify.quiet": "" });
    const api = asking(t);
    const ask = async (body: unknown) => ((await (await api.ask(body)).json()) as { ask: Ask }).ask;
    const stored = async (id: string) => (await api.list()).asks.find((a) => a.id === id)?.answer ?? null;

    const first = await ask({ text: "is it done?", item_id: "web#3" });
    await until(() => t.fake.sessions().length === 1);
    const res = await api.answer(
      first.id,
      "**Yes**: done in `4be71c2`.\r\n\r\n\r\n\r\n- checked `merge.ts`\n- tests pass\u202e\u0007\u2063\u{e0049}  \n\n```ts\nnextClock(s)\n```",
    );
    assert.equal(res.status, 200);
    const kept = "**Yes**: done in `4be71c2`.\n\n- checked `merge.ts`\n- tests pass\n\n```ts\nnextClock(s)\n```";
    assert.equal(((await res.json()) as { ask: Ask }).ask.answer?.text, kept);
    assert.equal((await stored(first.id))?.text, kept);
    assert.deepEqual(t.notes, ["acme/web#3: Yes: done in 4be71c2."]);

    const second = await ask({ text: "and is it deployed?", item_id: "web#3" });
    assert.equal((await api.answer(second.id, "```\nx\n\nYes, merged and deployed.\n```\n\nNo: CI is red.")).status, 200);
    assert.equal(t.notes.at(-1), "acme/web#3: No: CI is red.", "never the code block's words");
    const fenced = await ask({ text: "is it approved?", item_id: "web#3" });
    assert.equal((await api.answer(fenced.id, "```\n```ts\nYes, approved.\n```\n\nNo: I force-pushed.")).status, 200);
    assert.equal(t.notes.at(-1), "acme/web#3: No: I force-pushed.", "a ```ts line inside a block is the block's, as the chat draws it");

    const third = await ask({ text: "what did CI say?", item_id: "web#3" });
    assert.equal((await api.answer(third.id, "x".repeat(6_001))).status, 400);
    assert.equal(await stored(third.id), null, "refused, not cut");
    assert.equal((await api.answer(third.id, " ".repeat(200_000) + "x")).status, 400, "measured before it's normalised");
    assert.equal(await stored(third.id), null);
    assert.equal((await api.answer(third.id, "x".repeat(6_000))).status, 200);

    const words = await ask({ text: "line one\u2028\n\n\n\nline two\u2066" });
    assert.equal(words.text, "line one\n\nline two");
    await until(() => !!t.said().at(-1)?.endsWith('"line one line two" Answer it with desk_answer.'));
    const said = t.said().length;
    const asks = (await api.list()).asks.length;
    assert.equal((await api.ask({ text: "y".repeat(2_001) })).status, 400);
    assert.equal((await api.list()).asks.length, asks, "refused, not kept");
    await settle();
    assert.equal(t.said().length, said, "and never sent");
  },
);

test(
  "an ask your agent stopped without answering goes to it again, once per wait and never while it works; after three it's failed, with why",
  posix,
  async (c) => {
    const t = await coordinated(c);
    const api = asking(t);
    const { ask } = (await (await api.ask({ text: "is dana's comment addressed?", item_id: "web#3" })).json()) as { ask: Ask };
    const line = `My ask ${ask.id}, about my PR acme/web#3 (https://github.com/acme/web/pull/3), not handed off: "is dana's comment addressed?" Answer it with desk_answer.`;
    await until(() => t.said().length === 1 && !t.desk.yourAgent.flushing);
    const job = () => {
      const j = t.desk.jobs.get("ask", ask.id);
      return j && { state: j.state, attempts: j.attempts, error: j.error };
    };
    assert.deepEqual(job(), { state: "running", attempts: 1, error: null }, "your agent has it");
    let at = NOW.getTime();
    // Time passes, the loop looks, and so does the desk: your agent idle, it stopped without answering; or working.
    const later = async (minutes: number, status: "idle" | "busy" = "idle") => {
      t.fake.busy(status === "busy");
      await run(t.desk.yourAgent.find());
      at += minutes * 60_000;
      t.setNow(new Date(at));
      t.desk.jobs.tick();
      await settle();
      await until(() => !t.desk.yourAgent.flushing);
    };
    await later(4);
    assert.equal(t.said().length, 1, "not before its wait");
    await later(1);
    assert.deepEqual(t.said(), [`${AGENT_ROLE} ${line}`, line], "asked again in its own words");
    assert.deepEqual(job(), { state: "running", attempts: 2, error: null });
    await later(14);
    assert.equal(t.said().length, 2, "once per wait: the next is 15 minutes after it went again");
    await later(30, "busy");
    assert.equal(t.said().length, 2, "never while it's working");
    await later(1);
    assert.deepEqual(t.said().slice(1), [line, line]);
    await later(29);
    assert.equal(t.said().length, 3);
    await later(1);
    assert.deepEqual(job(), { state: "failed", attempts: 3, error: "your agent stopped without answering it, 3 times" });
    assert.equal(t.said().length, 3, "then it's failed, and nothing goes again");
    const work = runSync(t.desk.inflight()).work.map((w) => [w.kind, w.title, w.state]);
    assert.deepEqual(work, [["ask", "is dana's comment addressed?", "failed"]], "Claude's work lists it, with why");

    assert.equal((await api.answer(ask.id, "Yes.")).status, 200);
    assert.equal(job()?.state, "done", "an answer is the job done");
    assert.deepEqual(runSync(t.desk.inflight()).work, []);
  },
);

test("an ask that can't start the coordinator says so and isn't kept", posix, async (c) => {
  const t = await coordinated(c);
  const api = asking(t);
  t.fake.fail(true);
  const res = await api.ask({ text: "is dana's comment addressed?", item_id: "web#3" });
  assert.equal(res.status, 502);
  assert.deepEqual((await api.list()).asks, []);
  assert.deepEqual(t.desk.coordinator.asks(), []);
  t.fake.fail(false);
  const { ask } = (await (await api.ask({ text: "try again" })).json()) as { ask: Ask };
  assert.deepEqual(t.said(), [`${AGENT_ROLE} My ask ${ask.id}: "try again" Answer it with desk_answer.`]);
  assert.deepEqual((await api.list()).asks, [ask]);
});
