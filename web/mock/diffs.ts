// Realistic diffs and AI reviews for the mock API, so the review view (and npm run shots) has real-looking code to show.
import type { AiReview, ReviewFile } from "../../src/types.ts";

type Canned = { files: ReviewFile[]; ai: Omit<AiReview, "head_oid" | "at" | "model"> | null };

// Blank lines below are unchanged blank lines, which a patch writes as a single space.
const file = (path: string, status: ReviewFile["status"], text: string): ReviewFile => {
  const lines = text.split("\n").map((l) => l || " ");
  return {
    path,
    previous_path: null,
    status,
    additions: lines.filter((l) => l.startsWith("+")).length,
    deletions: lines.filter((l) => l.startsWith("-")).length,
    patch: lines.join("\n"),
  };
};

const planner: ReviewFile[] = [
  file(
    "src/planner/stream.ts",
    "added",
    `@@ -0,0 +1,24 @@
+import type { Query, Row } from "./types.ts";
+import { scan } from "./scan.ts";
+
+export interface StreamOptions {
+  batchSize: number;
+  signal?: AbortSignal;
+}
+
+// Yields rows in batches as the scan produces them, instead of buffering the whole result.
+export async function* streamRows(q: Query, opts: StreamOptions): AsyncGenerator<Row[]> {
+  let batch: Row[] = [];
+  for await (const row of scan(q)) {
+    if (opts.signal?.aborted) return;
+    batch.push(row);
+    if (batch.length >= opts.batchSize) {
+      yield batch;
+      batch = [];
+    }
+  }
+  if (batch.length) yield batch;
+}
+
+export const DEFAULT_BATCH = 500;
+export const DEFAULT_BUDGET_MS = 2_000;`,
  ),
  file(
    "src/planner/plan.ts",
    "modified",
    `@@ -1,8 +1,9 @@
 import type { Query, Row } from "./types.ts";
 import { costOf } from "./cost.ts";
-import { scan } from "./scan.ts";
+import { DEFAULT_BATCH, DEFAULT_BUDGET_MS, streamRows } from "./stream.ts";

 export interface PlanResult {
   rows: Row[];
   cost: number;
+  partial: boolean;
 }
@@ -14,10 +15,14 @@ export function explain(q: Query): string {
   return \`\${q.table} via \${q.index ?? "scan"}\`;
 }

-export async function runPlan(q: Query): Promise<PlanResult> {
+export async function runPlan(q: Query, budgetMs = DEFAULT_BUDGET_MS): Promise<PlanResult> {
   const rows: Row[] = [];
-  for await (const row of scan(q)) rows.push(row);
-  return { rows, cost: costOf(q) };
+  const deadline = Date.now() + budgetMs;
+  for await (const batch of streamRows(q, { batchSize: DEFAULT_BATCH })) {
+    rows.push(...batch);
+    if (Date.now() > deadline) return { rows, cost: costOf(q), partial: true };
+  }
+  return { rows, cost: costOf(q), partial: false };
 }

 export function estimate(q: Query): number {`,
  ),
  file(
    "src/routes/query.ts",
    "modified",
    `@@ -27,11 +27,14 @@ export function queryRoute(app: App): void {
   app.post("/v2/query", async (req, res) => {
     const q = parseQuery(req.body);
     if (!q.ok) return res.status(400).json({ error: q.error });
-    const result = await runPlan(q.query);
-    res.json({ rows: result.rows, cost: result.cost });
+    const budget = req.query.budget ? Number(req.query.budget) : undefined;
+    const result = await runPlan(q.query, budget);
+    if (result.partial) res.setHeader("X-Partial-Results", "1");
+    res.json({ rows: result.rows, cost: result.cost, partial: result.partial });
   });

   app.get("/v2/query/explain", (req, res) => {
-    res.json({ plan: explain(parseQuery(req.query).query) });
+    const q = parseQuery(req.query);
+    res.json({ plan: q.ok ? explain(q.query) : null });
   });
 }`,
  ),
  file(
    "test/planner/stream.test.ts",
    "added",
    `@@ -0,0 +1,19 @@
+import { test } from "node:test";
+import assert from "node:assert/strict";
+import { streamRows } from "../../src/planner/stream.ts";
+import { fakeScan } from "../helpers/scan.ts";
+
+test("streamRows yields full batches, then the rest", async () => {
+  fakeScan(1_250);
+  const sizes: number[] = [];
+  for await (const b of streamRows({ table: "events" }, { batchSize: 500 })) sizes.push(b.length);
+  assert.deepEqual(sizes, [500, 500, 250]);
+});
+
+test("streamRows stops when aborted", async () => {
+  fakeScan(10_000);
+  const ctl = new AbortController();
+  ctl.abort();
+  for await (const _ of streamRows({ table: "events" }, { batchSize: 500, signal: ctl.signal })) assert.fail();
+});
+`,
  ),
  file(
    "docs/api/query.md",
    "modified",
    `@@ -18,6 +18,10 @@ POST /v2/query

 Returns \`{ rows, cost }\`.

+Queries that run past their time budget (2 s, or \`?budget=\` in milliseconds) return the rows found so far
+with \`partial: true\` and an \`X-Partial-Results: 1\` header. Ask again with a larger budget, or narrow the
+query, to get the rest.
+
 ## Explain

 GET /v2/query/explain`,
  ),
];

