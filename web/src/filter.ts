// The search box: its author:, involves: and is: terms, and what a row matches.
import { itemIdOf } from "../../src/links.ts";
import { oneOf } from "../../src/narrow.ts";
import type { Card } from "../../src/types.ts";
import { shortRef } from "./format.ts";

// The filter's people: author:dana (who it's from) and involves:dana (anyone on it: asked, reviewed, said something).
export const FILTER_KEYS = ["author", "involves"] as const;

export type FilterKey = (typeof FILTER_KEYS)[number];

// The filter's kinds of row, a button each on the page's head: is:quick (a bolt), is:reply (a Reply) and is:oneclick (your
// PR one button moves on: Ready for review, Add reviewers, Hand off for merge).
const SHOW_KEYS = ["quick", "reply", "oneclick"] as const;

export type ShowKey = (typeof SHOW_KEYS)[number];

const SHOWS: Record<ShowKey, (c: Card) => boolean> = {
  quick: (c) => !!c.quick,
  reply: (c) => c.cta === "reply",
  oneclick: (c) => c.cta === "ready" || c.cta === "reviewers" || c.cta === "handoff",
};

export interface FilterTerm {
  key: FilterKey | "is";
  who: string; // a person's login; for is:, the kind of row
  done: boolean; // followed by a space: a pill, no longer being typed
}

const TERM_KEYS = [...FILTER_KEYS, "is"] as const;
const TERM = /^(author|involves|is):(\S*)$/i;

// A filter's terms and its free text. A term still being typed (the last word) matches as you type it.
export function parseFilter(s: string): { terms: FilterTerm[]; text: string } {
  const terms: FilterTerm[] = [];
  const text: string[] = [];
  for (const m of s.matchAll(/(\S+)(\s*)/g)) {
    const word = m[1]!;
    const t = TERM.exec(word);
    const key = oneOf(TERM_KEYS, t?.[1]?.toLowerCase());
    if (t && key) terms.push({ key, who: t[2]!.replace(/^@/, ""), done: !!m[2] });
    else text.push(word);
  }
  return { terms, text: text.join(" ") };
}

const showOf = (t: FilterTerm): ShowKey | null => (t.key === "is" ? (oneOf(SHOW_KEYS, t.who.toLowerCase()) ?? null) : null);

// The kind of row the head's buttons show, null for every row.
export function shownKind(s: string): ShowKey | null {
  for (const t of parseFilter(s).terms) {
    const k = t.done ? showOf(t) : null;
    if (k) return k;
  }
  return null;
}

// The head's buttons for a page's rows: a kind that has some, and the one that's on even with none left, to turn it off.
export function kindButtons(cards: Card[], s: string): ShowKey[] {
  const on = shownKind(s);
  return SHOW_KEYS.filter((k) => k === on || cards.some(SHOWS[k]));
}

const finished = (s: string) => parseFilter(s).terms.filter((t) => t.done);

// A head button's click: that kind of row alone, or every row when it's the one shown; the person picks and words kept.
export function toggleShow(s: string, key: ShowKey): string {
  const people = finished(s).filter((t) => t.key !== "is");
  return filterOf([...(shownKind(s) === key ? [] : [{ key: "is" as const, who: key }]), ...people], filterRest(s));
}

// The person filter's picks, with the kind of row shown and the words kept.
export function withPeople(s: string, picks: { key: FilterKey; who: string }[]): string {
  return filterOf([...finished(s).filter((t) => t.key === "is"), ...picks], filterRest(s));
}

// What the filter's box holds after its pills: the filter without its finished terms, as typed.
export function filterRest(s: string): string {
  let out = "";
  for (const m of s.matchAll(/(\S+)(\s*)/g)) if (!(TERM.test(m[1]!) && m[2])) out += m[0];
  return out;
}

// A filter from its pills and what's typed after them.
export function filterOf(terms: { key: FilterTerm["key"]; who: string }[], rest: string): string {
  return terms.map((t) => `${t.key}:${t.who} `).join("") + rest;
}

const isYou = (who: string) => who === "you" || who === "me";

// A GitHub link to a PR or an issue (any tab of it) as the desk's id, owner/repo#123; null for anything else.
export function githubRef(s: string): string | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)(?:[/?#]\S*)?$/i.exec(s.trim());
  return m ? itemIdOf(`${m[1]!}/${m[2]!}`, m[3]!) : null;
}

export function matches(c: Card, q: string, me: string): boolean {
  if (!q.trim()) return true;
  const { terms, text } = parseFilter(q);
  const ref = githubRef(text);
  if (ref) return c.id.toLowerCase() === ref.toLowerCase();
  // Kinds of row: any of them. A kind still being typed ("is:qu") filters nothing yet.
  const kinds = terms.flatMap((t) => showOf(t) ?? []);
  if (kinds.length && !kinds.some((k) => SHOWS[k](c))) return false;
  const has = (login: string, who: string) => login.toLowerCase().includes(who);
  const fits = terms.every((t) => {
    const who = t.who.toLowerCase();
    if (!who || t.key === "is") return true;
    if (t.key === "author") return isYou(who) ? c.by === "you" : has(c.author, who) || has(c.by, who);
    const people = c.people ?? [c.author];
    return isYou(who) ? c.by === "you" || people.includes(me) : people.some((p) => has(p, who));
  });
  return fits && (!text || `${c.title}\n${c.repo}\n${c.author}\n${shortRef(c)}`.toLowerCase().includes(text.toLowerCase()));
}

// Who the filter can suggest: everyone on these rows, most rows first, and whether they wrote any of them.
export function filterPeople(cards: Card[], me: string): { login: string; author: boolean }[] {
  const seen = new Map<string, { n: number; author: boolean }>();
  for (const c of cards) {
    const by = c.by === "you" ? me : c.by;
    for (const p of new Set([...(c.people ?? [c.author]), by])) {
      if (!p || (c.author_bot && p === c.author)) continue;
      const s = seen.get(p) ?? { n: 0, author: false };
      seen.set(p, { n: s.n + 1, author: s.author || p === by || p === c.author });
    }
  }
  return [...seen].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).map(([login, s]) => ({ login, author: s.author }));
}
