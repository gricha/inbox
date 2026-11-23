import type { ReactNode } from "react";
import { MOD } from "../format.ts";
import { partName, routeHash, settingsBack, type ListPage, type Route } from "../route.ts";

const BACK = { queue: "the Inbox", blocked: "Blocked", inflight: "Merging", archive: "the Archive" };
export const PAGE_NAME: Record<ListPage, string> = {
  queue: "Inbox",
  blocked: "Blocked",
  inflight: "Merging",
  archive: "Archive",
};

// The page's own head, at the top of its column: a list's name (its filter is in the sidebar), a question's or a Settings view's way back (a review has no head),
// or the page's name (Merging's, a Settings part's: the sidebar lists Settings' parts).
// In the desktop app it's the window's drag handle, its controls excepted.
export function PageHead({
  route,
  from,
  onNote,
  people,
}: {
  route: Route;
  from: ListPage; // where a question or a review document goes back to
  onNote: () => void;
  people: ReactNode; // the filter by person, on a list's head and Merging's
}) {
  const inSettings = route.name === "settings";
  const part = inSettings ? settingsBack(route.section) : null;
  const backTo = part ? partName(part) : "";
  return (
    <header className="page-head">
      {part ? (
        <a className="back" href={routeHash({ name: "settings", section: part })} title={`Back to ${backTo} (Esc)`}>
          <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10 3.5 5.5 8l4.5 4.5" />
          </svg>
          <span>{backTo}</span>
        </a>
      ) : inSettings ? (
        <h1 className="head-name">{partName(route.section)}</h1>
      ) : route.name === "inflight" ? (
        <>
          <h1 className="head-name">Merging</h1>
          {people}
        </>
      ) : route.name === "inquiry" || route.name === "doc" ? (
        <a
          className="back"
          href={routeHash({ name: from })}
          title={`Back to ${BACK[from]} (Esc); ${MOD}[ and ${MOD}] open the item before and after this one`}
        >
          <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10 3.5 5.5 8l4.5 4.5" />
          </svg>
          <span>{PAGE_NAME[from]}</span>
        </a>
      ) : (
        <>
          {route.name === "queue" || route.name === "blocked" || route.name === "archive" ? (
            <h1 className="head-name">{PAGE_NAME[route.name]}</h1>
          ) : null}
          {people}
          <button
            type="button"
            className="act head-note"
            data-key={`${MOD}N`}
            title={`A note to yourself, with a reminder if you like (${MOD}N)`}
            onClick={onNote}
          >
            New note
          </button>
        </>
      )}
    </header>
  );
}
