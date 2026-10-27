import type { Card, Overview, QueueView } from "../../../src/types.ts";
import { cls } from "../format.ts";
import { SORTED_AWAY, type Group, type GroupKey } from "../view.ts";
import { CardRow, type RowCtx } from "./CardRow.tsx";

const EMPTY: Partial<Record<GroupKey, string>> = { now: "Nothing needs you right now.", today: "Nothing else for today." };
const KEY: Partial<Record<GroupKey, string>> = { later: "g l", fyi: "g f", hidden: "g h", cleared: "g x" };

export function Queue({ view, overview, groups, ctx, filter, toggle }: {
  view: QueueView | null;
  overview: Overview | null;
  groups: Group[];
  ctx: RowCtx;
  filter: string;
  toggle: (k: GroupKey) => void;
}) {
  if (!view) {
    const first = !!overview && !overview.synced_at;
    return <div className="queue"><p className="quiet-note">{first ? "Reading your GitHub queue for the first time. This takes about 30 seconds." : "Loading…"}</p></div>;
  }
  const filtering = !!filter.trim();
  // While filtering, empty groups take no space.
  const top = groups.filter((g) => (g.key === "now" || g.key === "today") && (!filtering || g.cards.length));
  const away = groups.filter((g) => SORTED_AWAY.includes(g.key) && (filtering ? g.cards.length : g.total));
  const opened = away.filter((g) => g.open && g.cards.length);

  return (
    <div className="queue">
      {filtering && !top.length && <p className="group-empty">No matches in Now or Today.</p>}
      {top.map((g) => (
        <section key={g.key} className={`group g-${g.key}`} aria-labelledby={`h-${g.key}`}>
          <h2 id={`h-${g.key}`} className="group-head">
            <span>{g.label}</span>
            <span className="count">{filtering ? `${g.cards.length} of ${g.total}` : g.total}</span>
          </h2>
          {g.cards.length ? <Rows cards={g.cards} g={g} ctx={ctx} /> : <p className="group-empty">{EMPTY[g.key]}</p>}
        </section>
      ))}

      {away.length > 0 && (
        <section className="away" aria-label="Sorted away">
          <div className="away-bar">
            <span className="away-label">Sorted away</span>
            {away.map((g) => {
              const fresh = g.cards.filter((c) => c.new).length;
              return (
                <button
                  key={g.key}
                  type="button"
                  className={cls("away-btn", g.open && "on")}
                  aria-expanded={g.open}
                  disabled={g.forced}
                  title={g.forced ? "Opened by the filter" : `${g.open ? "Close" : "Open"} (${KEY[g.key]})`}
                  onClick={() => toggle(g.key)}
                >
                  <span className="n">{filtering ? g.cards.length : g.total}</span> {g.label.toLowerCase()}
                  {fresh > 0 && <span className="fresh">({fresh} new)</span>}
                </button>
              );
            })}
            {!opened.length && <p className="away-note">Your rules moved these out of the way. Nothing here needs you today.</p>}
          </div>
          {opened.map((g) => (
            <div key={g.key} className={`group g-${g.key}`}>
              <h3 className="group-head sub">
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

function Rows({ cards, g, ctx }: { cards: Card[]; g: Group; ctx: RowCtx }) {
  return (
    <div className="rows">
      {runs(cards).map((r) =>
        r.cards.length < 3 ? (
          r.cards.map((c) => <CardRow key={c.id} card={c} variant={g.variant} ctx={ctx} />)
        ) : (
          <div key={`run:${r.cards[0].id}`} className="run" role="group" aria-labelledby={`run-${r.cards[0].id}`}>
            <div className="run-head" id={`run-${r.cards[0].id}`}>
              <span className="run-title">{r.cards.length} {r.cards.every((c) => c.kind === "pr") ? "PRs" : "items"} from {r.author}</span>
              {r.why && <span className="run-why">{r.why}</span>}
            </div>
            {r.cards.map((c) => <CardRow key={c.id} card={c} variant={g.variant} ctx={ctx} inRun />)}
          </div>
        ),
      )}
    </div>
  );
}

// Consecutive cards with the same author and reason (a stack of PRs) read as one block.
function runs(cards: Card[]): { author: string; why: string; cards: Card[] }[] {
  const out: { author: string; why: string; cards: Card[] }[] = [];
  for (const c of cards) {
    const last = out.at(-1);
    if (last && last.author === c.author && last.why === c.why) last.cards.push(c);
    else out.push({ author: c.author, why: c.why, cards: [c] });
  }
  return out;
}
