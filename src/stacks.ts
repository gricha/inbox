// Stacks of PRs, from the PRs the desk holds: in one repo, each based on the head branch of the one below it. Pure.
import type { Bucket, Card, Item, Stack, StackMember, StackRef } from "./types.ts";

const SLACK = 5 * 60_000; // GitHub moves a stacked PR to main seconds after the one below it merges
const STATE: Record<Item["state"], number> = { open: 0, merged: 1, closed: 2 };

interface Node {
  item: Item;
  parent: string | null;
  children: string[]; // the main branch first: open PRs above it, then the longest, then the oldest
  depth: number; // 0 at the bottom
  root: string;
  main: boolean; // on the bottom PR's line
}

export interface Stacks {
  nodes: Map<string, Node>; // every PR in a stack of two or more; a closed PR with nothing open or merged above it isn't
  open: Map<string, number>; // per stack (its bottom PR's id): its open PRs
}

// Where the desk has the PR on the queue, for a stack's members.
export interface Seat {
  bucket: Bucket | null;
  why: string;
  new: boolean;
  inflight: boolean;
}

export interface Probe {
  repo: string;
  dir: "up" | "down"; // up: the PR whose head is `branch`; down: open PRs based on it
  branch: string;
}

const lc = (s: string) => s.toLowerCase();
const key = (repo: string, branch: string) => `${lc(repo)}\n${branch}`;
// Another PR in the repo can be based only on a branch of the repo itself, not on a fork's.
const ownBranch = (it: Item) => !!it.head_ref && (it.head_repo === undefined || lc(it.head_repo) === lc(it.repo));
export const probeKey = (p: Probe) => `${lc(p.repo)} ${p.dir} ${p.branch}`;

// The repo's default branch: the PR's own, else another PR's in the repo (older items don't have it).
function defaults(items: Item[]): (it: Item) => string {
  const known = new Map<string, string>();
  for (const it of items) if (it.default_branch) known.set(lc(it.repo), it.default_branch);
  return (it) => [it.default_branch, known.get(lc(it.repo))].find(Boolean) ?? "";
}

function parentOf(it: Item, heads: Map<string, Item[]>, main: string): Item | null {
  const on = (branch: string) => (heads.get(key(it.repo, branch)) ?? []).filter((p) => p.id !== it.id);
  if (it.base && it.base !== main) {
    const [best] = on(it.base).toSorted((a, b) => STATE[a.state] - STATE[b.state] || b.updated_at.localeCompare(a.updated_at));
    if (best) return best;
  }
  // Moved off a branch whose PR had just merged: that PR is below it.
  const r = it.retargeted;
  if (!r || r.from === it.base) return null;
  const by = Date.parse(r.at) + SLACK;
  const [merged] = on(r.from)
    .filter((p) => p.state === "merged" && Date.parse(p.closed_at ?? "") <= by)
    .toSorted((a, b) => (b.closed_at ?? "").localeCompare(a.closed_at ?? ""));
  return merged ?? null;
}

