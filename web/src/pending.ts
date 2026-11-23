import {
  askRef,
  isNoteRef,
  isAskRef,
  NOTE_PREFIX,
  INBOX_SECTIONS,
  placeNotes,
  type Card,
  type InboxSection,
  type Item,
  type Note,
  type NotesView,
  type QueueView,
  type Standing,
} from "../../src/types.ts";

// Note writes the desk's view doesn't show yet, by id: the note as you left it, null once done; a new one under a temporary id.
export type NoteEdits = Readonly<Record<string, Note | null>>;

const notesOf = (v: NotesView) => [...v.due, ...v.urgent, ...v.open, ...v.fyi, ...v.later];
const isNote = (n: Note | null): n is Note => n !== null;

export const dropKey = <T>(r: Readonly<Record<string, T>>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(r).filter(([k]) => k !== key));

// The desk's notes with yours on them, placed as the desk places them.
export function withNoteEdits(v: NotesView, edits: NoteEdits, now: string): NotesView {
  const ids = new Set(Object.keys(edits));
  if (!ids.size) return v;
  return placeNotes([...notesOf(v).filter((n) => !ids.has(n.id)), ...Object.values(edits).filter(isNote)], now);
}

// Your edits the desk's view now has drop off: a done note gone, a saved one as it was saved.
export function settleNoteEdits(v: NotesView, edits: NoteEdits): NoteEdits {
  const desk = new Map(notesOf(v).map((n) => [n.id, n]));
  const left = Object.entries(edits).filter(([id, n]) => {
    const d = desk.get(id);
    if (n === null) return !!d;
    return !d || d.text !== n.text || d.remind_at !== n.remind_at || d.section !== n.section;
  });
  return left.length === Object.keys(edits).length ? edits : Object.fromEntries(left);
}

// Your reviewer changes a review's read doesn't show yet, by who as its list names them (a login, or @team), lower case.
export type ReviewerAsks = Readonly<Record<string, "asked" | "removed">>;

const ORDER: readonly Standing["state"][] = ["changes requested", "asked", "approved", "commented"];

// A review's reviewers with your changes on them: a removed one off the list, an added one asked, and one asked again
// keeps their verdict, asked again, as the desk will list them.
export function withReviewerAsks(list: Standing[], asks: ReviewerAsks): Standing[] {
  if (!Object.keys(asks).length) return list;
  const by = new Map(list.map((s) => [s.who.toLowerCase(), s]));
  for (const [who, how] of Object.entries(asks)) {
    if (how === "removed") by.delete(who);
    else {
      const had = by.get(who);
      const verdict = had?.state === "approved" || had?.state === "changes requested";
      by.set(who, verdict ? { ...had, again: true } : { who: had?.who ?? who, state: "asked" });
    }
  }
  return [...by.values()].toSorted((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state));
}

// Your changes the review's read now has drop off: an asked one among its review requests, a removed one not.
export function settleReviewerAsks(requests: Item["review_requests"], asks: ReviewerAsks): ReviewerAsks {
  const asked = new Set(requests.map((r) => (r.type === "team" ? `@${r.reviewer}` : r.reviewer).toLowerCase()));
  const left = Object.entries(asks).filter(([who, how]) => asked.has(who) !== (how === "asked"));
  return left.length === Object.keys(asks).length ? asks : Object.fromEntries(left);
}

// A row you dragged (or moved up or down) on the Inbox, drawn there until the desk's view is read back: its id as the row's
// ("note:<id>", "ask:<id>" or an item's), the section, and the rows of its kind it went between.
export interface Drop {
  id: string;
  section: InboxSection;
  after?: string;
  before?: string;
}

// Into `list` beside the row the drop names, else where the desk's key puts it.
function insert<T>(list: readonly T[], x: T, d: Drop, id: (t: T) => string, below: (t: T) => boolean): T[] {
  const a = d.after === undefined ? -1 : list.findIndex((t) => id(t) === d.after);
  const b = d.before === undefined ? -1 : list.findIndex((t) => id(t) === d.before);
  const k = list.findIndex(below);
  const i = a >= 0 ? a + 1 : b >= 0 ? b : k < 0 ? list.length : k;
  return [...list.slice(0, i), x, ...list.slice(i)];
}

function dropNote(v: QueueView, d: Drop): QueueView {
  const id = d.id.slice(NOTE_PREFIX.length);
  const n = [...v.notes.due, ...v.notes.urgent, ...v.notes.open, ...v.notes.fyi].find((x) => x.id === id);
  if (!n) return v;
  const due = v.notes.due.includes(n) && d.section === "urgent";
  const moved: Note = { ...n, section: d.section, ...(!due && { remind_at: null, reminded_at: null }) };
  const off = (ns: Note[]) => ns.filter((x) => x.id !== id);
  const notes: NotesView = {
    ...v.notes,
    due: off(v.notes.due),
    urgent: off(v.notes.urgent),
    open: off(v.notes.open),
    fyi: off(v.notes.fyi),
  };
  const key = { urgent: "urgent", standard: "open", fyi: "fyi" } as const;
  const into = due ? "due" : key[d.section];
  const nd = {
    ...d,
    ...(d.after && { after: d.after.slice(NOTE_PREFIX.length) }),
    ...(d.before && { before: d.before.slice(NOTE_PREFIX.length) }),
  };
  notes[into] = insert(
    notes[into],
    moved,
    nd,
    (x) => x.id,
    (x) => (due ? (x.remind_at ?? "") > (n.remind_at ?? "") : x.at < n.at),
  );
  return { ...v, notes };
}

function dropAsk(v: QueueView, d: Drop): QueueView {
  const q = v.inquiries.find((x) => askRef(x.id) === d.id);
  if (!q || d.section !== "urgent") return v;
  const rest = v.inquiries.filter((x) => x !== q);
  return {
    ...v,
    inquiries: insert(
      rest,
      q,
      d,
      (x) => askRef(x.id),
      (x) => x.at > q.at,
    ),
  };
}

function dropCard(v: QueueView, d: Drop): QueueView {
  const from = INBOX_SECTIONS.find((s) => v.inbox[s].some((c) => c.id === d.id));
  if (!from) return v;
  const c: Card = { ...v.inbox[from].find((x) => x.id === d.id)!, section: d.section };
  const inbox = { ...v.inbox, [from]: v.inbox[from].filter((x) => x.id !== d.id) };
  inbox[d.section] = insert(
    inbox[d.section],
    c,
    d,
    (x) => x.id,
    (x) => (x.score ?? 0) < (c.score ?? 0),
  );
  return { ...v, inbox };
}

// The desk's view with your drops on it, in the order you made them.
export function withDrops(v: QueueView, drops: readonly Drop[]): QueueView {
  return drops.reduce((w, d) => (isNoteRef(d.id) ? dropNote(w, d) : isAskRef(d.id) ? dropAsk(w, d) : dropCard(w, d)), v);
}
