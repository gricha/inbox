// A review's diff: patches, rows and lines, where notes and threads sit, the file tree.
import { onLines, type Section } from "../../src/sections.ts";
import type { ActivityEvent, AskLines, Conversation, InlineAt, ReviewFile, ReviewHunk, ReviewNote } from "../../src/types.ts";
import { aiName } from "./format.ts";

// GitHub's file patch is only hunks; the diff renderer wants git's file headers too.
export function filePatch(f: ReviewFile): string {
  const before = f.previous_path ?? f.path;
  const mode = f.status === "added" ? "new file mode 100644\n" : f.status === "removed" ? "deleted file mode 100644\n" : "";
  const from = f.status === "added" ? "/dev/null" : `a/${before}`;
  const to = f.status === "removed" ? "/dev/null" : `b/${f.path}`;
  return `diff --git a/${before} b/${f.path}\n${mode}--- ${from}\n+++ ${to}\n${f.patch ?? ""}\n`;
}

// The section a line of the diff is drawn in, -1 when none draws it.
export function sectionOf(list: Pick<Section, "path" | "hunks">[], path: string, at: Pick<ReviewNote, "side" | "line">): number {
  return list.findIndex((x) => x.path === path && onLines(x.hunks, at));
}

const DRAW_LINES = 400; // about what Pierre highlights in a frame or two

// How far to draw the sections from `from` on: as many as fit in `lines` diff lines, and at least one more.
export function drawUpTo(list: { hunks: Pick<ReviewHunk, "patch">[] }[], from: number, lines = DRAW_LINES): number {
  let i = from;
  let n = 0;
  while (i < list.length && (i === from || n < lines)) {
    for (const h of list[i]!.hunks) n += h.patch.split("\n").length;
    i++;
  }
  return i;
}

// The rows a diff of these hunks draws at least: its context, added and removed lines.
export function diffRows(hunks: Pick<ReviewHunk, "patch">[]): number {
  return hunks.reduce((n, h) => n + h.patch.split("\n").filter((l) => /^[ +-]/.test(l)).length, 0);
}

type Side = "new" | "old";

// The diff's rows in order, each with its hunk and its line number on each side it's on (a context line is on both).
function rowsOf(hunks: Pick<ReviewHunk, "patch">[]): { hunk: number; old: number | null; new: number | null }[] {
  const rows: { hunk: number; old: number | null; new: number | null }[] = [];
  for (const [hunk, h] of hunks.entries()) {
    const [head = "", ...lines] = h.patch.split("\n");
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(head);
    if (!m) continue;
    let o = Number(m[1]);
    let n = Number(m[2]);
    for (const l of lines)
      if (l.startsWith("+")) rows.push({ hunk, old: null, new: n++ });
      else if (l.startsWith("-")) rows.push({ hunk, old: o++, new: null });
      else if (l.startsWith(" ")) rows.push({ hunk, old: o++, new: n++ });
  }
  return rows;
}

// Where a comment on the gutter's pick goes: GitHub's line and side, from the earlier row of the pick to the later. GitHub
// takes a range only within one hunk; across two, the comment is on the last line.
export function inlineAt(
  path: string,
  hunks: Pick<ReviewHunk, "patch">[],
  pick: { start: number; side?: "additions" | "deletions"; end: number; endSide?: "additions" | "deletions" },
): InlineAt | null {
  const rows = rowsOf(hunks);
  const at = (line: number, s: "additions" | "deletions" | undefined): { i: number; line: number; side: Side } | null => {
    const side: Side = s === "deletions" ? "old" : "new";
    const i = rows.findIndex((r) => r[side] === line);
    return i < 0 ? null : { i, line, side };
  };
  const a = at(pick.start, pick.side);
  const b = at(pick.end, pick.endSide ?? pick.side);
  if (!a || !b) return null;
  const [first, last] = a.i <= b.i ? [a, b] : [b, a];
  return {
    path,
    line: last.line,
    side: last.side,
    ...(first.i !== last.i && rows[first.i]!.hunk === rows[last.i]!.hunk && { start: { line: first.line, side: first.side } }),
  };
}

// The review threads on these hunks' lines, to show where they are; outdated ones are only in the conversation.
export function threadsOn(conversation: Conversation[], path: string, hunks: Pick<ReviewHunk, "header">[]): Conversation[] {
  return conversation.filter(
    (c) =>
      c.kind === "thread" &&
      c.path === path &&
      !c.outdated &&
      c.line !== null &&
      !!c.side &&
      onLines(hunks, { line: c.line, side: c.side }),
  );
}

// "src/planner/" and "plan.ts", so the name can stay whole while the folder truncates.
export function splitPath(p: string): [string, string] {
  const i = p.lastIndexOf("/");
  return [p.slice(0, i + 1), p.slice(i + 1)];
}

export const lineName = (at: InlineAt) => `${splitPath(at.path)[1]}:${at.start ? `${at.start.line}\u2013` : ""}${at.line}`;

// Mixed sides read as the new file's lines: only an all-removed range says so.
export function linesLabel(l: AskLines): string {
  if (l.note) return `${aiName()}'s note on ${lineName(l)}`;
  return l.side === "old" && (!l.start || l.start.side === "old") ? `${lineName(l)}, removed` : lineName(l);
}

