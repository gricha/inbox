import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { Overview } from "../../../src/types.ts";
import { cls, MOD } from "../format.ts";
import { SETTINGS_PARTS } from "../settings-parts.ts";
import { pageOf, routeHash, settingsPart, type ListPage, type Route } from "../view.ts";
import { AgentMark } from "./Chat.tsx";
import { ArchiveIcon, BlockedIcon, InboxIcon, MergingIcon, SettingsIcon } from "./SideIcons.tsx";
import { Splitter, type Width } from "./Splitter.tsx";

// The window's only global chrome, as wide as you drag it. The search leads, on every page but Settings; then the pages, in the owner's order: Inbox, Blocked, Merging and
// the Archive; in Settings, its parts instead, under the way back to the Inbox: the core's, then the plugins'. In the footer, bottom up, Settings, Ask your agent and a newer Inbox (only when there's one); what's wrong with
// the sync is a bubble (Bubbles.tsx).
export function Sidebar({
  route,
  from,
  count,
  overview,
  onUpdate,
  ask,
  waiting,
  onAsk,
  search,
}: {
  route: Route;
  from: ListPage; // where a review was opened from: it stays that page's
  count: number | null; // what the Inbox counts, less what's leaving it; null until the queue loads
  overview: Overview | null;
  onUpdate: () => void;
  ask: boolean; // Ask your agent: not with the chat open, your agent off, or on its own question's page
  waiting: boolean; // the open review's latest ask is unanswered
  onAsk: () => void;
  search: ReactNode | null; // the search, at the top on every page but Settings
}) {
  const page = pageOf(route, from);
  const onQueue = page === "queue";
  const onLane = page === "inflight";
  const onBlocked = page === "blocked";
  const onArchive = page === "archive";
  const onSettings = route.name === "settings";
  const part = route.name === "settings" ? settingsPart(route.section) : null;
  const flight = overview?.inflight;
  // One row across a narrow window: whether more of it lies past the window's edge, so its end fades.
  const side = useRef<HTMLElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = side.current;
    const check = () => {
      if (el) setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    };
    check();
    const ro = new ResizeObserver(check);
    if (el) for (const x of [el, ...el.children]) ro.observe(x);
    el?.addEventListener("scroll", check, { passive: true });
    return () => {
      ro.disconnect();
      el?.removeEventListener("scroll", check);
    };
  }, []);
  const up = overview?.update?.available ? overview.update : null;
  return (
    <aside ref={side} className={cls("side", more && "more")}>
      {/* Not a link: on macOS this row is the window's drag handle, which swallows clicks. */}
      <div className="wordmark side-brand">
        <span>Inbox</span>
      </div>
      {/* Not in Settings: it searches the lists, and there's none of them here. */}
      {search && !onSettings && <div className="side-search">{search}</div>}
      {onSettings ? (
        <nav className="side-nav side-parts" aria-label="Settings">
          <a href="#/" className="side-item side-back" title={`Back to the Inbox (${MOD}1)`}>
            <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M10 3.5 5.5 8l4.5 4.5" />
            </svg>
            <span className="side-name">Inbox</span>
          </a>
          <div className="side-sep" aria-hidden="true" />
          {SETTINGS_PARTS.map((p, i) => {
            const on = p.id === part;
            const head = i === 0 ? "App" : p.plugin && !SETTINGS_PARTS[i - 1]?.plugin ? "Integrations" : null;
            return (
              <Fragment key={p.id}>
                {head && <div className="side-group">{head}</div>}
                <a
                  href={routeHash({ name: "settings", section: p.id })}
                  className={cls("side-item", on && "on")}
                  aria-current={on ? "page" : undefined}
                >
                  <span className="side-name">{p.name}</span>
                </a>
              </Fragment>
            );
          })}
        </nav>
      ) : (
        <nav className="side-nav" aria-label="Pages">
          <a
            href="#/"
            data-key={`${MOD}1`}
            className={cls("side-item", onQueue && "on")}
            aria-current={onQueue ? "page" : undefined}
            title={count === null ? `${MOD}1` : `${count} need you (${MOD}1)`}
            onClick={(e) => {
              // Already here: the hash wouldn't change, so go back to the top instead.
              if (route.name === "queue") {
                e.preventDefault();
                window.scrollTo({ top: 0 });
              }
            }}
          >
            <InboxIcon />
            <span className="side-name">Inbox</span>
            <span className="side-count">{count !== null && count > 0 ? count : ""}</span>
          </a>
          {/* What can't move yet: no count, nothing there can move. */}
          <a
            href="#/blocked"
            data-key={`${MOD}2`}
            className={cls("side-item", onBlocked && "on")}
            aria-current={onBlocked ? "page" : undefined}
            title={`Your PRs that can't move yet: another PR to merge first, or their reviewers (${MOD}2)`}
          >
            <BlockedIcon />
            <span className="side-name">Blocked</span>
          </a>
          {/* No count: nothing there needs you, the coordinator has it. */}
          <a
            href="#/inflight"
            data-key={`${MOD}3`}
            className={cls("side-item", onLane && "on")}
            aria-current={onLane ? "page" : undefined}
            title={`${flight?.total ? `${flight.total} merging` : "Your agent and what it merged"} (${MOD}3)`}
          >
            <MergingIcon />
            <span className="side-name">Merging</span>
          </a>
          {/* What you finished, and what was dealt with: no count, nothing there needs you. */}
          <a
            href="#/archive"
            data-key={`${MOD}4`}
            className={cls("side-item", onArchive && "on")}
            aria-current={onArchive ? "page" : undefined}
            title={`What's done, snoozed or muted: what you acted on and what resolved (${MOD}4)`}
          >
            <ArchiveIcon />
            <span className="side-name">Archive</span>
          </a>
        </nav>
      )}
      <div className="side-foot">
        {/* A newer Inbox: the app downloads it unasked where it can, then offers the restart; else its release page has it. */}
        {up?.install && up.ready && (
          <button
            type="button"
            className="side-item side-update"
            onClick={onUpdate}
            disabled={up.installing}
            title={`Inbox ${up.latest} is downloaded: restart into it (this is ${up.current})`}
          >
            {up.installing ? (
              <span className="busy" />
            ) : (
              <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M13 8a5 5 0 1 1-1.5-3.55M13 2.5v3h-3" />
              </svg>
            )}
            <span className="side-name side-long">{up.installing ? "Restarting\u2026" : "Restart to update"}</span>
            <span className="side-name side-short">{up.installing ? "Restarting\u2026" : "Restart"}</span>
          </button>
        )}
        {up?.install && !up.ready && up.downloading && (
          <span className="side-item side-update quiet" title={`Downloading Inbox ${up.latest} (this is ${up.current})`}>
            <span className="busy" />
            <span className="side-name side-long">{`Downloading ${up.latest}\u2026`}</span>
            <span className="side-name side-short">{"Updating\u2026"}</span>
          </span>
        )}
        {up && !up.install && up.url && (
          <a
            href={up.url}
            target="_blank"
            rel="noreferrer"
            className="side-item side-update"
            title={`${up.error ? `The update failed: ${up.error}. ` : ""}Inbox ${up.latest} is out (this is ${up.current}): its release page has the download`}
          >
            <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
            </svg>
            <span className="side-name side-long">{`Download ${up.latest}`}</span>
            <span className="side-name side-short">Download</span>
          </a>
        )}
        {ask && (
          <button
            type="button"
            className={cls("side-item", "side-ask", waiting && "waiting")}
            onClick={onAsk}
            data-key={`${MOD}J`}
            title={`Ask your agent about what you're on${waiting ? " \u00b7 waiting for its answer" : ""} (${MOD}J)`}
          >
            <AgentMark agent={MARK_OF[overview?.ai_agent ?? "Claude"]} />
            <span className="side-name side-ask-long">{waiting ? "Your agent \u00b7 waiting" : "Ask your agent"}</span>
            <span className="side-name side-ask-short">{waiting ? "Asked" : "Ask"}</span>
          </button>
        )}
        <a href="#/settings" className={cls("side-item", onSettings && "on")}>
          <SettingsIcon />
          <span className="side-name">Settings</span>
        </a>
      </div>
      <Splitter width={SIDE} edge="right" column={() => side.current} label="the sidebar" className="side-resize" />
    </aside>
  );
}

// Your agent (Settings → Agent), as the chat draws its mark.
const MARK_OF = { Claude: "claude-code", Codex: "codex", OpenCode: "opencode" } as const;

const SIDE: Width = { key: "desk.side.width", cssVar: "--side-w-user", min: 160, max: 0.3 };
