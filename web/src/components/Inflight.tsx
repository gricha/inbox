import type { InflightRow, InflightView } from "../../../src/types.ts";
import { age, cls } from "../format.ts";
import { BACK_TITLE, Dots, KeyButton } from "./Detail.tsx";

// Merging: your PRs handed off for merge, one line each like the main page's: what each waits on and the coordinator's note.
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
  const row = (r: InflightRow) => <Row key={r.card.id} row={r} now={now} on={selected === r.card.id} select={select} run={run} />;
  // The desk sends a stack's rows together, bottom first: two or more sit under one quiet header.
  const rows = (list: InflightRow[]) => {
    const parts: InflightRow[][] = [];
    for (const r of list) {
      const last = parts.at(-1);
      if (last && r.card.stack && last[0]!.card.stack?.id === r.card.stack.id) last.push(r);
      else parts.push([r]);
    }
    return (
      <div className="lines">
        {parts.map((p) => {
          const s = p.length > 1 && p[0]!.card.stack;
          if (!s) return p.map(row);
          return (
            <div key={s.id} className="lines lane-stack" aria-label={`Stack of ${s.size}`}>
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
    <div className="queue lane">
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

// One line: the title, quietly its ref and place in its stack, what it waits on and the coordinator's latest note, its age.
// Selected, the note whole with its age, and its keys.
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
        {c.stack && (
          <span className="line-stack" title={`${c.stack.pos} of ${c.stack.size} open PRs in its stack`}>
            {c.stack.pos}/{c.stack.size}
          </span>
        )}
        <span className="line-note">{live ? <Dots parts={[r.waits_on ?? "merging", ...(r.note ? [r.note.text] : [])]} /> : r.state}</span>
        <span className="line-age" title={`${c.resolved_at ? "resolved" : "waiting since"} ${new Date(since).toLocaleString()}`}>
          {age(since, now)}
        </span>
      </button>
      {on && (
        <div className="lane-more">
          {/* The row cuts a long note short: here it's whole. */}
          {live && r.note && (
            <p className="lane-why">
              <Dots parts={[r.note.text, age(r.note.at, now)]} />
            </p>
          )}
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
