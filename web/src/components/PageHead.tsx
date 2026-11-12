import type { ReactNode } from "react";
import { MOD } from "../format.ts";
import { partName, routeHash, settingsBack, type ListPage, type Route } from "../view.ts";

const BACK = { queue: "the Inbox", blocked: "Blocked", inflight: "Merging", archive: "the Archive" };
export const PAGE_NAME: Record<ListPage, string> = {
  queue: "Inbox",
  blocked: "Blocked",
  inflight: "Merging",
  archive: "Archive",
};

// The page's own head, at the top of its column: a list's filter, a review's, a question's or a Settings view's way back,
// or the page's name (Merging's, a Settings part's: the sidebar lists Settings' parts).
// In the desktop app it's the window's drag handle, its controls excepted.
export function PageHead({
  route,
  from,
  question,
  search,
  onNote,
}: {
  route: Route;
  from: ListPage; // where a review goes back to
  question: string | null; // a review opened from an agent's question goes back to it
  search: ReactNode; // the list's Filter
  onNote: () => void;
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
        <h1 className="head-name">Merging</h1>
      ) : route.name === "review" || route.name === "inquiry" || route.name === "doc" ? (
        <a
          className="back"
          href={routeHash(question ? { name: "inquiry", id: question } : { name: from })}
          title={`Back to ${question ? "the question" : BACK[from]} (Esc); ${MOD}[ and ${MOD}] open the item before and after this one`}
        >
          <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10 3.5 5.5 8l4.5 4.5" />
          </svg>
          <span>{question ? "Question" : PAGE_NAME[from]}</span>
        </a>
      ) : (
        <>
          {search}
          <button
            type="button"
            className="act head-note"
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
