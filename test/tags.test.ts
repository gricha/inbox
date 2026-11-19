// Your tags on a review's hunks (config.toml's [[tags]]): a rule is free and checked as the review is drawn; a question is one
// decision request a hunk, alongside the AI review, kept by hunk mark and question so a rebase asks nothing.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type { ReviewDeps } from "../src/desk.ts";
import type { AiReview, ReviewFile, ReviewView } from "../src/types.ts";
import { fakeDecisions, type DecisionCall } from "./helpers/decisions.ts";
import { setup } from "./helpers/desk.ts";
import { makeItem } from "./helpers/items.ts";
import { run, runSync } from "./helpers/run.ts";

const posix = { skip: process.platform === "win32" };
const ID = "acme/web#4";
const file = (p: string, patch: string): ReviewFile => ({
  path: p,
  previous_path: null,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch,
});
const TYPES = file("src/types.ts", "@@ -1,3 +1,3 @@\n a\n-type A = string;\n+type A = number;\n b");
const PLAN = file("src/plan.py", "@@ -10,3 +10,3 @@ def plan():\n a\n-old()\n+new()\n b\n@@ -40,3 +40,3 @@\n c\n-x\n+y\n d");
const LOCK = file("yarn.lock", "@@ -1,2 +1,2 @@\n-a@1\n+a@2");
// The same changes on a base that added lines above them: moved, with other context.
const REBASED = [
  file("src/types.ts", "@@ -5,3 +5,3 @@\n a2\n-type A = string;\n+type A = number;\n b"),
  file("src/plan.py", "@@ -14,3 +14,3 @@ def plan():\n a\n-old()\n+new()\n b\n@@ -44,3 +44,3 @@\n c\n-x\n+y\n d"),
  LOCK,
];
// A push that rewrote plan.py's second hunk.
const REWRITTEN = [
  TYPES,
  file("src/plan.py", "@@ -10,3 +10,3 @@ def plan():\n a\n-old()\n+new()\n b\n@@ -40,3 +40,3 @@\n c\n-x\n+z\n d"),
  LOCK,
];

const TAGS = `
[[tags]]
id = "lockfile"
name = "Lockfile"
when = "any(chunk.path, '*.lock')"

[[tags]]
id = "types-only"
name = "Types only"
bg = "#e6f4ea"
fg = "#176847"
when = "any(chunk.path, '*.ts')"
ask = "Does this hunk change only types?"

[[tags]]
id = "comments-only"
name = "Comments only"
ask = "Does this hunk change only comments?"
`;

// Jev: types.ts's hunk is types only (91% sure), comments only a little less than the cutoff; everything else no.
const JEV = (call: DecisionCall) => {
  const yes = (q: string) =>
    call.body.state?.path === "src/types.ts" ? (q === "types-only" ? 0.91 : 0.79) : q === "comments-only" ? 0.2 : 0.1;
  return { json: { answers: Object.fromEntries(Object.keys(call.body.questions ?? {}).map((q) => [q, { type: "noul", noul: yes(q) }])) } };
};

const AI = (it: { head_oid: string }): AiReview => ({
  verdict: "skim",
  risk: "low",
  summary: "Moves a type.",
  concerns: [],
  notes: [],
  head_oid: it.head_oid,
  model: "claude-opus-5",
  at: "2026-11-10T12:00:00.000Z",
});