const tokenizer: ReviewFile[] = [
  file(
    "pipeline/tokenize.py",
    "modified",
    `@@ -1,15 +1,25 @@
 import os
+from functools import lru_cache

 from transformers import AutoTokenizer

 from pipeline.config import settings


-def get_tokenizer():
-    return AutoTokenizer.from_pretrained(settings.TOKENIZER, use_fast=True)
+@lru_cache(maxsize=4)
+def get_tokenizer(name: str | None = None):
+    """One tokenizer per worker process and name; loading one costs about 1.5 s."""
+    return AutoTokenizer.from_pretrained(name or settings.TOKENIZER, use_fast=True)


 def encode_batch(texts: list[str], max_length: int = 512) -> list[list[int]]:
-    tok = get_tokenizer()
+    tok = get_tokenizer(settings.TOKENIZER)
     out = tok(texts, truncation=True, max_length=max_length, padding=False)
     return out["input_ids"]
+
+
+def warm_up() -> None:
+    """Called from the worker's post-fork hook so the first request doesn't pay for the load."""
+    if os.environ.get("PIPELINE_SKIP_WARMUP"):
+        return
+    get_tokenizer(settings.TOKENIZER)`,
  ),
  // At the repo's root, so the shots show a file with no folder.
  file(
    "requirements.txt",
    "modified",
    `@@ -3,3 +3,3 @@ numpy==1.26.4
 pydantic==2.8.2
-transformers==4.44.0
+transformers==4.46.1
 uvicorn==0.30.6`,
  ),
  file(
    "pipeline/worker.py",
    "modified",
    `@@ -41,8 +41,9 @@ def on_starting(server):

 def post_fork(server, worker):
     configure_logging(worker.pid)
     metrics.reset()
+    tokenize.warm_up()


 def worker_exit(server, worker):
     metrics.flush()`,
  ),
  // Deep enough that its folder gives way in the file list.
  file(
    "pipeline/migrations/versions/0008_tokenizer_cache.py",
    "added",
    `@@ -0,0 +1,5 @@
+"""Adds the tokenizer cache size setting."""
+
+
+def upgrade(op):
+    op.add_setting("tokenizer_cache_size", default=4)`,
  ),
  file(
    "tests/test_tokenize.py",
    "added",
    `@@ -0,0 +1,14 @@
+from pipeline import tokenize
+
+
+def test_get_tokenizer_is_cached(monkeypatch):
+    calls = []
+    monkeypatch.setattr(tokenize.AutoTokenizer, "from_pretrained", lambda *a, **k: calls.append(a) or object())
+    tokenize.get_tokenizer.cache_clear()
+    assert tokenize.get_tokenizer("bert-base") is tokenize.get_tokenizer("bert-base")
+    assert len(calls) == 1
+
+
+def test_warm_up_can_be_skipped(monkeypatch):
+    monkeypatch.setenv("PIPELINE_SKIP_WARMUP", "1")
+    tokenize.warm_up()`,
  ),
  { path: "assets/tokenizer-load.png", previous_path: null, status: "added", additions: 0, deletions: 0, patch: null },
];

