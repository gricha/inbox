import type { QueueView } from "../../../src/types.ts";
import { cls } from "../format.ts";
import type { Route } from "../view.ts";

// Sources of work, one entry each (just GitHub for now), and Settings in the footer.
export function Sidebar({ route, view, inert }: { route: Route; view: QueueView | null; inert?: boolean }) {
  const onQueue = route.name === "queue";
  const onSettings = route.name === "settings";
  const now = view?.sections.now.length ?? 0;
  const today = view?.sections.today.length ?? 0;
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
          title={view ? `${now} now, ${today} today` : undefined}
          onClick={(e) => {
            // Already here: the hash wouldn't change, so go back to the top instead.
            if (onQueue) {
              e.preventDefault();
              window.scrollTo({ top: 0 });
            }
          }}
        >
          <span className="side-name">GitHub</span>
          <span className="side-count">{view ? now + today : ""}</span>
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
