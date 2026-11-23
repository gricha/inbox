import { useRef, useState, type DragEvent, type FocusEvent, type MouseEvent, type ReactNode } from "react";
import type { InboxSection } from "../../../src/types.ts";
import type { Drop } from "../pending.ts";

// Dragging a row on the Inbox to reprioritize it. Native HTML5 drag and drop: no package, Chromium draws the row under the
// pointer, and a click that doesn't move stays a click. A row goes among its own kind (docs/ui.md → Your order): a PR or an
// issue among the items of any section, a note among the notes, a question among the questions in Urgent.
export type Lane = "ask" | "due" | "note" | "card";
const LANES: readonly string[] = ["ask", "session", "due", "note", "card"]; // a section's rows, top to bottom

// Where a row of `lane` goes in `section`, or null where it can't.
function laneIn(lane: Lane, section: InboxSection): Lane | null {
  if (lane === "ask") return section === "urgent" ? "ask" : null;
  if (lane === "due") return section === "urgent" ? "due" : "note";
  return lane;
}

export interface Reorder {
  row: (id: string, lane: Lane, section: InboxSection) => RowDrag;
  list: {
    onDragEnter: (e: DragEvent<HTMLElement>) => void;
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDragLeave: (e: DragEvent<HTMLElement>) => void;
    onDrop: (e: DragEvent<HTMLElement>) => void;
  };
  line: ReactNode;
}
export interface RowDrag {
  draggable: true;
  "data-lane": Lane;
  "data-dragging"?: true; // the row on its way: faded where it was
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
}

// A row's button: a press doesn't select the row (focus by Tab does); on a row that drags, the press is left alone so a
// drag can start from anywhere on it.
export const press = (drag: RowDrag | undefined, select?: () => void) => ({
  onMouseDown: (e: MouseEvent) => {
    if (!drag) e.preventDefault();
  },
  ...(select && {
    onFocus: (e: FocusEvent<HTMLElement>) => {
      if (!drag || e.currentTarget.matches(":focus-visible")) select();
    },
  }),
});

// The handle that shows on a row under the pointer; the whole row drags, it only says so.
export function Grip() {
  return (
    <span className="line-grip" data-tip="Drag to change its place">
      <svg className="i" viewBox="0 0 6 10" aria-hidden="true">
        {[1, 5].map((x) => [1, 5, 9].map((y) => <circle key={`${x} ${y}`} cx={x} cy={y} r="1" />))}
      </svg>
    </span>
  );
}

const sectionOf = (el: Element | null | undefined): InboxSection | null => {
  const s = el?.closest<HTMLElement>("[data-section]")?.dataset.section;
  return s === "urgent" || s === "standard" || s === "fyi" ? s : null;
};

// The rows of `lane` in a section's table as they're drawn, `except` the one being dragged.
const laneRows = (sec: Element, lane: Lane, except?: string): HTMLElement[] =>
  [...sec.querySelectorAll<HTMLElement>(`.lines > .line[data-lane="${lane}"]`)].filter((el) => el.dataset.id !== except);

// Where a drop at `y` lands: the section under it (or the nearest), the rows of its kind it goes between, and where the line
// is drawn, in px down `list`.
function target(list: HTMLElement, y: number, from: { id: string; lane: Lane }): { drop: Drop; y: number } | null {
  const sections = [...list.querySelectorAll<HTMLElement>("section[data-section]")];
  const dist = (s: HTMLElement) => {
    const r = s.getBoundingClientRect();
    return y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
  };
  const sec = sections.toSorted((a, b) => dist(a) - dist(b))[0];
  const section = sectionOf(sec);
  const lane = section && laneIn(from.lane, section);
  if (!sec || !section || !lane) return null;
  const top = list.getBoundingClientRect().top;
  const rows = laneRows(sec, lane, from.id);
  const i = rows.findIndex((el) => {
    const r = el.getBoundingClientRect();
    return y < r.top + r.height / 2;
  });
  const below = i < 0 ? undefined : rows[i];
  const above = i < 0 ? rows.at(-1) : rows[i - 1];
  // None of its kind there: after the rows of the kinds drawn above its own, else under the heading.
  const lead = [...sec.querySelectorAll<HTMLElement>(".lines > .line")].filter(
    (el) => el.dataset.id !== from.id && LANES.indexOf(el.dataset.lane ?? "card") < LANES.indexOf(lane),
  );
  const edge = below
    ? below.getBoundingClientRect().top
    : above
      ? above.getBoundingClientRect().bottom
      : (lead.at(-1)?.getBoundingClientRect().bottom ?? sec.querySelector(".group-head")!.getBoundingClientRect().bottom);
  return {
    drop: {
      id: from.id,
      section,
      ...(above?.dataset.id && { after: above.dataset.id }),
      ...(below?.dataset.id && { before: below.dataset.id }),
    },
    y: edge - top,
  };
}

