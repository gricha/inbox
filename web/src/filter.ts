// The search box: its author: and involves: terms, and what a row matches.
import { itemIdOf } from "../../src/links.ts";
import { oneOf } from "../../src/narrow.ts";
import type { Card } from "../../src/types.ts";
import { shortRef } from "./format.ts";

// The filter's people: author:dana (who it's from) and involves:dana (anyone on it: asked, reviewed, said something).
export const FILTER_KEYS = ["author", "involves"] as const;

export type FilterKey = (typeof FILTER_KEYS)[number];

export interface FilterTerm {
  key: FilterKey;
  who: string;
  done: boolean; // followed by a space: a pill, no longer being typed
}

const TERM = /^(author|involves):(\S*)$/i;

// A filter's terms and its free text. A term still being typed (the last word) matches as you type it.
export function parseFilter(s: string): { terms: FilterTerm[]; text: string } {
  const terms: FilterTerm[] = [];
  const text: string[] = [];
  for (const m of s.matchAll(/(\S+)(\s*)/g)) {
    const word = m[1]!;
    const t = TERM.exec(word);
    const key = oneOf(FILTER_KEYS, t?.[1]?.toLowerCase());
    if (t && key) terms.push({ key, who: t[2]!.replace(/^@/, ""), done: !!m[2] });
    else text.push(word);
  }
  return { terms, text: text.join(" ") };
}

// What the filter's box holds after its pills: the filter without its finished terms, as typed.
export function filterRest(s: string): string {
  let out = "";
  for (const m of s.matchAll(/(\S+)(\s*)/g)) if (!(TERM.test(m[1]!) && m[2])) out += m[0];
  return out;
}

// A filter from its pills and what's typed after them.
export function filterOf(terms: { key: FilterKey; who: string }[], rest: string): string {
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
  const has = (login: string, who: string) => login.toLowerCase().includes(who);
  const fits = terms.every((t) => {
    const who = t.who.toLowerCase();
    if (!who) return true;
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
