import { useRef, type KeyboardEvent } from "react";
import { filterOf, filterRest, parseFilter } from "../view.ts";
import { SearchIcon } from "./SideIcons.tsx";

export interface FilterPerson {
  login: string;
  author: boolean; // wrote one of the rows
}

// The search at the top of the sidebar: words that match a row's title, repo or author. Who it's by or who's on it is the
// Filter button's (PeopleFilter.tsx); its picks stay in the query as author:/involves: terms, kept as you type here.
export function Filter({ filter, setFilter }: { filter: string; setFilter: (s: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const pills = parseFilter(filter).terms.filter((t) => t.done);
  const rest = filterRest(filter);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setFilter(filterOf(pills, ""));
      e.currentTarget.blur();
    } else if (e.key === "Enter" || e.key === "ArrowDown") e.currentTarget.blur();
  }

  return (
    <div className="search-box">
      <label className="search">
        <SearchIcon />
        <input
          ref={input}
          type="search"
          placeholder="Search"
          aria-label="Search by title, repo or author"
          autoComplete="off"
          value={rest}
          onChange={(e) => {
            setFilter(filterOf(pills, e.target.value));
          }}
          onKeyDown={onKeyDown}
        />
      </label>
    </div>
  );
}
