// Your tags on a review's hunks (config.toml's [[tags]]): a rule is free and checked as the review is drawn; a question is
// answered by the AI review itself, kept on it by hunk mark.
import "./helpers/no-agent.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import type { ReviewDeps } from "../src/desk.ts";
import { hunksOf, type PrText } from "../src/review.ts";
import type { AiReview, ReviewFile, ReviewView } from "../src/types.ts";
import { setup } from "./helpers/desk.ts";
import { makeItem } from "./helpers/items.ts";
import { run, runSync } from "./helpers/run.ts";

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

// The review's yeses, by hunk id: types-only on plan.py too, where its `when` doesn't pass, and a tag config.toml lacks.
const SAID: Record<string, string[]> = { h1: ["types-only", "made-up"], h2: ["types-only", "comments-only"], h3: ["comments-only"] };

const marks = (files: ReviewFile[], said: Record<string, string[]>) =>
  Object.fromEntries(hunksOf(files).flatMap((h) => (said[h.id] ? [[h.mark, said[h.id]!]] : [])));

const AI = (it: { head_oid: string }, files: ReviewFile[]): AiReview => ({
  verdict: "skim",
  risk: "low",
  summary: "Moves a type.",
  concerns: [],
  notes: [],
  tags: marks(files, SAID),
  head_oid: it.head_oid,
  model: "claude-opus-5",
  at: "2026-11-10T12:00:00.000Z",
});

async function tagged(c: TestContext) {
  let files = [TYPES, PLAN, LOCK];
  const asked: PrText[] = [];
  const review: ReviewDeps = {
    fetchPr: () => Effect.succeed({ body: "", files }),
    generate: (it, _s, _why, pr) => {
      asked.push(pr);
      return Effect.succeed(AI(it, [TYPES, PLAN, LOCK]));
    },
  };
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
    { settings: { "policy.judge": false, "review.auto_ai": false }, desk: { review } },
  );
  c.after(t.cleanup);
  await run(t.desk.sync());
  const config = (text: string) => {
    assert.deepEqual(runSync(t.desk.putConfig(text)).errors, []);
  };
  const plain = t.desk.configText;
  config(plain + TAGS);
  const push = (next: ReviewFile[]) => {
    files = next;
    t.desk.store.set(`pr:${ID}`, null);
  };
  return { t, asked, config, plain, push, view: (): Promise<ReviewView> => run(t.desk.reviewView(ID)) };
}

// Each hunk's tags, by its file and id.
const tagsOf = (v: ReviewView) =>
  Object.fromEntries(
    [...v.order.chunks, ...v.order.unread, ...v.order.skipped, ...v.order.rest.flatMap((r) => r.hunks)].map((h) => [
      `${h.path} ${h.id}`,
      (h.tags ?? []).map((x) => x.id),
    ]),
  );

test("the AI review is asked your tags' questions, and a question tag shows where it said yes and its when passes", async (c) => {
  const { t, asked, view } = await tagged(c);
  await run(t.desk.aiReview(ID));
  assert.deepEqual(asked[0]!.tags, [
    { id: "types-only", ask: "Does this hunk change only types?" },
    { id: "comments-only", ask: "Does this hunk change only comments?" },
  ]);
  const v = await view();
  assert.deepEqual(tagsOf(v), {
    "src/types.ts h1": ["types-only"],
    "src/plan.py h2": ["comments-only"],
    "src/plan.py h3": ["comments-only"],
    "yarn.lock h4": ["lockfile"],
  });
  const all = [...v.order.chunks, ...v.order.rest.flatMap((r) => r.hunks)];
  assert.deepEqual(all.find((h) => h.id === "h1")!.tags, [
    { id: "types-only", name: "Types only", bg: "#e6f4ea", fg: "#176847", by: "review" },
  ]);
  assert.deepEqual(all.find((h) => h.id === "h4")!.tags, [{ id: "lockfile", name: "Lockfile", by: "rule" }]);
});

test("a push keeps a review's tags on the hunks it didn't change, and config.toml's edits show on the next draw", async (c) => {
  const { t, view, push, config, plain } = await tagged(c);
  await run(t.desk.aiReview(ID));
  push(REWRITTEN);
  assert.deepEqual(tagsOf(await view()), {
    "src/types.ts h1": ["types-only"],
    "src/plan.py h2": ["comments-only"],
    "src/plan.py h3": [],
    "yarn.lock h4": ["lockfile"],
  });
  config(plain + TAGS.replace("'*.lock'", "'*.json'").replace(/\[\[tags\]\]\nid = "comments-only"[\s\S]*$/, ""));
  assert.deepEqual(tagsOf(await view()), {
    "src/types.ts h1": ["types-only"],
    "src/plan.py h2": [],
    "src/plan.py h3": [],
    "yarn.lock h4": [],
  });
});

test("rule tags show before any AI review, and a desk with no question tags asks the review none", async (c) => {
  const { t, asked, view, config, plain } = await tagged(c);
  assert.deepEqual(tagsOf(await view())["yarn.lock h4"], ["lockfile"]);
  config(plain + TAGS.replace(/\[\[tags\]\]\nid = "types-only"[\s\S]*$/, ""));
  await run(t.desk.aiReview(ID));
  assert.deepEqual(asked[0]!.tags, []);
});