export function buildStacks(items: Item[]): Stacks {
  const prs = items.filter((i) => i.kind === "pr");
  const heads = new Map<string, Item[]>();
  for (const it of prs) {
    if (!ownBranch(it)) continue;
    const k = key(it.repo, it.head_ref!);
    heads.set(k, [...(heads.get(k) ?? []), it]);
  }
  const mainOf = defaults(prs);
  const parent = new Map<string, Item>();
  for (const it of prs) {
    const p = parentOf(it, heads, mainOf(it));
    if (p) parent.set(it.id, p);
  }
  // Stale data can loop (A on B, B on A): cut the link that closes it.
  for (const id of parent.keys()) {
    const seen = new Set([id]);
    for (let x = id, y = parent.get(x); y; x = y.id, y = parent.get(x)) {
      if (seen.has(y.id)) {
        parent.delete(x);
        break;
      }
      seen.add(y.id);
    }
  }
  const byId = new Map(prs.map((i) => [i.id, i]));
  const kids = new Map<string, string[]>();
  for (const [id, p] of parent) kids.set(p.id, [...(kids.get(p.id) ?? []), id]);
  const memo = new Map<string, { alive: boolean; open: boolean; height: number }>();
  const facts = (id: string): { alive: boolean; open: boolean; height: number } => {
    const got = memo.get(id);
    if (got) return got;
    const it = byId.get(id)!;
    const below = (kids.get(id) ?? []).map(facts).filter((f) => f.alive);
    const f = {
      alive: it.state !== "closed" || below.length > 0,
      open: it.state === "open" || below.some((b) => b.open),
      height: 1 + Math.max(0, ...below.map((b) => b.height)),
    };
    memo.set(id, f);
    return f;
  };
  const nodes = new Map<string, Node>();
  const open = new Map<string, number>();
  for (const it of prs) {
    if (parent.has(it.id) || !facts(it.id).alive) continue;
    const tree: Node[] = [];
    const walk = (id: string, up: string | null, depth: number, main: boolean) => {
      const children = (kids.get(id) ?? [])
        .filter((c) => facts(c).alive)
        .toSorted(
          (a, b) =>
            Number(facts(b).open) - Number(facts(a).open) || facts(b).height - facts(a).height || byId.get(a)!.number - byId.get(b)!.number,
        );
      tree.push({ item: byId.get(id)!, parent: up, children, depth, root: it.id, main });
      children.forEach((c, i) => {
        walk(c, id, depth + 1, main && i === 0);
      });
    };
    walk(it.id, null, 0, true);
    if (tree.length < 2) continue;
    for (const n of tree) nodes.set(n.item.id, n);
    open.set(it.id, tree.filter((n) => n.item.state === "open").length);
  }
  return { nodes, open };
}

// Bottom to top through `id`: the PRs below it, then up the main branch at each fork.
export function lineOf(s: Stacks, id: string): string[] {
  const line: string[] = [];
  for (let n = s.nodes.get(id); n; n = n.parent ? s.nodes.get(n.parent) : undefined) line.unshift(n.item.id);
  for (let n = s.nodes.get(id); n?.children[0]; n = s.nodes.get(n.children[0])) line.push(n.children[0]);
  return line;
}

// An open PR's place among the open PRs of its line, in a stack with two or more open: the stack still to land. The merged
// PRs below it are in the stack's chain, not in the count.
export function stackRef(s: Stacks, id: string): StackRef | undefined {
  const n = s.nodes.get(id);
  if (n?.item.state !== "open" || (s.open.get(n.root) ?? 0) < 2) return undefined;
  const line = lineOf(s, id).filter((x) => s.nodes.get(x)!.item.state === "open");
  return { id: n.root, pos: line.indexOf(id) + 1, size: line.length };
}

// Lower in the stack: nearer the bottom, then on the main line before a fork's other branch.
const below = (s: Stacks, a: string, b: string) => {
  const x = s.nodes.get(a)!;
  const y = s.nodes.get(b)!;
  return x.depth - y.depth || Number(y.main) - Number(x.main);
};

// A queue view lists a stack once. Of its members with a card in these sections (open ones, in a stack with a ref), the one
// in the most urgent section stands for it, the lowest in the stack on a tie (stacks are reviewed and merged bottom up);
// the others leave the sections and are named, bottom first, on that card's stack.folded. Returns the cards that stand
// for a stack.
export function oneLinePerStack<K extends string>(sections: Record<K, Card[]>, order: readonly K[], s: Stacks): Card[] {
  const lead = new Map<string, { card: Card; rank: number }>();
  const members = new Map<string, string[]>();
  order.forEach((k, rank) => {
    for (const c of sections[k]) {
      const n = c.stack && s.nodes.get(c.id);
      if (!n) continue;
      members.set(n.root, [...(members.get(n.root) ?? []), c.id]);
      const cur = lead.get(n.root);
      if (!cur || (cur.rank === rank && below(s, c.id, cur.card.id) < 0)) lead.set(n.root, { card: c, rank });
    }
  });
  const leads = new Set([...lead.values()].map((l) => l.card));
  for (const k of order) sections[k] = sections[k].filter((c) => !c.stack || leads.has(c));
  for (const card of leads) {
    const n = s.nodes.get(card.id)!;
    const folded = members
      .get(n.root)!
      .filter((id) => id !== card.id)
      .toSorted((a, b) => below(s, a, b));
    card.stack = { ...stackRef(s, card.id)!, folded };
  }
  return [...leads];
}