// The row's neighbours of its kind as drawn: a drop between them changes nothing.
function stays(d: Drop, from: { section: InboxSection; after?: string; before?: string }): boolean {
  return d.section === from.section && d.after === from.after && d.before === from.before;
}

const EDGE = 72; // px from the window's top or bottom where a drag scrolls the page
// Near an edge, the page scrolls toward it, faster the closer the pointer: dragover comes every 50 ms or so while it's held.
function scrollNear(y: number) {
  const head = document.querySelector(".page-head")?.getBoundingClientRect().bottom ?? 0;
  const up = head + EDGE - y;
  const down = y - (window.innerHeight - EDGE);
  if (up > 0) window.scrollBy(0, -Math.ceil(up / 3));
  else if (down > 0) window.scrollBy(0, Math.ceil(down / 3));
}

// The Inbox's drag: the props each row spreads, the list's own, and the insertion line where the row will land.
export function useReorder(place: (d: Drop) => void) {
  const from = useRef<{ id: string; lane: Lane; section: InboxSection; after?: string; before?: string } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [at, setAt] = useState<{ drop: Drop; y: number } | null>(null);
  const end = () => {
    from.current = null;
    setDragging(null);
    setAt(null);
  };
  const row = (id: string, lane: Lane, section: InboxSection): RowDrag => ({
    draggable: true,
    "data-lane": lane,
    ...(dragging === id && { "data-dragging": true as const }),
    onDragStart: (e) => {
      const el = e.currentTarget;
      const sec = el.closest("[data-section]");
      const mine = sec ? laneRows(sec, lane) : [];
      const i = mine.findIndex((x) => x.dataset.id === id);
      const after = mine[i - 1]?.dataset.id;
      const before = mine[i + 1]?.dataset.id;
      from.current = { id, lane, section, ...(after && { after }), ...(before && { before }) };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
      setDragging(id);
    },
    onDragEnd: end,
  });
  // Over the list, entering a row or moving on it: the line goes where it would land. Taken (preventDefault) only where it
  // can land; else the browser sends the rest of the drag to the page's body.
  const over = (e: DragEvent<HTMLElement>) => {
    const f = from.current;
    if (!f) return;
    scrollNear(e.clientY);
    const t = target(e.currentTarget, e.clientY, f);
    if (!t || stays(t.drop, f)) {
      e.dataTransfer.dropEffect = "none";
      if (at) setAt(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (at?.y !== t.y || at.drop.section !== t.drop.section) setAt(t);
  };
  const list = {
    onDragEnter: (e: DragEvent<HTMLElement>) => {
      over(e);
      if (from.current) e.preventDefault();
    },
    onDragOver: over,
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setAt(null);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      const f = from.current;
      const t = f && target(e.currentTarget, e.clientY, f);
      end();
      if (t && f && !stays(t.drop, f)) place(t.drop);
    },
  };
  const line = at && <div className="drop-line" style={{ top: at.y }} aria-hidden="true" />;
  return { row, list, line } satisfies Reorder;
}

// "Move up" and "Move down" in a row's menu: the drop that puts it past the row of its kind drawn above or below it.
export function stepDrops(id: string): { up?: Drop; down?: Drop } {
  const el = document.querySelector<HTMLElement>(`.queue .lines > .line[data-id="${CSS.escape(id)}"][data-lane]`);
  const section = sectionOf(el);
  const sec = el?.closest("[data-section]");
  const lane = el?.dataset.lane;
  if (!el || !section || !sec || (lane !== "ask" && lane !== "due" && lane !== "note" && lane !== "card")) return {};
  const rows = laneRows(sec, lane);
  const i = rows.findIndex((x) => x === el);
  const up = rows[i - 1]?.dataset.id;
  const down = rows[i + 1]?.dataset.id;
  return { ...(up && { up: { id, section, before: up } }), ...(down && { down: { id, section, after: down } }) };
}
