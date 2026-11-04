// Agents' questions for the owner (desk_inquire): a row on the main page and a notification, answered only in the desk's
// window; and a write the owner makes in the desk takes its item off the desk at once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.ts";
import type { GitHubWriter } from "../src/github/write.ts";
import type { Inquiry } from "../src/types.ts";
import { myPr, reviewAsk, setup } from "./helpers/desk.ts";
import { refuseWrites } from "./helpers/writer.ts";

const DESK = { origin: "http://localhost:47823", "sec-fetch-site": "same-origin" };

function http(t: Awaited<ReturnType<typeof setup>>) {
  const app = createApp(t.desk, 47823);
  return (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(`http://127.0.0.1:47823${p}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

test("an agent's question is a row on the main page and a notification until the owner answers it in the desk", async (c) => {
  const t = await setup([reviewAsk(1)], { settings: { "notify.quiet": "" } });
  c.after(t.cleanup);
  await t.desk.sync();
  const req = http(t);
  const asked = await req("POST", "/api/inquiries", {
    question: "Keep the label as text,\nor icons?",
    from: "review-desk session",
    context: "Text needs no legend.",
    options: ["Text", "Icons"],
    item: "api#1",
  });
  assert.equal(asked.status, 200, "any local client may ask: agents do, through MCP");
  const { inquiry } = (await asked.json()) as { inquiry: Inquiry };
  assert.deepEqual(
    [inquiry.question, inquiry.from, inquiry.options, inquiry.item_id, inquiry.answer],
    ["Keep the label as text, or icons?", "review-desk session", ["Text", "Icons"], "acme/api#1", null],
  );
  assert.deepEqual(
    t.desk.queue().inquiries.map((q) => q.id),
    [inquiry.id],
  );
  assert.deepEqual(t.notes, ["Keep the label as text, or icons?"]);

  const answer = (body: unknown, headers: Record<string, string> = DESK) =>
    req("POST", `/api/inquiries/${inquiry.id}/answer`, body, headers);
  assert.equal((await answer({ text: "Text" }, {})).status, 403, "an agent can't answer its own question");
  assert.equal((await answer({})).status, 400);
  assert.equal((await answer({ text: "  " })).status, 400);
  assert.equal((await answer({ text: "Text" })).status, 200);
  assert.equal((await answer({ text: "Icons" })).status, 409, "answered once");
  assert.deepEqual(t.desk.queue().inquiries, [], "answered, it leaves the main page");
  const read = (await (await req("GET", `/api/inquiries/${inquiry.id}`)).json()) as Inquiry;
  assert.deepEqual([read.answer?.text, read.answer?.dismissed], ["Text", false]);
});

test("a dismissed question tells the agent so; a malformed one is refused", async (c) => {
  const t = await setup([]);
  c.after(t.cleanup);
  await t.desk.sync();
  const req = http(t);
  assert.equal((await req("POST", "/api/inquiries", {})).status, 400);
  assert.equal((await req("POST", "/api/inquiries", { question: "  " })).status, 400);
  assert.equal((await req("POST", "/api/inquiries", { question: "Q", options: "a" })).status, 400);
  assert.equal((await req("POST", "/api/inquiries", { question: "Q", options: ["1", "2", "3", "4", "5", "6", "7"] })).status, 400);
  const q = t.desk.inquire({ question: "Ship it?" });
  assert.equal(q.from, "an agent");
  assert.equal((await req("POST", `/api/inquiries/${q.id}/answer`, { dismiss: true }, DESK)).status, 200);
  assert.deepEqual(t.desk.inquiry(q.id).answer?.dismissed, true);
  assert.deepEqual(t.desk.queue().inquiries, []);
  assert.equal((await req("GET", "/api/inquiries/nope")).status, 404);
});

function writer() {
  const calls: string[] = [];
  const w: GitHubWriter = {
    ...refuseWrites(),
    ready: (pr) => (calls.push(`ready ${pr}`), Promise.resolve()),
    close: (pr) => (calls.push(`close ${pr}`), Promise.resolve()),
    reopen: (pr) => (calls.push(`reopen ${pr}`), Promise.resolve()),
    draft: (pr) => (calls.push(`draft ${pr}`), Promise.resolve()),
    comment: (pr, body) => (calls.push(`comment ${pr} ${body}`), Promise.resolve({ url: "" })),
  };
  return { w, calls };
}

test("what the owner does in the desk takes it off the desk at once: ready for review and close are done, reopen brings it back, a draft stays", async (c) => {
  const { w } = writer();
  const t = await setup([myPr(3, { ci: "green", draft: true }), myPr(4, { ci: "green" }), myPr(5, { ci: "green" })], {
    desk: { writer: w },
  });
  c.after(t.cleanup);
  await t.desk.sync();
  const status = (ref: string) => t.desk.item(ref).card.status;
  await t.desk.markReady("web#3");
  assert.equal(status("web#3"), "done", "marked ready: it waits on reviewers now");
  await t.desk.githubAct("web#4", "close");
  assert.equal(status("web#4"), "done");
  await t.desk.githubAct("web#5", "draft");
  assert.equal(status("web#5"), "active", "a draft is still yours to finish");
  const it = t.gh.items.get("acme/web#4")!;
  t.gh.items.set(it.id, { ...it, state: "closed", updated_at: new Date(Date.parse(it.updated_at) + 60_000).toISOString() });
  await t.desk.sync();
  await t.desk.githubAct("web#4", "reopen");
  assert.equal(status("web#4"), "active", "reopened: back on the desk");
});

test("a comment on the PR goes from the desk's window only, and takes it off the desk until someone answers", async (c) => {
  const { w, calls } = writer();
  const t = await setup([reviewAsk(1)], { desk: { writer: w } });
  c.after(t.cleanup);
  await t.desk.sync();
  const req = http(t);
  const post = (body: unknown, headers: Record<string, string> = DESK) =>
    req("POST", `/api/review/${encodeURIComponent("acme/api#1")}/comment`, body, headers);
  assert.equal((await post({ body: "Why the retry?" }, {})).status, 403);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ body: "  " })).status, 400);
  assert.deepEqual(calls, []);
  assert.equal((await post({ body: " Why the retry? " })).status, 200);
  assert.deepEqual(calls, ["comment PR_acme/api_1 Why the retry?"]);
  assert.equal(t.desk.item("api#1").card.status, "done");
});

test("a question about an item the desk doesn't hold still goes; one still waiting is never aged out; the tray counts it", async (c) => {
  const t = await setup([reviewAsk(1)]);
  c.after(t.cleanup);
  await t.desk.sync();
  assert.equal(t.desk.inquire({ question: "Ship it?", item: "acme/elsewhere#9" }).item_id, "acme/elsewhere#9");
  const first = t.desk.inquiries()[0]!;
  for (let i = 0; i < 120; i++) {
    const q = t.desk.inquire({ question: `Q${i}?` });
    if (i < 110) t.desk.answerInquiry(q.id, "yes");
  }
  const kept = t.desk.inquiries();
  assert.ok(kept.length <= 101, `${kept.length} kept`);
  assert.ok(
    kept.some((q) => q.id === first.id),
    "the first, still unanswered, is kept",
  );
  assert.equal(t.desk.queue().inquiries.length, 11);
  assert.equal(t.desk.overview().focus.asks, 11);
  assert.equal(t.desk.status().now, t.desk.overview().focus.now + 11, "the tray and dock count them as now");
});

test("reopening what a close took off the desk puts back what it was before: snoozed stays snoozed", async (c) => {
  const { w } = writer();
  const t = await setup([myPr(4, { ci: "green" })], { desk: { writer: w } });
  c.after(t.cleanup);
  await t.desk.sync();
  t.desk.act("web#4", "snooze", "2d");
  await t.desk.githubAct("web#4", "close");
  assert.equal(t.desk.item("web#4").card.status, "done");
  const it = t.gh.items.get("acme/web#4")!;
  t.gh.items.set(it.id, { ...it, state: "closed", updated_at: new Date(Date.parse(it.updated_at) + 60_000).toISOString() });
  await t.desk.sync();
  await t.desk.githubAct("web#4", "reopen");
  assert.equal(t.desk.item("web#4").card.status, "snoozed");
});

test("Wake it under an ask it stopped without answering hands that ask over again, in your words", async (c) => {
  const t = await setup([myPr(3)], { settings: { "agent.coordinator": true } });
  c.after(t.cleanup);
  await t.desk.sync();
  const told: string[] = [];
  t.desk.coordinator.tell = (line: string) => (told.push(line), Promise.resolve());
  t.desk.coordinator.now = () => Promise.reject(new Error("not this one"));
  t.desk.coordinator.saved = () => ({ id: "c0ffee01" });
  const a = {
    id: "a1",
    at: new Date().toISOString(),
    text: "Is it safe to merge?",
    item_id: "acme/web#3",
    thread_id: null,
    thread_url: null,
    answer: null,
  };
  t.desk.store.set("asks", [a]);
  await t.desk.wakeCoordinator("a1");
  assert.equal(told.length, 1);
  assert.match(told[0]!, /^My ask a1, about acme\/web#3 \(https:\/\/github\.com\/acme\/web\/pull\/3\): "Is it safe to merge\?"/);
});
