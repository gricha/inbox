import { routeHash, type ListPage, type Route } from "../view.ts";

const BACK = { queue: "the Inbox", later: "FYI", blocked: "Blocked", inflight: "Merging", archive: "the Archive" };
export const PAGE_NAME: Record<ListPage, string> = {
  queue: "Inbox",
  later: "FYI",
  blocked: "Blocked",
  inflight: "Merging",
  archive: "Archive",
};

// The page's own head, at the top of its column: a list's filter, a review's or a question's way back, or the page's name.
// In the desktop app it's the window's drag handle, its controls excepted.
export function PageHead({
  route,
  from,
  question,
  filter,
  setFilter,
}: {
  route: Route;
  from: ListPage; // where a review goes back to
  question: string | null; // a review opened from an agent's question goes back to it
  filter: string;
  setFilter: (s: string) => void;
}) {
  const inSettings = route.name === "settings";
  return (
    <header className="page-head">
      {inSettings || route.name === "inflight" ? (
        <h1 className="head-name">{inSettings ? "Settings" : "Merging"}</h1>
      ) : route.name === "review" || route.name === "inquiry" ? (
        <a
          className="back"
          href={routeHash(question ? { name: "inquiry", id: question } : { name: from })}
          title={`Back to ${question ? "the question" : BACK[from]} (Esc)`}
        >
          <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10 3.5 5.5 8l4.5 4.5" />
          </svg>
          <span>{question ? "Question" : PAGE_NAME[from]}</span>
        </a>
      ) : (
        <Filter filter={filter} setFilter={setFilter} />
      )}
    </header>
  );
}

// A list's filter: on its page's head, or the head of the list beside a review.
export function Filter({ filter, setFilter }: { filter: string; setFilter: (s: string) => void }) {
  return (
    <label className="search">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" />
        <path d="m10.5 10.5 3 3" />
      </svg>
      <input
        type="search"
        placeholder="Filter"
        aria-label="Filter by title, repo or author"
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setFilter("");
            e.currentTarget.blur();
          } else if (e.key === "Enter" || e.key === "ArrowDown") e.currentTarget.blur();
        }}
      />
    </label>
  );
}
