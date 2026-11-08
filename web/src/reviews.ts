import { Effect } from "effect";
import type { ReviewView } from "../../src/types.ts";
import { api, runUi, type ApiError } from "./api.ts";

const JOIN_MS = 2_000; // an open while the last one's GET is still out (StrictMode's second effect) shares it
const DWELL_MS = 150; // the cursor or the pointer rests this long on a row before its review is fetched ahead

let last: { id: string; at: number; review: Effect.Effect<ReviewView, ApiError> } | null = null;

// An open asks the desk, which starts its AI review; only once for the same PR opened twice in a row. The GET runs on its
// own, outside the opener's fiber: StrictMode interrupting its first effect leaves it running for the second.
export function reviewOf(id: string, get = api.review, now = Date.now()): Effect.Effect<ReviewView, ApiError> {
  if (last?.id === id && now - last.at < JOIN_MS) return last.review;
  // Once it answers, a refresh asks again.
  const p = Effect.runPromiseExit(get(id)).then((exit) => {
    if (last?.review === review) last = null;
    return exit;
  });
  const review = Effect.flatten(Effect.promise(() => p));
  last = { id, at: now, review };
  return review;
}

let timer: ReturnType<typeof setTimeout> | undefined;
let resting: string | null = null;

// The PR whose row the cursor or the pointer is on (null: none); after a short rest there, the desk fetches its diff and
// conversation ahead (it keeps them per commit), so the open answers from them.
export function restOn(id: string | null, get = api.review): void {
  if (id === resting) return;
  resting = id;
  clearTimeout(timer);
  if (id)
    timer = setTimeout(() => {
      runUi(get(id, true).pipe(Effect.ignore)); // opening it says what went wrong
    }, DWELL_MS);
}
