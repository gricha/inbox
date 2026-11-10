// The Inbox's sections and order: criteria, scores, sections, and where each row says why it's there.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.ts";
import type { Card, InboxSection, Item } from "../src/types.ts";
import { fallbackScore, sectionOf } from "../src/urgency.ts";
import { fakeDecisions } from "./helpers/decisions.ts";
import { idle, myPr, reviewAsk, setup, teamPing } from "./helpers/desk.ts";
import { hoursAgo, makeItem } from "./helpers/items.ts";
import { run, runSync } from "./helpers/run.ts";

const posix = { skip: process.platform === "win32" };
const QUIET = { "policy.judge": false, "review.auto_ai": false, "notify.quiet": "" };
const SVC = { name: "Service accounts", ask: "Is it about service accounts?", when: "!me.author", urgent: true };

// A fake claude: answers a criteria question with ask.json, a score with score.json; each call's kind goes in calls.
function fakeClaude(c: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-fake-urgency-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(
    bin,
    `#!/bin/sh
d="$(dirname "$0")"
cat > "$d/stdin"
if grep -q "yes-or-no questions" "$d/stdin"; then k=ask; else k=score; fi
echo $k >> "$d/calls"; cp "$d/stdin" "$d/stdin.$k"
printf '{"type":"result","is_error":false,"structured_output":%s}' "$(cat "$d/$k.json")"
`,
  );
  fs.chmodSync(bin, 0o755);
  const was = process.env.DESK_CLAUDE;
  process.env.DESK_CLAUDE = bin;
  c.after(() => {
    process.env.DESK_CLAUDE = was;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const say = (k: "ask" | "score", items: unknown[]) => {
    fs.writeFileSync(path.join(dir, `${k}.json`), JSON.stringify({ items }));
  };
  say("ask", []);
  say("score", []);
  const calls = () => (fs.existsSync(path.join(dir, "calls")) ? fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n") : []);
  const stdin = (k: "ask" | "score") => fs.readFileSync(path.join(dir, `stdin.${k}`), "utf8");
  return { say, calls, stdin };
}

async function settled(t: Awaited<ReturnType<typeof setup>>) {
  await idle(t.desk);
  for (let i = 0; i < 500 && (t.desk.urgency.running || (!t.desk.urgency.held && t.desk.urgency.next())); i++)
    await new Promise((r) => {
      setTimeout(r, 10);
    });
}

const inbox = (t: Awaited<ReturnType<typeof setup>>) => runSync(t.desk.queue()).inbox;
const where = (t: Awaited<ReturnType<typeof setup>>, id: string): [InboxSection, Card] | null => {
  const v = inbox(t);
  for (const k of ["urgent", "standard", "fyi"] as const) {
    const c = v[k].find((x) => x.id === id);
    if (c) return [k, c];
  }
  return null;
};
const svcPr = (n: number, o: Partial<Item> = {}): Item => ({ ...teamPing(n), title: "Service accounts reach the control silo", ...o });

test("sections: an urgent yes and a hand-back lift it whatever its score; fyi holds; a direct ask or a pin never goes below Standard", () => {
  const t = { urgent_at: 8, fyi_at: 3 };
  const at = (o: Partial<Parameters<typeof sectionOf>[0]>) =>
    sectionOf({ score: 5, urgent: false, bucket: "today", floor: false, ...o }, t);
  assert.equal(at({}), "standard");
  assert.equal(at({ score: 8 }), "urgent", "the Urgent threshold is inclusive");
  assert.equal(at({ score: 3 }), "fyi", "the FYI threshold is inclusive");
  assert.equal(at({ score: 0, urgent: true, bucket: "fyi" }), "urgent", "an urgent yes beats the score and a sort to fyi");
  assert.equal(at({ score: 0, urgent: true, bucket: "hide" }), "urgent");
  assert.equal(at({ score: 9, bucket: "fyi" }), "fyi", "what the rules sorted to fyi stays there, but for an urgent yes");
  assert.equal(at({ score: 1, floor: true }), "standard", "asked by name or pinned: never below Standard");
  assert.equal(at({ score: 9, bucket: "fyi", floor: true }), "urgent");
  assert.equal(sectionOf({ score: 6, urgent: false, bucket: "today", floor: false }, { urgent_at: 6, fyi_at: 3 }), "urgent");
  // With no model: where the rules put it, and a point a yes.
  assert.deepEqual(
    [fallbackScore("now", 0), fallbackScore("today", 2), fallbackScore("later", 1), fallbackScore("fyi", 0), fallbackScore("now", 9)],
    [7, 8, 4, 1, 10],
  );
});

test("with no model to answer, the desk scores from the rules and the yeses: a fresh desk still sections and orders", posix, async (c) => {
  // DESK_CLAUDE points nowhere (test/helpers/no-agent.ts): the scorer's call fails, and it waits.
  const t = await setup([reviewAsk(1), teamPing(2), myPr(3, { ci: "green", review_decision: "approved", mergeable: "clean" })], {
    settings: { ...QUIET, "agent.score": true },
  });
  c.after(t.cleanup);
  await run(t.desk.sync());
  await settled(t);
  assert.match(t.desk.urgency.held?.why ?? "", /not found/, "it waits on the agent");
  const [s1, c1] = where(t, "acme/api#1")!;
  assert.deepEqual([s1, c1.score, c1.reason], ["urgent", 8, "Asked by name"], "now's 7 and a yes");
  const [s3, c3] = where(t, "acme/web#3")!;
  assert.equal(s3, "standard");
  assert.equal(c3.reason, "Ready to merge");
  assert.ok((c3.score ?? 0) > fallbackScore("later", 0), "a yes counts toward it");
  // The thresholds are settings: lower Urgent's, and the ready PR is urgent too.
  runSync(t.desk.putSettings({ set: { "queue.urgent_at": c3.score! } }));
  assert.equal(where(t, "acme/web#3")![0], "urgent");
  assert.equal(t.desk.urgency.view().criteria.find((x) => x.id === "github.asked")!.yes, 1);
});

test(
  "an agent's criterion is on as it's saved; its question is asked once per item and again when the item or the question changes",
  posix,
  async (c) => {
    const fake = fakeClaude(c);
    const t = await setup([reviewAsk(1), svcPr(2)], { settings: QUIET });
    c.after(t.cleanup);
    await run(t.desk.sync());
    // Over HTTP from an agent: saved on (it only orders the Inbox), and only the owner switches it.
    const app = createApp(t.desk, 47823);
    const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
      app.request(`http://127.0.0.1:47823${p}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    fake.say("ask", [{ id: "acme/api#2", yes: ["svc"] }]);
    const saved = (await (await req("PUT", "/api/criteria/svc", SVC)).json()) as { criterion: { on: boolean; by: string } };
    assert.deepEqual([saved.criterion.on, saved.criterion.by], [true, "an agent"]);
    assert.equal((await req("PUT", "/api/criteria/svc/on", { on: false })).status, 403);
    await settled(t);
    assert.deepEqual(fake.calls(), ["ask"], "one call, both items");
    assert.match(fake.stdin("ask"), /- svc: Is it about service accounts\?/);
    assert.match(fake.stdin("ask"), /questions: svc/);
    const [section, card] = where(t, "acme/api#2")!;
    assert.deepEqual([section, card.reason], ["urgent", "Service accounts"], "an urgent yes puts it in Urgent, and says so");
    assert.notEqual(where(t, "acme/api#1")![1].reason, "Service accounts");

    // Nothing changed: nothing asked.
    await run(t.desk.sync());
    await settled(t);
    assert.deepEqual(fake.calls(), ["ask"]);
    // The item changed: it's asked again, and keeps its yes until the answer lands.
    t.gh.items.set("acme/api#2", { ...svcPr(2), title: "Service accounts reach the control silo, v2", updated_at: hoursAgo(0) });
    fake.say("ask", []);
    await run(t.desk.sync());
    await settled(t);
    assert.deepEqual(fake.calls(), ["ask", "ask"]);
    assert.doesNotMatch(fake.stdin("ask"), /acme\/api#1/, "only the item that changed");
    assert.notEqual(where(t, "acme/api#2")![0], "urgent", "left out of the answer: no");
    // The question changed: both are asked again.
    fake.say("ask", [{ id: "acme/api#2", yes: ["svc"] }]);
    runSync(t.desk.urgency.set("svc", { ...SVC, ask: "Is it about service accounts or tokens?" }, true));
    await settled(t);
    assert.deepEqual(fake.calls(), ["ask", "ask", "ask"]);
    assert.match(fake.stdin("ask"), /acme\/api#1[\s\S]*acme\/api#2/);
    assert.equal(where(t, "acme/api#2")![0], "urgent");
    // Every answer is a line of the dataset.
    const labels = fs
      .readFileSync(path.join(t.home, "labels.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.ok(labels.some((l) => l.kind === "criterion" && l.item === "acme/api#2" && l.yes === true && l.criterion === "svc"));
    // Deleted by an agent too: it's only an order.
    assert.equal((await req("DELETE", "/api/criteria/svc")).status, 200);
    assert.equal(where(t, "acme/api#2")![1].reason === "Service accounts", false);
  },
);

test("the score orders each section and says why on the row; a model's score can't push an urgent yes out of Urgent", posix, async (c) => {
  const fake = fakeClaude(c);
  const t = await setup([reviewAsk(1), reviewAsk(4), svcPr(2)], { settings: { ...QUIET, "agent.score": true } });
  c.after(t.cleanup);
  fake.say("ask", [{ id: "acme/api#2", yes: ["svc"] }]);
  fake.say("score", [
    { id: "acme/api#1", score: 5, why: "carol's small change" },
    { id: "acme/api#4", score: 7, why: "carol waits on you today" },
    { id: "acme/api#2", score: 0, why: "a team ping" },
  ]);
  runSync(t.desk.urgency.set("svc", SVC, false));
  await run(t.desk.sync());
  await settled(t);
  assert.deepEqual(fake.calls(), ["ask", "score"], "questions first: a score weighs their answers");
  assert.match(fake.stdin("score"), /criteria: Service accounts: no; Asked by name: yes/);
  const v = inbox(t);
  assert.deepEqual(
    v.standard.map((x) => [x.id, x.score, x.reason]),
    [
      ["acme/api#4", 7, "carol waits on you today"],
      ["acme/api#1", 5, "carol's small change"],
    ],
  );
  assert.deepEqual(
    v.urgent.map((x) => [x.id, x.score]),
    [["acme/api#2", 0]],
  );
  const labels = fs
    .readFileSync(path.join(t.home, "labels.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const scored = labels.find((l) => l.kind === "score" && l.item === "acme/api#4") as {
    input: { placed: { bucket: string } };
    score: number;
  };
  assert.deepEqual([scored.score, scored.input.placed.bucket], [7, "now"]);
  // Scored once: nothing changed, nothing asked.
  await run(t.desk.sync());
  await settled(t);
  assert.deepEqual(fake.calls(), ["ask", "score"]);
});

test("with the decision model down, its questions wait and the Inbox uses what it has", posix, async (c) => {
  let down = false;
  const api = await fakeDecisions((call) =>
    down
      ? { status: 503, json: { error: { message: "overloaded" } } }
      : {
          json: {
            answers: Object.fromEntries(
              Object.keys(call.body.questions ?? {}).map((k) => [
                k,
                { type: "noul", noul: call.body.state?.item?.[1]?.includes("Service") ? 0.95 : 0.1 },
              ]),
            ),
          },
        },
  );
  c.after(api.close);
  const t = await setup([reviewAsk(1), svcPr(2)], {
    settings: { ...QUIET, "agent.decision_key": "sk-or-v1-0000" },
    desk: { decisions: api.url },
  });
  c.after(t.cleanup);
  runSync(t.desk.urgency.set("svc", SVC, true));
  await run(t.desk.sync());
  await settled(t);
  assert.equal(api.calls.length, 2, "one request an item");
  assert.equal(api.calls[0]!.body.questions?.svc?.instructions, SVC.ask);
  assert.equal(where(t, "acme/api#2")![0], "urgent");

  down = true;
  t.gh.items.set("acme/api#2", { ...svcPr(2), updated_at: hoursAgo(0), head_oid: "pushed" });
  await run(t.desk.sync());
  await settled(t);
  assert.match(t.desk.urgency.held?.why ?? "", /overloaded/);
  const view = t.desk.urgency.view();
  assert.equal(view.criteria.find((x) => x.id === "svc")!.waiting, 1);
  assert.match(view.held?.why ?? "", /overloaded/);
  assert.equal(where(t, "acme/api#2")![0], "urgent", "its earlier yes holds while the question waits");
  // Another key or model asks again at once.
  down = false;
  const before = api.calls.length;
  runSync(t.desk.putSettings({ set: { "agent.decision_key": "sk-or-v1-1111" } }));
  await settled(t);
  assert.equal(t.desk.urgency.held, null);
  assert.equal(api.calls.length, before + 1);
});

test(
  "your PR others wait on is urgent, even when Claude sorted it later; what an automation pinned says so on its row",
  posix,
  async (c) => {
    // Built in: your approved, green PR that others need merged first. Asked by name, its reviewers have been silent two workdays.
    const base = myPr(10, { ci: "green", review_decision: "approved", mergeable: "clean", head_ref: "base-branch" });
    const above = myPr(11, { base: "base-branch", ci: "pending" });
    const asked = [{ at: hoursAgo(120), actor: "me", actor_bot: false, reviewer: "dana", reviewer_type: "user" as const }];
    const silent = myPr(3, { ci: "green", created_at: hoursAgo(130), request_events: asked });
    const t = await setup([base, above, silent], { settings: QUIET, builtIns: true });
    c.after(t.cleanup);
    t.desk.start();
    await idle(t.desk);
    t.desk.automations.tick();
    for (let i = 0; i < 50 && t.desk.automations.running.size; i++)
      await Promise.all([...t.desk.automations.running.values()].map((r) => r.p));
    const [s10, c10] = where(t, "acme/web#10")!;
    assert.deepEqual([s10, c10.reason], ["urgent", "Your PR others wait on"]);
    // The row of what Follow up on silent reviewers pinned says it, whatever else it is.
    assert.equal(where(t, "acme/web#3")![1].reason, "Follow up on silent reviewers: the reviewers you named are silent two workdays");
  },
);

test("Blocked keeps its own page; the Inbox's sections are what's in now, today, later and fyi", posix, async (c) => {
  const t = await setup([reviewAsk(1), teamPing(2), makeItem({ number: 5, author: "carol" })], { settings: QUIET });
  c.after(t.cleanup);
  await run(t.desk.sync());
  const q = runSync(t.desk.queue());
  const onInbox = [...q.inbox.urgent, ...q.inbox.standard, ...q.inbox.fyi].map((x) => x.id).sort();
  const placed = [...q.sections.now, ...q.sections.today, ...q.sections.later, ...q.sections.fyi].map((x) => x.id).sort();
  assert.deepEqual(onInbox, placed);
  for (const x of [...q.inbox.urgent, ...q.inbox.standard, ...q.inbox.fyi]) assert.ok(x.reason, `${x.id} says why it's there`);
});
