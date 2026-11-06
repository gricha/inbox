import { QUEUE_GROUPS, type Card, type Inquiry, type Overview, type QueueGroup, type QueueView } from "../../../src/types.ts";
import { cls } from "../format.ts";
import { foldOf, type Group, type GroupKey } from "../view.ts";
import { CardRow, type RowCtx } from "./CardRow.tsx";
import { InquiryRow, type InquiryCtx } from "./Inquiry.tsx";
import { withCode } from "./Review.tsx";
import { SkRows } from "./Skeleton.tsx";

const KEY: Partial<Record<GroupKey, string>> = { later: "g l", fyi: "g f", hidden: "g h", cleared: "g x", archive: "g a", blocked: "g b" };

const PART: Record<QueueGroup, string> = {
  back: "Back to you",
  review: "Waiting on your review",
  other: "Issues and other PRs",
  mine: "Your PRs",
};
// What the fold line says each part has behind it.
const FOLDED: Record<QueueGroup, string> = {
  back: "back to you",
  review: "waiting on your review",
  other: "issues and other PRs",
  mine: "of your PRs",
};

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
  // The cards come in their parts' order (byPart): a heading where the part changes, each counting all of its lines.
  const parts: { key: QueueGroup; cards: Card[] }[] = [];
  for (const c of g?.cards ?? []) {
    const key = c.group ?? "other";
    const last = parts.at(-1);
    if (last?.key === key) last.cards.push(c);
    else parts.push({ key, cards: [c] });
  }
  const total = (k: QueueGroup) => [...view.sections.now, ...view.sections.today].filter((c) => (c.group ?? "other") === k).length;
  // Filtering, a heading says how many of its lines match, as Later's do.
  const count = (p: { key: QueueGroup; cards: Card[] }) => (filter.trim() ? `${p.cards.length} of ${total(p.key)}` : total(p.key));
  // The fold is only there unfiltered, so what each part has behind it is its total less what shows.
  const folded = QUEUE_GROUPS.map((k) => [k, total(k) - (parts.find((p) => p.key === k)?.cards.length ?? 0)] as const).filter(
    ([, n]) => n > 0,
  );
  const foldText =
    folded.length === 1
      ? `${folded[0]![1]} more ${FOLDED[folded[0]![0]]}`
      : `${g?.fold ?? 0} more: ${folded.map(([k, n]) => `${n} ${FOLDED[k]}`).join(", ")}`;
  return (
    <div className="queue">
      {view.paused && (
        <p className="ai-paused">
          <b>{view.paused.who === "claude" ? "Claude is paused:" : "AI reviews are paused:"}</b> {withCode(view.paused.why)}
        </p>
      )}
      {inquiries.length > 0 || parts.length > 0 ? (
        <>
          {inquiries.length > 0 && (
            <section className="group part" aria-labelledby="h-questions">
              <h2 id="h-questions" className="group-head">
                Questions <span className="count">{inquiries.length}</span>
              </h2>
              <div className="lines">
                {inquiries.map((q) => (
                  <InquiryRow key={q.id} q={q} ctx={inq} />
                ))}
              </div>
            </section>
          )}
          {parts.map((p) => (
            <section key={p.key} className={`group part part-${p.key}`} aria-labelledby={`h-${p.key}`}>
              <h2 id={`h-${p.key}`} className="group-head">
                {PART[p.key]} <span className="count">{count(p)}</span>
              </h2>
              <div className="lines">
                {p.cards.map((c) => (
                  <CardRow key={c.id} card={c} variant="active" ctx={ctx} />
                ))}
              </div>
            </section>
          ))}
        </>
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
          {foldText}
        </button>
      )}
      {view.reviewing > 0 && (
        <p className="queue-reviewing">
          {view.reviewing === 1
            ? "1 more PR reaches you once Claude has reviewed it."
            : `${view.reviewing} more PRs reach you once Claude has reviewed them.`}
        </p>
      )}
    </div>
  );
}

// Later: what Claude and the rules sorted away, and what you snoozed or muted; the Archive: what's done. Each group opens on
// its heading.
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
              title={g.forced ? "Opened by the filter" : `${g.open ? "Close" : "Open"}${KEY[g.key] ? ` (${KEY[g.key]})` : ""}`}
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
