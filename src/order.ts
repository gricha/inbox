// Your order on the Inbox (docs/api.md → Your order): a row you dragged keeps a rank among the keys the desk sorts its
// list by (a score, a time), so what the desk adds or rescores still lands around it.
import type { InboxSection, Inquiry, Place } from "./types.ts";

export const ASK = "ask:"; // an agent's question as a row: "ask:<its id>"

export interface Ranked<T> {
  id: (r: T) => string;
  key: (r: T) => number; // the desk's own: the list comes sorted by it, highest first
  place: (r: T) => Place | undefined; // yours, when it holds for this list
}

// The list with your placed rows at their ranks: after every row with a higher key, and beside the neighbour you dropped it
// by when their keys tie. A row placed against another placed row goes in after it; the newer of two ties is nearer.
export function arrange<T>(rows: readonly T[], r: Ranked<T>): T[] {
  const placed = rows.filter((x) => r.place(x));
  if (!placed.length) return [...rows];
  const out = rows.filter((x) => !r.place(x));
  const key = (x: T) => r.place(x)?.rank ?? r.key(x);
  const left = placed.toSorted((a, b) => key(b) - key(a) || (r.place(a)!.at ?? "").localeCompare(r.place(b)!.at ?? ""));
  const waiting = new Set(left.map(r.id));
  const tie = (id: string | undefined, rank: number) => {
    const i = id === undefined ? -1 : out.findIndex((x) => r.id(x) === id);
    return i >= 0 && key(out[i]!) === rank ? i : -1;
  };
  const insert = (x: T) => {
    const p = r.place(x)!;
    const a = tie(p.after, p.rank);
    const b = tie(p.before, p.rank);
    const i = a >= 0 ? a + 1 : b >= 0 ? b : out.findIndex((y) => key(y) < p.rank);
    out.splice(i < 0 ? out.length : i, 0, x);
    waiting.delete(r.id(x));
  };
  while (left.length) {
    const next = left.findIndex((x) => !waiting.has(r.place(x)!.after ?? "") && !waiting.has(r.place(x)!.before ?? ""));
    insert(left.splice(Math.max(0, next), 1)[0]!); // a loop of anchors: the highest goes in by its rank
  }
  return out;
}

// Where a row dropped between `after` and `before` (row ids, either left out) goes in `rows` (as arranged): a rank between
// their keys, and the two rows it went between. Leaving one out takes the row next to the other, so a drop in a filtered
// list lands by the rows you saw. Neither: no rank, it goes where the desk puts it. A name not in the list is null.
export function rankAt<T>(
  rows: readonly T[],
  r: Ranked<T>,
  self: string,
  after?: string,
  before?: string,
): { rank: number; after?: string; before?: string } | null | undefined {
  const list = rows.filter((x) => r.id(x) !== self);
  const at = (id: string) => list.findIndex((x) => r.id(x) === id);
  const i = after === undefined ? -1 : at(after);
  const j = before === undefined ? -1 : at(before);
  if ((after !== undefined && i < 0) || (before !== undefined && j < 0)) return null;
  if (after === undefined && before === undefined) return undefined;
  const above = after !== undefined ? list[i] : list[j - 1];
  const below = before !== undefined ? list[j] : list[i + 1];
  const key = (x: T) => r.place(x)?.rank ?? r.key(x);
  const ka = above === undefined ? undefined : key(above);
  const kb = below === undefined ? undefined : key(below);
  const rank = ka === undefined ? (kb ?? 0) + 1 : kb === undefined ? ka - 1 : ka > kb ? ka / 2 + kb / 2 : ka;
  return {
    rank,
    ...(above !== undefined && { after: r.id(above) }),
    ...(below !== undefined && { before: r.id(below) }),
  };
}

// The questions leading Urgent in your order: oldest first, with the ones you dragged where you put them.
export const askOrder: Ranked<Inquiry> = {
  id: (q) => q.id,
  key: (q) => -Date.parse(q.at),
  place: (q) => (q.place?.section === "urgent" ? q.place : undefined),
};

// A row's id in a list of one kind: an item's as it is, a note's or a question's without its prefix.
export const bare = (id: string | undefined, prefix: string): string | undefined => (id?.startsWith(prefix) ? id.slice(prefix.length) : id);

export const SECTION_WORD: Record<InboxSection, string> = { urgent: "Urgent", standard: "Standard", fyi: "FYI" };
