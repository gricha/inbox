// Each item's log: where it stood on your desk (an Inbox section, Blocked, hidden, off it, resolved) each time that changed,
// with why: its row's why, the rule that placed it, Claude's answer, the criteria that said yes, its score, your moves. Kept
// from the queue as the desk computes it (Desk.queue()), so it says what you'd have seen, and only when something moved.
import { Result, Schema } from "effect";
import type { Core, Desk, Snapshot } from "./desk.ts";
import { decode } from "./narrow.ts";
import { BUCKETS, type Card, type Placed, type PlacedEntry, type QueueView, type Where } from "./types.ts";

type Host = Core & Pick<Desk, "urgency" | "card" | "placementOf">;

const Bucketed = Schema.Literals(BUCKETS);
const PlacedSchema = Schema.Struct({
  where: Schema.Literals(["urgent", "standard", "fyi", "blocked", "hidden", "cleared", "resolved", "gone"]),
  score: Schema.optionalKey(Schema.Number),
  reason: Schema.String,
  rule: Schema.optionalKey(
    Schema.Struct({
      board: Schema.String,
      path: Schema.optionalKey(Schema.String),
      id: Schema.optionalKey(Schema.String),
      why: Schema.String,
      when: Schema.String,
      bucket: Schema.Union([Bucketed, Schema.Literal("judge")]),
    }),
  ),
  judge: Schema.optionalKey(Schema.Struct({ bucket: Schema.NullOr(Bucketed), why: Schema.String, by: Schema.optionalKey(Schema.String) })),
  criteria: Schema.optionalKey(Schema.Array(Schema.String)),
  moved: Schema.optionalKey(Schema.Literals(["urgent", "standard", "fyi"])),
  status: Schema.optionalKey(Schema.Literals(["done", "snoozed", "muted"])),
  resolved: Schema.optionalKey(Schema.String),
});
const EntrySchema = Schema.Struct({ placed: PlacedSchema, changed: Schema.Array(Schema.String) });

// What counts as a change worth an entry: a score that moved a whole point or more, the rest as they are.
function changes(was: Placed | undefined, is: Placed): string[] {
  if (!was) return ["new"];
  const out: string[] = [];
  if (was.where !== is.where) out.push("where");
  if (Math.abs((was.score ?? 0) - (is.score ?? 0)) >= 1) out.push("score");
  const rule = (p: Placed) => (p.rule ? `${p.rule.board} ${p.rule.id ?? p.rule.path ?? ""}` : "");
  if (rule(was) !== rule(is)) out.push("rule");
  if ((was.judge?.bucket ?? null) !== (is.judge?.bucket ?? null) || (was.judge?.by ?? "") !== (is.judge?.by ?? "")) out.push("judge");
  if ((was.criteria ?? []).join("\n") !== (is.criteria ?? []).join("\n")) out.push("criteria");
  if (was.moved !== is.moved) out.push("moved");
  if (was.status !== is.status) out.push("status");
  if (was.resolved !== is.resolved) out.push("resolved");
  return out;
}

export class Placements {
  desk: Host;
  last: Map<string, Placed> | null = null; // every item's latest, read once from the store

  constructor(desk: Host) {
    this.desk = desk;
  }

  latest(): Map<string, Placed> {
    if (this.last) return this.last;
    this.last = new Map();
    for (const row of this.desk.store.placements()) {
      const e = Result.getOrNull(decode(EntrySchema, row.data));
      if (e) this.last.set(row.item_id, e.placed);
    }
    return this.last;
  }

  // Where one card stands, and why.
  placedOf(c: Card, where: Where, snap: Snapshot): Placed {
    const e = snap.entries.get(c.id);
    const p = snap.best.get(c.id);
    const board = this.desk.loaded?.config.boards.find((b) => b.id === p?.board);
    const rule = p && p.rule !== null ? board?.rules[p.rule] : undefined;
    const yes = e ? this.desk.urgency.outcomes(e).filter((o) => o.yes) : [];
    const judge = p?.judge && (p.judge.bucket !== null || p.judge.why) ? p.judge : undefined;
    return {
      where,
      ...(c.score !== undefined && (where === "urgent" || where === "standard" || where === "fyi") && { score: c.score }),
      reason: c.reason ?? c.why,
      ...(c.rule && rule && { rule: { ...c.rule, when: rule.when, bucket: rule.bucket } }),
      ...(judge && { judge: { bucket: judge.bucket, why: judge.why, ...(judge.by !== undefined && { by: judge.by }) } }),
      ...(yes.length > 0 && { criteria: yes.map((o) => o.c.name) }),
      ...(e?.state.section && { moved: e.state.section }),
      ...(c.status !== "active" && { status: c.status }),
      ...(c.resolved && { resolved: c.resolved }),
    };
  }

