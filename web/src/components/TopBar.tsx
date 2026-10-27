import type { RefObject } from "react";
import type { Overview } from "../../../src/types.ts";
import { ago, cls } from "../format.ts";
import type { Route } from "../view.ts";

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
  filter,
  setFilter,
  filterRef,
  onSync,
  onHelp,
  inert,
}: {
  overview: Overview | null;
  offline: boolean;
  now: number;
  route: Route;
  filter: string;
  setFilter: (s: string) => void;
  filterRef: RefObject<HTMLInputElement | null>;
  onSync: () => void;
  onHelp: () => void;
  inert?: boolean;
}) {
  const inSettings = route.name === "settings";
  const rate = o?.rate_limit ? `GitHub API: ${o.rate_limit.remaining} requests left` : undefined;
  return (
    <header className="topbar" inert={inert}>
      <a className="wordmark" href="#/" title="Queue">
        <svg className="mark" viewBox="0 0 20 20" aria-hidden="true">
          <rect x="2" y="3" width="16" height="4" rx="1.5" className="mark-hl" />
          <rect x="2" y="9" width="12" height="2.5" rx="1.25" />
          <rect x="2" y="14" width="9" height="2.5" rx="1.25" />
        </svg>
        <span>Review Desk</span>
      </a>
      {inSettings ? (
        <span className="crumb">Settings</span>
      ) : (
        <label className="search">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" />
          </svg>
          <input
            ref={filterRef}
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
          {!filter && <kbd>/</kbd>}
        </label>
      )}
      <div className="tb-right">
        <button
          type="button"
          className={cls("sync", ((!!o?.sync_error && !o.syncing) || offline) && "err")}
          onClick={onSync}
          title={o?.sync_error ?? rate ?? "Sync now (r)"}
        >
          <svg className={cls("i", o?.syncing && "spin")} viewBox="0 0 16 16" aria-hidden="true">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
          </svg>
          <span>{syncText(o, now, offline)}</span>
        </button>
        <button type="button" className="icon" onClick={onHelp} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
          <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="1.5" y="4" width="13" height="8.5" rx="1.5" />
            <path d="M4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M5 10h6" />
          </svg>
        </button>
        <a
          className={cls("icon", "to-settings", inSettings && "on")}
          href={inSettings ? "#/" : "#/settings/github"}
          title={inSettings ? "Back to the queue (Esc)" : "Settings (,)"}
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
