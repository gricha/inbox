// Agents' questions for the owner (desk_inquire): a row on the main page and a notification, answered only in the desk's
// window; and a write the owner makes in the desk takes its item off the desk at once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClient } from "../src/client.ts";
import { createMcpServer } from "../src/mcp.ts";
import { createApp } from "../src/server.ts";
import type { GitHubWriter } from "../src/github/write.ts";
import type { Inquiry } from "../src/types.ts";
import { myPr, reviewAsk, setup } from "./helpers/desk.ts";
import { NOW } from "./helpers/items.ts";
import { refuseWrites } from "./helpers/writer.ts";
import { Effect } from "effect";
import { run, runSync } from "./helpers/run.ts";

const DESK = { origin: "http://localhost:47823", "sec-fetch-site": "same-origin" };
const CONTEXT =
  "The queue labels each row PR or Issue in text; GitHub shows icons instead. Text needs no legend and reads at 13px. " +
  "Icons take less room, but a draft and an open PR look alike at that size. I'd keep the text: nothing else changes.";
// A question with all it needs; a test overrides what it checks.
const full = (o: Record<string, unknown> = {}) => ({
  question: "Ship it?",
  from: "inbox session",
  context: CONTEXT,
  links: [{ label: "The row", url: "https://github.com/acme/web/pull/1#discussion_r1" }],
  ...o,
});

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
  await run(t.desk.sync());
  const req = http(t);
  const asked = await req("POST", "/api/inquiries", {
    question: "Keep the label as text,\nor icons?",
    from: "inbox session",
    context: `${CONTEXT}\n\nSecond paragraph.`,
    options: [
      { answer: "Text", next: "Nothing changes." },
      { answer: "Icons", next: "I swap the label for GitHub's icons, with a legend for drafts." },
    ],
    links: [{ label: "The label's code", url: "https://github.com/acme/api/blob/main/web/src/Row.tsx#L12" }],
    item: "api#1",
  });
  assert.equal(asked.status, 200, "any local client may ask: agents do, through MCP");
  const { inquiry } = (await asked.json()) as { inquiry: Inquiry };
  assert.deepEqual(
    [inquiry.question, inquiry.from, inquiry.context, inquiry.options, inquiry.links, inquiry.item_id, inquiry.answer],
    [
      "Keep the label as text, or icons?",
      "inbox session",
      `${CONTEXT}\n\nSecond paragraph.`,
      [
        { answer: "Text", next: "Nothing changes." },
        { answer: "Icons", next: "I swap the label for GitHub's icons, with a legend for drafts." },
      ],
      [{ label: "The label's code", url: "https://github.com/acme/api/blob/main/web/src/Row.tsx#L12" }],
      "acme/api#1",
      null,
    ],
  );
  assert.deepEqual(
    runSync(t.desk.queue()).inquiries.map((q) => q.id),
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
  assert.deepEqual(runSync(t.desk.queue()).inquiries, [], "answered, it leaves the main page");
  const read = (await (await req("GET", `/api/inquiries/${inquiry.id}`)).json()) as Inquiry;
  assert.deepEqual([read.answer?.text, read.answer?.dismissed], ["Text", false]);
});