  // Notes what moved since the queue was last computed: one entry per item whose standing changed.
  note(view: QueueView, snap: Snapshot): void {
    const now: Map<string, Placed> = new Map();
    const put = (cards: Card[], where: Where) => {
      for (const c of cards) if (!now.has(c.id)) now.set(c.id, this.placedOf(c, where, snap));
    };
    put(view.inbox.urgent, "urgent");
    put(view.inbox.standard, "standard");
    put(view.inbox.fyi, "fyi");
    put(view.sections.blocked, "blocked");
    put(view.resolved, "resolved");
    put(view.hidden, "hidden");
    put(view.cleared, "cleared");
    // Resolved where the Inbox doesn't list it (an FYI or a hidden one resolves silently): its log still says so.
    const last = this.latest();
    for (const [id, e] of snap.entries) {
      if (now.has(id) || !e.resolved || last.get(id)?.resolved === e.resolved.reason) continue;
      put([this.desk.card(e, this.desk.placementOf(id, snap), snap)], "resolved");
    }
    const at = this.desk.now().toISOString();
    const rows: { at: string; item_id: string; data: unknown }[] = [];
    for (const [id, placed] of now) {
      const changed = changes(last.get(id), placed);
      if (!changed.length) continue;
      rows.push({ at, item_id: id, data: { placed, changed } });
      last.set(id, placed);
    }
    // An item the desk no longer holds left every search: its log says so once.
    for (const [id, was] of last) {
      if (now.has(id) || snap.entries.has(id) || was.where === "gone") continue;
      const placed: Placed = { where: "gone", reason: "no search returns it any more" };
      rows.push({ at, item_id: id, data: { placed, changed: ["where"] } });
      last.set(id, placed);
    }
    if (rows.length) this.desk.store.addPlacements(rows);
  }

  // One item's log, newest first.
  log(id: string): PlacedEntry[] {
    return this.desk.store.placements(id).flatMap((row) => {
      const e = Result.getOrNull(decode(EntrySchema, row.data));
      return e ? [{ ...e.placed, seq: row.seq, at: row.at, changed: [...e.changed] }] : [];
    });
  }
}

// An item's log as text (inbox show, inbox_item): each move, newest first, with what it rested on. Reasons and whys are
// GitHub or model text: the caller fences them.
export function logLines(log: readonly PlacedEntry[]): string[] {
  if (!log.length) return [];
  const one = (s: string) => s.replaceAll(/\s+/g, " ").trim();
  return [
    "log (where it stood each time that changed, newest first):",
    ...log.flatMap((e) => [
      `  ${e.at} ${e.where}${e.score === undefined ? "" : ` ${e.score}`} (${e.changed.join(", ")})${e.reason ? `: ${one(e.reason)}` : ""}`,
      ...(e.rule ? [`    rule ${e.rule.id ?? e.rule.path ?? ""} on ${e.rule.board} (${e.rule.bucket}): ${e.rule.when}`] : []),
      ...(e.judge ? [`    ${e.judge.by ?? "judge"}: ${e.judge.bucket ?? "no answer"}${e.judge.why ? `, ${one(e.judge.why)}` : ""}`] : []),
      ...(e.criteria?.length ? [`    criteria yes: ${e.criteria.join(", ")}`] : []),
      ...(e.moved ? [`    you moved it to ${e.moved}`] : []),
      ...(e.status ? [`    ${e.status}`] : []),
      ...(e.resolved ? [`    resolved: ${one(e.resolved)}`] : []),
    ]),
  ];
}
