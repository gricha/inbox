// The ledger of work Claude owes the owner (src/jobs.ts) and its loop: an AI review survives a desk restart, a run past its
// time is retried with backoff and then failed with its reason, and the review page says what the ledger says.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { Desk, type ReviewDeps } from "../src/desk.ts";
import { ClaudeApiError } from "../src/errors.ts";
import type { PrText } from "../src/review.ts";
import type { AiReview, Job } from "../src/types.ts";
import { reviewAsk, setup } from "./helpers/desk.ts";
import { NOW } from "./helpers/items.ts";
import { run, runSync } from "./helpers/run.ts";

const ID = "acme/api#1";
const FILE = { path: "a.ts", previous_path: null, status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n-a\n+b" } as const;
const SETTINGS = { "policy.judge": false };

const flush = () =>
  new Promise((r) => {
    setImmediate(r);
  });

// A fake agent that holds each review until the test lets it go, then answers, or fails with `fail`'s words.
function fakeReview() {
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  let fail: string | null = null;
  const deps: ReviewDeps = {
    fetchPr: () => Effect.succeed({ body: "why", files: [{ ...FILE }] } satisfies PrText),
    generate: (item) =>
      Effect.gen(function* () {
        started.push(item.id);
        yield* Effect.promise(
          () =>
            new Promise<void>((r) => {
              gates.set(item.id, r);
            }),
        );
        if (fail) return yield* Effect.fail(new ClaudeApiError({ message: fail }));
        return {
          verdict: "skim",
          risk: "low",
          summary: `Review of ${item.id}`,
          concerns: [],
          notes: [],
          head_oid: item.head_oid,
          model: "claude-opus-5",
          at: NOW.toISOString(),
        } satisfies AiReview;
      }),
  };
  return {
    deps,
    started,
    release: async (id: string) => {
      gates.get(id)!();
      await flush();
    },
    fail: (words: string | null) => {
      fail = words;
    },
  };
}

async function reviewing(c: TestContext) {
  const f = fakeReview();
  const t = await setup([reviewAsk(1)], { settings: SETTINGS, desk: { review: f.deps } });
  const desks = [t.desk];
  c.after(() => {
    for (const d of desks) d.stop();
    t.cleanup();
  });
  // The next desk on the same home, as after a restart.
  const restart = async () => {
    t.desk.stop();
    const desk = new Desk({ home: t.home, github: t.gh, now: () => NOW, review: f.deps, notify: () => {}, log: () => {} });
    desks.push(desk);
    await run(desk.init());
    return desk;
  };
  await run(t.desk.sync());
  await flush();
  return { ...t, f, restart };
}

const pick = (j: Job | null, keys: (keyof Job)[] = ["state", "attempts"]) => j && Object.fromEntries(keys.map((k) => [k, j[k]]));

// The review page's AI section reads the ledger: a spinner exactly while its job runs, else its last try's words.
async function same(desk: Desk) {
  const v = await run(desk.reviewView(ID));
  const j = desk.jobs.get("ai_review", ID)!;
  assert.deepEqual(
    { generating: v.generating, ai_error: v.ai_error, ai_job: v.ai_job },
    { generating: j.state === "running", ai_error: j.state === "running" ? null : j.error, ai_job: j },
    "the review page says what the ledger says",
  );
}

test("a review that failed stays failed across a desk restart: opening it says why, with Try again, and starts nothing", async (c) => {
  const t = await reviewing(c);
  t.f.fail("claude exited with 1");
  await t.f.release(ID);
  const before = await run(t.desk.reviewView(ID));
  assert.deepEqual([before.generating, before.ai_error], [false, "claude exited with 1"]);
  const desk = await t.restart();
  const after = await run(desk.reviewView(ID));
  assert.deepEqual([after.generating, after.ai_error], [false, "claude exited with 1"], "no spinner for a review nobody runs");
  assert.deepEqual(t.f.started, [ID], "opening it doesn't start it again: the loop retries it after its backoff");
});

test("a desk restart queues again the review it was in, that try not counted, and the loop starts it", async (c) => {
  const t = await reviewing(c);
  assert.deepEqual(t.f.started, [ID]);
  assert.deepEqual(pick(t.desk.jobs.get("ai_review", ID)), { state: "running", attempts: 1 });
  await same(t.desk);
  const desk = await t.restart(); // its run is cut, and records nothing
  assert.deepEqual(pick(desk.jobs.get("ai_review", ID)), { state: "queued", attempts: 0 }, "the cut try doesn't count");
  await same(desk);
  assert.deepEqual(
    runSync(desk.inflight()).work.map((w) => [w.title, w.state]),
    [["Change 1", "queued"]],
    "Claude's work lists it",
  );
  desk.jobs.tick();
  await flush();
  assert.deepEqual(t.f.started, [ID, ID], "the loop starts it again");
  assert.deepEqual(pick(desk.jobs.get("ai_review", ID)), { state: "running", attempts: 1 });
  await same(desk);
  await t.f.release(ID);
  assert.deepEqual(pick(desk.jobs.get("ai_review", ID)), { state: "done", attempts: 1 });
  await same(desk);
  assert.deepEqual(runSync(desk.inflight()).work, [], "done isn't listed");
});

test("a review past its time is stopped and tried again after its backoff; after three tries it's failed with its reason, until you try again", async (c) => {
  const t = await reviewing(c);
  let at = NOW.getTime();
  const later = async (minutes: number) => {
    at += minutes * 60_000;
    t.setNow(new Date(at));
    t.desk.jobs.tick();
    await flush();
  };
  const job = () => pick(t.desk.jobs.get("ai_review", ID), ["state", "attempts", "error"]);
  const late = "no answer in 15 minutes, so it was stopped";

  await later(14);
  assert.deepEqual(job(), { state: "running", attempts: 1, error: null }, "within its time");
  await later(1);
  assert.deepEqual(job(), { state: "queued", attempts: 1, error: late });
  assert.equal(t.desk.generating.size, 0, "its run is stopped");
  await same(t.desk);
  await later(1);
  assert.equal(t.f.started.length, 1, "it waits out its backoff");
  await later(1);
  assert.equal(t.f.started.length, 2, "then tries again");
  assert.deepEqual(job(), { state: "running", attempts: 2, error: late });
  await same(t.desk);
  await later(15);
  assert.deepEqual(job(), { state: "queued", attempts: 2, error: late });
  assert.equal(t.desk.aiPausedNow(), false, "one PR timing out again doesn't pause the others");
  await later(10);
  assert.deepEqual(job(), { state: "running", attempts: 3, error: late });
  await later(15);
  assert.deepEqual(job(), { state: "failed", attempts: 3, error: late });
  await same(t.desk);
  await later(60);
  assert.equal(t.f.started.length, 3, "failed: it waits for you");
  assert.deepEqual(
    runSync(t.desk.inflight()).work.map((w) => pick(w, ["kind", "key", "state", "error"])),
    [{ kind: "ai_review", key: ID, state: "failed", error: late }],
    "Claude's work lists it, with its reason",
  );

  const again = run(t.desk.aiReview(ID)); // Try again
  await flush();
  assert.deepEqual(job(), { state: "running", attempts: 1, error: late }, "Try again starts its tries over");
  await t.f.release(ID);
  assert.equal((await again).summary, `Review of ${ID}`);
  assert.deepEqual(job(), { state: "done", attempts: 1, error: null });
  await same(t.desk);
});
