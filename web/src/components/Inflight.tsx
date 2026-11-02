import type { Draft, InflightRow, InflightView } from "../../../src/types.ts";
import { age, cls } from "../format.ts";
import { laneFacts, sitterNews, sitterParts, waitsOn } from "../view.ts";
import { atCommas, Owed } from "./CardRow.tsx";
import { BACK_TITLE, Dots, KeyButton } from "./Detail.tsx";

// Merging: your PRs handed off for merge, what Claude is doing on each and what it waits on, and what's back with you.
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
  const waiting = open.filter((r) => r.needs_you).length;
  const row = (r: InflightRow) => (
    <Row key={r.card.id} row={r} now={now} on={selected === r.card.id} sending={sending} armed={armed} select={select} run={run} />
  );
  // The desk sends a stack's rows together, bottom first: two or more sit under one quiet header.
  const rows = (list: InflightRow[]) => {
    const parts: InflightRow[][] = [];
    for (const r of list) {
      const last = parts.at(-1);
      if (last && r.card.stack && last[0]!.card.stack?.id === r.card.stack.id) last.push(r);
      else parts.push([r]);
    }
    return (
      <div className="rows cards">
        {parts.map((p) => {
          const s = p.length > 1 && p[0]!.card.stack;
          if (!s) return p.map(row);
          return (
            <div key={s.id} className="rows cards lane-stack" aria-label={`Stack of ${s.size}`}>
              <p className="lane-stack-head">
                Stack on {view.stacks[s.id]?.base ?? "its base"} · {s.size} open
              </p>
              {p.map(row)}
            </div>
          );
        })}
      </div>
    );
  };
  return (
    <div className="queue deck lane">
      {open.length ? (
        <section className="group" aria-labelledby="h-inflight">
          <h2 id="h-inflight" className="group-head">
            <span>Merging</span>
            <span className="count">
              {open.length}
              {waiting > 0 && ` · ${waiting} waiting on you`}
            </span>
          </h2>
          <p className="lane-intro">
            {view.babysitting ? (
              "Claude is getting these merged: it fixes CI and drafts replies. What waits on you is listed first; what it can't get merged goes back to your queue."
            ) : (
              <>
                Your PRs handed off for merge. <a href="#/settings/inflight">Claude is off</a>, so a PR waits on you here when CI fails or
                reviewers ask for something.
              </>
            )}
          </p>
          {rows(open)}
        </section>
      ) : (
        <h2 className="group-head">
          <span>Merging</span>
          <span className="group-none">
            Nothing yet: press <kbd>m</kbd> on one of your PRs when you're done with it.
          </span>
        </h2>
      )}
      {landed.length > 0 && (
        <section className="group" aria-labelledby="h-landed">
          <h3 id="h-landed" className="group-head sub">
            <span>Merged</span>
            <span className="count">{landed.length}</span>
          </h3>
          {rows(landed)}
        </section>
      )}
    </div>
  );
}

// A row is a queue card: the title and its age; the ref, why it needs you and the PR's state; what it waits on and Claude's
// line; who merges it when auto-merge isn't on; a drafted reply as a margin note; the selected row's keys under a hairline.
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
  const waits = waitsOn(r);
  // Idle, what it waits on says more than "watching".
  const sitter = sitterNews(r) && !(waits && r.sitter.state === "idle");
  // A missing clone is fixed in Settings: say where.
  const noClone = !!needs && needs.startsWith("no local clone");
  const keys = (k: string) => {
    run(r, k);
  };
  const since = c.resolved_at ?? c.waiting_since;
  const draft = live ? r.drafts[0] : undefined;
  const facts = live ? laneFacts(r) : [];
  // With Claude off the problem itself is the why ("CI failing"); its fact says it in full, so the why goes.
  const said = !!needs && facts.some((f) => f.text === needs || f.text.startsWith(`${needs}: `));
  return (
    <div className={cls("row", "card", "lane-row", needs && "waits", on && "sel", !live && "dim")} data-id={c.id}>
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
              {c.stack && <span title={`${c.stack.pos} of ${c.stack.size} open PRs in its stack`}>{`${c.stack.pos}/${c.stack.size}`}</span>}
              {/* Why it waits on you, its label in ink. */}
              {needs && !said && <Owed why={needs} />}
              {live ? (
                facts.map((f) => (
                  <span key={f.text} className={cls("fact-word", needs && f.tone && `t-${f.tone}`)}>
                    {atCommas(f.text)}
                  </span>
                ))
              ) : (
                <span>{r.state}</span>
              )}
            </span>
          </span>
          {(!!waits || sitter) && (
            <Dots className="gist sitter" parts={[waits ?? "", ...(sitter ? sitterParts(r, now) : [])].filter(Boolean)} />
          )}
          {live && r.merge_note && <span className="gist sitter">Merge it yourself when it's green: {r.merge_note}</span>}
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
              {/* Not Claude's own: another agent over MCP drafted it, so say so before you send it as you. */}
              {d.by === "agent" ? "Your agent's reply" : "Reply"} to {d.to}
              {d.quote && <span className="draft-quote">: “{d.quote}”</span>}
            </p>
            <p className="draft-body">{d.body}</p>
          </div>
        ))}
      {on && (
        <div className="more">
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
