// Places items on a board: filter, first matching rule, caps, sort.
import { Result } from "effect";
import type { BoardConfig, Bucket, Card, ConfigError, JudgeStep, Placement, Signals, TraceStep } from "./types.ts";
import { RANK } from "./types.ts";
import type { ExprSyntaxError } from "./errors.ts";
import { compile, renderTemplate, type Compiled } from "./expr.ts";

type Expr = Result.Result<Compiled, ExprSyntaxError>;

export interface CompiledBoard {
  config: BoardConfig;
  filter: Expr | null;
  priority: Expr | null;
  rules: Expr[];
}

export function compileBoard(board: BoardConfig, path: string): { board: CompiledBoard; errors: ConfigError[] } {
  const errors: ConfigError[] = [];
  const at = (where: string, src: string): Expr => {
    const c = compile(src);
    if (Result.isFailure(c)) errors.push({ path: `${path}.${where}`, message: c.failure.message });
    return c;
  };
  const filter = board.filter ? at("filter", board.filter) : null;
  const priority = board.priority ? at("priority", board.priority) : null;
  const rules = board.rules.map((r, i) => at(`rules[${i}].when`, r.when));
  return { board: { config: board, filter, priority, rules }, errors };
}

export interface Entry {
  id: string;
  signals: Signals;
  waiting_since: string;
  created_at: string;
  activity_at: string;
  pinned: boolean;
  floor?: Bucket; // your pin keeps it at least here
  floor_why?: string; // why, when the floor is what puts it there: an automation's pin says its own
  active: boolean; // not done, snoozed or muted; only active items count toward caps
  kept?: boolean; // gone from the board's searches but shown as resolved: the filter judged it while it was there
  ai?: "look" | "skim" | "skip"; // the AI review's call on its current commit (high risk is "look"); none yet: undefined
}

export interface BoardResult {
  placements: Map<string, Placement>;
  order: Record<Bucket, string[]>; // active items, sorted
  inactive: string[]; // on the board but done/snoozed/muted
}

// A rule that doesn't compile, or can't be worked out for this item, doesn't match: its trace says why.
function truthy(c: Expr, s: Signals): { matched: boolean; error?: string } {
  if (Result.isFailure(c)) return { matched: false, error: c.failure.message };
  const v = c.success.eval(s);
  return Result.isSuccess(v) ? { matched: Boolean(v.success) } : { matched: false, error: v.failure.message };
}

// The policy judge's answer for an item while judging is on, or an automation's sort of it; null: nobody sorts it.
export type JudgeLookup = (id: string) => JudgeStep | null;

// A hard rule's floor: Today for a Now rule, so Claude still picks Now or Today for what it matches.
export const floorOf = (b: Bucket): Bucket => (b === "now" ? "today" : b);
// `b`, or `floor` when that's more urgent.
const atLeast = (b: Bucket, floor: Bucket | undefined): Bucket => (floor && RANK[floor] < RANK[b] ? floor : b);

function place(board: CompiledBoard, e: Entry, judge?: JudgeLookup): Placement | null {
  const trace: TraceStep[] = [];
  const cfg = board.config;
  const s = e.signals;
  if (board.filter && cfg.filter && !e.kept) {
    const r = truthy(board.filter, s);
    trace.push({ index: -1, when: cfg.filter, ...r });
    if (!r.matched) return null;
  }
  // Where the rules put it is Claude's hint, and holds until it answers. Its empty why keeps the rules'. Below a hard
  // rule's floor, or your pin's, the floor holds with the rule's why. An automation's sort is bound the same, and says its name.
  const judged = (rule: number | null, ruled: Bucket, why: string, hard?: Bucket, final?: boolean): Placement => {
    const floor = e.floor ? atLeast(e.floor, hard) : hard;
    const bucket = atLeast(ruled, floor);
    const lifted = (from: Bucket, to: Bucket) => (to !== from ? e.floor_why : undefined);
    const p: Placement = {
      board: cfg.id,
      bucket,
      rule_bucket: bucket,
      rule,
      why: lifted(ruled, bucket) ?? renderTemplate(why, s),
      trace,
      ...(hard && { hard: true }),
      ...(floor && { floor }),
    };
    const j = judge?.(e.id);
    if (!j) return p;
    const hint = { bucket: ruled, why: p.why };
    if (final) return { ...p, hint }; // a final rule: Claude doesn't re-sort it
    if (j.bucket === null) return { ...p, judge: j, hint };
    const to = atLeast(j.bucket, floor);
    const said = j.by ? `${j.by}: ${j.why}` : j.why;
    const own = to === j.bucket && j.why.trim() ? said : (lifted(j.bucket, to) ?? p.why);
    return { ...p, bucket: to, rule_bucket: to, why: own, judge: j, hint };
  };
  for (const [i, c] of board.rules.entries()) {
    const rule = cfg.rules[i]!; // board.rules is compiled 1:1 from cfg.rules
    const r = truthy(c, s);
    trace.push({ index: i, when: rule.when, ...r });
    if (!r.matched) continue;
    if (rule.bucket === "judge") return judged(i, cfg.default, rule.why?.trim() ? rule.why : cfg.default_why);
    return judged(i, rule.bucket, rule.why ?? "", rule.hard ? floorOf(rule.bucket) : undefined, rule.final);
  }
  return judged(null, cfg.default, cfg.default_why);
}

