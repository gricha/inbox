import type { Card, Overview, QueueView } from "../../../src/types.ts";
import { cls } from "../format.ts";
import { AWAY_BAR, foldOf, nextText, problems, runs, says, SORTED_AWAY, type Group, type GroupKey } from "../view.ts";
import { CardRow, withKeys, type RowCtx } from "./CardRow.tsx";
import { withCode } from "./Review.tsx";

const EMPTY: Partial<Record<GroupKey, string>> = { now: "Nothing needs you right now.", today: "Nothing else for today." };
const MORE: Partial<Record<GroupKey, string>> = { now: "need you", today: "for today" };
const KEY: Partial<Record<GroupKey, string>> = { later: "g l", fyi: "g f", resolved: "g d", hidden: "g h", cleared: "g x" };

export function Queue({
  view,
  overview,
  groups,
  ctx,
  filter,
  toggle,
  unfold,
  selectFold,
}: {
  view: QueueView | null;
  overview: Overview | null;
  groups: Group[];
  ctx: RowCtx;
  filter: string;
  toggle: (k: GroupKey) => void;
  unfold: (k: GroupKey) => void;
  selectFold: (k: GroupKey) => void;
}) {
  if (!view) {
    const first = !!overview && !overview.synced_at;
    return (
      <div className="queue deck">
        <p className="quiet-note">{first ? "Reading your GitHub queue for the first time. This takes about 30 seconds." : "Loading…"}</p>
      </div>
    );
  }
  const filtering = !!filter.trim();
  // While filtering, empty groups take no space.
  const top = groups.filter((g) => (g.key === "now" || g.key === "today") && (!filtering || g.cards.length));
  const away = groups.filter((g) => SORTED_AWAY.includes(g.key) && (filtering ? g.cards.length : g.total));
  // The quiet line names later and resolved; the rest show up there only while open (g f, g h, g x, or the filter).
  const bar = away.filter((g) => AWAY_BAR.includes(g.key) || g.open);
  const opened = away.filter((g) => g.open && g.cards.length);

  return (
    <div className="queue deck">
      {view.ai_paused && (
        <p className="ai-paused">
          <b>AI reviews are paused:</b> {withCode(view.ai_paused)}
        </p>
      )}
      {filtering && !top.length && <p className="group-empty">No matches in Now or Today.</p>}
      {top.map((g) => (
        // An empty group is one line: an empty Now has nothing urgent, so it carries no highlighter and no 0.
        <section key={g.key} className={cls("group", `g-${g.key}`, !g.cards.length && "none")} aria-labelledby={`h-${g.key}`}>
          <h2 id={`h-${g.key}`} className="group-head">
            <span>{g.label}</span>
            {g.cards.length ? (
              <span className="count">{filtering ? `${g.cards.length} of ${g.total}` : g.total}</span>
            ) : (
              <span className="group-none">{EMPTY[g.key]}</span>
            )}
          </h2>
          {g.cards.length > 0 && <Rows cards={g.cards} g={g} ctx={ctx} folded={g.fold > 0} />}
          {g.fold > 0 && (
            <button
              type="button"
              className={cls("fold", ctx.selected === foldOf(g.key) && "sel")}
              data-id={foldOf(g.key)}
              // Focus on mousedown would close the selected card above and move this line out from under the click.
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
              {g.fold} more {MORE[g.key]}
            </button>
          )}
        </section>
      ))}

      {bar.length > 0 && (
        <section className="away" aria-label="Sorted away">
          <div className="away-bar">
            <span className="away-label">Sorted away</span>
            {bar.map((g) => (
              <button
                key={g.key}
                type="button"
                className={cls("away-btn", g.open && "on")}
                aria-expanded={g.open}
                disabled={g.forced}
                title={g.forced ? "Opened by the filter" : `${g.open ? "Close" : "Open"} (${KEY[g.key]})`}
                onClick={() => {
                  toggle(g.key);
                }}
              >
                {g.key === "fyi" ? g.label : g.label.toLowerCase()}
              </button>
            ))}
          </div>
          {opened.map((g) => (
            <div key={g.key} className={`group g-${g.key}`}>
              <h3 id={`h-${g.key}`} className="group-head sub">
                <span>{g.label}</span>
                <span className="count">{g.cards.length}</span>
              </h3>
              <Rows cards={g.cards} g={g} ctx={ctx} />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function Rows({ cards, g, ctx, folded }: { cards: Card[]; g: Group; ctx: RowCtx; folded?: boolean }) {
  const away = SORTED_AWAY.includes(g.key);
  const me = ctx.me.toLowerCase();
  return (
    <div className={cls("rows", "cards", folded && "folded")}>
      {runs(cards).map((r) => {
        if (r.cards.length < 3) return r.cards.map((c) => <CardRow key={c.id} card={c} variant={g.variant} ctx={ctx} away={away} />);
        const first = r.cards[0]!;
        // Your own stack is one card's worth: what's wrong once, in its colour, and what d does once; each PR a short line.
        // Sorted away, it's still yours by name, without the d hint.
        const yours = first.kind === "pr" && !!me && r.author.toLowerCase() === me;
        const mine = yours && !away;
        const kind = r.cards.every((c) => c.kind === "pr") ? "PRs" : "items";
        const why = r.why.startsWith(`${r.author} `) ? r.why.slice(r.author.length + 1) : r.why;
        const tone = g.variant === "active" && !away ? problems(first).find((f) => says(r.why, f.text))?.tone : undefined;
        const next = mine ? nextText(first)?.replace(/ it /, " each ") : undefined;
        return (
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- <fieldset> is for form controls; this groups a run of rows
          <div key={`run:${r.id}`} className={cls("run", mine && "mine")} role="group" aria-labelledby={`run-${r.id}`}>
            <p className="run-head" id={`run-${r.id}`}>
              <span className="run-title">{yours ? `Your ${r.cards.length} ${kind}` : `${r.cards.length} ${kind} from ${r.author}`}</span>
              {why && <span className={cls("run-why", tone && `t-${tone}`)}>{why}</span>}
              {next && <span className="run-next">{withKeys(next)}</span>}
            </p>
            <div className="run-cards">
              {r.cards.map((c) => (
                <CardRow key={c.id} card={c} variant={g.variant} ctx={ctx} away={away} inRun compact={mine} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
