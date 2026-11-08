import type { Overview, QueueView } from "../../../src/types.ts";
import { ago, cls } from "../format.ts";
import { pageOf, type ListPage, type Route } from "../view.ts";
import { Mark } from "./Mark.tsx";

function syncText(o: Overview | null, now: number, offline: boolean): string {
  if (offline) return "Offline";
  if (!o) return "Connecting…";
  if (o.syncing) return "Syncing…";
  if (o.sync_error) return "Sync failed";
  return o.synced_at ? `Synced ${ago(o.synced_at, now)}` : "Not synced yet";
}

// The window's only global chrome. The pages, in the owner's order: Inbox, Blocked, FYI, then Merging and the Archive under
// a hairline; in the footer, bottom up, Settings, the sync line and Ask your agent.
export function Sidebar({
  route,
  from,
  view,
  overview,
  offline,
  now,
  onSync,
  ask,
  waiting,
  onAsk,
}: {
  route: Route;
  from: ListPage; // where a review was opened from: it stays that page's
  view: QueueView | null;
  overview: Overview | null;
  offline: boolean;
  now: number;
  onSync: () => void;
  ask: boolean; // Ask your agent: not with the chat open, your agent off, or on its own question's page
  waiting: boolean; // the open review's latest ask is unanswered
  onAsk: () => void;
}) {
  const page = pageOf(route, from);
  const onQueue = page === "queue";
  const onLater = page === "later";
  const onLane = page === "inflight";
  const onBlocked = page === "blocked";
  const onArchive = page === "archive";
  const onSettings = route.name === "settings";
  const urgent = (view?.sections.now.length ?? 0) + (view?.inquiries.length ?? 0); // an agent's question waits on you too
  const today = view?.sections.today.length ?? 0;
  const flight = overview?.inflight;
  const rate = overview?.rate_limit ? `GitHub API: ${overview.rate_limit.remaining} requests left` : undefined;
  return (
    <aside className="side">
      {/* Not a link: on macOS this row is the window's drag handle, which swallows clicks. */}
      <div className="wordmark side-brand">
        <Mark />
        <span>Review Desk</span>
      </div>
      <nav className="side-nav" aria-label="Pages">
        <a
          href="#/"
          className={cls("side-item", onQueue && "on")}
          aria-current={onQueue ? "page" : undefined}
          title={view ? `${urgent + today} need you` : undefined}
          onClick={(e) => {
            // Already here: the hash wouldn't change, so go back to the top instead.
            if (route.name === "queue") {
              e.preventDefault();
              window.scrollTo({ top: 0 });
            }
          }}
        >
          <span className="side-name">Inbox</span>
          <span className="side-count">{view && urgent + today > 0 ? urgent + today : ""}</span>
        </a>
        {/* What can't move yet: no count, nothing there can move. */}
        <a
          href="#/blocked"
          className={cls("side-item", onBlocked && "on")}
          aria-current={onBlocked ? "page" : undefined}
          title="What can't move yet: another PR to merge first, or a review"
        >
          <span className="side-name">Blocked</span>
        </a>
        {/* What Claude and the rules sorted away: no count, nothing there needs you. */}
        <a
          href="#/later"
          className={cls("side-item", onLater && "on")}
          aria-current={onLater ? "page" : undefined}
          title="What was sorted away, snoozed or muted"
        >
          <span className="side-name">FYI</span>
        </a>
        <div className="side-sep" aria-hidden="true" />
        {/* No count: nothing there needs you, the coordinator has it. */}
        <a
          href="#/inflight"
          className={cls("side-item", onLane && "on")}
          aria-current={onLane ? "page" : undefined}
          title={flight?.total ? `${flight.total} merging` : "Your agent and what it merged"}
        >
          <span className="side-name">Merging</span>
        </a>
        {/* What you finished, and what was dealt with: no count, nothing there needs you. */}
        <a
          href="#/archive"
          className={cls("side-item", onArchive && "on")}
          aria-current={onArchive ? "page" : undefined}
          title="What's done: what you acted on and what resolved"
        >
          <span className="side-name">Archive</span>
        </a>
      </nav>
      <div className="side-foot">
        {ask && (
          <button
            type="button"
            className={cls("side-item", "side-ask", waiting && "waiting")}
            onClick={onAsk}
            title={`Ask your agent about what you're on${waiting ? " \u00b7 waiting for its answer" : ""}`}
          >
            <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
            </svg>
            <span className="side-name side-ask-long">{waiting ? "Your agent \u00b7 waiting" : "Ask your agent"}</span>
            <span className="side-name side-ask-short">{waiting ? "Asked" : "Ask"}</span>
          </button>
        )}
        <button
          type="button"
          className={cls("side-item", "side-sync", ((!!overview?.sync_error && !overview.syncing) || offline) && "err")}
          onClick={onSync}
          title={overview?.sync_error ?? rate ?? "Sync now"}
        >
          <svg className={cls("i", overview?.syncing && "spin")} viewBox="0 0 16 16" aria-hidden="true">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
          </svg>
          <span className="side-name">{syncText(overview, now, offline)}</span>
        </button>
        <a href="#/settings" className={cls("side-item", onSettings && "on")} aria-current={onSettings ? "page" : undefined}>
          <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
            <circle cx="10" cy="4.5" r="1.5" />
            <circle cx="6" cy="11.5" r="1.5" />
          </svg>
          <span className="side-name">Settings</span>
        </a>
      </div>
    </aside>
  );
}
