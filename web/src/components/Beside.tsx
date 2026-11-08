import { useEffect, useRef, type ReactNode } from "react";
import { cls } from "../format.ts";
import { Filter } from "./PageHead.tsx";

// The list a review or a question was opened from, beside it: its name, its filter and its rows, scrolling on their own; or,
// folded, a thin rail with the same button. App keeps the review where it is in the tree, so this coming and going never
// redraws it.
export function Beside({
  name,
  count,
  open,
  filter,
  setFilter,
  selected,
  onFold,
  children,
}: {
  name: string;
  count: number | null; // the Inbox's, as the sidebar has it
  open: boolean;
  filter: string;
  setFilter: ((s: string) => void) | null; // Merging has no filter
  selected: string | null; // the open item's row
  onFold: () => void;
  children: ReactNode;
}) {
  const body = useRef<HTMLDivElement>(null);
  const shown = useRef<string | null>(null); // the open item whose row was last brought into view
  // The open item's row in view, once per item and each time the list opens; scrolling it away yourself stays put.
  useEffect(() => {
    const box = body.current;
    if (!open) shown.current = null;
    if (!open || !box || !selected || shown.current === selected) return;
    const row = box.querySelector(`[data-id="${CSS.escape(selected)}"]`);
    if (!row) return;
    shown.current = selected;
    const r = row.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.top < b.top) box.scrollTop -= b.top - r.top + 8;
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 8;
  });
  const label = open ? "Hide the list" : "Show the list";
  return (
    <aside className={cls("beside", !open && "folded")} aria-label={name}>
      {open && (
        <div className="beside-head">
          <h2 className="beside-name">
            {name} {!!count && <span className="count">{count}</span>}
          </h2>
          {setFilter && <Filter filter={filter} setFilter={setFilter} />}
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
