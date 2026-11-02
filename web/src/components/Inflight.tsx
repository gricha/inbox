import type { Draft, InflightRow, InflightView } from "../../../src/types.ts";
import { age, cls } from "../format.ts";
import { laneFacts, sitterNews, sitterParts, waitsOn } from "../view.ts";
import { Owed } from "./CardRow.tsx";
import { BACK_TITLE, KeyButton } from "./Detail.tsx";

// Merging: your PRs handed off for merge, one line each like the main page's, those waiting on you first.
export function Inflight({
  view,
  now,
  selected,
  sending,
  armed,
  select,
  run,
}: {
  view: InflightView | null;
  now: number;
  selected: string | null;
  sending: string | null; // the draft on its way to GitHub
  armed: string | null; // the draft a first y armed
  select: (id: string) => void;
  run: (row: InflightRow, key: string, draft?: Draft) => void; // Merging's keys: enter o b y x c
}) {
  if (!view) return <p className="quiet-note">Loading…</p>;
  const open = view.rows.filter((r) => r.state === "open");
  const landed = view.rows.filter((r) => r.state !== "open");
  const rows = (list: InflightRow[]) => (
    <div className="lines">
      {list.map((r) => (
        <Row key={r.card.id} row={r} now={now} on={selected === r.card.id} sending={sending} armed={armed} select={select} run={run} />
      ))}
    </div>
  );
  return (
    <div className="queue lane">
      {open.length > 0 && !view.babysitting && (
        <p className="lane-note">
          <a href="#/settings/inflight">Claude is off:</a> a PR waits on you here when CI fails or reviewers ask for something.
        </p>
      )}
      {open.length ? (
        rows(open)
      ) : (
        <p className="queue-empty">
          Nothing in Merging yet: press <kbd>m</kbd> twice on one of your PRs when you're done with it.
        </p>
      )}
      {landed.length > 0 && (
        <section className="group" aria-labelledby="h-landed">
          <h3 id="h-landed" className="group-head">
            <span>Merged</span>
            <span className="count">{landed.length}</span>
          </h3>
          {rows(landed)}
        </section>
      )}
    </div>
  );
}

// What a row says after its ref, in one phrase: why it waits on you (its label in ink, a problem in its colour), else what
// Claude is doing or what it waits on.
function Phrase({ row: r }: { row: InflightRow }) {
  if (r.state !== "open") return r.state;
  const needs = r.needs_you;
  if (needs) {
    // With Claude off the problem itself is the why ("CI failing"); its fact says it in full.
    const fact = laneFacts(r).find((f) => f.text === needs || f.text.startsWith(`${needs}: `));
    if (!fact) return <Owed why={needs} />;
    return (
      <span className="why owed">
        <span className={cls(fact.tone && `t-${fact.tone}`)}>{fact.text.charAt(0).toUpperCase() + fact.text.slice(1)}</span>
      </span>
    );
  }
  if (sitterNews(r)) return sitterParts(r, 0)[0] ?? "merging";
  return waitsOn(r) ?? (r.merge_note ? "merge it yourself when it's green" : "merging");
}

// One line: the title, quietly its ref, one phrase, its age. Selected, its drafted reply and its keys open under it.
function Row({
  row: r,
  now,
  on,
  sending,
  armed,
  select,
  run,
}: {
  row: InflightRow;
  now: number;
  on: boolean;
  sending: string | null;
  armed: string | null;
  select: (id: string) => void;
  run: (row: InflightRow, key: string, draft?: Draft) => void;
}) {
  const c = r.card;
  const live = r.state === "open";
  const keys = (k: string) => {
    run(r, k);
  };
  const since = c.resolved_at ?? c.waiting_since;
  const draft = live ? r.drafts[0] : undefined;
  // A missing clone is fixed in Settings: say where.
  const noClone = live && !!r.needs_you?.startsWith("no local clone");
  return (
    <div className={cls("line", "lane-row", on && "sel", !live && "dim")} data-id={c.id}>
      <button
        type="button"
        className="row-main line-main"
        onClick={() => {
          select(c.id);
        }}
        onDoubleClick={() => {
          run(r, "enter");
        }}
        onFocus={() => {
          select(c.id);
        }}
      >
        <span className="line-title">{c.title}</span>
        {/* A long repo name gives way before the title; the number never does. */}
        <span className="line-ref" title={`${c.repo}#${c.number}`}>
          {c.repo.split("/")[1]}
        </span>
        <span className="line-num">#{c.number}</span>
        <span className="line-note">
          <Phrase row={r} />
        </span>
        <span className="line-age" title={`${c.resolved_at ? "resolved" : "waiting since"} ${new Date(since).toLocaleString()}`}>
          {age(since, now)}
        </span>
      </button>
      {on && (
        <div className="lane-more">
          {/* The row cuts a long question short: here it's whole. */}
          {live && r.escalation && r.needs_you && (
            <p className="lane-why">
              <Owed why={r.needs_you} />
            </p>
          )}
          {noClone && (
            <p className="lane-link">
              <a href="#/settings/inflight">Set up local clones</a>
            </p>
          )}
          {/* A drafted reply is a margin note: read it before y sends it as you. */}
          {live &&
            r.drafts.map((d) => (
              <div key={d.id} className="draft">
                <p className="draft-to">
                  {/* Not Claude's own: another agent over MCP drafted it, so say so before you send it as you. */}
                  {d.by === "agent" ? "Your agent's reply" : "Reply"} to {d.to}
                  {d.quote && <span className="draft-quote">: “{d.quote}”</span>}
                </p>
                <p className="draft-body">{d.body}</p>
              </div>
            ))}
          {/* One order on every surface: what finishes it (y Send, c Answer), then x, enter and o, b last. */}
          <div className="actions card-keys">
            {draft && (
              <KeyButton
                k="y"
                label={sending === draft.id ? "Sending…" : armed === draft.id ? "again to send" : "Send"}
                disabled={sending !== null}
                title="Post this reply on GitHub, as you: press y twice"
                className={cls(armed === draft.id && "armed")}
                run={() => {
                  run(r, "y", draft);
                }}
              />
            )}
            {live && r.escalation && r.resume && <KeyButton k="c" label="Answer in a terminal" title={`Copies ${r.resume}`} run={keys} />}
            {live && r.escalation && <KeyButton k="x" label="Dismiss the question" run={keys} />}
            {draft && !r.escalation && !r.outside_at && (
              <KeyButton
                k="x"
                label="Discard"
                run={() => {
                  run(r, "x", draft);
                }}
              />
            )}
            {live && !r.escalation && r.outside_at && (
              <KeyButton k="x" label="Mark read" title="You've read the outside contributors' comments on GitHub" run={keys} />
            )}
            <KeyButton k="enter" label="Review" run={keys} />
            <KeyButton k="o" label="Open on GitHub" run={keys} />
            {r.resume && !(live && r.escalation) && <KeyButton k="c" label="Copy resume command" title={`Copies ${r.resume}`} run={keys} />}
            {live && <KeyButton k="b" label="Back to desk" title={BACK_TITLE} run={keys} />}
          </div>
        </div>
      )}
    </div>
  );
}
