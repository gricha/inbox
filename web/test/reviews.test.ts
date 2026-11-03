import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewView } from "../../src/types.ts";
import { restOn, reviewOf } from "../src/reviews.ts";

// A fake GET /api/review/:id that logs each call as "id" or "id ahead".
function fakeGet(fail = false) {
  const calls: string[] = [];
  const get = (id: string, ahead = false) => {
    calls.push(ahead ? `${id} ahead` : id);
    return fail ? Promise.reject(new Error("down")) : Promise.resolve({ card: { id } } as unknown as ReviewView);
  };
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
  await assert.rejects(reviewOf("x", bad.get, 0));
  const f = fakeGet();
  await reviewOf("x", f.get, 10);
  assert.deepEqual(f.calls, ["x"]);
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
