// End to end over the HTTP API with a source that isn't email: an automation over the fake tracker MCP server
// (scripts/fake-tracker), with a declared type, a when rule, an ask rule, an icon and buttons. The fake claude reads the
// server through the --mcp-config the desk writes, as the real one would; the desk's tool-less calls answer from files.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.ts";
import { AGREE, DISAGREE, type AutomationView, type Inquiry, type QueueView } from "../src/types.ts";
import { TRACKER_TYPE } from "../scripts/fake-tracker/messages.ts";
import { setup } from "./helpers/desk.ts";
import { unixOnly } from "./helpers/platform.ts";
import { until } from "./helpers/wait.ts";

const ROOT = path.join(import.meta.dirname, "..");
const WINDOW = { "sec-fetch-site": "same-origin", origin: "http://localhost:47823", "content-type": "application/json" };

const TRACKER = {
  name: "Tracker mentions",
  schedule: "weekdays hourly",
  prompt: "Read the messages that mention me through tracker, read only. Raise a note for each that needs me.",
  mcp: ["tracker"],
  icon: "message-circle",
  type: TRACKER_TYPE,
  rules: [
    { when: "item.kind == 'announcement'", do: "drop" },
    { when: "item.kind == 'incident'", do: "urgent" },
    { ask: "Is it from a bot or an automated digest?", do: "fyi" },
  ],
  buttons: [
    { label: "Open in tracker", do: "open" },
    { label: "Draft a reply", do: "ask", prompt: "Draft a reply to this message; don't send it." },
  ],
};