const CANNED: Record<string, Canned> = {
  "acme/api#4127": {
    files: planner,
    ai: {
      verdict: "look",
      risk: "medium",
      summary:
        "Adds a streaming scan (`streamRows`) and uses it in `runPlan`, so a query that runs past its time budget returns the rows found so far, marked partial. The `/v2/query` route passes an optional `?budget=` through and sets `X-Partial-Results`.",
      concerns: [
        "src/routes/query.ts passes ?budget= through Number() unchecked: a non-numeric value becomes NaN and silently turns the budget off, and 0 or a negative value returns an empty partial result.",
        "Every query now has a 2 s budget by default, so slow queries that used to complete will come back partial; clients that ignore the new partial flag will treat them as complete.",
      ],
      notes: [
        {
          path: "src/planner/stream.ts",
          side: "new",
          line: 10,
          body: "The core of the change: rows come out in batches as the scan produces them, so the planner can stop between batches instead of buffering the whole result first.",
        },
        {
          path: "src/planner/plan.ts",
          side: "new",
          line: 23,
          body: "The budget is only checked between batches, so a slow batch can run past it by up to 500 rows' worth of scanning.",
        },
        {
          path: "src/routes/query.ts",
          side: "new",
          line: 30,
          body: "The only place a budget comes from the outside. Without `?budget=` the 2 s default applies, which changes behaviour for every existing caller.",
        },
        {
          path: "src/routes/query.ts",
          side: "new",
          line: 37,
          body: "Unrelated fix riding along: explain no longer throws on a query that doesn't parse.",
        },
        {
          path: "test/planner/stream.test.ts",
          side: "new",
          line: 0,
          body: "Covers batching and abort, but nothing exercises `runPlan`'s partial path or the route's `X-Partial-Results` header.",
        },
      ],
      chunks: {
        ranked: [
          { id: "h3", path: "src/planner/plan.ts", level: "look", why: "budget checked only between batches" },
          { id: "h4", path: "src/routes/query.ts", level: "look", why: "?budget= read unchecked" },
          { id: "h1", path: "src/planner/stream.ts", level: "skim", why: "new batching generator" },
          { id: "h5", path: "test/planner/stream.test.ts", level: "skim", why: "" },
        ],
        unread: [],
        total: 6,
      },
      guide: {
        steps: [
          {
            title: "The row stream",
            body: "A new generator, `streamRows`, yields rows in batches as the scan finds them. The planner and the route below both read from it.",
            check: "A batch ends when the cursor closes, even mid-page.",
            hunks: [{ id: "h1", path: "src/planner/stream.ts" }],
          },
          {
            title: "The planner's budget",
            body: "`runPlan` now reads from `streamRows` and checks its time budget between batches, marking the result partial when it runs out.",
            check: "One slow batch can't run far past the budget.",
            hunks: [
              { id: "h2", path: "src/planner/plan.ts" },
              { id: "h3", path: "src/planner/plan.ts" },
            ],
          },
          {
            title: "The query route",
            body: "/v2/query passes `?budget=` through and sets X-Partial-Results when the planner stopped early.",
            check: "",
            hunks: [{ id: "h4", path: "src/routes/query.ts" }],
          },
          {
            title: "Tests",
            body: "The stream's batching and the budget's cut-off, against a fake scan.",
            check: "",
            hunks: [{ id: "h5", path: "test/planner/stream.test.ts" }],
          },
        ],
      },
    },
  },
  "acme/ml-pipeline#311": {
    files: tokenizer,
    ai: {
      verdict: "skim",
      risk: "medium",
      summary:
        "Caches the Hugging Face tokenizer per process with lru_cache and loads it in the worker's post-fork hook, so the first request on each worker no longer pays the 1.5 s load.",
      concerns: [
        "If anything calls get_tokenizer() in the master before it forks, every worker inherits the same Rust-backed tokenizer, which can deadlock after fork; setting TOKENIZERS_PARALLELISM=false or asserting that warm_up runs post-fork would rule it out.",
      ],
      notes: [
        {
          path: "pipeline/tokenize.py",
          side: "new",
          line: 9,
          body: "`lru_cache` keys on the `name` argument, so `get_tokenizer()` and `get_tokenizer(settings.TOKENIZER)` would be two cache entries for the same model; `encode_batch` now always passes the name, which avoids that in practice.",
        },
        {
          path: "pipeline/worker.py",
          side: "new",
          line: 45,
          body: "Runs after the fork, so each worker loads its own copy: memory goes up by one tokenizer per worker (about 400 MB for the default model).",
        },
      ],
      chunks: {
        ranked: [
          { id: "h1", path: "pipeline/tokenize.py", level: "look", why: "cache keyed on the name argument" },
          { id: "h3", path: "pipeline/worker.py", level: "look", why: "loads after fork, once per worker" },
          { id: "h2", path: "requirements.txt", level: "skim", why: "transformers minor bump" },
          { id: "h4", path: "pipeline/migrations/versions/0008_tokenizer_cache.py", level: "skim", why: "setting nothing reads yet" },
        ],
        unread: [],
        total: 5,
      },
    },
  },
};

