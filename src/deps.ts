// What a PR needs merged before it, and who blocks whom: from its description and its git stack. Pure.
import { andMore } from "./stage.ts";
import type { Stacks } from "./stacks.ts";
import type { Card, Item } from "./types.ts";

// Descriptions are attacker-written: no pattern here has nested or overlapping unbounded quantifiers, so each runs in linear time.
const REF = String.raw`(?:https://github\.com/[\w.-]+/[\w.-]+/(?:pull|issues)/\d+(?:[^\d\s)\],;][^\s)\],;]*)?|[\w.-]+/[\w.-]+#\d+|(?<![\w/])#\d+)`;
const REFS = String.raw`${REF}(?:(?:\s*(?:,|&|\+|\band\b)\s*|\s+)${REF})*`;
const FILLER = String.raw`(?:[^\s.,;:#\x60]+\s+){0,4}\(?`; // up to 4 words: "the cleanup PR (", "Seer reader"
// A few words may sit between these and the ref ("Stacked on the cleanup PR (#8943)"); none after the rest.
const NAMED = String.raw`depends on|dependent on|blocked (?:by|on)|stacked on(?: top of)?|builds on(?: top of)?`;
const DIRECT = String.raw`requires|needs|(?:merge|land) (?:this |it )?after|lands after`;
const PATTERNS = [
  new RegExp(String.raw`\b(?:${NAMED}):?\s+${FILLER}(?<refs>${REFS})`, "gi"),
  new RegExp(String.raw`\b(?:${DIRECT}):?\s+(?<refs>${REFS})`, "gi"),
];
const REF_G = new RegExp(REF, "g");
const ENDS = new RegExp(String.raw`\b(?:${NAMED}|${DIRECT}):?\s*$`, "i"); // "merge blocked on:" with the refs on the lines below
const ITEM = new RegExp(String.raw`^\s*[-*+]\s+(?:\[([ xX])\]\s+)?(${REF})\s*$`);
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)/;
const WORD = /[A-Za-z0-9]/;

// An unclosed block runs to the end, as GitHub renders it, so a body of openers is read once.
function clean(md: string): string {
  const lines = md
    .replaceAll(/\r\n?/g, "\n")
    .replaceAll(/<details\b[^<>]*>[\s\S]*?(?:<\/details>|$)/gi, " ")
    .replaceAll(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replaceAll(/```[\s\S]*?(?:```|$)/g, " ")
    .replaceAll(/`[^`\n]*`/g, " ")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith(">"))
    .map((l) => l.replaceAll(/\[([^[\]\n]*)\]\(([^()\s]*)\)/g, (_, text: string, url: string) => (PR_URL.test(url) ? url : text)));
  for (const [i, line] of lines.entries()) {
    if (!ENDS.test(line.replaceAll(/[*_]/g, ""))) continue;
    const refs: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (j === i + 1 && !l.trim()) continue; // "Blocked on:", a blank line, then the list
      const m = ITEM.exec(l);
      if (!m) break;
      if (m[1] === undefined || m[1] === " ") refs.push(m[2]!);
    }
    if (refs.length) lines[i] = `${line} ${refs.join(", ")}`;
  }
  // Emphasis: "**Merge after** x#1" reads "Merge after x#1"; sentry_plugins#12 keeps its underscore.
  return lines
    .join("\n")
    .replaceAll("*", "")
    .replaceAll(/_+/g, (run: string, at: number, s: string) =>
      WORD.test(s[at - 1] ?? "") && WORD.test(s[at + run.length] ?? "") ? run : "",
    );
}

const normal = (ref: string, repo: string): string => {
  const url = PR_URL.exec(ref);
  if (url) return `${url[1]}#${url[2]}`;
  return ref.startsWith("#") ? `${repo}${ref}` : ref;
};

