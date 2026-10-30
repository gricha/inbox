import type { Draft, InflightRow, InflightView } from "../../../src/types.ts";
import { age, cls } from "../format.ts";
import { laneFacts, sitterParts } from "../view.ts";
import { atCommas, Owed } from "./CardRow.tsx";
import { Dots, KeyButton } from "./Detail.tsx";

// The In-flight lane: your PRs marked done, what each babysitter is doing, and what's back with you.
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
  run: (row: InflightRow, key: string, draft?: Draft) => void; // the lane's keys: enter o d y x c
}) {
  if (!view) return <p className="quiet-note">Loading…</p>;
  const open = view.rows.filter((r) => r.state === "open");
  const landed = view.rows.filter((r) => r.state !== "open");
  const rows = (list: InflightRow[]) => (
    <div className="rows cards">
      {list.map((r) => (
        <Row key={r.card.id} row={r} now={now} on={selected === r.card.id} sending={sending} armed={armed} select={select} run={run} />
      ))}
    </div>
  );
  return (
    <div className="queue deck lane">
      {open.length ? (
        <section className="group" aria-labelledby="h-inflight">
          <h2 id="h-inflight" className="group-head">
            <span>In flight</span>
            <span className="count">{open.length}</span>
          </h2>
          <p className="lane-intro">
            {view.babysitting ? (
              "Your PRs marked done. Babysitters fix CI and draft replies; a PR is back in Now only when it needs you."
            ) : (
              <>
                Your PRs marked done. <a href="#/settings/inflight">Babysitting is off</a>, so a PR is back in Now when CI fails or
                reviewers ask for something.
              </>
            )}
          </p>
          {rows(open)}
        </section>
      ) : (
        <h2 className="group-head">
          <span>In flight</span>
          <span className="group-none">
            Nothing yet: press <kbd>d</kbd> on one of your PRs when you're done with it.
          </span>
        </h2>
      )}
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

// A lane row is a queue card: the title and its age; the ref, why it's back with you and the PR's state; the babysitter's
// line; a drafted reply as a margin note; the selected row's keys under a hairline.
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
  const needs = live ? r.needs_you : null;
  const s = r.sitter;
  // The babysitter's own news, unless it only repeats why the PR needs you ("babysitter asks: …", "no local clone of …").
  const sitter = live && (!needs || s.state === "done" || s.state === "running");
  // A missing clone is fixed in Settings: say where.
  const noClone = !!needs && needs.startsWith("no local clone");
  const keys = (k: string) => {
    run(r, k);
  };
  const since = c.resolved_at ?? c.waiting_since;
  const draft = live ? r.drafts[0] : undefined;
  return (
    <div className={cls("row", "card", "lane-row", needs && "b-now", on && "sel", !live && "dim")} data-id={c.id}>
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
          <span className="title-line">
            <span className="title">{c.title}</span>
          </span>
          {/* The queue's measure: how long it's been waiting, or when it landed. */}
          <span className="age" title={`${c.resolved_at ? "resolved" : "waiting since"} ${new Date(since).toLocaleString()}`}>
            {age(since, now)}
          </span>
          <span className="card-line">
            <span className="meta">
              <span className="ref" title={`${c.repo}#${c.number}`}>
                <span className="ref-ink">
                  <span className="ref-repo">{c.repo.split("/")[1]}</span>#{c.number}
                </span>
              </span>
              {/* The highlighter on the ref already says it needs you: the reason, in ink, as the queue's why. */}
              {needs && <Owed why={needs} />}
              {live ? (
                laneFacts(r).map((f) => (
                  <span key={f.text} className={cls("fact-word", needs && f.tone && `t-${f.tone}`)}>
                    {atCommas(f.text)}
                  </span>
                ))
              ) : (
                <span>{r.state}</span>
              )}
            </span>
          </span>
          {sitter && <Dots className="gist sitter" parts={sitterParts(r, now)} />}
        </button>
      </div>
      {noClone && (
        <p className="lane-link">
          <a href="#/settings/inflight">Set up local clones</a>
        </p>
      )}
      {/* A drafted reply is a margin note; the selected row's keys send or discard the first. */}
      {live &&
        r.drafts.map((d) => (
          <div key={d.id} className="draft">
            <p className="draft-to">
              {/* Not its babysitter's: another agent over MCP drafted it, so say so before you send it as you. */}
              {d.by === "agent" ? "Your agent's reply" : "Reply"} to {d.to}
              {d.quote && <span className="draft-quote">: “{d.quote}”</span>}
            </p>
            <p className="draft-body">{d.body}</p>
          </div>
        ))}
      {on && (
        <div className="more">
          <div className="actions card-keys">
            <KeyButton k="enter" label="Review" run={keys} />
            {draft && (
              <KeyButton
                k="y"
                label={sending === draft.id ? "Sending…" : armed === draft.id ? "Press y again to send" : "Send"}
                disabled={sending !== null}
                title="Post this reply on GitHub, as you: press y twice"
                className={cls(armed === draft.id && "armed")}
                run={() => {
                  run(r, "y", draft);
                }}
              />
            )}
            {draft && !r.escalation && !r.outside_at && (
              <KeyButton
                k="x"
                label="Discard"
                run={() => {
                  run(r, "x", draft);
                }}
              />
            )}
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
        </div>
      )}
    </div>
  );
}
