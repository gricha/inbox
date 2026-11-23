import { useRef, type ClipboardEvent, type KeyboardEvent } from "react";
import { filterOf, filterRest, githubRef, parseFilter } from "../filter.ts";
import { SearchIcon } from "./SideIcons.tsx";

export interface FilterPerson {
  login: string;
  author: boolean; // wrote one of the rows
}

// The search at the top of the sidebar: words that match a row's title, repo or author. Who it's by or who's on it is the
// Filter button's (PeopleFilter.tsx); its picks stay in the query as author:/involves: terms, kept as you type here.
// A pasted GitHub link to a PR or an issue is the whole search, and `onLink` adds it when the desk doesn't have it.
export function Filter({ filter, setFilter, onLink }: { filter: string; setFilter: (s: string) => void; onLink: (ref: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const pills = parseFilter(filter).terms.filter((t) => t.done);
  const rest = filterRest(filter);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setFilter(filterOf(pills, ""));
      e.currentTarget.blur();
    } else if (e.key === "Enter" || e.key === "ArrowDown") e.currentTarget.blur();
  }

  // Only a paste: a link typed by hand would add PR #1 on its way to #131869.
  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const link = e.clipboardData.getData("text").trim();
    const ref = githubRef(link);
    if (!ref) return;
    e.preventDefault();
    setFilter(link);
    onLink(ref);
  }

  return (
    <div className="search-box">
      <label className="search" data-key="/">
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
          onPaste={onPaste}
        />
      </label>
    </div>
  );
}
