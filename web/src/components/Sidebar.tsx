import type { Overview, QueueView } from "../../../src/types.ts";
import { cls } from "../format.ts";
import type { Route } from "../view.ts";

// Sources of work, one entry each (just GitHub for now), your PRs in flight, and Settings in the footer.
export function Sidebar({
  route,
  from,
  view,
  overview,
  inert,
}: {
  route: Route;
  from: "queue" | "inflight"; // where a review was opened from: it stays that page's
  view: QueueView | null;
  overview: Overview | null;
  inert?: boolean;
}) {
  const onQueue = route.name === "queue" || (route.name === "review" && from === "queue");
  const onLane = route.name === "inflight" || (route.name === "review" && from === "inflight");
  const onSettings = route.name === "settings";
  const now = view?.sections.now.length ?? 0;
  const today = view?.sections.today.length ?? 0;
  const flight = overview?.inflight;
  return (
    <aside className="side" inert={inert}>
      {/* Not a link: on macOS this row is the window's drag handle, which swallows clicks. */}
      <div className="wordmark side-brand">
        <svg className="mark" viewBox="0 0 20 20" aria-hidden="true">
          <rect x="2" y="3" width="16" height="4" rx="1.5" className="mark-hl" />
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
          title={view ? `${now + today} in the queue${now ? `, ${now} urgent` : ""}` : undefined}
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
        {/* All of them, as the lane's heading says; the ones that need you are in the queue already. */}
        <a
          href="#/inflight"
          className={cls("side-item", onLane && "on")}
          aria-current={onLane ? "page" : undefined}
          title={flight ? `${flight.total} in flight, ${flight.needs_you} need you (g i)` : "Your PRs in flight (g i)"}
        >
          <span className="side-name">In flight</span>
          <span className="side-count">{flight && flight.total > 0 ? flight.total : ""}</span>
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
