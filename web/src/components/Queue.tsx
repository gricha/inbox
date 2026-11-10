import type { Card, Inquiry, Overview, QueueView, SessionCard } from "../../../src/types.ts";
import { cls, aiName } from "../format.ts";
import { foldOf, PAGE_GROUPS, treeGuides, type Group, type GroupKey } from "../view.ts";
import { CardRow, type RowCtx } from "./CardRow.tsx";
import { InquiryRow, type InquiryCtx } from "./Inquiry.tsx";
import { SessionRow, type SessionCtx } from "./Session.tsx";
import { withCode } from "./Review.tsx";
import { SkRows } from "./Skeleton.tsx";

// The main page: what's on your Inbox, in its sections, each in the desk's order: Urgent (agents' questions and the sessions
// that need you first, since one waits on each), Standard and FYI. Each row says why it's there, quietly.
export function Queue({
  view,
  overview,
  groups,
  ctx,
  inquiries,
  inq,
  sessions,
  ses,
  filter,
  unfold,
  selectFold,
  toggle,
}: {
  view: QueueView | null;
  overview: Overview | null;
  groups: Group[];
  ctx: RowCtx;
  inquiries: Inquiry[];
  inq: InquiryCtx;
  sessions?: SessionCard[]; // none beside a review: two lines a row has no room for one's detail
  ses?: SessionCtx;
  filter: string;
  unfold: (k: GroupKey, keyboard: boolean) => void;
  selectFold: (k: GroupKey) => void;
  toggle: (k: GroupKey) => void;
}) {
  if (!view) {
    const first = !!overview && !overview.synced_at;
    return (
      <div className="queue">
        {first ? (
          <p className="quiet-note">Filling your Inbox for the first time. This takes about 30 seconds.</p>
        ) : (
          // Under a heading's placeholder, so the first section's rows land where these were.
          <section className="group">
            <h2 className="group-head" aria-hidden="true">
              <span className="group-toggle">
                <span className="sk sk-head" />
                {"\u200b"}
              </span>
            </h2>
            <SkRows />
          </section>
        )}
      </div>
    );
  }
  const shown = ses ? (sessions ?? []) : [];
  const parts = groups
    .filter((g) => PAGE_GROUPS.queue.includes(g.key))
    .map((g) => ({ g, lead: g.key === "urgent" ? inquiries.length + shown.length : 0 }))
    .filter(({ g, lead }) => lead > 0 || g.cards.length > 0 || g.fold > 0);
  // A row you acted on is on its way off: it fades out where it is, and the last one to go leaves the empty line.
  const any = parts.some(({ g, lead }) => lead > 0 || g.cards.some((c) => !ctx.leaving.has(c.id)));
  return (
    <div className="queue">
      {view.paused && (
        <p className="ai-paused">
          <b>{view.paused.who === "claude" ? `${aiName()} is paused:` : "AI reviews are paused:"}</b> {withCode(view.paused.why)}
        </p>
      )}
      {any ? (
        parts.map(({ g, lead }) => (
          <section key={g.key} className={`group g-${g.key}`} aria-labelledby={`h-${g.key}`}>
            <h2 id={`h-${g.key}`} className="group-head">
              <button
                type="button"
                className="group-toggle"
                aria-expanded={g.open}
                disabled={g.forced}
                title={g.forced ? "Opened by the filter" : g.open ? "Close" : "Open"}
                onClick={() => {
                  toggle(g.key);
                }}
              >
                <span>{g.label}</span>
                <span className="count">{g.total + lead}</span>
              </button>
            </h2>
            {g.open && (
              <div className="lines">
                {g.key === "urgent" && inquiries.map((q) => <InquiryRow key={q.id} q={q} ctx={inq} />)}
                {g.key === "urgent" && ses && shown.map((s) => <SessionRow key={s.id} s={s} ctx={ses} />)}
                {g.cards.map((c) => (
                  <CardRow key={c.id} card={c} variant="active" ctx={ctx} />
                ))}
              </div>
            )}
            {g.open && g.fold > 0 && (
              <button
                type="button"
                className={cls("fold", ctx.selected === foldOf(g.key) && "sel")}
                data-id={foldOf(g.key)}
                // Focus on mousedown would move the selection before the click lands.
                onMouseDown={(e) => {
                  e.preventDefault();
                }}
                onClick={(e) => {
                  unfold(g.key, e.detail === 0); // 0: Enter or Space, not a click
                }}
                onFocus={() => {
                  selectFold(g.key);
                }}
              >
                {g.fold} more
              </button>
            )}
          </section>
        ))
      ) : (
        <p className="queue-empty">{filter.trim() ? "No matches." : "Nothing needs you right now."}</p>
      )}
      {view.reviewing > 0 && (
        <p className="queue-reviewing">
          {view.reviewing === 1
            ? `1 more PR reaches you once ${aiName()} has reviewed it.`
            : `${view.reviewing} more PRs reach you once ${aiName()} has reviewed them.`}
        </p>
      )}
    </div>
  );
}

// Blocked and the Archive (what's done, snoozed, muted or hidden by rules): their groups, each opening on its heading.
export function Later({
  view,
  groups,
  keys,
  empty,
  ctx,
  filter,
  toggle,
}: {
  view: QueueView | null;
  groups: Group[];
  keys: GroupKey[]; // the groups this page shows
  empty: string;
  ctx: RowCtx;
  filter: string;
  toggle: (k: GroupKey) => void;
}) {
  if (!view)
    return (
      <div className="queue later">
        <SkRows />
      </div>
    );
  const filtering = !!filter.trim();
  const away = groups.filter((g) => keys.includes(g.key) && (filtering ? g.cards.length : g.total));
  // Blocked is a tree in the desk's order; filtered, some of it is missing, so it lies flat.
  const tree = (k: GroupKey, cards: Card[]) => (k === "blocked" && !filtering ? treeGuides(cards.map((c) => c.depth ?? 0)) : []);
  const trees = new Map(away.map((g) => [g.key, tree(g.key, g.cards)]));
  return (
    <div className="queue later">
      {!away.length && <p className="queue-empty">{filtering ? "No matches." : empty}</p>}
      {away.map((g) => (
        <section key={g.key} className={`group g-${g.key}`} aria-labelledby={`h-${g.key}`}>
          <h2 id={`h-${g.key}`} className="group-head">
            <button
              type="button"
              className="group-toggle"
              aria-expanded={g.open}
              disabled={g.forced}
              title={g.forced ? "Opened by the filter" : g.open ? "Close" : "Open"}
              onClick={() => {
                toggle(g.key);
              }}
            >
              <span>{g.label}</span>
              <span className="count">{filtering ? `${g.cards.length} of ${g.total}` : g.total}</span>
            </button>
          </h2>
          {g.open && (
            <div className="lines">
              {g.cards.map((c, i) => (
                <CardRow key={c.id} card={c} variant={g.variant} ctx={ctx} why tree={trees.get(g.key)![i]} />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