// The stack `current` is in, as a view shows it; null when it's in none.
export function stackView(s: Stacks, current: string, seat: (id: string) => Seat): Stack | null {
  const n = s.nodes.get(current);
  if (!n) return null;
  const root = s.nodes.get(n.root)!;
  const line = lineOf(s, current);
  const on = new Set(line);
  const all: string[] = [];
  const walk = (id: string) => {
    all.push(id);
    for (const c of s.nodes.get(id)!.children) walk(c);
  };
  walk(n.root);
  const member = (id: string): StackMember => {
    const it = s.nodes.get(id)!.item;
    const at = seat(id);
    return {
      id,
      number: it.number,
      title: it.title,
      url: it.url,
      author: it.author,
      state: it.state,
      draft: it.draft,
      ci: it.ci,
      review: it.review_decision,
      parent: s.nodes.get(id)!.parent,
      current: id === current,
      bucket: at.bucket,
      why: at.why,
      needs_you: at.bucket === "now" || at.bucket === "today",
      new: at.new,
      inflight: at.inflight,
    };
  };
  const members = line.map(member);
  const forks = all.filter((id) => !on.has(id)).map(member);
  const i = line.indexOf(current);
  return {
    id: n.root,
    repo: root.item.repo,
    base: root.item.base,
    line: members,
    forks,
    current,
    up: line[i + 1] ?? null,
    down: line[i - 1] ?? null,
    needs_you: [...members, ...forks].filter((m) => m.needs_you).length,
  };
}

// A stack's rows together where the first of them was, bottom first.
export function grouped<T>(rows: T[], idOf: (row: T) => string, s: Stacks): T[] {
  const slots: T[][] = [];
  const byRoot = new Map<string, T[]>();
  for (const r of rows) {
    const root = s.nodes.get(idOf(r))?.root;
    const g = root ? byRoot.get(root) : undefined;
    if (g) g.push(r);
    else {
      slots.push([r]);
      if (root) byRoot.set(root, slots.at(-1)!);
    }
  }
  return slots.flatMap((g) => (g.length > 1 ? g.toSorted((a, b) => below(s, idOf(a), idOf(b))) : g));
}

// What to fetch for the stacks of the PRs on the boards (`listed`), which the desk may see only part of. Probes: up, the
// PR whose branch a bottom PR is based on (or was, before the one below it merged); down, open PRs based on an open PR's
// branch. Stale: members no board lists, still open as of a fetch before `before`.
export function toFetch(items: Item[], s: Stacks, listed: Set<string>, before: string): { probes: Probe[]; stale: Item[] } {
  const byId = new Map(items.map((i) => [i.id, i]));
  const roots = new Set([...listed].map((id) => s.nodes.get(id)?.root));
  const ids = new Set(listed);
  for (const [id, n] of s.nodes) if (roots.has(n.root)) ids.add(id);
  const mainOf = defaults(items);
  const probes = new Map<string, Probe>();
  const add = (p: Probe) => probes.set(probeKey(p), p);
  const stale: Item[] = [];
  for (const id of ids) {
    const it = byId.get(id);
    if (!it || it.kind !== "pr" || it.state === "closed") continue;
    if (!listed.has(id) && it.state === "open" && it.detail_at < before) stale.push(it);
    const main = mainOf(it);
    if (main && !s.nodes.get(id)?.parent) {
      if (it.base && it.base !== main) add({ repo: it.repo, dir: "up", branch: it.base });
      else if (it.retargeted && it.retargeted.from !== main) add({ repo: it.repo, dir: "up", branch: it.retargeted.from });
    }
    if (it.state === "open" && ownBranch(it)) add({ repo: it.repo, dir: "down", branch: it.head_ref! });
  }
  return { probes: [...probes.values()], stale };
}
