// Places items on a board: filter, first matching rule, caps, sort.
import type { BoardConfig, Bucket, ConfigError, JudgeStep, Placement, Signals, TraceStep } from "./types.ts";
import { compile, renderTemplate, type Compiled } from "./expr.ts";

export interface CompiledBoard {
  config: BoardConfig;
  filter: Compiled | null;
  priority: Compiled | null;
  rules: Compiled[];
}

export function compileBoard(board: BoardConfig, path: string): { board: CompiledBoard; errors: ConfigError[] } {
  const errors: ConfigError[] = [];
  const filter = board.filter ? compile(board.filter) : null;
  if (filter && !filter.ok) errors.push({ path: `${path}.filter`, message: filter.error });
  const priority = board.priority ? compile(board.priority) : null;
  if (priority && !priority.ok) errors.push({ path: `${path}.priority`, message: priority.error });
  const rules = board.rules.map((r, i) => {
    const c = compile(r.when);
    if (!c.ok) errors.push({ path: `${path}.rules[${i}].when`, message: c.error });
    return c;
  });
  return { board: { config: board, filter, priority, rules }, errors };
}

export interface Entry {
  id: string;
  signals: Signals;
  waiting_since: string;
  updated_at: string;
  created_at: string;
  activity_at: string;
  pinned: boolean;
  active: boolean; // not done, snoozed or muted; only active items count toward caps
  kept?: boolean; // gone from the board's searches but shown as resolved: the filter judged it while it was there
}

export interface BoardResult {
  placements: Map<string, Placement>;
  order: Record<Bucket, string[]>; // active items, sorted
  inactive: string[]; // on the board but done/snoozed/muted
}

function truthy(c: Compiled, s: Signals): { matched: boolean; error?: string } {
  if (!c.ok) return { matched: false, error: c.error };
  try {
    return { matched: Boolean(c.eval(s)) };
  } catch (e) {
    return { matched: false, error: (e as Error).message };
  }
}

// The policy judge's answer for an item, while judging is on.
export type JudgeLookup = (id: string) => JudgeStep;

function place(board: CompiledBoard, e: Entry, judge?: JudgeLookup): Placement | null {
  const trace: TraceStep[] = [];
  const cfg = board.config;
  const s = e.signals;
  if (board.filter && cfg.filter && !e.kept) {
    const r = truthy(board.filter, s);
    trace.push({ index: -1, when: cfg.filter, ...r });
    if (!r.matched) return null;
  }
  // The gray zone: the board default, unless the judge placed it. Its empty why (the policy says nothing) keeps the rules'.
  const gray = (rule: number | null, why: string): Placement => {
    const p: Placement = { board: cfg.id, bucket: cfg.default, rule_bucket: cfg.default, rule, why: renderTemplate(why, s), trace };
    if (!judge) return p;
    const j = judge(e.id);
    if (j.bucket === null) return { ...p, judge: j };
    return { ...p, bucket: j.bucket, rule_bucket: j.bucket, why: j.why.trim() ? j.why : p.why, judge: j };
  };
  for (const [i, c] of board.rules.entries()) {
    const rule = cfg.rules[i]!; // board.rules is compiled 1:1 from cfg.rules
    const r = truthy(c, s);
    trace.push({ index: i, when: rule.when, ...r });
    if (!r.matched) continue;
    if (rule.bucket === "judge") return gray(i, rule.why?.trim() ? rule.why : cfg.default_why);
    return { board: cfg.id, bucket: rule.bucket, rule_bucket: rule.bucket, rule: i, why: renderTemplate(rule.why ?? "", s), trace };
  }
  return gray(null, cfg.default_why);
}

const SORTS: Record<BoardConfig["sort"], (a: Entry, b: Entry) => number> = {
  waiting: (a, b) => a.waiting_since.localeCompare(b.waiting_since),
  updated: (a, b) => b.activity_at.localeCompare(a.activity_at),
  newest: (a, b) => b.created_at.localeCompare(a.created_at),
};

