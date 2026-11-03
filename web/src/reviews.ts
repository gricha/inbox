import type { ReviewView } from "../../src/types.ts";
import { api } from "./api.ts";

const KEEP_MS = 30_000; // a backstop: any change on the desk forgets them sooner
const JOIN_MS = 2_000; // opens this close together (StrictMode's second effect) share one GET
const KEPT = 6; // a big PR's view is megabytes
const DWELL_MS = 150; // the cursor or the pointer rests this long on a row before its review is fetched

interface Kept {
  at: number;
  ahead: boolean; // fetched before it was opened: the desk started nothing for it
  p: Promise<ReviewView>;
}

const kept = new Map<string, Kept>();

// A prefetch is kept until the desk changes; an open always asks the desk (only it starts the AI review), once.
export function reviewOf(id: string, ahead = false, get = api.review, now = Date.now()): Promise<ReviewView> {
  const k = kept.get(id);
  if (k && (ahead ? now - k.at < KEEP_MS : !k.ahead && now - k.at < JOIN_MS)) return k.p;
  const p = get(id, ahead);
  kept.delete(id); // to the end: the oldest goes first
  kept.set(id, { at: now, ahead, p });
  for (const old of kept.keys()) if (kept.size > KEPT) kept.delete(old);
  p.catch(() => {
    if (kept.get(id)?.p === p) kept.delete(id);
  });
  return p;
}

// The last view fetched, to draw while the open's own GET is on its way.
export function keptReview(id: string, now = Date.now()): Promise<ReviewView> | null {
  const k = kept.get(id);
  return k && now - k.at < KEEP_MS ? k.p : null;
}

// The desk changed: the next ask fetches again.
export function forgetReviews(): void {
  kept.clear();
}

let timer: ReturnType<typeof setTimeout> | undefined;
let resting: string | null = null;

// The PR whose row the cursor or the pointer is on (null: none); after a short rest there, its review is fetched ahead.
export function restOn(id: string | null, get = api.review): void {
  if (id === resting) return;
  resting = id;
  clearTimeout(timer);
  if (id)
    timer = setTimeout(() => {
      reviewOf(id, true, get).catch(() => {}); // opening it says what went wrong
    }, DWELL_MS);
}
