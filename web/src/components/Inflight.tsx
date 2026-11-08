import type { CoordinatorView, InflightRow, InflightView } from "../../../src/types.ts";
import { age, cls } from "../format.ts";
import { Dots } from "./Detail.tsx";
import { withCode } from "./Review.tsx";
import { SkRows } from "./Skeleton.tsx";

// Merging: your PRs handed off for merge, one line each like the main page's: what each waits on and the coordinator's note.
// Beside a review (compact), its rows alone, two lines each.
export function Inflight({
  view,
  now,
  selected,
  select,
  act,
  open,
  compact = false,
}: {
  view: InflightView | null;
  now: number;
  selected: string | null;
  select: (id: string) => void;
  act: (k: "copy" | "wake") => void; // your agent's line: Copy attach command, Wake it
  open: (row: InflightRow) => void; // its review
  compact?: boolean;
}) {
  if (!view)
    return (
      <div className="queue lane">
        <SkRows count={4} />
      </div>
    );
  const live = view.rows.filter((r) => r.state === "open");
  const landed = view.rows.filter((r) => r.state !== "open");
  const row = (r: InflightRow) => (
    <Row key={r.card.id} row={r} now={now} on={selected === r.card.id} select={select} open={open} compact={compact} />
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
      {!compact && <Coordinator c={view.coordinator} act={act} />}
      {live.length ? (
        rows(live)
      ) : (
        <p className="queue-empty">Nothing in Merging yet: hand off one of your PRs for merge when you're done with it.</p>
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

// One quiet line: how your agent is, where to watch it, Copy attach command and Wake it.
function Coordinator({ c, act }: { c: CoordinatorView; act: (k: "copy" | "wake") => void }) {
  const wake = () => {
    act("wake");
  };
  if (!c.on) return <p className="lane-coord">{"Your agent is off in Settings \u2192 Agents."}</p>;
  if (c.error)
    return (
      <p className="lane-coord lane-coord-error">
        <b>Your agent can't run:</b> {withCode(c.error)}{" "}
        <button type="button" className="link-btn" onClick={wake}>
          Try again
        </button>
      </p>
    );
  if (!c.id)
    return (
      <p className="lane-coord">
        Your agent starts on your first hand-off or ask.{" "}
        <button type="button" className="link-btn" onClick={wake}>
          Start it now
        </button>
      </p>
    );
  return (
    <p className="lane-coord">
      <Dots
        parts={[
          "Your agent",
          ...(c.url
            ? [
                <a key="url" href={c.url} target="_blank" rel="noreferrer">
                  Watch on claude.ai
                </a>,
              ]
            : []),
          <button
            key="attach"
            type="button"
            className="link-btn"
            title={`claude attach ${c.id}`}
            onClick={() => {
              act("copy");
            }}
          >
            Copy attach command
          </button>,
          <button key="wake" type="button" className="link-btn" onClick={wake}>
            Wake it
          </button>,
        ]}
      />
    </p>
  );
}

// One line: the title, quietly its ref and place in its stack, what it waits on and the coordinator's latest note, its age.
// Selected (by Tab, or the row you came back from), its phrase moves whole under the row, with the note's age; on every
// other row that's its tooltip.
function Row({
  row: r,
  now,
  on,
  select,
  open,
  compact,
}: {
  row: InflightRow;
  now: number;
  on: boolean;
  select: (id: string) => void;
  open: (row: InflightRow) => void;
  compact: boolean;
}) {
  const c = r.card;
  const live = r.state === "open";
  const since = c.resolved_at ?? c.waiting_since;
  const phrase = [r.waits_on ?? "merging", ...(r.note ? [r.note.text] : [])];
  // A long repo name gives way before the title; the number never does.
  const ref = (
    <>
      <span className="line-ref" title={`${c.repo}#${c.number}`}>
        {c.repo.split("/")[1]}
      </span>
      <span className="line-num">#{c.number}</span>
      {c.stack && (
        <span className="line-stack" title={`${c.stack.pos} of ${c.stack.size} open PRs in its stack`}>
          {c.stack.pos}/{c.stack.size}
        </span>
      )}
    </>
  );
  const note = (whole: boolean) => (
    <span className="line-note" title={live ? [...phrase, ...(r.note ? [age(r.note.at, now)] : [])].join(" \u00b7 ") : undefined}>
      {live ? <Dots parts={whole ? phrase : phrase.slice(0, 1)} /> : r.state}
    </span>
  );
  const ageEl = (
    <span className="line-age" title={`${c.resolved_at ? "resolved" : "waiting since"} ${new Date(since).toLocaleString()}`}>
      {age(since, now)}
    </span>
  );
  return (
    <div className={cls("line", "lane-row", compact && "c-line", on && "sel", !live && "dim")} data-id={c.id}>
      <button
        type="button"
        className={cls("row-main line-main", compact && "c-row")}
        onMouseDown={(e) => {
          e.preventDefault(); // a click opens without selecting first, as the main page's rows do
        }}
        onClick={() => {
          open(r);
        }}
        onFocus={() => {
          select(c.id);
        }}
      >
        <span className="line-title">{c.title}</span>
        {compact ? (
          <>
            {/* What it waits on: the coordinator's note is the row's tooltip. */}
            <span className="c-meta">
              <span className="c-ref">{ref}</span>
              {note(false)}
            </span>
            {ageEl}
          </>
        ) : (
          <>
            {/* One width for every ref, so what each waits on starts in one column. */}
            <span className="lane-ref">{ref}</span>
            {!(on && live) && note(true)}
            {ageEl}
          </>
        )}
      </button>
      {on && live && !compact && (
        <div className="lane-more">
          <p className="lane-why">
            <Dots parts={r.note ? [...phrase, age(r.note.at, now)] : phrase} />
          </p>
        </div>
      )}
    </div>
  );
}
