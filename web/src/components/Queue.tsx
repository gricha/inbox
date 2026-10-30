import type { Card, Overview, QueueView } from "../../../src/types.ts";
import { cls } from "../format.ts";
import { FOLD, SORTED_AWAY, type Group, type GroupKey } from "../view.ts";
import { CardRow, type RowCtx } from "./CardRow.tsx";
import { withCode } from "./Review.tsx";

const EMPTY: Partial<Record<GroupKey, string>> = { now: "Nothing needs you right now.", today: "Nothing else for today." };
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
  unfold: () => void;
  selectFold: () => void;
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
              className={cls("fold", ctx.selected === FOLD && "sel")}
              data-id={FOLD}
              onClick={unfold}
              onFocus={selectFold}
            >
              {g.fold} more for today
            </button>
          )}
        </section>
      ))}

      {away.length > 0 && (
        <section className="away" aria-label="Sorted away">
          <div className="away-bar">
            <span className="away-label">Sorted away</span>
            {away.map((g) => (
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
  return (
    <div className={cls("rows", "cards", folded && "folded")}>
      {runs(cards).map((r) =>
        r.cards.length < 3 ? (
          r.cards.map((c) => <CardRow key={c.id} card={c} variant={g.variant} ctx={ctx} away={away} />)
        ) : (
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- <fieldset> is for form controls; this groups a run of rows
          <div key={`run:${r.id}`} className="run" role="group" aria-labelledby={`run-${r.id}`}>
            <p className="run-head" id={`run-${r.id}`}>
              <span className="run-title">
                {r.cards.length} {r.cards.every((c) => c.kind === "pr") ? "PRs" : "items"} from {r.author}
              </span>
              {r.why && <span className="run-why">{r.why}</span>}
            </p>
            <div className="run-cards">
              {r.cards.map((c) => (
                <CardRow key={c.id} card={c} variant={g.variant} ctx={ctx} away={away} inRun />
              ))}
            </div>
          </div>
        ),
      )}
    </div>
  );
}

// Consecutive cards with the same author and reason (a stack of PRs) read as one block.
function runs(cards: Card[]): { id: string; author: string; why: string; cards: Card[] }[] {
  const out: { id: string; author: string; why: string; cards: Card[] }[] = [];
  for (const c of cards) {
    const last = out.at(-1);
    if (last && last.author === c.author && last.why === c.why) last.cards.push(c);
    else out.push({ id: c.id, author: c.author, why: c.why, cards: [c] });
  }
  return out;
}
