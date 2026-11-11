// A review's reading order (src/review.ts's reviewOrder) as the stretches a page draws: by importance, or the walk-through's
// steps. The window's review (web/src/components/Review.tsx) and a rendered review document (src/render.ts) both read it.
import type { AiReview, ReviewFile, ReviewHunk, ReviewNote, ReviewOrder } from "./types.ts";

// The review's words for what it is.
export const VERDICT = { look: "Look closely", skim: "Skim it", skip: "Skip it" };
export const LEVEL: Record<NonNullable<Section["level"]>, string> = { look: "Look", skim: "Skim", unread: "Not read", skip: "Skip" };
export const STATUS: Partial<Record<ReviewFile["status"], string>> = {
  added: "new",
  removed: "deleted",
  renamed: "renamed",
  copied: "copied",
};
export const FIT: Partial<Record<NonNullable<AiReview["intent"]>["fit"], string>> = {
  partial: "Not quite what the description says",
  differs: "Not what the description says",
};

// One stretch of the review: a file's hunks next to each other in the desk's order, at one level and for one reason.
export interface Section {
  key: string;
  path: string;
  file: number; // index in ReviewView.files
  level: ReviewHunk["level"]; // skip: Claude left it out, or under a ranked review's fold; null: no ranking
  why: string | null; // Claude's few words, why it wasn't read, or why the desk folded the file
  hunks: ReviewHunk[]; // none for a file with no text diff
  notes: number[]; // indices into ai.notes, in reading order
}

// A file's neighbouring hunks at one level and for one reason, as one section.
function grouped(hunks: ReviewHunk[], list: Section[] = []): Section[] {
  const from = list.length;
  for (const h of hunks) {
    const last = list.length > from ? list.at(-1) : undefined;
    if (last?.path === h.path && last.level === h.level && last.why === h.why) {
      last.hunks.push(h);
      last.notes.push(...h.notes);
    } else list.push({ key: h.id, path: h.path, file: h.file, level: h.level, why: h.why, hunks: [h], notes: [...h.notes] });
  }
  return list;
}

const restOf = (o: ReviewOrder): Section[] =>
  o.rest.map((r) => ({
    key: `rest:${r.path}`,
    path: r.path,
    file: r.file,
    level: o.ranked ? "skip" : null,
    why: r.why,
    hunks: r.hunks,
    notes: [...r.notes, ...r.hunks.flatMap((h) => h.notes)],
  }));

// The desk's reading order as sections: ranked, unread, skipped, then from `rest` on, the files the desk folds away.
export function sections(o: ReviewOrder): { list: Section[]; rest: number } {
  const list = grouped([...o.chunks, ...o.unread, ...o.skipped]);
  return { list: [...list, ...restOf(o)], rest: list.length };
}

export interface WalkStep {
  at: number; // its first section in the list
  title: string;
  body: string;
  check: string;
  note: string; // block prose, or ""
  diagram: string; // the id of its diagram in ai.diagrams, or ""
}

// The walk-through as one list of sections: each step's, then from `beyond` on what no step covers, then the desk's fold.
export function walk(o: ReviewOrder): { list: Section[]; rest: number; steps: WalkStep[]; beyond: number } {
  const list: Section[] = [];
  const steps = (o.steps ?? []).map((st) => {
    const at = list.length;
    grouped(st.hunks, list);
    return { at, title: st.title, body: st.body, check: st.check, note: st.note ?? "", diagram: st.diagram ?? "" };
  });
  const beyond = list.length;
  grouped(o.beyond ?? [], list);
  const rest = list.length;
  return { list: [...list, ...restOf(o)], rest, steps, beyond };
}

// Whether a note sits on one of these hunks' lines; one that doesn't is about the whole file, above its diff.
export function onLines(hunks: Pick<ReviewHunk, "header">[], n: Pick<ReviewNote, "side" | "line">): boolean {
  return hunks.some((h) => {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(h.header);
    const [from, count] = n.side === "old" ? [m?.[1], m?.[2]] : [m?.[3], m?.[4]];
    return !!from && n.line >= Number(from) && n.line < Number(from) + Number(count ?? 1);
  });
}