test("a question the owner can't decide from its page alone is refused, and says what it lacks", async (c) => {
  const t = await setup([]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  const req = http(t);
  const refused = async (body: unknown) => {
    const r = await req("POST", "/api/inquiries", body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 120));
    return ((await r.json()) as { error: string }).error;
  };
  await refused({});
  await refused(full({ question: "  " }));
  await refused(full({ from: undefined }));
  await refused(full({ context: undefined }));
  assert.match(await refused(full({ context: "Text needs no legend." })), /too thin to decide from \(21 of at least 200/);
  assert.match(await refused(full({ options: ["Text", "Icons"] })), /options must be a list of \{ answer, next \}/);
  assert.match(await refused(full({ options: [{ answer: "Text" }] })), /options must be a list of \{ answer, next \}/);
  assert.match(await refused(full({ options: [{ answer: "Text", next: " " }] })), /"next" of "Text" is empty/);
  await refused(full({ options: Array.from({ length: 7 }, (_, i) => ({ answer: `${i}`, next: "x" })) }));
  assert.match(await refused(full({ links: [] })), /link what it's about/);
  assert.match(await refused(full({ links: [{ label: "x", url: "javascript:alert(1)" }] })), /a link is https, not javascript:/);
  assert.match(await refused(full({ links: [{ label: "x", url: "file:///etc/passwd" }] })), /not file:/);
  assert.match(
    await refused(full({ links: [{ label: "x", url: "http://example.com" }] })),
    /not http:/,
    "the app's window opens https only",
  );
  assert.match(await refused(full({ links: [{ label: "x", url: "claude://claude.ai/epitaxy/local_1" }] })), /not claude:/);
  assert.match(await refused(full({ links: [{ label: "x", url: "src/a.ts" }] })), /not a link/);
  // What's past a limit is often what an answer costs: refused, never cut.
  assert.match(
    await refused(full({ options: [{ answer: "Rename here", next: `${"x".repeat(380)} and it breaks two callers` }] })),
    /keep the "next" of "Rename here" under 400 characters/,
  );
  assert.match(await refused(full({ links: [{ label: "y".repeat(81), url: "https://github.com" }] })), /link's label under 80/);
  assert.match(await refused(full({ question: "q".repeat(301) })), /question under 300/);
  const ok = await req("POST", "/api/inquiries", full({ links: [], item: "acme/elsewhere#9" }));
  assert.equal(ok.status, 200, "the PR or issue alone is a link");
});

test("marks that make text read as something else are dropped from what an agent wrote", async (c) => {
  const t = await setup([]);
  c.after(t.cleanup);
  const q = runSync(
    t.desk.inquire(
      full({ question: "Open \u202Emoc.buhtig\u202C?", context: `${CONTEXT} See https://evil.example/\u202Emoc.buhtig\u202C.` }),
    ),
  );
  assert.equal(q.question, "Open moc.buhtig?");
  assert.ok(!/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/.test(q.context));
});

test("a question's page gets its item's card wherever the desk shows it, Merging too; one it doesn't hold has none", async (c) => {
  const t = await setup([myPr(3, { ci: "green" })]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  runSync(t.desk.act("web#3", "inflight"));
  const about = runSync(t.desk.inquire(full({ item: "web#3" })));
  assert.equal(runSync(t.desk.inquiryView(about.id)).card?.id, "acme/web#3");
  const away = runSync(t.desk.inquire(full({ item: "acme/elsewhere#9" })));
  assert.equal(runSync(t.desk.inquiryView(away.id)).card, null);
  assert.equal(runSync(t.desk.inquiryView(runSync(t.desk.inquire(full())).id)).card, null);
});

test("the coordinator ends its turn once it asks: your answer, or that you dismissed it, wakes it; another agent's question doesn't", async (c) => {
  const t = await setup([myPr(3)], { settings: { "agent.coordinator": true } });
  c.after(t.cleanup);
  await run(t.desk.sync());
  const told: string[] = [];
  t.desk.coordinator.tell = (line: string) => Effect.sync(() => (told.push(line), Effect.void));
  const mine = runSync(t.desk.inquire(full({ from: "Inbox coordinator", question: "Rebase #3 onto main?" })));
  runSync(t.desk.answerInquiry(mine.id, "Yes,\nthen merge"));
  assert.deepEqual(told, [`My answer to your question ${mine.id} ("Rebase #3 onto main?"): "Yes, then merge"`]);
  const again = runSync(t.desk.inquire(full({ from: "Inbox coordinator", question: "Close #3?" })));
  runSync(t.desk.answerInquiry(again.id, "", true));
  assert.equal(told[1], `I dismissed your question ${again.id} ("Close #3?"): decide yourself.`);
  runSync(t.desk.answerInquiry(runSync(t.desk.inquire(full())).id, "Text"));
  assert.equal(told.length, 2, "another session reads its own answer with desk_inquiry");
  // Its name before the rename to Inbox: a question it asked then, or one from a session that follows the old skill.
  const old = runSync(t.desk.inquire(full({ from: "Review Desk coordinator", question: "Rebase #3?" })));
  runSync(t.desk.answerInquiry(old.id, "No"));
  assert.equal(told[2], `My answer to your question ${old.id} ("Rebase #3?"): "No"`);
});

test("a dismissed question tells the agent so", async (c) => {
  const t = await setup([]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  const req = http(t);
  const q = runSync(t.desk.inquire(full()));
  assert.equal((await req("POST", `/api/inquiries/${q.id}/answer`, { dismiss: true }, DESK)).status, 200);
  assert.deepEqual(runSync(t.desk.inquiry(q.id)).answer?.dismissed, true);
  assert.deepEqual(runSync(t.desk.queue()).inquiries, []);
  assert.equal((await req("GET", "/api/inquiries/nope")).status, 404);
});

test("an answer is owed to the agent that asked until it reads it: Claude's work lists it, desk_inquiry finds it, and its first read is kept", async (c) => {
  const t = await setup([reviewAsk(1)]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  const req = http(t);
  const json = async <T>(r: Response | Promise<Response>) => (await r).json() as Promise<T>;
  const work = () => runSync(t.desk.inflight()).work.map((w) => [w.kind, w.key, w.state, w.title, w.from, w.item]);
  const q = runSync(t.desk.inquire(full({ from: "docs research", item: "api#1" })));
  assert.deepEqual(work(), [], "nothing is owed while it waits on you");
  assert.equal((await req("POST", `/api/inquiries/${q.id}/answer`, { text: "Yes" }, DESK)).status, 200);
  const rev = t.desk.rev;
  assert.equal((await json<Inquiry>(req("GET", `/api/inquiries/${q.id}`))).answer?.read_at, null, "the window's look isn't a read");
  assert.deepEqual(work(), [["answer", q.id, "queued", "Ship it?", "docs research", "acme/api#1"]]);
  const waiting = await json<Inquiry[]>(req("GET", "/api/inquiries/unread"));
  assert.deepEqual(
    waiting.map((x) => [x.id, x.from, x.question]),
    [[q.id, "docs research", "Ship it?"]],
  );
  assert.equal(runSync(t.desk.inquiry(q.id)).answer?.read_at, null, "listing what waits doesn't read it");

  t.setNow(new Date(NOW.getTime() + 2 * 60_000));
  const read = await req("POST", `/api/inquiries/${q.id}/read`);
  assert.equal(read.status, 200, "any local client: the asking session, through desk_inquiry");
  const at = new Date(NOW.getTime() + 2 * 60_000).toISOString();
  assert.equal(((await read.json()) as { inquiry: Inquiry }).inquiry.answer?.read_at, at);
  assert.ok(t.desk.rev > rev, "the window hears of it");
  assert.deepEqual(work(), [], "read: nothing is owed");
  assert.deepEqual(await json<Inquiry[]>(req("GET", "/api/inquiries/unread")), []);
  assert.equal(t.desk.jobs.get("answer", q.id)?.state, "done");
  t.setNow(new Date(NOW.getTime() + 9 * 60_000));
  assert.equal((await req("POST", `/api/inquiries/${q.id}/read`)).status, 200);
  assert.equal(runSync(t.desk.inquiry(q.id)).answer?.read_at, at, "its first read is the one kept");
  assert.equal((await req("POST", "/api/inquiries/nope/read")).status, 404);
});

test("the whole way round: an agent asks through MCP, you answer in the window, its desk_inquiry finds your answer and then picks it up", async (c) => {
  const t = await setup([]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  const app = createApp(t.desk, 47823);
  const [server, client] = InMemoryTransport.createLinkedPair();
  // The desk's own tools over its own routes, as its /mcp serves them.
  await createMcpServer(
    createClient((p, init) => app.request(`http://127.0.0.1:47823${p}`, init)),
    () => {},
  ).connect(server);
  const agent = new Client({ name: "test", version: "0" });
  await agent.connect(client);
  c.after(() => agent.close());
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    ((await agent.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text;
  const id = /^asked as inquiry (\w+)/.exec(await call("desk_inquire", full({ from: "docs research" })))![1]!;
  assert.equal(await call("desk_inquiry"), "no answers waiting to be picked up");
  assert.equal(await call("desk_inquiry", { id }), 'no answer yet to "Ship it?"');
  assert.equal((await http(t)("POST", `/api/inquiries/${id}/answer`, { text: "Yes" }, DESK)).status, 200);
  assert.ok((await call("desk_inquiry")).includes(`\n${id}  docs research asked "Ship it?"\n`), "who asked, the question, its id");
  assert.equal(runSync(t.desk.inquiry(id)).answer?.read_at, null, "finding it isn't picking it up");
  assert.equal(await call("desk_inquiry", { id }), "the user answered: Yes");
  assert.equal(runSync(t.desk.inquiry(id)).answer?.read_at, NOW.toISOString(), "its page says when");
  assert.equal(await call("desk_inquiry"), "no answers waiting to be picked up");
  assert.deepEqual(runSync(t.desk.inflight()).work, []);
});

test("a dismissal owes nothing, and neither does a question still open or an answer from before the desk kept reads", async (c) => {
  const t = await setup([]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  const dismissed = runSync(t.desk.inquire(full({ question: "Drop it?" })));
  runSync(t.desk.answerInquiry(dismissed.id, "", true));
  const open = runSync(t.desk.inquire(full({ question: "Still open?" })));
  const old = { ...open, id: "0ld0ld00", question: "Before?", answer: { text: "Yes", at: NOW.toISOString(), dismissed: false } };
  t.desk.store.set("inquiries", [...t.desk.inquiries(), old]);
  assert.deepEqual(t.desk.unreadAnswers(), []);
  assert.deepEqual(runSync(t.desk.inflight()).work, []);
  for (const id of [dismissed.id, open.id, old.id]) {
    const before = runSync(t.desk.inquiry(id)).answer;
    assert.deepEqual(runSync(t.desk.answerRead(id)).answer, before, "a read of it changes nothing");
    assert.ok(!before || !("read_at" in before), "the page says nothing about a pickup the desk never tracked");
  }
});

function writer() {
  const calls: string[] = [];
  const w: GitHubWriter = {
    ...refuseWrites(),
    ready: (pr) => Effect.sync(() => void calls.push(`ready ${pr}`)),
    close: (pr) => Effect.sync(() => void calls.push(`close ${pr}`)),
    reopen: (pr) => Effect.sync(() => void calls.push(`reopen ${pr}`)),
    draft: (pr) => Effect.sync(() => void calls.push(`draft ${pr}`)),
    comment: (pr, body) => Effect.sync(() => (calls.push(`comment ${pr} ${body}`), { url: "" })),
  };
  return { w, calls };
}

test("what the owner does in the desk takes it off the desk at once: ready for review and close are done, reopen brings it back, a draft stays", async (c) => {
  const { w } = writer();
  const t = await setup([myPr(3, { ci: "green", draft: true }), myPr(4, { ci: "green" }), myPr(5, { ci: "green" })], {
    desk: { writer: w },
  });
  c.after(t.cleanup);
  await run(t.desk.sync());
  const status = (ref: string) => runSync(t.desk.item(ref)).card.status;
  await run(t.desk.markReady("web#3"));
  assert.equal(status("web#3"), "done", "marked ready: it waits on reviewers now");
  await run(t.desk.githubAct("web#4", "close"));
  assert.equal(status("web#4"), "done");
  await run(t.desk.githubAct("web#5", "draft"));
  assert.equal(status("web#5"), "active", "a draft is still yours to finish");
  const it = t.gh.items.get("acme/web#4")!;
  t.gh.items.set(it.id, { ...it, state: "closed", updated_at: new Date(Date.parse(it.updated_at) + 60_000).toISOString() });
  await run(t.desk.sync());
  await run(t.desk.githubAct("web#4", "reopen"));
  assert.equal(status("web#4"), "active", "reopened: back on the desk");
});

test("a comment on the PR goes from the desk's window only, and takes it off the desk until someone answers", async (c) => {
  const { w, calls } = writer();
  const t = await setup([reviewAsk(1)], { desk: { writer: w } });
  c.after(t.cleanup);
  await run(t.desk.sync());
  const req = http(t);
  const post = (body: unknown, headers: Record<string, string> = DESK) =>
    req("POST", `/api/review/${encodeURIComponent("acme/api#1")}/comment`, body, headers);
  assert.equal((await post({ body: "Why the retry?" }, {})).status, 403);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ body: "  " })).status, 400);
  assert.deepEqual(calls, []);
  assert.equal((await post({ body: " Why the retry? " })).status, 200);
  assert.deepEqual(calls, ["comment PR_acme/api_1 Why the retry?"]);
  assert.equal(runSync(t.desk.item("api#1")).card.status, "done");
});

test("a question about an item the desk doesn't hold still goes; one still waiting is never aged out; the tray counts it", async (c) => {
  const t = await setup([reviewAsk(1)]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  assert.equal(runSync(t.desk.inquire(full({ item: "acme/elsewhere#9" }))).item_id, "acme/elsewhere#9");
  const first = t.desk.inquiries()[0]!;
  for (let i = 0; i < 120; i++) {
    const q = runSync(t.desk.inquire(full({ question: `Q${i}?` })));
    if (i < 110) runSync(t.desk.answerInquiry(q.id, "yes"));
  }
  const kept = t.desk.inquiries();
  assert.ok(kept.length <= 101, `${kept.length} kept`);
  assert.ok(
    kept.some((q) => q.id === first.id),
    "the first, still unanswered, is kept",
  );
  assert.equal(runSync(t.desk.queue()).inquiries.length, 11);
  assert.equal(runSync(t.desk.overview()).focus.asks, 11);
  assert.equal(runSync(t.desk.status()).now, runSync(t.desk.overview()).focus.now + 11, "the tray and dock count them as now");
});

test("a question asked before options said what follows still reads, its options with no next and no links", async (c) => {
  const t = await setup([]);
  c.after(t.cleanup);
  const old = {
    id: "q1",
    at: new Date().toISOString(),
    from: "a",
    question: "Q?",
    context: "",
    options: ["A", "B"],
    item_id: null,
    answer: null,
  };
  t.desk.store.set("inquiries", [old]);
  assert.deepEqual(runSync(t.desk.inquiry("q1")), {
    ...old,
    options: [
      { answer: "A", next: "" },
      { answer: "B", next: "" },
    ],
    links: [],
  });
});

test("reopening what a close took off the desk puts back what it was before: snoozed stays snoozed", async (c) => {
  const { w } = writer();
  const t = await setup([myPr(4, { ci: "green" })], { desk: { writer: w } });
  c.after(t.cleanup);
  await run(t.desk.sync());
  runSync(t.desk.act("web#4", "snooze", "2d"));
  await run(t.desk.githubAct("web#4", "close"));
  assert.equal(runSync(t.desk.item("web#4")).card.status, "done");
  const it = t.gh.items.get("acme/web#4")!;
  t.gh.items.set(it.id, { ...it, state: "closed", updated_at: new Date(Date.parse(it.updated_at) + 60_000).toISOString() });
  await run(t.desk.sync());
  await run(t.desk.githubAct("web#4", "reopen"));
  assert.equal(runSync(t.desk.item("web#4")).card.status, "snoozed");
});

test("Wake it under an ask it stopped without answering hands that ask over again, in your words", async (c) => {
  const t = await setup([myPr(3)], { settings: { "agent.coordinator": true } });
  c.after(t.cleanup);
  await run(t.desk.sync());
  const told: string[] = [];
  t.desk.coordinator.tell = (line: string) => Effect.sync(() => (told.push(line), Effect.void));
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
  await run(t.desk.wakeCoordinator("a1"));
  assert.equal(told.length, 1);
  assert.match(
    told[0]!,
    /^My ask a1, about my PR acme\/web#3 \(https:\/\/github\.com\/acme\/web\/pull\/3\), not handed off: "Is it safe to merge\?"/,
  );
});
