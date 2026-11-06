import type { Overview, QueueView } from "../../../src/types.ts";
import { cls } from "../format.ts";
import type { ListPage, Route } from "../view.ts";

// Sources of work, one entry each (just GitHub for now), what was sorted away, your PRs in Merging, and Settings in the footer.
export function Sidebar({
  route,
  from,
  view,
  overview,
  inert,
}: {
  route: Route;
  from: ListPage; // where a review was opened from: it stays that page's
  view: QueueView | null;
  overview: Overview | null;
  inert?: boolean;
}) {
  const onQueue = route.name === "queue" || route.name === "inquiry" || (route.name === "review" && from === "queue");
  const onLater = route.name === "later" || (route.name === "review" && from === "later");
  const onLane = route.name === "inflight" || (route.name === "review" && from === "inflight");
  const onWaiting = route.name === "waiting" || (route.name === "review" && from === "waiting");
  const onArchive = route.name === "archive" || (route.name === "review" && from === "archive");
  const onSettings = route.name === "settings";
  const now = (view?.sections.now.length ?? 0) + (view?.inquiries.length ?? 0); // an agent's question waits on you too
  const today = view?.sections.today.length ?? 0;
  const flight = overview?.inflight;
  return (
    <aside className="side" inert={inert}>
      {/* Not a link: on macOS this row is the window's drag handle, which swallows clicks. */}
      <div className="wordmark side-brand">
        <svg className="mark" viewBox="0 0 20 20" aria-hidden="true">
          <rect x="2" y="3" width="16" height="4" rx="1.5" />
          <rect x="2" y="9" width="12" height="2.5" rx="1.25" />
          <rect x="2" y="14" width="9" height="2.5" rx="1.25" />
        </svg>
        <span>Review Desk</span>
      </div>
      <nav className="side-nav" aria-label="Sources">
        <a
          href="#/"
          className={cls("side-item", onQueue && "on")}
          aria-current={onQueue ? "page" : undefined}
          title={view ? `${now + today} need you` : undefined}
          onClick={(e) => {
            // Already here: the hash wouldn't change, so go back to the top instead.
            if (route.name === "queue") {
              e.preventDefault();
              window.scrollTo({ top: 0 });
            }
          }}
        >
          <span className="side-name">GitHub</span>
          <span className="side-count">{view && now + today > 0 ? now + today : ""}</span>
        </a>
        {/* What Claude and the rules sorted away: no count, nothing there needs you. */}
        <a
          href="#/later"
          className={cls("side-item", onLater && "on")}
          aria-current={onLater ? "page" : undefined}
          title="Sorted away (g l)"
        >
          <span className="side-name">Later</span>
        </a>
        {/* No count: nothing there needs you, the coordinator has it. */}
        <a
          href="#/inflight"
          className={cls("side-item", onLane && "on")}
          aria-current={onLane ? "page" : undefined}
          title={flight ? `${flight.total} merging (g m)` : "Your PRs the coordinator is getting merged (g m)"}
        >
          <span className="side-name">Merging</span>
        </a>
        {/* Your PRs whose next move is someone else's: no count, nothing there needs you. */}
        <a
          href="#/waiting"
          className={cls("side-item", onWaiting && "on")}
          aria-current={onWaiting ? "page" : undefined}
          title="Your PRs waiting on someone else's review or another PR (g w)"
        >
          <span className="side-name">Waiting</span>
        </a>
        {/* What you finished, and what was dealt with: no count, nothing there needs you. */}
        <a
          href="#/archive"
          className={cls("side-item", onArchive && "on")}
          aria-current={onArchive ? "page" : undefined}
          title="What's done: what you acted on and what resolved (g a)"
        >
          <span className="side-name">Archive</span>
        </a>
      </nav>
      <a href="#/settings" className={cls("side-item", "side-foot", onSettings && "on")} aria-current={onSettings ? "page" : undefined}>
        <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
          <circle cx="10" cy="4.5" r="1.5" />
          <circle cx="6" cy="11.5" r="1.5" />
        </svg>
        <span className="side-name">Settings</span>
        <kbd>,</kbd>
      </a>
    </aside>
  );
}
