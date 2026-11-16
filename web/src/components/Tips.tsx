import { useEffect, useLayoutEffect, useRef, useState } from "react";

const DELAY = 350; // ms the pointer rests before a tip shows
const WARM = 400; // ms after one hid in which the next shows at once
const GAP = 6;
const EDGE = 8;

// What says itself under the pointer: the smallest [data-tip] there. A row's button covers its whole line, so what's under
// it counts too, but only in that row, never something behind a menu.
function tipAt(x: number, y: number): HTMLElement | null {
  const stack = document.elementsFromPoint(x, y);
  const row = stack[0]?.closest(".line-row");
  let best: HTMLElement | null = null;
  let least = Infinity;
  for (const el of stack) {
    const t = el.closest("[data-tip]");
    if (!(t instanceof HTMLElement) || !t.dataset.tip) continue;
    if (el !== stack[0] && !row?.contains(t)) continue;
    const r = t.getBoundingClientRect();
    if (r.width * r.height < least) {
      least = r.width * r.height;
      best = t;
    }
  }
  return best;
}

// The window's own tooltip: one for every [data-tip], in the theme's colours, over what it names (under it at the top edge).
// One with a hidden .tip-rich child shows that instead of its words: a row's signal opens its four facts.
export function Tips() {
  const [tip, setTip] = useState<{ text: string; box: DOMRect; rich: Element | null } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let over: HTMLElement | null = null;
    let timer: number | undefined;
    let hidAt = 0;
    let shown = false;
    const hide = () => {
      window.clearTimeout(timer);
      if (shown) hidAt = Date.now();
      shown = false;
      setTip(null);
    };
    const show = (el: HTMLElement) => {
      if (!el.isConnected || !el.dataset.tip) return;
      shown = true;
      setTip({ text: el.dataset.tip, box: el.getBoundingClientRect(), rich: el.querySelector(":scope > .tip-rich") });
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = tipAt(e.clientX, e.clientY);
      if (el === over) return;
      hide();
      over = el;
      if (!el) return;
      if (Date.now() - hidAt < WARM) show(el);
      else
        timer = window.setTimeout(() => {
          show(el);
        }, DELAY);
    };
    const away = () => {
      over = null;
      hide();
    };
    const focus = (e: FocusEvent) => {
      const el = e.target instanceof HTMLElement && e.target.matches("[data-tip]:focus-visible") ? e.target : null;
      if (el) show(el);
    };
    document.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", away, true);
    document.addEventListener("scroll", away, true);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", away);
    document.documentElement.addEventListener("pointerleave", away);
    window.addEventListener("blur", away);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", away, true);
      document.removeEventListener("scroll", away, true);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", away);
      document.documentElement.removeEventListener("pointerleave", away);
      window.removeEventListener("blur", away);
    };
  }, []);

  // Centred over what it names, kept inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tip) return;
    const { box } = tip;
    // What it names may say itself in more than words: a copy of its hidden .tip-rich, shown here.
    if (tip.rich) {
      const copy = tip.rich.cloneNode(true);
      if (copy instanceof HTMLElement) copy.hidden = false;
      el.replaceChildren(copy);
    }
    const left = Math.min(Math.max(box.left + box.width / 2 - el.offsetWidth / 2, EDGE), window.innerWidth - el.offsetWidth - EDGE);
    const above = box.top - el.offsetHeight - GAP;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(above < EDGE ? box.bottom + GAP : above)}px`;
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={ref} key={tip.rich ? "rich" : "text"} className="tip" role="tooltip">
      {tip.rich ? null : tip.text}
    </div>
  );
}