async function tagged(
  c: TestContext,
  o: { answer?: Parameters<typeof fakeDecisions>[0]; key?: boolean; generate?: ReviewDeps["generate"] } = {},
) {
  let files = [TYPES, PLAN, LOCK];
  const api = await fakeDecisions(o.answer ?? JEV);
  c.after(api.close);
  const review: ReviewDeps = { fetchPr: () => Effect.succeed({ body: "", files }), generate: o.generate ?? (() => Effect.never) };
  const t = await setup(
    [
      makeItem({
        number: 4,
        repo: "acme/web",
        title: "Secret plan",
        author: "dana",
        review_requests: [{ reviewer: "me", type: "user", codeowner: false }],
      }),
    ],
    {
      settings: { "policy.judge": false, "review.auto_ai": false, ...(o.key !== false && { "agent.decision_key": "sk-or-v1-0000" }) },
      desk: { review, decisions: api.url },
    },
  );
  c.after(t.cleanup);
  await run(t.desk.sync());
  const config = (text: string) => {
    assert.deepEqual(runSync(t.desk.putConfig(text)).errors, []);
  };
  const plain = t.desk.configText;
  config(plain + TAGS);
  // Lets a run started by a draw or a review finish.
  const settled = async () => {
    for (let i = 0; i < 500 && t.desk.tags.running.size; i++)
      await new Promise((r) => {
        setTimeout(r, 10);
      });
    await api.quiet(20);
  };
  // Draws the review (which starts asking what's missing), lets that finish, and draws it again.
  const view = async (): Promise<ReviewView> => {
    await run(t.desk.reviewView(ID));
    await settled();
    return run(t.desk.reviewView(ID));
  };
  const push = (next: ReviewFile[]) => {
    files = next;
    t.desk.store.set(`pr:${ID}`, null);
  };
  return { t, api, view, push, config, plain, settled };
}

// Each hunk's tags, by its file and id.
const tagsOf = (v: ReviewView) =>
  Object.fromEntries(
    [...v.order.chunks, ...v.order.unread, ...v.order.skipped, ...v.order.rest.flatMap((r) => r.hunks)].map((h) => [
      `${h.path} ${h.id}`,
      (h.tags ?? []).map((x) => x.id),
    ]),
  );
const asked = (calls: DecisionCall[]) =>
  calls.map((x) => `${x.body.state?.path}: ${Object.keys(x.body.questions ?? {}).join(", ")}`).toSorted();

test("a rule tags for free, a question is one request a hunk with every question its when passes, and a yes counts from 0.8", async (c) => {
  const { t, api, view } = await tagged(c);
  const v = await view();
  assert.deepEqual(asked(api.calls), [
    "src/plan.py: comments-only",
    "src/plan.py: comments-only",
    "src/types.ts: types-only, comments-only",
  ]);
  assert.deepEqual(tagsOf(v), {
    "src/types.ts h1": ["types-only"],
    "src/plan.py h2": [],
    "src/plan.py h3": [],
    "yarn.lock h4": ["lockfile"],
  });
  const types = v.order.chunks[0]!.tags![0]!;
  assert.deepEqual(types, {
    id: "types-only",
    name: "Types only",
    bg: "#e6f4ea",
    fg: "#176847",
    p: 0.91,
    by: t.desk.settings["agent.decision_model"],
  });
  assert.deepEqual(v.order.chunks.at(-1)!.tags, [{ id: "lockfile", name: "Lockfile", by: "rule" }]);
  const state = api.calls[0]!.body.state!;
  assert.deepEqual(Object.keys(state).toSorted(), ["note", "patch", "path", "status"], "only the hunk: nothing else of the PR");
  assert.ok(!JSON.stringify(api.calls).includes("Secret plan"));
  await view();
  assert.equal(api.calls.length, 3, "answered once: drawing it again asks nothing");
});

test("a rebase asks nothing, a push asks only about the hunk it rewrote, and an edited question only its own tag", async (c) => {
  const { api, view, push, config, plain } = await tagged(c);
  await view();
  push(REBASED);
  assert.deepEqual(tagsOf(await view())["src/types.ts h1"], ["types-only"]);
  assert.equal(api.calls.length, 3, "the same changed lines: nothing to ask");
  push(REWRITTEN);
  await view();
  assert.deepEqual(asked(api.calls.slice(3)), ["src/plan.py: comments-only"]);
  config(plain + TAGS.replace("Does this hunk change only types?", "Does it change only type annotations?"));
  const v = await view();
  assert.deepEqual(asked(api.calls.slice(4)), ["src/types.ts: types-only"]);
  assert.deepEqual(
    v.order.chunks[0]!.tags?.map((x) => x.id),
    ["types-only"],
  );
});