export function requiresOf(md: string, repo: string, number: number): string[] {
  const self = `${repo}#${number}`.toLowerCase();
  const out = new Map<string, string>();
  for (const sentence of clean(md).split(/\n|(?<=[.;!?])\s/))
    for (const p of PATTERNS)
      for (const m of sentence.matchAll(p))
        for (const [ref] of m.groups!.refs!.matchAll(REF_G)) {
          const x = normal(ref, repo);
          const k = x.toLowerCase();
          if (k !== self && !out.has(k)) out.set(k, x);
        }
  return [...out.values()].slice(0, 10);
}

export interface DepFacts {
  requires: string[]; // repo#number, any state: the stack parent, then the description's (unknown refs too; another org's in full)
  open: string[]; // repo#number: open PRs the desk holds that it needs directly, edges that close a loop left out
  needs: string[]; // item.id: the same PRs as open
  closed: string[]; // repo#number: needs closed without merging
  merged: { ref: string; at: string }[]; // needs that merged, oldest first
  root: string | null; // item.id: the open PR at the end of its first open chain; null when nothing open blocks it
  through: string | null; // repo#number: the need that chain goes through, when the root isn't a direct need
  blocks: string[]; // repo#number: open PRs that need this one, directly or not
}

const short = (it: Item) => `${it.repo.split("/")[1]}#${it.number}`;
const orgOf = (ref: string) => ref.slice(0, ref.indexOf("/")).toLowerCase();
// Its author can't pick a blocker in another org, nor one that reads like your org's: only its own org's refs count.
export const sameOrg = (ref: string, it: Item) => orgOf(ref) === orgOf(it.repo);

// Keyed by item.id, open PRs only. Refs the desk doesn't hold, another org's, and issues never block; a loop blocks nobody in it.
export function dependencies(items: Item[], stacks: Stacks): Map<string, DepFacts> {
  const prs = new Map(items.filter((i) => i.kind === "pr").map((i) => [i.id.toLowerCase(), i]));
  const live = [...prs.values()].filter((i) => i.state === "open");
  const facts = new Map<string, DepFacts>();
  const edges = new Map<string, Item[]>();
  for (const x of live) {
    const f: DepFacts = { requires: [], open: [], needs: [], closed: [], merged: [], root: null, through: null, blocks: [] };
    const seen = new Set([x.id.toLowerCase()]);
    const out: Item[] = [];
    for (const ref of [stacks.nodes.get(x.id)?.parent, ...(x.requires ?? [])]) {
      if (!ref || seen.has(ref.toLowerCase())) continue;
      seen.add(ref.toLowerCase());
      const ours = sameOrg(ref, x);
      const y = ours ? prs.get(ref.toLowerCase()) : undefined;
      f.requires.push(y ? short(y) : ours ? ref.slice(ref.indexOf("/") + 1) : ref);
      if (y?.state === "open") out.push(y);
      else if (y?.state === "closed") f.closed.push(short(y));
      else if (y) f.merged.push({ ref: short(y), at: y.closed_at ?? y.updated_at });
    }
    f.merged.sort((a, b) => a.at.localeCompare(b.at));
    facts.set(x.id, f);
    edges.set(x.id, out);
  }
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set([from]);
    const todo = [from];
    for (let i = 0; i < todo.length; i++) {
      if (todo[i] === to) return true;
      for (const y of edges.get(todo[i]!)!) {
        if (seen.has(y.id)) continue;
        seen.add(y.id);
        todo.push(y.id);
      }
    }
    return false;
  };
  // An edge that closes a loop is dropped, so what's kept has none and rootOf ends.
  const kept = new Map([...edges].map(([id, ys]) => [id, ys.filter((y) => !reaches(y.id, id))]));
  const memo = new Map<string, { root: string; through: string | null } | null>();
  const rootOf = (id: string): { root: string; through: string | null } | null => {
    if (memo.has(id)) return memo.get(id)!;
    const [y] = kept.get(id)!;
    const up = y ? rootOf(y.id) : null;
    const r = !y ? null : up ? { root: up.root, through: short(y) } : { root: y.id, through: null };
    memo.set(id, r);
    return r;
  };
  for (const x of live) {
    const f = facts.get(x.id)!;
    const r = rootOf(x.id);
    f.open = kept.get(x.id)!.map(short);
    f.needs = kept.get(x.id)!.map((y) => y.id);
    f.root = r?.root ?? null;
    f.through = r?.through ?? null;
    const reached = new Set<string>();
    const todo = [...kept.get(x.id)!];
    for (let y = todo.pop(); y; y = todo.pop()) {
      if (reached.has(y.id)) continue;
      reached.add(y.id);
      const blocks = facts.get(y.id)!.blocks;
      if (!blocks.includes(short(x))) blocks.push(short(x));
      todo.push(...kept.get(y.id)!);
    }
  }
  return facts;
}

