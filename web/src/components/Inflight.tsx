import type { CoordinatorView, InflightRow, InflightView } from "../../../src/types.ts";
import { age, cls } from "../format.ts";
import { BACK_TITLE, Dots, KeyButton } from "./Detail.tsx";
import { SkRows } from "./Skeleton.tsx";

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
  run: (row: InflightRow, key: string) => void; // Merging's keys: enter o b t
}) {
  if (!view)
    return (
      <div className="queue lane">
        <SkRows count={4} />
      </div>
    );
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
      <Coordinator c={view.coordinator} />
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

// One quiet line: how the coordinator is, where to watch it, and its keys (c copies the attach command, w wakes it).
function Coordinator({ c }: { c: CoordinatorView }) {
  if (!c.on) return <p className="lane-coord">The coordinator is off in Settings → Agents.</p>;
  if (c.error)
    return (
      <p className="lane-coord lane-coord-error">
        The coordinator can't run: {c.error} <kbd>w</kbd> tries again.
      </p>
    );
  if (!c.id)
    return (
      <p className="lane-coord">
        The coordinator starts on your first hand-off; <kbd>w</kbd> starts it now.
      </p>
    );
  return (
    <p className="lane-coord">
      <Dots
        parts={[
          "Coordinator",
          ...(c.url
            ? [
                <a key="url" href={c.url} target="_blank" rel="noreferrer">
                  Watch on claude.ai
                </a>,
              ]
            : []),
          <span key="attach">
            <kbd>c</kbd> copy <code>claude attach {c.id}</code>
          </span>,
          <span key="wake">
            <kbd>w</kbd> wake it
          </span>,
        ]}
      />
    </p>
  );
}

// One line: the title, quietly its ref and place in its stack, what it waits on and the coordinator's latest note, its age.
// Selected, that phrase moves whole under the row, with the note's age, and its keys.
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
  const phrase = [r.waits_on ?? "merging", ...(r.note ? [r.note.text] : [])];
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
        {!(on && live) && <span className="line-note">{live ? <Dots parts={phrase} /> : r.state}</span>}
        <span className="line-age" title={`${c.resolved_at ? "resolved" : "waiting since"} ${new Date(since).toLocaleString()}`}>
          {age(since, now)}
        </span>
      </button>
      {on && (
        <div className="lane-more">
          {live && (
            <p className="lane-why">
              <Dots parts={r.note ? [...phrase, age(r.note.at, now)] : phrase} />
            </p>
          )}
          <div className="actions card-keys">
            <KeyButton k="enter" label="Review" run={keys} />
            <KeyButton k="o" label="Open on GitHub" run={keys} />
            {live && <KeyButton k="b" label="Back to desk" title={BACK_TITLE} run={keys} />}
            <KeyButton k="t" label="Ask coordinator" title="Tell or ask your coordinator something about it" run={keys} />
          </div>
        </div>
      )}
    </div>
  );
}