// A resolved PR's "Resolved: …" line takes the event that caused it (and who merged or closed it), so Recent activity
// doesn't say it again; the "resolved" events go too. `events` are newest first.
export function resolvedHead(events: ActivityEvent[], resolved: string, me: string): { line: string; events: ActivityEvent[] } {
  const ended = resolved === "merged" || resolved === "closed";
  const approver = /^approved by (.+)$/.exec(resolved)?.[1]?.toLowerCase();
  const cause = events.find((e) =>
    ended
      ? e.kind === resolved
      : resolved === "no longer requested"
        ? e.kind === "request_removed"
        : e.kind === "reviewed" && e.data.state === "approved" && e.actor.toLowerCase() === approver,
  );
  const who = ended && cause?.actor ? ` by ${cause.actor.toLowerCase() === me.toLowerCase() ? "you" : cause.actor}` : "";
  return { line: `Resolved: ${resolved}${who}`, events: events.filter((e) => e !== cause && e.kind !== "resolved") };
}

// Which section the reader is in: the last one whose top has scrolled past the line under the page head. At the page's end
// the last ones can't reach that line, so it's the last one.
export function currentFile(tops: number[], line: number, atEnd = false): number {
  if (atEnd) return Math.max(0, tops.length - 1);
  let cur = 0;
  for (const [i, top] of tops.entries()) if (top <= line) cur = i;
  return cur;
}

// A review's files as folders, in the order reading reaches them: a folder with one folder in it reads as one ("web/src").
export interface PathNode {
  name: string;
  path: string;
  kids?: PathNode[]; // a folder's; a file has none
}

export function pathTree(paths: readonly string[]): PathNode[] {
  const root: PathNode[] = [];
  for (const p of new Set(paths)) {
    const parts = p.split("/");
    let at = root;
    for (const [k, name] of parts.entries()) {
      const path = parts.slice(0, k + 1).join("/");
      if (k === parts.length - 1) {
        at.push({ name, path });
        break;
      }
      let dir = at.find((n) => n.kids && n.path === path);
      if (!dir) {
        dir = { name, path, kids: [] };
        at.push(dir);
      }
      at = dir.kids ?? at;
    }
  }
  const squash = (n: PathNode): PathNode => {
    if (!n.kids) return n;
    const only = n.kids.length === 1 ? n.kids[0] : undefined;
    if (only?.kids) return squash({ name: `${n.name}/${only.name}`, path: only.path, kids: only.kids });
    return { ...n, kids: n.kids.map(squash) };
  };
  return root.map(squash);
}

// The file before a PR from the file after it and the PR's patch for it: the patch run backwards. null when they don't agree
// (a patch GitHub cut short, or one from another commit).
export function oldFromNew(text: string, patch: string): string | null {
  const now = text.split("\n");
  const out: string[] = [];
  let at = 0;
  let inHunk = false;
  for (const l of patch.split("\n")) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m) {
      const start = m[2] === "0" ? Number(m[1]) : Number(m[1]) - 1;
      if (start < at || start > now.length) return null;
      out.push(...now.slice(at, start));
      at = start;
      inHunk = true;
    } else if (!inHunk || l.startsWith("\\")) continue;
    else if (l.startsWith("-")) out.push(l.slice(1));
    else if (l.startsWith("+") || l.startsWith(" ")) {
      if (now[at] !== l.slice(1)) return null;
      if (l.startsWith(" ")) out.push(l.slice(1));
      at++;
    }
  }
  out.push(...now.slice(at));
  return out.join("\n");
}

// The whole file before and after, as a review's section can show more lines of it: cut at the first hunk of the file past the
// section's last, so the lines after the section are the same on both sides (Pierre's diff takes the ones it's given as all
// there are). null when the section's hunks aren't the file's, the file has a hunk above the section's last that it doesn't
// show (Pierre would draw the lines before from both sides as one, and fail), or the cut doesn't line up.
export function wholeFor(w: { old: string; new: string }, patch: string, sectionHunks: string[]): { old: string; new: string } | null {
  const heads = (p: string) =>
    [...p.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({
      key: m[0],
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
    }));
  const all = heads(patch);
  const mine = sectionHunks.flatMap((h) => heads(h));
  const last = mine.at(-1);
  if (!last) return null;
  const at = all.findIndex((h) => h.key === last.key);
  if (at < 0) return null;
  // A hunk of the file above the section's last that isn't in it leaves the lines before different on each side.
  const keys = new Set(mine.map((h) => h.key));
  if (all.slice(0, at).some((h) => !keys.has(h.key))) return null;
  const end = (start: number, n: number) => (n === 0 ? start : start + n - 1); // the hunk's last line on that side
  const oldLines = w.old.split("\n");
  const newLines = w.new.split("\n");
  const next = all[at + 1];
  const before = next ? oldLines.slice(0, next.oldStart - 1) : oldLines;
  const after = next ? newLines.slice(0, next.newStart - 1) : newLines;
  const trailing = (lines: string[], start: number, n: number) => lines.length - end(start, n);
  if (trailing(before, last.oldStart, last.oldCount) !== trailing(after, last.newStart, last.newCount)) return null;
  return { old: before.join("\n"), new: after.join("\n") };
}