const refOf = (id: string) => id.slice(id.indexOf("/") + 1);

// Blocked as a forest: a chain (rows joined by what they need) at a time, by its oldest wait; in it each PR before the PRs that
// need it, hung under the last of them listed, older waits first. A row names what it needs; a chain says once what its
// blocker waits on: on the blocker's own row when it's listed, else on the first row it blocks. `needsOf` is dependencies()'s
// kept edges, which have no loop.
export function blockedOrder(cards: Card[], needsOf: (id: string) => string[]): Card[] {
  const listed = new Map(cards.map((c) => [c.id, c]));
  const joined = new Map<string, string>();
  const find = (x: string): string => {
    const up = joined.get(x) ?? x;
    if (up === x) return x;
    const top = find(up);
    joined.set(x, top);
    return top;
  };
  // The nearest listed PRs each row needs, through any the page doesn't list; anything it reaches joins its chain.
  const ups = new Map<string, string[]>();
  for (const c of cards) {
    const near: string[] = [];
    const seen = new Set([c.id]);
    const todo = [...needsOf(c.id)];
    for (let y = todo.shift(); y !== undefined; y = todo.shift()) {
      if (seen.has(y)) continue;
      seen.add(y);
      joined.set(find(y), find(c.id));
      if (listed.has(y)) near.push(y);
      else todo.push(...needsOf(y));
    }
    ups.set(c.id, near);
  }
  const older = (a: Card, b: Card) => a.waiting_since.localeCompare(b.waiting_since) || a.id.localeCompare(b.id);
  const kids = new Map<string, Card[]>();
  for (const c of cards.toSorted(older)) for (const y of ups.get(c.id)!) kids.set(y, [...(kids.get(y) ?? []), c]);
  const chains = new Map<string, Card[]>();
  for (const c of cards.toSorted(older)) chains.set(find(c.id), [...(chains.get(find(c.id)) ?? []), c]);
  const placed: Card[] = [];
  const done = new Set<string>();
  const place = (c: Card, depth: number) => {
    done.add(c.id);
    placed.push({ ...c, depth });
    for (const k of kids.get(c.id) ?? []) if (!done.has(k.id) && ups.get(k.id)!.every((y) => done.has(y))) place(k, depth + 1);
  };
  // Each chain's rows come oldest first, so its first is its oldest wait.
  for (const chain of [...chains.values()].toSorted((a, b) => older(a[0]!, b[0]!)))
    for (const c of chain) if (!ups.get(c.id)!.length) place(c, 0);
  // The rows are place()'s copies, so their words change here and not the cards it was given.
  const said = new Set<string>();
  for (const c of placed) {
    if (!c.blocker) continue;
    // Only the desk's own words (the template's "blocked by …, which …"); a rule's own why stays as written.
    const lead = `blocked by ${c.blocker.ref}`;
    const at = c.why.indexOf(lead);
    if (at < 0) continue;
    const which = `, which ${c.blocker.waits}`;
    const rest = c.why.slice(at + lead.length);
    const root = refOf(c.blocker.id);
    const needs = c.needs?.length ? c.needs : [root];
    const tell = !listed.has(c.blocker.id) && !said.has(c.blocker.id);
    said.add(c.blocker.id);
    const tail = !tell ? "" : needs.length === 1 && needs[0] === root ? which : `; ${root} ${c.blocker.waits}`;
    c.why = `${c.why.slice(0, at)}needs ${andMore(needs)}${tail}${rest.startsWith(which) ? rest.slice(which.length) : rest}`;
  }
  return placed;
}