// "quiet for 16 days", "quiet for 3 weeks", "quiet for 5 months"
export function quietText(hours: number): string {
  const days = Math.floor(hours / 24);
  if (days < 14) return `quiet for ${days} days`;
  return days < 60 ? `quiet for ${Math.round(days / 7)} weeks` : `quiet for ${Math.round(days / 30)} months`;
}

// Quiet items (nobody touched them in `quietDays`, 0 = off) leave Now and Today for Later, then caps apply after the judge.
export function classify(board: CompiledBoard, entries: Entry[], judge?: JudgeLookup, quietDays = 0): BoardResult {
  const cfg = board.config;
  const placements = new Map<string, Placement>();
  const byBucket: Record<Bucket, Entry[]> = { now: [], today: [], later: [], fyi: [], hide: [] };
  const inactive: string[] = [];
  for (const e of entries) {
    const p = place(board, e, judge);
    if (!p) continue;
    placements.set(e.id, p);
    if (e.active) byBucket[p.bucket].push(e);
    else inactive.push(e.id);
  }
  const sort = SORTS[cfg.sort];
  const prio = new Map<string, number>();
  if (board.priority?.ok) {
    for (const e of entries) {
      try {
        prio.set(e.id, Number(board.priority.eval(e.signals)) || 0);
      } catch {
        prio.set(e.id, 0);
      }
    }
  }
  const rank = (e: Entry) => prio.get(e.id) ?? 0;
  // An earlier rule is a stronger reason, so it also wins the capped slots.
  const ruleOf = (e: Entry) => placements.get(e.id)!.rule ?? Infinity;
  for (const b of Object.keys(byBucket) as Bucket[]) {
    byBucket[b].sort(
      (x, y) => Number(y.pinned) - Number(x.pinned) || ruleOf(x) - ruleOf(y) || rank(y) - rank(x) || sort(x, y) || x.id.localeCompare(y.id),
    );
  }

  const quietHours = quietDays * 24;
  // A review you were asked for in that time is never quiet, whatever GitHub's updatedAt says.
  const quiet = (e: Entry) => {
    const s = e.signals;
    const asked = s.me.requested_hours >= 0 && s.me.requested_hours < quietHours;
    return quietDays > 0 && !e.pinned && !asked && s.item.updated_hours >= quietHours;
  };
  for (const b of ["now", "today"] as const) {
    const gone = byBucket[b].filter(quiet);
    for (const e of gone) {
      const p = placements.get(e.id)!;
      p.bucket = "later";
      p.demoted = quietText(e.signals.item.updated_hours);
    }
    byBucket[b] = byBucket[b].filter((e) => !gone.includes(e));
    byBucket.later = [...byBucket.later, ...gone];
  }

  const exempt = (e: Entry) => {
    if (e.pinned) return true;
    const rule = placements.get(e.id)!.rule;
    return rule !== null && cfg.rules[rule]?.nocap === true;
  };
  const demote = (from: "now" | "today", to: Bucket, cap: number | undefined) => {
    if (cap === undefined) return;
    let counted = 0;
    const keep: Entry[] = [],
      over: Entry[] = [];
    for (const e of byBucket[from]) {
      if (exempt(e)) keep.push(e);
      else if (counted < cap) {
        keep.push(e);
        counted++;
      } else over.push(e);
    }
    for (const e of over) {
      const p = placements.get(e.id)!;
      p.bucket = to;
      // Caps are per board, so the note names it: Now across boards can hold more than one board's cap.
      p.demoted = `${from.charAt(0).toUpperCase()}${from.slice(1)} was full on ${cfg.name} (${cap})`;
    }
    byBucket[from] = keep;
    byBucket[to] = [...over, ...byBucket[to]];
  };
  demote("now", "today", cfg.caps?.now);
  demote("today", "later", cfg.caps?.today);

  const order = Object.fromEntries(Object.entries(byBucket).map(([b, list]) => [b, list.map((e) => e.id)])) as Record<Bucket, string[]>;
  return { placements, order, inactive };
}
