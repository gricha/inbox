import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Exit } from "effect";
import type { ReviewView } from "../../src/types.ts";
import { DeskUnreachable } from "../src/api.ts";
import { restOn, reviewOf } from "../src/reviews.ts";

// A fake GET /api/review/:id that logs each call as "id" or "id ahead" when it runs.
function fakeGet(fail = false) {
  const calls: string[] = [];
  const get = (id: string, ahead = false) =>
    Effect.suspend(() => {
      calls.push(ahead ? `${id} ahead` : id);
      return fail ? Effect.fail(new DeskUnreachable({})) : Effect.succeed({ card: { id } } as unknown as ReviewView);
    });
  return { calls, get };
}

test("an open asks the desk once for StrictMode's second effect, and again later or for another PR", () => {
  const f = fakeGet();
  const first = reviewOf("a", f.get, 0);
  assert.equal(reviewOf("a", f.get, 10), first, "StrictMode's second effect joins it");
  assert.deepEqual(f.calls, ["a"]);
  reviewOf("a", f.get, 5000);
  reviewOf("b", f.get, 5000);
  reviewOf("a", f.get, 5000);
  assert.deepEqual(f.calls, ["a", "a", "b", "a"]);
});

test("a failed open isn't joined", async () => {
  const bad = fakeGet(true);
  const exit = await Effect.runPromiseExit(reviewOf("x", bad.get, 0));
  assert.ok(Exit.isFailure(exit));
  const f = fakeGet();
  await Effect.runPromise(reviewOf("x", f.get, 10));
  assert.deepEqual(f.calls, ["x"]);
});

test("a refresh after the open has answered asks the desk again", async () => {
  const f = fakeGet();
  await Effect.runPromise(reviewOf("r", f.get, 0));
  await Effect.runPromise(reviewOf("r", f.get, 1300));
  assert.deepEqual(f.calls, ["r", "r"]);
});

test("StrictMode interrupting the first open leaves the shared GET running for the second", async () => {
  let answer: (v: ReviewView) => void = () => {};
  const gets: string[] = [];
  const get = (id: string) =>
    Effect.promise(
      () =>
        new Promise<ReviewView>((ok) => {
          gets.push(id);
          answer = ok;
        }),
    );
  const stop = new AbortController();
  const first = Effect.runPromiseExit(reviewOf("s", get, 0), { signal: stop.signal });
  stop.abort(); // the first effect's cleanup
  const second = Effect.runPromise(reviewOf("s", get, 5));
  answer({ card: { id: "s" } } as unknown as ReviewView);
  assert.equal((await second).card.id, "s");
  assert.ok(Exit.hasInterrupts(await first));
  assert.deepEqual(gets, ["s"]);
});

test("resting on a row fetches its review ahead after a short pause; passing over one doesn't", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fakeGet();
  restOn("a", f.get);
  t.mock.timers.tick(100);
  restOn("b", f.get);
  t.mock.timers.tick(100);
  assert.deepEqual(f.calls, []);
  restOn("b", f.get); // the pointer moving within the same row
  t.mock.timers.tick(60);
  assert.deepEqual(f.calls, ["b ahead"]);
  restOn(null, f.get);
  restOn("c", f.get);
  restOn(null, f.get);
  t.mock.timers.tick(500);
  assert.deepEqual(f.calls, ["b ahead"], "left before the pause ran out");
});