// A desk whose Claude Code has the tracker server (in its own CLAUDE_CONFIG_DIR) and whose claude is the fake.
async function trackerDesk(c: TestContext) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "desk-tracker-"));
  const answers = path.join(scratch, "claude");
  fs.mkdirSync(answers);
  const config = path.join(scratch, "config");
  fs.mkdirSync(config);
  const server = {
    command: process.execPath,
    args: ["--disable-warning=ExperimentalWarning", path.join(ROOT, "scripts/fake-tracker/server.ts")],
  };
  fs.writeFileSync(path.join(config, ".claude.json"), JSON.stringify({ mcpServers: { tracker: server } }));
  const was = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    DESK_CLAUDE: process.env.DESK_CLAUDE,
    FAKE_CLAUDE_DIR: process.env.FAKE_CLAUDE_DIR,
  };
  Object.assign(process.env, {
    CLAUDE_CONFIG_DIR: config,
    DESK_CLAUDE: path.join(ROOT, "scripts/fake-tracker/claude.ts"),
    FAKE_CLAUDE_DIR: answers,
  });
  const t = await setup([], { settings: { "policy.judge": false, "notify.quiet": "" }, desk: { mcpUrl: "http://localhost:47823/mcp" } });
  c.after(async () => {
    await t.cleanup();
    for (const [k, v] of Object.entries(was)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const app = createApp(t.desk, 47823);
  const json = async (p: string, init: { method?: string; body?: string } = {}): Promise<any> => {
    const r = await app.request(`http://127.0.0.1:47823${p}`, { ...init, headers: WINDOW });
    const body: unknown = await r.json();
    assert.ok(r.ok, `${p}: ${r.status} ${JSON.stringify(body)}`);
    return body;
  };
  return {
    t,
    json,
    answer: (file: string, out: object) => {
      fs.writeFileSync(path.join(answers, file), JSON.stringify(out));
    },
    stdin: (n: number) => fs.readFileSync(path.join(answers, `stdin.${n}`), "utf8"),
    calls: () => Number(fs.readFileSync(path.join(answers, "count"), "utf8")),
    // Run now, then the automation as it is once that run has ended.
    automation: async (): Promise<AutomationView> =>
      ((await json("/api/automations")) as AutomationView[]).find((x) => x.id === "tracker")!,
    runNow: async (): Promise<AutomationView> => {
      const runs = () => t.desk.automations.runs().filter((r) => r.automation === "tracker" && r.done_at).length;
      const before = runs();
      await json("/api/automations/tracker/run", { method: "POST" });
      await until(() => runs() > before && !t.desk.automations.view().find((x) => x.id === "tracker")!.running, "the run to end");
      return ((await json("/api/automations")) as AutomationView[]).find((x) => x.id === "tracker")!;
    },
  };
}

test("an automation over a tracker's MCP server: cards with icon, body and buttons; rules drop and sort; a malformed one is held for a recommendation you agree with, disagree with or comment on", async (c) => {
  if (unixOnly(c)) return;
  const d = await trackerDesk(c);
  await d.json("/api/automations/tracker", { method: "PUT", body: JSON.stringify(TRACKER) });
  d.answer("rule.json", {
    items: [
      { key: "m4", yes: true },
      { key: "m2", yes: false },
    ],
  });
  d.answer("recommend.1.json", {
    do: "fix",
    says: "I think sam's message is an incident: do you agree?",
    why: "The tracker spelled its kind as Incident!!, which isn't one of the kinds.",
    fields: { kind: "incident", author: "sam", channel: "support", mentions: ["me"] },
  });
  d.answer("recommend.2.json", {
    do: "drop",
    says: "I think lee's message can be dropped: do you agree?",
    why: "Its due date is a number.",
  });
  d.answer("recommend.3.json", {
    do: "type",
    says: "I think author should be optional: do you agree?",
    why: "Some messages come without one.",
    type: TRACKER_TYPE.replace("author: string", "author?: string"),
  });

  const a = await d.runNow();
  const r = a.runs[0]!;
  assert.equal(r.error, null);
  assert.equal(r.summary, "Read 7 messages that mention me.");
  assert.deepEqual(
    r.items.map((x) => [x.item_id.startsWith("note:") ? "note" : x.item_id, x.outcome, x.rule ?? null]),
    [
      ["m5", "unfit", null],
      ["m6", "unfit", null],
      ["m7", "unfit", null],
      ["note", "added", null],
      ["note", "added", null],
      ["m3", "dropped", "item.kind == 'announcement'"],
      ["note", "added", null],
    ],
  );
  assert.match(r.items[0]!.error!, /at \["kind"\]/);
  assert.match(r.items[1]!.error!, /Expected array[\s\S]*at \["mentions"\][\s\S]*Expected string[\s\S]*at \["due"\]/);
  assert.match(r.items[2]!.error!, /Missing key\n {2}at \["author"\]/);

  // The run read the tracker through the config the desk wrote: only the server it names, beside the desk's.
  assert.match(d.stdin(1), /You have these MCP servers for this run: tracker\./);

  // The ask rule was asked only of what the when rules left.
  const asked = d.stdin(2);
  assert.match(asked, /Is it from a bot or an automated digest\?/);
  assert.ok(asked.includes('"key":"m2"') && asked.includes('"key":"m4"') && !asked.includes('"key":"m1"'));

  const q: QueueView = await d.json("/api/queue");
  const line = (n: { text: string; icon?: string; body?: string; url?: string; buttons?: { label: string }[] }) => [
    n.text,
    n.icon,
    !!n.body,
    n.url,
    n.buttons?.map((b) => b.label),
  ];
  const both = ["Open in tracker", "Draft a reply"];
  assert.deepEqual(q.notes.urgent.map(line), [
    [
      "dana in #infra-alerts: p99 latency on the API is over 2s, can you look?",
      "message-circle",
      true,
      "https://tracker.example/m/m1",
      both,
    ],
  ]);
  assert.deepEqual(q.notes.open.map(line), [
    ["priya in #design: Review the onboarding copy before Friday", "git-pull-request", true, "https://tracker.example/m/m2", both],
  ]);
  assert.deepEqual(q.notes.fyi.map(line), [
    ["standup-bot in #eng: Daily digest: 4 threads mention you", "message-circle", false, "https://tracker.example/m/m4", both],
  ]);
  // Each keeps its fields as its type decoded them, untrusted text the window shows as such.
  assert.deepEqual(q.notes.open[0]!.fields, {
    kind: "review_request",
    author: "priya",
    channel: "design",
    mentions: ["me"],
    due: "2026-11-27",
    points: 3,
  });

  // The held three aren't on the desk; their recommendations are questions on it.
  const recs = q.inquiries.filter((x) => x.fix);
  assert.deepEqual(
    recs.map((x) => [x.question, x.fix?.do]),
    [
      ["I think sam's message is an incident: do you agree?", "fix"],
      ["I think lee's message can be dropped: do you agree?", "drop"],
      ["I think author should be optional: do you agree?", "type"],
    ],
  );
  const [fix, drop, type] = recs as [Inquiry, Inquiry, Inquiry];
  const answer = (x: Inquiry, text: string) => d.json(`/api/inquiries/${x.id}/answer`, { method: "POST", body: JSON.stringify({ text }) });

  // Agree: the fixed note goes through the rules, an incident, so Urgent; its run's record says so.
  await answer(fix, AGREE);
  const afterFix: QueueView = await d.json("/api/queue");
  assert.deepEqual(afterFix.notes.urgent.map((n) => n.text).toSorted(), [
    "dana in #infra-alerts: p99 latency on the API is over 2s, can you look?",
    "sam in #support: Customer can't log in",
  ]);
  assert.ok(!afterFix.inquiries.some((x) => x.id === fix.id), "acting removes it");

  // Disagree: gone for good.
  await answer(drop, DISAGREE);

  // A comment: the old one leaves at once and a revised one comes back, asked with what you said.
  d.answer("recommend.4.json", {
    do: "fix",
    says: "I think it's a question from an unknown author: do you agree?",
    why: "You said to keep author required.",
    fields: { kind: "question", author: "unknown", channel: "random", mentions: ["me"] },
  });
  await answer(type, "Keep author required; say unknown when there's none");
  await until(() => d.t.desk.inquiries().some((x) => x.fix && x.id !== type.id), "a revised one");
  const revised = ((await d.json("/api/queue")) as QueueView).inquiries.filter((x) => x.fix);
  assert.deepEqual(
    revised.map((x) => x.question),
    ["I think it's a question from an unknown author: do you agree?"],
  );
  assert.match(
    d.stdin(d.calls()),
    /I said, and you should take it into account:\n<comment-\w+>\nKeep author required; say unknown when there's none/,
  );

  const record = (await d.runNow()).runs.at(-1)!;
  assert.deepEqual(
    record.items.map((x) => [x.item_id.startsWith("note:") ? "note" : x.item_id, x.outcome, x.rule ?? null]),
    [
      ["note", "added", null],
      ["m6", "dropped", "you dropped it"],
      ["m7", "unfit", null],
      ["note", "added", null],
      ["note", "added", null],
      ["m3", "dropped", "item.kind == 'announcement'"],
      ["note", "added", null],
    ],
    "the first run's record says what came of each",
  );
  // The second run read the same messages: nothing new raised, the one still held not held again, nobody asked.
  const second = (await d.automation()).runs[0]!;
  assert.deepEqual(
    second.items.map((x) => [x.item_id, x.outcome]),
    [["m7", "unfit"]],
  );
  assert.equal(((await d.json("/api/queue")) as QueueView).inquiries.filter((x) => x.fix).length, 1);
});
