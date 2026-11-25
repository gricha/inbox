import { useEffect, useRef, useState } from "react";
import { cls } from "../format.ts";
import { FILTER_KEYS, parseFilter, withPeople, type FilterKey } from "../filter.ts";
import { Avatar } from "./Avatar.tsx";
import type { FilterPerson } from "./Filter.tsx";

const KEY_LABEL: Record<FilterKey, string> = { author: "Author", involves: "Involves" };
const KEY_HELP: Record<FilterKey, string> = { author: "Who opened it", involves: "Anyone on it: asked, reviewed or said something" };

// The page's filter by person: one icon button on the page's head, its count of picks on it, and a popover of the people on
// the page's rows of the kind that's on (filterPeople()) under Author and Involves, a click to pick or unpick each. The picks
// are the query's author:/involves: terms, so the sidebar's search words and the head's kind of row still apply with them.
export function PeopleFilter({
  filter,
  setFilter,
  people,
  me,
}: {
  filter: string;
  setFilter: (s: string) => void;
  people: FilterPerson[];
  me: string;
}) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState("");
  const picks = parseFilter(filter).terms.flatMap((t) => (t.done && t.who && t.key !== "is" ? [{ key: t.key, who: t.who }] : []));
  const isYou = (who: string) => who === "you" || who === "me" || (!!me && who === me);
  const picked = (key: FilterKey, login: string) => picks.some((t) => t.key === key && (t.who === login || (login === me && isYou(t.who))));

  function toggle(key: FilterKey, login: string) {
    const next = picked(key, login)
      ? picks.filter((t) => !(t.key === key && (t.who === login || (login === me && isYou(t.who)))))
      : [...picks, { key, who: login === me ? "you" : login }];
    setFilter(withPeople(filter, next));
  }

  // Esc closes it, before the page reads it as "back" or "clear".
  const onKey = (e: KeyboardEvent) => {
    if (!open || e.key !== "Escape" || e.isComposing) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    setOpen(false);
  };
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      keyRef.current(e);
    };
    window.addEventListener("keydown", h, { capture: true });
    return () => {
      window.removeEventListener("keydown", h, { capture: true });
    };
  }, []);

  const q = find.trim().replace(/^@/, "").toLowerCase();
  const fits = (login: string) => !q || login.toLowerCase().includes(q) || (login === me && "you".includes(q));
  // You first, then everyone else as the desk lists them.
  const ordered = [...people.filter((p) => p.login === me), ...people.filter((p) => p.login !== me)];
  const lists: Record<FilterKey, string[]> = {
    author: ordered.flatMap((p) => (p.author && fits(p.login) ? [p.login] : [])),
    involves: ordered.flatMap((p) => (fits(p.login) ? [p.login] : [])),
  };

  return (
    <div className="people-filter">
      <button
        type="button"
        className={cls("act", "head-filter", picks.length > 0 && "on")}
        title="Filter by who opened it or who's involved"
        aria-label={picks.length ? `Filter by person, ${picks.length} on` : "Filter by person"}
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          setFind("");
        }}
      >
        <svg className="si" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <path d="M3 5.5h14M5.5 10h9M8 14.5h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        {picks.length > 0 && <span className="pill-count">{picks.length}</span>}
      </button>
      {open && (
        <>
          <div
            className="scrim-clear"
            role="presentation"
            onClick={() => {
              setOpen(false);
            }}
          />
          <div className="popover people-pop" aria-label="Filter by person">
            <input
              className="people-find"
              type="search"
              placeholder="Find a person"
              aria-label="Find a person"
              autoComplete="off"
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- the popover opens to pick someone; the box is where that starts
              autoFocus
              value={find}
              onChange={(e) => {
                setFind(e.target.value);
              }}
            />
            {FILTER_KEYS.map((key) => (
              <div key={key} className="people-group">
                <div className="pop-title" title={KEY_HELP[key]}>
                  {KEY_LABEL[key]}
                </div>
                {lists[key].length === 0 && <p className="people-none">No one</p>}
                {lists[key].map((login) => {
                  const on = picked(key, login);
                  return (
                    <button
                      key={login}
                      type="button"
                      className={cls("pop-item", on && "on")}
                      aria-pressed={on}
                      onClick={() => {
                        toggle(key, login);
                      }}
                    >
                      <Avatar login={login} />
                      <span className="people-who">{login === me ? "You" : login}</span>
                      {on && (
                        <svg className="people-tick" viewBox="0 0 16 16" aria-hidden="true">
                          <path d="m3.5 8.5 3 3 6-7" />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
            {picks.length > 0 && (
              <button
                type="button"
                className="pop-item people-clear"
                onClick={() => {
                  setFilter(withPeople(filter, []));
                }}
              >
                Clear
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
