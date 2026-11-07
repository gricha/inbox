import type { Overview } from "../../../src/types.ts";
import { ago, cls } from "../format.ts";
import { routeHash, type ListPage, type Route } from "../view.ts";

const BACK = { queue: "the queue", later: "Later", blocked: "Blocked", inflight: "Merging", archive: "the Archive" };
const BACK_LABEL = { queue: "Queue", later: "Later", blocked: "Blocked", inflight: "Merging", archive: "Archive" };

function syncText(o: Overview | null, now: number, offline: boolean): string {
  if (offline) return "Offline";
  if (!o) return "Connecting…";
  if (o.syncing) return "Syncing…";
  if (o.sync_error) return "Sync failed";
  return o.synced_at ? `Synced ${ago(o.synced_at, now)}` : "Not synced yet";
}

export function TopBar({
  overview: o,
  offline,
  now,
  route,
  from,
  question,
  filter,
  setFilter,
  onSync,
  ask,
  waiting,
  onAsk,
}: {
  overview: Overview | null;
  offline: boolean;
  now: number;
  route: Route;
  from: ListPage; // where a review goes back to
  question: string | null; // a review opened from an agent's question goes back to it
  filter: string;
  setFilter: (s: string) => void;
  onSync: () => void;
  ask: boolean; // Ask your agent: not with the chat open, your agent off, or on its own question's page
  waiting: boolean; // the open review's latest ask is unanswered
  onAsk: () => void;
}) {
  const inSettings = route.name === "settings";
  const rate = o?.rate_limit ? `GitHub API: ${o.rate_limit.remaining} requests left` : undefined;
  return (
    <header className="topbar">
      <a className="wordmark" href="#/" title="Queue">
        <svg className="mark" viewBox="0 0 20 20" aria-hidden="true">
          <rect x="2" y="3" width="16" height="4" rx="1.5" />
          <rect x="2" y="9" width="12" height="2.5" rx="1.25" />
          <rect x="2" y="14" width="9" height="2.5" rx="1.25" />
        </svg>
        <span>Review Desk</span>
      </a>
      {inSettings || route.name === "inflight" ? (
        <span className="crumb">{inSettings ? "Settings" : "Merging"}</span>
      ) : route.name === "review" || route.name === "inquiry" ? (
        <a
          className="back"
          href={routeHash(question ? { name: "inquiry", id: question } : { name: from })}
          title={`Back to ${question ? "the question" : BACK[from]} (Esc)`}
        >
          <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10 3.5 5.5 8l4.5 4.5" />
          </svg>
          <span>{question ? "Question" : BACK_LABEL[from]}</span>
        </a>
      ) : (
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
      )}
      <div className="tb-right">
        <button
          type="button"
          className={cls("sync", ((!!o?.sync_error && !o.syncing) || offline) && "err")}
          onClick={onSync}
          title={o?.sync_error ?? rate ?? "Sync now"}
        >
          <svg className={cls("i", o?.syncing && "spin")} viewBox="0 0 16 16" aria-hidden="true">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
          </svg>
          <span>{syncText(o, now, offline)}</span>
        </button>
        {/* Below 1000px the sidebar is gone: Later, Merging, Blocked and the Archive are reachable from here. */}
        {route.name !== "later" && (
          <a className="tb-flight" href="#/later" title="Sorted away">
            Later
          </a>
        )}
        {/* Merging is your agent's page, so it's here while nothing is handed off too. */}
        {route.name !== "inflight" && (
          <a
            className="tb-flight"
            href="#/inflight"
            title={o?.inflight.total ? `${o.inflight.total} merging` : "Your agent and what it merged"}
          >
            Merging
          </a>
        )}
        {route.name !== "blocked" && (
          <a className="tb-flight" href="#/blocked" title="What can't move yet">
            Blocked
          </a>
        )}
        {route.name !== "archive" && (
          <a className="tb-flight" href="#/archive" title="What's done">
            Archive
          </a>
        )}
        {ask && (
          <button
            type="button"
            className={cls("tb-ask", waiting && "waiting")}
            onClick={onAsk}
            title={`Ask your agent about what you're on${waiting ? " \u00b7 waiting for its answer" : ""}`}
          >
            <span className="tb-ask-long">{waiting ? "Your agent \u00b7 waiting" : "Ask your agent"}</span>
            <span className="tb-ask-short">{waiting ? "Asked" : "Ask"}</span>
            <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
            </svg>
          </button>
        )}
        <a
          className={cls("icon", "to-settings", inSettings && "on")}
          href={inSettings ? "#/" : "#/settings/github"}
          title={inSettings ? "Back to the queue (Esc)" : "Settings"}
          aria-label="Settings"
        >
          <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
            <circle cx="10" cy="4.5" r="1.5" />
            <circle cx="6" cy="11.5" r="1.5" />
          </svg>
        </a>
      </div>
    </header>
  );
}
