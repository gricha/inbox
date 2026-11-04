import type { Inquiry, Overview, QueueView } from "../../../src/types.ts";
import { cls } from "../format.ts";
import { foldOf, SORTED_AWAY, type Group, type GroupKey } from "../view.ts";
import { CardRow, type RowCtx } from "./CardRow.tsx";
import { InquiryRow, type InquiryCtx } from "./Inquiry.tsx";
import { withCode } from "./Review.tsx";
import { SkRows } from "./Skeleton.tsx";

const KEY: Partial<Record<GroupKey, string>> = { later: "g l", fyi: "g f", resolved: "g d", hidden: "g h", cleared: "g x" };

// The main page: only what needs you, one line each, in the desk's order; agents' questions first, since one waits on each.
export function Queue({
  view,
  overview,
  groups,
  ctx,
  inquiries,
  inq,
  filter,
  unfold,
  selectFold,
}: {
  view: QueueView | null;
  overview: Overview | null;
  groups: Group[];
  ctx: RowCtx;
  inquiries: Inquiry[];
  inq: InquiryCtx;
  filter: string;
  unfold: (k: GroupKey) => void;
  selectFold: (k: GroupKey) => void;
}) {
  if (!view) {
    const first = !!overview && !overview.synced_at;
    return (
      <div className="queue">
        {first ? <p className="quiet-note">Reading your GitHub queue for the first time. This takes about 30 seconds.</p> : <SkRows />}
      </div>
    );
  }
  const g = groups.find((x) => x.key === "queue");
  return (
    <div className="queue">
      {view.paused && (
        <p className="ai-paused">
          <b>{view.paused.who === "claude" ? "Claude is paused:" : "AI reviews are paused:"}</b> {withCode(view.paused.why)}
        </p>
      )}
      {inquiries.length > 0 || (g && g.cards.length > 0) ? (
        <div className="lines" aria-label="Needs you">
          {inquiries.map((q) => (
            <InquiryRow key={q.id} q={q} ctx={inq} />
          ))}
          {g?.cards.map((c) => (
            <CardRow key={c.id} card={c} variant="active" ctx={ctx} />
          ))}
        </div>
      ) : (
        <p className="queue-empty">{filter.trim() ? "No matches." : "Nothing needs you right now."}</p>
      )}
      {g && g.fold > 0 && (
        <button
          type="button"
          className={cls("fold", ctx.selected === foldOf(g.key) && "sel")}
          data-id={foldOf(g.key)}
          // Focus on mousedown would move the selection before the click lands.
          onMouseDown={(e) => {
            e.preventDefault();
          }}
          onClick={() => {
            unfold(g.key);
          }}
          onFocus={() => {
            selectFold(g.key);
          }}
        >
          {g.fold} more
        </button>
      )}
    </div>
  );
}

// Later: what Claude and the rules sorted away, and what you cleared or what resolved. Each group opens on its heading.
export function Later({
  view,
  groups,
  ctx,
  filter,
  toggle,
}: {
  view: QueueView | null;
  groups: Group[];
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
  const away = groups.filter((g) => SORTED_AWAY.includes(g.key) && (filtering ? g.cards.length : g.total));
  return (
    <div className="queue later">
      {!away.length && <p className="queue-empty">{filtering ? "No matches." : "Nothing sorted away."}</p>}
      {away.map((g) => (
        <section key={g.key} className={`group g-${g.key}`} aria-labelledby={`h-${g.key}`}>
          <h2 id={`h-${g.key}`} className="group-head">
            <button
              type="button"
              className="group-toggle"
              aria-expanded={g.open}
              disabled={g.forced}
              title={g.forced ? "Opened by the filter" : `${g.open ? "Close" : "Open"} (${KEY[g.key]})`}
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
              {g.cards.map((c) => (
                <CardRow key={c.id} card={c} variant={g.variant} ctx={ctx} why />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
