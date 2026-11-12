import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { cls } from "../format.ts";
import { getStored, setStored } from "../storage.ts";

// The list a review or a question was opened from, beside it: its name, its filter and its rows, scrolling on their own; or,
// folded, a thin rail with the same button. App keeps the review where it is in the tree, so this coming and going never
// redraws it.
export function Beside({
  name,
  count,
  open,
  search,
  selected,
  onFold,
  children,
}: {
  name: string;
  count: number | null; // the Inbox's, as the sidebar has it
  open: boolean;
  search: ReactNode; // its Filter; Merging has none
  selected: string | null; // the open item's row
  onFold: () => void;
  children: ReactNode;
}) {
  const body = useRef<HTMLDivElement>(null);
  const shown = useRef<string | null>(null); // the open item whose row was last brought into view
  // The open item's row in view, once per item and each time the list opens; scrolling it away yourself stays put. Out of
  // sight, it comes to about the list's middle, the list's top on the start of a row or a heading, never half of one.
  useEffect(() => {
    const box = body.current;
    if (!open) shown.current = null;
    if (!open || !box || !selected || shown.current === selected) return;
    const row = box.querySelector(`[data-id="${CSS.escape(selected)}"]`);
    if (!row) return;
    shown.current = selected;
    const r = row.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.top >= b.top && r.bottom <= b.bottom) return;
    const top = (el: Element) => el.getBoundingClientRect().top - b.top + box.scrollTop;
    const mid = Math.min(top(row) - Math.max(0, (b.height - r.height) / 2), box.scrollHeight - box.clientHeight);
    box.scrollTop = Math.max(0, ...[...box.querySelectorAll(".line, .group-head")].map(top).filter((y) => y <= mid + 1));
  });
  const label = open ? "Hide the list" : "Show the list";
  const aside = useRef<HTMLElement>(null);
  // This device's width for it, dragged by its edge; unset, the stylesheet's.
  useEffect(() => {
    widen(Number(getStored(WIDTH)) || null);
  }, []);
  const dragTo = (x: number) => {
    const left = aside.current?.getBoundingClientRect().left ?? 0;
    widen(x - left, true);
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.documentElement.classList.add("resizing");
    const move = (m: globalThis.PointerEvent) => {
      dragTo(m.clientX);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      document.documentElement.classList.remove("resizing");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const w = aside.current?.getBoundingClientRect().width ?? 340;
    widen(w + (e.key === "ArrowRight" ? 24 : -24), true);
  };
  return (
    <aside ref={aside} className={cls("beside", !open && "folded")} aria-label={name}>
      {open && (
        <div
          className="beside-resize"
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a splitter you drag and move with ←/→; an <hr> takes no focus or children
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the list"
          title="Drag to resize the list; double-click for its usual width"
          tabIndex={0}
          onPointerDown={onDown}
          onKeyDown={onKey}
          onDoubleClick={() => {
            widen(null, true);
          }}
        />
      )}
      {open && (
        <div className="beside-head">
          <h2 className="beside-name">
            {name} {!!count && <span className="count">{count}</span>}
          </h2>
          {search}
        </div>
      )}
      <button
        type="button"
        className="beside-fold"
        aria-expanded={open}
        aria-controls="beside-list"
        aria-label={label}
        title={label}
        onClick={onFold}
      >
        <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
          <path d={open ? "M9.5 4.5 6 8l3.5 3.5" : "M6.5 4.5 10 8l-3.5 3.5"} />
        </svg>
      </button>
      <div ref={body} id="beside-list" className="beside-list" hidden={!open}>
        {open && children}
      </div>
    </aside>
  );
}

const WIDTH = "desk.beside.width";
const MIN = 260;

// The list's width as a CSS variable the app's grid reads, between MIN and most of the window; null is the stylesheet's.
function widen(px: number | null, keep = false) {
  const root = document.documentElement.style;
  const w = px === null ? null : Math.round(Math.min(Math.max(px, MIN), Math.max(MIN, innerWidth * 0.5)));
  if (w === null) root.removeProperty("--list-w-user");
  else root.setProperty("--list-w-user", `${w}px`);
  if (keep) setStored(WIDTH, w === null ? null : String(w));
}
