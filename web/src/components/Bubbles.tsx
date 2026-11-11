import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cls } from "../format.ts";
import type { Fix, Notice } from "../notices.ts";
import { withCode } from "./Review.tsx";

const FADE_MS = 8000;

// What's wrong with the system, as a small stack at the window's bottom right, beside the page's column and clear of the
// chat: each its words, at most one fix and a dismiss. One that's transient fades on its own, held while the pointer's on it.
export function Bubbles({ notices, fix, dismiss }: { notices: readonly Notice[]; fix: (f: Fix) => void; dismiss: (n: Notice) => void }) {
  const stack = useRef<HTMLDivElement>(null);
  // The page keeps room for the stack under its end, so its last rows can scroll clear of it. Always there, empty or not, so
  // a screen reader hears what comes into it.
  useLayoutEffect(() => {
    const el = stack.current;
    const app = el?.closest<HTMLElement>(".app");
    const ro = new ResizeObserver(() => {
      if (el) app?.style.setProperty("--bubbles-h", `${el.offsetHeight}px`);
    });
    if (el) ro.observe(el);
    return () => {
      ro.disconnect();
      app?.style.removeProperty("--bubbles-h");
    };
  }, []);
  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- <output> holds only phrasing content, and a bubble is a block
    <div ref={stack} className="bubbles" role="status" aria-label="Notices">
      {notices.map((n) => (
        <Bubble key={n.id} n={n} fix={fix} dismiss={dismiss} />
      ))}
    </div>
  );
}

function Bubble({ n, fix, dismiss }: { n: Notice; fix: (f: Fix) => void; dismiss: (n: Notice) => void }) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const t = n.transient && !held ? window.setTimeout(dismiss, FADE_MS, n) : undefined;
    return () => {
      clearTimeout(t);
    };
  }, [n, held, dismiss]);
  const f = n.fix;
  return (
    <div
      className={cls("bubble", n.tone && `t-${n.tone}`, n.transient && "transient", !held && n.transient && "fading")}
      onMouseEnter={() => {
        setHeld(true);
      }}
      onMouseLeave={() => {
        setHeld(false);
      }}
    >
      <div className="bubble-words">
        <p className="bubble-title">{n.title}</p>
        {n.text && <p className="bubble-text">{withCode(n.text)}</p>}
        {n.log && <pre className="bubble-log">{n.log}</pre>}
        {f &&
          ("href" in f ? (
            <a className="act bubble-fix" href={f.href}>
              {f.label}
            </a>
          ) : (
            <button
              type="button"
              className="act bubble-fix"
              disabled={n.busy}
              onClick={() => {
                fix(f);
              }}
            >
              {f.label}
            </button>
          ))}
      </div>
      <button
        type="button"
        className="bubble-x"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={() => {
          dismiss(n);
        }}
      >
        <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
        </svg>
      </button>
    </div>
  );
}
