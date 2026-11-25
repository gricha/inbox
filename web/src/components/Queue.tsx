import { useState } from "react";
import type { Card, Inquiry, Note, Overview, QueueView, SessionCard } from "../../../src/types.ts";
import { cls } from "../format.ts";
import { fyiShown, inquiryOf, PAGE_GROUPS, treeGuides, type Group, type GroupKey } from "../groups.ts";
import { CardRow, type RowCtx } from "./CardRow.tsx";
import { InquiryRow, type InquiryCtx } from "./Inquiry.tsx";
import { noteOf, NoteRow, type NoteCtx } from "./Note.tsx";
import { SessionRow, type SessionCtx } from "./Session.tsx";
import { SkRows } from "./Skeleton.tsx";
import type { Lane, Reorder } from "./Reorder.tsx";

// The main page: what's on your Inbox, in its sections, each in the desk's order: Urgent (agents' questions and the sessions
// that need you first, since one waits on each), Standard and FYI. Each row says why it's there, quietly.
// Rows on their way under a heading's placeholder, so the rows land where these were.
function SkSection({ rows, label }: { rows?: number; label?: string }) {
  return (
    <section className="group" {...(label && { "aria-label": label, "aria-busy": true })}>
      <h2 className="group-head" aria-hidden="true">
        <span className="group-toggle">
          <span className="sk sk-head" />
          {"\u200b"}
        </span>
      </h2>
      <SkRows {...(rows && { count: rows })} />
    </section>
  );
}

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
  adding = null,
  toggle,
  reorder,
}: {
  view: QueueView | null;
  overview: Overview | null;
  groups: Group[];
  ctx: RowCtx;
  inquiries: Inquiry[];
  inq: InquiryCtx;
  sessions?: SessionCard[]; // none beside a review: two lines a row has no room for one's detail
  ses?: SessionCtx;
  note: NoteCtx; // your notes: due reminders lead Urgent, the rest lead the section you put them in
  filter: string;
  adding?: string | null; // a pasted link's PR or issue the desk is adding: a placeholder row in place of "No matches."
  toggle: (k: GroupKey) => void;
  reorder?: Reorder; // the Inbox's own page: its rows drag to another place
}) {
  const [allFyi, setAllFyi] = useState(false);
  if (!view) {
    const first = !!overview && !overview.synced_at;
    return <div className="queue">{first ? <p className="quiet-note">Getting your PRs from GitHub…</p> : <SkSection />}</div>;
  }
  const shown = ses ? (sessions ?? []) : [];
  const words = filter.trim().toLowerCase();
  const mine = (ns: Note[]) => (words ? ns.filter((n) => n.text.toLowerCase().includes(words)) : ns);
  const due = mine(view.notes.due);
  const urgent = mine(view.notes.urgent);
  const open = mine(view.notes.open);
  const fyi = mine(view.notes.fyi);
  // The rows a section has before its PRs and issues: questions and sessions, then notes.
  const leadOf = (k: GroupKey, asks: number, ns: Omit<QueueView["notes"], "later">) =>
    k === "urgent" ? asks + ns.due.length + ns.urgent.length : k === "standard" ? ns.open.length : k === "fyi" ? ns.fyi.length : 0;
  const parts = groups
    .filter((g) => PAGE_GROUPS.queue.includes(g.key))
    .map((g) => ({ g, lead: leadOf(g.key, inquiries.length + shown.length, { due, urgent, open, fyi }) }))
    .filter(({ g, lead }) => lead > 0 || g.cards.length > 0);
  // Filtered, a heading counts what matches of all its section holds, as Blocked's and the Archive's do.
  const filtering = !!words;
  const asks = view.inquiries.length + (ses ? view.sessions.filter((x) => x.status === "active").length : 0);
  const counted = (g: Group, lead: number) =>
    filtering ? `${g.cards.length + lead} of ${g.total + leadOf(g.key, asks, view.notes)}` : g.total + lead;
  // A row you acted on is on its way off: it fades out where it is, and the last one to go leaves the empty line.
  const any = parts.some(({ g, lead }) => lead > 0 || g.cards.some((c) => !ctx.leaving.has(c.id)));
  // A new desk's first minutes, said in the desk's words: where the empty line would be, or above the rows.
  const first = view.first_pass && !filter.trim() ? view.first_pass.line : null;
  const section = (k: GroupKey) => (k === "urgent" || k === "standard" || k === "fyi" ? k : null);
  return (
    <div className="queue" {...reorder?.list}>
      {reorder?.line}
      {first && <p className={cls("queue-first", any && "above")}>{first}</p>}
      {any ? (
        parts.map(({ g, lead }) => {
          // FYI shows its first rows, its notes among them, unless you're filtering or asked for all.
          const fold =
            g.key === "fyi" && !allFyi && !filter.trim()
              ? fyiShown([...fyi.map((n) => noteOf(n.id)), ...g.cards.map((c) => c.id)], ctx.selected)
              : null;
          const notes = fold === null ? fyi : fyi.slice(0, fold);
          const cards = fold === null ? g.cards : g.cards.slice(0, Math.max(0, fold - fyi.length));
          const s = section(g.key);
          const drag = (id: string, lane: Lane) => (reorder && s ? reorder.row(id, lane, s) : undefined);
          return (
            <section key={g.key} className={`group g-${g.key}`} aria-labelledby={`h-${g.key}`} {...(s && { "data-section": s })}>
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
                  <span className="count">{counted(g, lead)}</span>
                </button>
              </h2>
              {g.open && (
                <div className="lines">
                  {g.key === "urgent" &&
                    inquiries.map((q) => <InquiryRow key={q.id} q={q} ctx={inq} drag={drag(inquiryOf(q.id), "ask")} />)}
                  {g.key === "urgent" && ses && shown.map((x) => <SessionRow key={x.id} s={x} ctx={ses} />)}
                  {g.key === "urgent" && due.map((n) => <NoteRow key={n.id} n={n} ctx={note} drag={drag(noteOf(n.id), "due")} />)}
                  {g.key === "urgent" && urgent.map((n) => <NoteRow key={n.id} n={n} ctx={note} drag={drag(noteOf(n.id), "note")} />)}
                  {g.key === "standard" && open.map((n) => <NoteRow key={n.id} n={n} ctx={note} drag={drag(noteOf(n.id), "note")} />)}
                  {g.key === "fyi" && notes.map((n) => <NoteRow key={n.id} n={n} ctx={note} drag={drag(noteOf(n.id), "note")} />)}
                  {cards.map((c) => (
                    <CardRow key={c.id} card={c} variant="active" ctx={ctx} drag={drag(c.id, "card")} />
                  ))}
                </div>
              )}
              {g.open && fold !== null && (
                <p className="group-more">
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      setAllFyi(true);
                    }}
                  >
                    Show {fyi.length + g.cards.length - fold} more
                  </button>
                </p>
              )}
            </section>
          );
        })
      ) : first ? null : adding ? ( // A pasted link's row on its way: a placeholder where it will land, as on the first load.
        <SkSection rows={1} label={`Adding ${adding} to your desk`} />
      ) : (
        <p className="queue-empty">{filter.trim() ? "No matches." : "Nothing needs you right now."}</p>
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
