import { useEffect, useRef, type ReactNode } from "react";
import { cls } from "../format.ts";
import { Splitter, type Width } from "./Splitter.tsx";

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
  return (
    <aside ref={aside} className={cls("beside", !open && "folded")} aria-label={name}>
      {open && <Splitter width={LIST} edge="right" column={() => aside.current} label="the list" className="beside-resize" />}
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

const LIST: Width = { key: "desk.beside.width", cssVar: "--list-w-user", min: 260, max: 0.5 };