// Who placed it, for its card: Claude or an automation where it chose the bucket (a hard rule's floor, or a pin's, may
// overrule it), else a hard rule, a pin, or the rules while Claude hasn't answered (or gave no answer).
export function placedBy(p: Placement): Card["placed_by"] {
  if (p.judge?.bucket && p.judge.bucket === p.rule_bucket) return p.judge.by ? "automation" : "claude";
  if (p.hard) return "hard";
  if (p.floor && p.hint && p.rule_bucket !== (p.judge?.bucket ?? p.hint.bucket)) return "pin";
  if (!p.judge) return undefined;
  return p.judge.pending ? "pending" : "unanswered";
}

// Weightiest first: handed back, close looks (current commit first), capped, yours approved and green, the rest, others' red, skips.
export function queueOrder(cards: Card[], me: string): Card[] {
  const weight = (c: Card) => {
    const p = c.preflight;
    const mine = c.kind === "pr" && !c.resolved && !!me && c.author.toLowerCase() === me.toLowerCase();
    if (c.handed_back) return 0;
    if (p?.verdict === "skip") return 7;
    if (!mine && c.kind === "pr" && c.ci === "red") return 6;
    if (p?.risk === "high" || p?.verdict === "look") return p.state === "ready" ? 1 : 2;
    if (c.demoted) return 3;
    return mine && c.ci === "green" && c.chips.includes("approved") ? 4 : 5;
  };
  return cards
    .map((c, i) => ({ c, i, w: weight(c) }))
    .sort((a, b) => a.w - b.w || a.i - b.i)
    .map((x) => x.c);
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

// Over a board's cap, in the Inbox's words: it's one list, so "now" is urgency and "today" a place on it.
export const capText = (from: "now" | "today", cap: number, board: string): string =>
  from === "now" ? `${cap} from ${board} ${cap === 1 ? "is" : "are"} urgent already` : `the Inbox has ${cap} from ${board} already`;

// Quiet items (nobody touched them in `quietDays`, 0 = off) leave Now and Today for Later, then caps apply after the judge.
// Neither moves an item below a hard rule's floor.
export function classify(board: CompiledBoard, entries: Entry[], judge?: JudgeLookup, quietDays = 0): BoardResult {
  const cfg = board.config;
  const placements = new Map<string, Placement>();
  const byBucket: Record<Bucket, Entry[]> = { now: [], today: [], blocked: [], later: [], fyi: [], hide: [] };
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
  if (board.priority && Result.isSuccess(board.priority)) {
    const priority = board.priority.success;
    for (const e of entries) {
      const v = priority.eval(e.signals);
      prio.set(e.id, Result.isSuccess(v) ? Number(v.success) || 0 : 0); // one it can't work out sorts as 0
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
    for (const e of byBucket[b].filter(quiet)) {
      const p = placements.get(e.id)!;
      const to = atLeast("later", p.floor);
      if (to === b) continue;
      p.bucket = to;
      p.demoted = quietText(e.signals.item.updated_hours);
      byBucket[b] = byBucket[b].filter((x) => x !== e);
      byBucket[to].push(e);
    }
  }

  const exempt = (e: Entry, to: Bucket) => {
    const p = placements.get(e.id)!;
    if (e.pinned || atLeast(to, p.floor) !== to) return true;
    return p.rule !== null && cfg.rules[p.rule]?.nocap === true;
  };
  const demote = (from: "now" | "today", to: Bucket, cap: number | undefined) => {
    if (cap === undefined) return;
    const counts = byBucket[from].filter((e) => !exempt(e, to));
    // Over the cap, the lightest call leaves first: a close look keeps its slot, then one not reviewed yet, skim, skip.
    const weight = (e: Entry) => (e.ai === "look" ? 0 : e.ai === undefined ? 1 : e.ai === "skim" ? 2 : 3);
    const kept = new Set(counts.length > cap ? counts.toSorted((x, y) => weight(x) - weight(y)).slice(0, cap) : counts);
    const keep = byBucket[from].filter((e) => exempt(e, to) || kept.has(e));
    const over = byBucket[from].filter((e) => !keep.includes(e));
    for (const e of over) {
      const p = placements.get(e.id)!;
      p.bucket = to;
      // Caps are per board, and the queue across boards can hold more than one board's cap: the note says what this board gets.
      p.demoted = e.ai === "skip" ? "the AI says skip it" : capText(from, cap, cfg.name);
    }
    byBucket[from] = keep;
    byBucket[to] = [...over, ...byBucket[to]];
  };
  demote("now", "today", cfg.caps?.now);
  demote("today", "later", cfg.caps?.today);

  const order = Object.fromEntries(Object.entries(byBucket).map(([b, list]) => [b, list.map((e) => e.id)])) as Record<Bucket, string[]>;
  return { placements, order, inactive };
}