const PARTS = [
  "types",
  "store",
  "render",
  "hooks",
  "measure",
  "keys",
  "scroll",
  "config",
  "util",
  "api",
  "errors",
  "index",
  "cache",
  "retry",
];

// The rest of a seed's size, so the review's header and its file list agree: whole names, +/− adding up.
function filler(dir: string, ext: string, adds: number, dels: number, count: number): ReviewFile[] {
  return Array.from({ length: count }, (_, i) => {
    const a = Math.floor(adds / count) + (i < adds % count ? 1 : 0);
    const d = Math.floor(dels / count) + (i < dels % count ? 1 : 0);
    const name = `${dir}/${PARTS[i % PARTS.length]}${i >= PARTS.length ? `-${Math.floor(i / PARTS.length) + 1}` : ""}.${ext}`;
    const lines = [
      `@@ -1,${d} +1,${a} @@`,
      ...Array.from({ length: d }, (_x, k) => `-${ext === "py" ? "    " : "  "}legacy_step_${k}()`),
      ...Array.from({ length: a }, (_x, k) => `+${ext === "py" ? "    " : "  "}step_${k}()`),
    ];
    return file(name, "modified", lines.join("\n"));
  });
}

// Every other PR gets a diff shaped by its title and sized like its seed, and no review until one is asked for.
function generic(repo: string, n: number, title: string, size?: [number, number, number]): Canned {
  // Whole words, up to 32 characters: a cut name reads like a typo.
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let slug = "";
  for (const w of words) {
    const next = slug ? `${slug}_${w}` : w;
    if (next.length > 32) break;
    slug = next;
  }
  slug ||= `change_${n}`;
  const py = repo.includes("ml-");
  const [adds, dels, count] = size ?? [0, 0, 1];
  const first = py ? [4, 1] : [4, 2];
  const rest =
    count > 1
      ? filler(
          py ? `pipeline/${slug}` : `src/${slug.replaceAll("_", "-")}`,
          py ? "py" : "ts",
          Math.max(adds - first[0]!, count - 1),
          Math.max(dels - first[1]!, 0),
          count - 1,
        )
      : [];
  return {
    files: [
      py
        ? file(
            `pipeline/${slug}.py`,
            "modified",
            `@@ -12,7 +12,10 @@ from pipeline.config import settings


 def run(batch):
-    return legacy_${slug}(batch)
+    started = time.monotonic()
+    result = ${slug}(batch, limit=settings.BATCH_LIMIT)
+    metrics.timing("${slug}", time.monotonic() - started)
+    return result


 def legacy_${slug}(batch):`,
          )
        : file(
            `src/${slug.replaceAll("_", "-")}.ts`,
            "modified",
            `@@ -8,8 +8,10 @@ import { log } from "./log.ts";

 // ${title}
 export async function run(input: Input): Promise<Output> {
-  const out = await legacy(input);
-  return out;
+  const started = performance.now();
+  const out = await next(input, { retries: 2 });
+  log.debug("${slug}", { ms: performance.now() - started });
+  return out;
 }

 export { legacy };`,
          ),
      ...rest,
    ],
    ai: null,
  };
}

export function canned(id: string, repo: string, n: number, title: string, size?: [number, number, number]): Canned {
  return CANNED[id] ?? generic(repo, n, title, size);
}
