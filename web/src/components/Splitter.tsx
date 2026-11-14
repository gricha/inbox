import { useLayoutEffect, type KeyboardEvent, type PointerEvent } from "react";
import { cls } from "../format.ts";
import { getStored, setStored } from "../storage.ts";

// A column's edge to drag (or move with ←/→), its width a CSS variable on the root the stylesheet reads, kept per device;
// double-click gives back the stylesheet's. `edge` is the side of the column it sits on: a column on the right is dragged
// by its left edge.
export interface Width {
  key: string; // where this device keeps it
  cssVar: string; // e.g. --chat-w-user
  min: number;
  max: number; // of the window's width
}

export function Splitter({
  width,
  edge,
  column,
  label,
  className,
}: {
  width: Width;
  edge: "left" | "right";
  column: () => HTMLElement | null; // the column it resizes, measured as it's dragged
  label: string; // e.g. "the list"
  className?: string;
}) {
  useLayoutEffect(() => {
    resize(width, Number(getStored(width.key)) || null);
  }, [width]);
  const dragTo = (x: number) => {
    const r = column()?.getBoundingClientRect();
    if (r) resize(width, edge === "right" ? x - r.left : r.right - x, true);
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
    const w = column()?.getBoundingClientRect().width ?? width.min;
    const wider = (e.key === "ArrowRight") === (edge === "right");
    resize(width, w + (wider ? 24 : -24), true);
  };
  return (
    <div
      className={cls("splitter", `splitter-${edge}`, className)}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a splitter you drag and move with ←/→; an <hr> takes no focus or children
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      title={`Drag to resize ${label}; double-click for its usual width`}
      tabIndex={0}
      onPointerDown={onDown}
      onKeyDown={onKey}
      onDoubleClick={() => {
        resize(width, null, true);
      }}
    />
  );
}

// Between min and the window's share; null is the stylesheet's.
function resize(width: Width, px: number | null, keep = false) {
  const root = document.documentElement.style;
  const w = px === null ? null : Math.round(Math.min(Math.max(px, width.min), Math.max(width.min, innerWidth * width.max)));
  if (w === null) root.removeProperty(width.cssVar);
  else root.setProperty(width.cssVar, `${w}px`);
  if (keep) setStored(width.key, w === null ? null : String(w));
}
