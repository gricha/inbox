import type { QueueView, SettingsView } from "../../../src/types.ts";
import { cls } from "../format.ts";
import { SORTED_AWAY, type GroupKey, type Route } from "../view.ts";

const LABEL: Record<GroupKey, string> = { now: "Now", today: "Today", later: "Later", fyi: "FYI", hidden: "Hidden", cleared: "Cleared" };
const RULES = { id: "rules", title: "Rules" };

export const cardsOf = (view: QueueView, k: GroupKey) => (k === "hidden" ? view.hidden : k === "cleared" ? view.cleared : view.sections[k]);

// Navigation for the one queue and its settings. No categories here: those are rules.
export function Sidebar({
  route,
  view,
  settings,
  open,
  jump,
  inert,
}: {
  route: Route;
  view: QueueView | null;
  settings: SettingsView | null;
  open: Record<GroupKey, boolean>;
  jump: (k: GroupKey) => void;
  inert?: boolean;
}) {
  const sections = settings ? [...settings.sections.slice(0, 1), RULES, ...settings.sections.slice(1)] : [];
  // An unknown section shows the first one (see Settings), so mark that one.
  const shown = route.name === "settings" && sections.some((x) => x.id === route.section) ? route.section : sections[0]?.id;
  const onQueue = route.name === "queue";

  const item = (k: GroupKey) => {
    const cards = view ? cardsOf(view, k) : [];
    const away = SORTED_AWAY.includes(k);
    const fresh = away ? cards.filter((c) => c.new).length : 0;
    return (
      <button
        key={k}
        type="button"
        className={cls("side-item", k === "now" && cards.length > 0 && "side-now", onQueue && away && open[k] && "open")}
        aria-expanded={away ? open[k] : undefined}
        disabled={away && view !== null && cards.length === 0}
        onClick={() => {
          jump(k);
        }}
      >
        <span className="side-name">{LABEL[k]}</span>
        {fresh > 0 && (
          <>
            <span className="side-new" aria-hidden="true" title={`${fresh} with new activity`} />
            <span className="sr-only">, {fresh} new</span>
          </>
        )}
        <span className="side-count">{view ? cards.length : ""}</span>
      </button>
    );
  };

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
      <nav className="side-nav" aria-label="Queue and settings">
        <a
          href="#/"
          className="side-label first"
          aria-current={onQueue ? "page" : undefined}
          onClick={(e) => {
            // Already here: the hash wouldn't change, so go back to the top instead.
            if (onQueue) {
              e.preventDefault();
              window.scrollTo({ top: 0 });
            }
          }}
        >
          Queue
        </a>
        {item("now")}
        {item("today")}
        <p className="side-label">Sorted away</p>
        {SORTED_AWAY.map(item)}
        <p className="side-label">Settings</p>
        {sections.map((s) => {
          const on = route.name === "settings" && shown === s.id;
          return (
            <a
              key={s.id}
              href={`#/settings/${s.id}`}
              className={cls("side-item", "side-set", on && "on")}
              aria-current={on ? "page" : undefined}
            >
              {s.title}
            </a>
          );
        })}
      </nav>
    </aside>
  );
}
