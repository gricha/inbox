import { useState } from "react";
import type { Card, Inquiry, Note, Overview, QueueView, SessionCard } from "../../../src/types.ts";
import { cls, aiName } from "../format.ts";
import { PAGE_GROUPS, treeGuides, type Group, type GroupKey } from "../view.ts";
import { CardRow, type RowCtx } from "./CardRow.tsx";
import { InquiryRow, type InquiryCtx } from "./Inquiry.tsx";
import { NoteRow, type NoteCtx } from "./Note.tsx";
import { SessionRow, type SessionCtx } from "./Session.tsx";
import { SkRows } from "./Skeleton.tsx";

const FYI_SHOWN = 5; // FYI's first rows; the rest wait behind Show more until you leave the page

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
  note,
  filter,
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
  note: NoteCtx; // your notes: due reminders lead Urgent, the rest lead Standard
  filter: string;
  toggle: (k: GroupKey) => void;
}) {
  const [allFyi, setAllFyi] = useState(false);
  if (!view) {
    const first = !!overview && !overview.synced_at;
    return (
      <div className="queue">
        {first ? (
          <p className="quiet-note">Getting your PRs from GitHub…</p>
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
  const words = filter.trim().toLowerCase();
  const mine = (ns: Note[]) => (words ? ns.filter((n) => n.text.toLowerCase().includes(words)) : ns);
  const due = mine(view.notes.due);
  const open = mine(view.notes.open);
  const parts = groups
    .filter((g) => PAGE_GROUPS.queue.includes(g.key))
    .map((g) => ({
      g,
      lead: g.key === "urgent" ? inquiries.length + shown.length + due.length : g.key === "standard" ? open.length : 0,
    }))
    .filter(({ g, lead }) => lead > 0 || g.cards.length > 0);
  // A row you acted on is on its way off: it fades out where it is, and the last one to go leaves the empty line.
  const any = parts.some(({ g, lead }) => lead > 0 || g.cards.some((c) => !ctx.leaving.has(c.id)));
  // A new desk's first minutes, said in the desk's words: where the empty line would be, or above the rows.
  const first = view.first_pass && !filter.trim() ? view.first_pass.line : null;
  return (
    <div className="queue">
      {first && <p className={cls("queue-first", any && "above")}>{first}</p>}
      {any ? (
        parts.map(({ g, lead }) => {
          // FYI shows its first rows, unless you're filtering, asked for all, or the selected row is further down.
          const cut =
            g.key === "fyi" &&
            !allFyi &&
            !filter.trim() &&
            g.cards.length > FYI_SHOWN + 1 &&
            !g.cards.slice(FYI_SHOWN).some((c) => c.id === ctx.selected);
          const cards = cut ? g.cards.slice(0, FYI_SHOWN) : g.cards;
          return (
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
                  {g.key === "urgent" && due.map((n) => <NoteRow key={n.id} n={n} ctx={note} />)}
                  {g.key === "standard" && open.map((n) => <NoteRow key={n.id} n={n} ctx={note} />)}
                  {cards.map((c) => (
                    <CardRow key={c.id} card={c} variant="active" ctx={ctx} />
                  ))}
                </div>
              )}
              {g.open && cut && (
                <p className="group-more">
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      setAllFyi(true);
                    }}
                  >
                    Show {g.cards.length - FYI_SHOWN} more
                  </button>
                </p>
              )}
            </section>
          );
        })
      ) : first ? null : (
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
  note,
  filter,
  toggle,
}: {
  view: QueueView | null;
  groups: Group[];
  keys: GroupKey[]; // the groups this page shows
  empty: string;
  note?: NoteCtx; // the Archive's: your reminders still to come, first
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
  const words = filter.trim().toLowerCase();
  const coming = note ? view.notes.later.filter((n) => !words || n.text.toLowerCase().includes(words)) : [];
  return (
    <div className="queue later">
      {!away.length && !coming.length && <p className="queue-empty">{filtering ? "No matches." : empty}</p>}
      {note && coming.length > 0 && (
        <section className="group g-reminders" aria-labelledby="h-reminders">
          <h2 id="h-reminders" className="group-head">
            <span className="group-toggle">
              <span>Reminders</span>
              <span className="count">{coming.length}</span>
            </span>
          </h2>
          <div className="lines">
            {coming.map((n) => (
              <NoteRow key={n.id} n={n} ctx={note} />
            ))}
          </div>
        </section>
      )}
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
              {g.cards.map((c, i) => {
                const guides = trees.get(g.key)?.[i];
                return <CardRow key={c.id} card={c} variant={g.variant} ctx={ctx} why {...(guides && { tree: guides })} />;
              })}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
