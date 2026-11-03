import type { ReviewView } from "../../src/types.ts";
import { api } from "./api.ts";

const JOIN_MS = 2_000; // an open while the last one's GET is still out (StrictMode's second effect) shares it
const DWELL_MS = 150; // the cursor or the pointer rests this long on a row before its review is fetched ahead

let last: { id: string; at: number; p: Promise<ReviewView> } | null = null;

// An open asks the desk, which starts its AI review; only once for the same PR opened twice in a row.
export function reviewOf(id: string, get = api.review, now = Date.now()): Promise<ReviewView> {
  if (last?.id === id && now - last.at < JOIN_MS) return last.p;
  const p = get(id);
  last = { id, at: now, p };
  const settled = () => {
    if (last?.p === p) last = null;
  };
  p.then(settled, settled); // once it answers, a refresh asks again
  return p;
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
      get(id, true).catch(() => {}); // opening it says what went wrong
    }, DWELL_MS);
}
