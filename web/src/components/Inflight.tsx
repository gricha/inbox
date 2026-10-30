import type { Draft, InflightRow, InflightView } from "../../../src/types.ts";
import { age, cls } from "../format.ts";
import { laneFacts, sitterLine } from "../view.ts";
import { KeyButton } from "./Detail.tsx";

// The In-flight lane: your PRs marked done, what each babysitter is doing, and what's back with you.
export function Inflight({
  view,
  now,
  selected,
  sending,
  select,
  run,
}: {
  view: InflightView | null;
  now: number;
  selected: string | null;
  sending: string | null; // the draft on its way to GitHub
  select: (id: string) => void;
  run: (row: InflightRow, key: string, draft?: Draft) => void; // the lane's keys: enter o d y x c
}) {
  if (!view) return <p className="quiet-note">Loading…</p>;
  const open = view.rows.filter((r) => r.state === "open");
  const landed = view.rows.filter((r) => r.state !== "open");
  const rows = (list: InflightRow[]) => (
    <div className="rows">
      {list.map((r) => (
        <Row key={r.card.id} row={r} now={now} on={selected === r.card.id} sending={sending} select={select} run={run} />
      ))}
    </div>
  );
  return (
    <div className="queue lane">
      <section className="group" aria-labelledby="h-inflight">
        <h2 id="h-inflight" className="group-head">
          <span>In flight</span>
          <span className="count">{open.length}</span>
        </h2>
        <p className="lane-intro">
          Your PRs marked done. Babysitters fix CI and draft replies; a PR is back in Now only when it needs you.
        </p>
        {open.length ? (
          rows(open)
        ) : (
          <p className="group-empty">
            Nothing in flight. Press <kbd>d</kbd> on one of your PRs when you're done with it.
          </p>
        )}
      </section>
      {landed.length > 0 && (
        <section className="group" aria-labelledby="h-landed">
          <h3 id="h-landed" className="group-head sub">
            <span>Landed</span>
            <span className="count">{landed.length}</span>
          </h3>
          {rows(landed)}
        </section>
      )}
    </div>
  );
}

function Row({
  row: r,
  now,
  on,
  sending,
  select,
  run,
}: {
  row: InflightRow;
  now: number;
  on: boolean;
  sending: string | null;
  select: (id: string) => void;
  run: (row: InflightRow, key: string, draft?: Draft) => void;
}) {
  const c = r.card;
  const live = r.state === "open";
  const needs = live ? r.needs_you : null;
  const s = r.sitter;
  // The babysitter's own news, unless it only repeats why the PR needs you ("babysitter asks: …", "no local clone of …").
  const sitter = live && (!needs || s.state === "done" || s.state === "running");
  // A missing clone is fixed in Settings: say where.
  const noClone = !!needs && needs.startsWith("no local clone");
  const open = on || (live && r.drafts.length > 0);
  const keys = (k: string) => {
    run(r, k);
  };
  return (
    <div className={cls("row", "lane-row", needs && "b-now", on && "sel", open && "open", !live && "dim")} data-id={c.id}>
      <div className="row-line">
        <button
          type="button"
          className="row-main"
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
          <span className="ref" title={`${c.repo}#${c.number}`}>
            <span className="ref-ink">
              <span className="ref-repo">{c.repo.split("/")[1]}</span>#{c.number}
            </span>
          </span>
          <span className="row-body">
            <span className="title-line">
              <span className="title" title={c.title}>
                {c.title}
              </span>
            </span>
            {/* The highlighter on the ref already says it needs you: the reason, in ink, as the queue's why. */}
            {needs && (
              <span className="lane-status needs">
                {needs}
                {noClone && (
                  <>
                    {" · "}
                    <a href="#/settings/inflight">Local clones</a>
                  </>
                )}
              </span>
            )}
            {sitter && <span className="lane-status">{sitterLine(r, now)}</span>}
            {live ? (
              <span className="meta">
                {laneFacts(r).map((f) => (
                  <span key={f.text} className={cls("fact-word", needs && f.tone && `t-${f.tone}`)}>
                    {f.text}
                  </span>
                ))}
              </span>
            ) : (
              <span className="lane-status">{r.state}</span>
            )}
          </span>
          {/* The queue's measure: how long it's been waiting, or when it landed. */}
          <span
            className="age"
            title={`${c.resolved_at ? "resolved" : "waiting since"} ${new Date(c.resolved_at ?? c.waiting_since).toLocaleString()}`}
          >
            {age(c.resolved_at ?? c.waiting_since, now)}
          </span>
        </button>
      </div>
      {open && (
        <div className="detail lane-detail">
          {live &&
            r.drafts.map((d, i) => (
              <div key={d.id} className="draft">
                <p className="draft-to">
                  Reply to {d.to}
                  {d.quote && <span className="draft-quote">: “{d.quote}”</span>}
                </p>
                <p className="draft-body">{d.body}</p>
                <div className="actions">
                  <KeyButton
                    k={on && i === 0 ? "y" : ""}
                    label={sending === d.id ? "Sending…" : "Send"}
                    disabled={sending !== null}
                    title="Post this reply on GitHub, as you"
                    run={() => {
                      run(r, "y", d);
                    }}
                  />
                  <KeyButton
                    k={on && i === 0 && !r.escalation && !r.outside_at ? "x" : ""}
                    label="Discard"
                    run={() => {
                      run(r, "x", d);
                    }}
                  />
                </div>
              </div>
            ))}
          {on && (
            <div className="actions">
              <KeyButton k="enter" label="Review" run={keys} />
              <KeyButton k="o" label="Open on GitHub" run={keys} />
              {live && <KeyButton k="d" label="Take back" run={keys} />}
              {live && r.escalation && <KeyButton k="x" label="Dismiss the question" run={keys} />}
              {live && !r.escalation && r.outside_at && (
                <KeyButton k="x" label="Mark read" title="You've read the outside contributors' comments on GitHub" run={keys} />
              )}
              {r.resume && (
                <KeyButton
                  k="c"
                  label={live && r.escalation ? "Answer in a terminal" : "Copy resume command"}
                  title={`Copies ${r.resume}`}
                  run={keys}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