test("a rule's edit shows on the next draw with no model call, and a tag gone from config.toml is gone from the review", async (c) => {
  const { api, view, config, plain } = await tagged(c);
  await view();
  config(plain + TAGS.replace("'*.lock'", "'*.json'").replace(/\[\[tags\]\]\nid = "types-only"[\s\S]*?ask = "[^"]*"\n/, ""));
  const v = await view();
  assert.equal(api.calls.length, 3);
  assert.deepEqual(tagsOf(v), { "src/types.ts h1": [], "src/plan.py h2": [], "src/plan.py h3": [], "yarn.lock h4": [] });
});

test("tags are asked alongside the AI review, not after it", async (c) => {
  const { t, api } = await tagged(c);
  t.desk.startAi(ID); // a review that never finishes
  for (let i = 0; i < 500 && !t.desk.store.get(`tags:${ID}`); i++)
    await new Promise((r) => {
      setTimeout(r, 10);
    });
  assert.ok(t.desk.store.get(`tags:${ID}`), "answered while the review is still being written");
  assert.equal(api.calls.length, 3);
});

test("a tagging run that fails doesn't fail the AI review", async (c) => {
  const { t, api, settled } = await tagged(c, { answer: () => ({ status: 503, json: {} }), generate: (it) => Effect.succeed(AI(it)) });
  const ai = await run(t.desk.aiReview(ID));
  await settled();
  assert.equal(ai.verdict, "skim");
  assert.ok(api.calls.length > 0, "OpenRouter was down");
  assert.ok(t.desk.tags.held, "and so was the light model: nothing's answered, and drawn reviews wait to ask again");
  assert.equal(t.desk.store.get(`tags:${ID}`), null);
});

// A fake claude for the light model: answers every call with `answer`, and keeps what it was asked.
function fakeClaude(c: TestContext, answer: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-fake-tags-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(path.join(dir, "answer.json"), JSON.stringify(answer));
  fs.writeFileSync(
    bin,
    `#!/bin/sh
d="$(dirname "$0")"
cat > "$d/stdin"
printf '{"type":"result","is_error":false,"structured_output":%s}' "$(cat "$d/answer.json")"
`,
  );
  fs.chmodSync(bin, 0o755);
  const was = process.env.DESK_CLAUDE;
  process.env.DESK_CLAUDE = bin;
  c.after(() => {
    process.env.DESK_CLAUDE = was;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { stdin: () => fs.readFileSync(path.join(dir, "stdin"), "utf8") };
}

test("with no decision key, the light model answers a batch of hunks and nothing goes to OpenRouter", posix, async (c) => {
  const claude = fakeClaude(c, {
    hunks: [
      { id: "h1", yes: ["types-only"] },
      { id: "h2", yes: [] },
    ],
  });
  const { t, api, view } = await tagged(c, { key: false });
  const v = await view();
  assert.equal(api.calls.length, 0);
  assert.deepEqual(tagsOf(v), {
    "src/types.ts h1": ["types-only"],
    "src/plan.py h2": [],
    "src/plan.py h3": [],
    "yarn.lock h4": ["lockfile"],
  });
  assert.deepEqual(v.order.chunks[0]!.tags![0], {
    id: "types-only",
    name: "Types only",
    bg: "#e6f4ea",
    fg: "#176847",
    by: t.desk.light.tierName(),
  });
  const prompt = claude.stdin();
  assert.match(prompt, /\+type A = number;/);
  assert.doesNotMatch(prompt, /a@2/, "a lockfile's hunks aren't asked about");
  assert.doesNotMatch(prompt, /Secret plan/);
});
