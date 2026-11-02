import type { InflightRow, InflightView } from "../../../src/types.ts";
import { age, cls } from "../format.ts";
import { BACK_TITLE, Dots, KeyButton } from "./Detail.tsx";

// Merging: your PRs handed off for merge, what each waits on and the coordinator's latest note on it.
export function Inflight({
  view,
  now,
  selected,
  select,
  run,
}: {
  view: InflightView | null;
  now: number;
  selected: string | null;
  select: (id: string) => void;
  run: (row: InflightRow, key: string) => void; // Merging's keys: enter o b
}) {
  if (!view) return <p className="quiet-note">Loading…</p>;
  const open = view.rows.filter((r) => r.state === "open");
  const landed = view.rows.filter((r) => r.state !== "open");
  const rows = (list: InflightRow[]) => (
    <div className="rows cards">
      {list.map((r) => (
        <Row key={r.card.id} row={r} now={now} on={selected === r.card.id} select={select} run={run} />
      ))}
    </div>
  );
  return (
    <div className="queue deck lane">
      {open.length ? (
        <section className="group" aria-labelledby="h-inflight">
          <h2 id="h-inflight" className="group-head">
            <span>Merging</span>
            <span className="count">{open.length}</span>
          </h2>
          <p className="lane-intro">The coordinator is getting these merged. What it can't get merged comes back to your queue.</p>
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

// The title and its age; the ref and what it waits on; the coordinator's latest note and its age; the selected row's keys.
function Row({
  row: r,
  now,
  on,
  select,
  run,
}: {
  row: InflightRow;
  now: number;
  on: boolean;
  select: (id: string) => void;
  run: (row: InflightRow, key: string) => void;
}) {
  const c = r.card;
  const live = r.state === "open";
  const keys = (k: string) => {
    run(r, k);
  };
  const since = c.resolved_at ?? c.waiting_since;
  return (
    <div className={cls("row", "card", "lane-row", on && "sel", !live && "dim")} data-id={c.id}>
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
              <span>{r.waits_on ?? r.state}</span>
            </span>
          </span>
          {r.note && <Dots className="gist lane-note" parts={[r.note.text, age(r.note.at, now)]} />}
        </button>
      </div>
      {on && (
        <div className="more">
          <div className="actions card-keys">
            <KeyButton k="enter" label="Review" run={keys} />
            <KeyButton k="o" label="Open on GitHub" run={keys} />
            {live && <KeyButton k="b" label="Back to desk" title={BACK_TITLE} run={keys} />}
          </div>
        </div>
      )}
    </div>
  );
}
