// The owner's "after" links (kv `after:<id>`): "B after A" means B waits until A is complete. The desk keeps them and
// GitHub never sees them, so they chain anyone's PRs, issues and notes. Pure.

export const NOTE = "note:"; // a note as a node: "note:<its id>"

// complete: a merged PR, a closed issue, a note marked done (gone); broken: a PR closed without merging, which never completes.
export type NodeState = "open" | "complete" | "broken";

export interface Chains {
  head: Map<string, string>; // each waiting node: the node it hangs under, the nearest that isn't waiting
  steps: Map<string, string[]>; // each head: its waiting nodes, in the order they run
  waits: Map<string, string[]>; // each waiting node: its prerequisites not yet complete, in the order they run
}

// Prerequisites before what comes after them; otherwise by id, so the order holds from one pass to the next.
function runOrder(links: ReadonlyMap<string, readonly string[]>): Map<string, number> {
  const order = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (order.has(id) || visiting.has(id)) return; // a loop setAfter refused can't be here; one that is still ends
    visiting.add(id);
    for (const p of (links.get(id) ?? []).toSorted()) visit(p);
    order.set(id, order.size);
  };
  for (const id of [...new Set([...links.keys(), ...[...links.values()].flat()])].toSorted()) visit(id);
  return order;
}

// A node waits while it isn't complete and a prerequisite isn't. It hangs under the last of those in the order they run,
// or under what that one hangs under, so each chain is one row.
export function chains(links: ReadonlyMap<string, readonly string[]>, stateOf: (id: string) => NodeState): Chains {
  const order = runOrder(links);
  const at = (id: string) => order.get(id) ?? -1;
  const waits = new Map<string, string[]>();
  for (const [id, after] of links) {
    if (stateOf(id) === "complete") continue;
    const open = after.filter((p) => stateOf(p) !== "complete").toSorted((a, b) => at(a) - at(b));
    if (open.length) waits.set(id, open);
  }
  const head = new Map<string, string>();
  const headOf = (id: string, seen: Set<string>): string => {
    const known = head.get(id);
    if (known) return known;
    const last = waits.get(id)!.at(-1)!;
    const h = waits.has(last) && !seen.has(last) ? headOf(last, seen.add(last)) : last;
    head.set(id, h);
    return h;
  };
  const steps = new Map<string, string[]>();
  for (const id of [...waits.keys()].toSorted((a, b) => at(a) - at(b))) {
    const h = headOf(id, new Set([id]));
    steps.set(h, [...(steps.get(h) ?? []), id]);
  }
  return { head, steps, waits };
}

// The prerequisite that would close a loop if `id` came after `after`: one that is `id`, or comes after it already.
export function loopThrough(links: ReadonlyMap<string, readonly string[]>, id: string, after: readonly string[]): string | null {
  for (const p of after) {
    const seen = new Set<string>();
    const todo = [p];
    for (let x = todo.pop(); x !== undefined; x = todo.pop()) {
      if (x === id) return p;
      if (seen.has(x)) continue;
      seen.add(x);
      todo.push(...(links.get(x) ?? []));
    }
  }
  return null;
}
