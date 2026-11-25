import type { ReactNode } from "react";
import { shownKind, toggleShow, type ShowKey } from "../filter.ts";
import { cls } from "../format.ts";

const SHOW: Record<ShowKey, { label: string; tip: string; icon: ReactNode }> = {
  quick: {
    label: "Quick reviews",
    tip: "Only quick reviews: someone else's small PR its AI review calls low risk",
    icon: (
      <svg className="si" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M9 1.5 3.5 9h4.5l-1 5.5 5.5-7.5H8z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    ),
  },
  reply: {
    label: "Waiting on your reply",
    tip: "Only your PRs where someone waits on your reply",
    icon: (
      <svg className="si" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M20 18v-2a4 4 0 0 0-4-4H4m5 5-5-5 5-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  oneclick: {
    label: "One click",
    tip: "Only your PRs one click moves on: Ready for review, Add reviewers or Hand off for merge",
    icon: (
      <svg className="si" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M14 4.1 12 6M5.1 8l-2.9-.8M6 12l-1.9 2M7.2 2.2 8 5.1m1.037 4.59a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
};

// The head's kinds of row, a button each before the filter by person: a click shows only that kind (the query's is: term),
// a click on the one that's on shows every row again. `kinds` are the buttons the page's rows call for (kindButtons()).
export function ShowFilter({ filter, setFilter, kinds }: { filter: string; setFilter: (s: string) => void; kinds: ShowKey[] }) {
  const on = shownKind(filter);
  return (
    <>
      {kinds.map((k) => (
        <button
          key={k}
          type="button"
          className={cls("act", "head-filter", on === k && "on")}
          aria-pressed={on === k}
          aria-label={SHOW[k].label}
          title={SHOW[k].tip}
          onClick={() => {
            setFilter(toggleShow(filter, k));
          }}
        >
          {SHOW[k].icon}
        </button>
      ))}
    </>
  );
}
