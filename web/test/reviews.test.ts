import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewView } from "../../src/types.ts";
import { forgetReviews, keptReview, restOn, reviewOf } from "../src/reviews.ts";

// A fake GET /api/review/:id that logs each call as "id" or "id ahead".
function fakeGet(fail = false) {
  const calls: string[] = [];
  const get = (id: string, ahead = false) => {
    calls.push(ahead ? `${id} ahead` : id);
    return fail ? Promise.reject(new Error("down")) : Promise.resolve({ card: { id } } as unknown as ReviewView);
  };
  return { calls, get };
}

test("opens share one GET, a prefetch is kept until the desk changes, and a later open asks the desk again", () => {
  forgetReviews();
  const f = fakeGet();
  const first = reviewOf("a", false, f.get, 0);
  assert.equal(reviewOf("a", false, f.get, 10), first, "StrictMode's second effect joins it");
  assert.equal(reviewOf("a", true, f.get, 20), first, "a prefetch takes the open's");
  assert.deepEqual(f.calls, ["a"]);
  assert.equal(keptReview("a", 5000), first, "drawn while the next open's GET is on its way");
  reviewOf("a", false, f.get, 5000);
  assert.deepEqual(f.calls, ["a", "a"], "a later open asks again");
  const ahead = reviewOf("a", true, f.get, 6000);
  assert.equal(reviewOf("a", true, f.get, 20_000), ahead, "a prefetch is kept");
  forgetReviews();
  reviewOf("a", true, f.get, 20_000);
  assert.deepEqual(f.calls, ["a", "a", "a ahead"], "until the desk changes");
  reviewOf("a", true, f.get, 50_000);
  assert.deepEqual(f.calls, ["a", "a", "a ahead", "a ahead"], "or half a minute passes");
});

test("opening a PR fetched ahead asks the desk again, and draws the prefetch meanwhile", () => {
  forgetReviews();
  const f = fakeGet();
  const ahead = reviewOf("a", true, f.get, 0);
  assert.equal(reviewOf("a", true, f.get, 0), ahead);
  assert.equal(keptReview("a", 0), ahead);
  const open = reviewOf("a", false, f.get, 0);
  assert.notEqual(open, ahead);
  assert.deepEqual(f.calls, ["a ahead", "a"], "only an open starts its AI review");
  assert.equal(reviewOf("a", false, f.get, 0), open);
});

test("a failed fetch isn't kept, and only the last few PRs are", async () => {
  forgetReviews();
  const bad = fakeGet(true);
  await assert.rejects(reviewOf("a", false, bad.get, 0));
  assert.equal(keptReview("a", 0), null);
  const f = fakeGet();
  for (const id of ["a", "b", "c", "d", "e", "f", "g"]) reviewOf(id, true, f.get, 0);
  assert.equal(keptReview("a", 0), null, "the oldest goes");
  assert.ok(keptReview("g", 0));
  reviewOf("b", true, f.get, 0);
  assert.equal(f.calls.filter((c) => c === "b ahead").length, 1);
});

test("resting on a row fetches its review ahead after a short pause; passing over one doesn't", (t) => {
  forgetReviews();
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
