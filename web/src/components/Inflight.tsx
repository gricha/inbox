import { JOB_ATTEMPTS, type CoordinatorView, type InflightRow, type InflightView, type Work } from "../../../src/types.ts";
import { age, cls, fromName, aiName } from "../format.ts";
import { Dots } from "./Detail.tsx";
import { withCode } from "./Review.tsx";
import { SkRows } from "./Skeleton.tsx";
import { attachCommand } from "../view.ts";

// Merging: your PRs handed off for merge, one line each like the main page's: what each waits on and the coordinator's note;
// then Claude's work. Beside a review (compact), its rows alone, two lines each.
export function Inflight({
  view,
  now,
  selected,
  select,
  act,
  open,
  onWork,
  compact = false,
}: {
  view: InflightView | null;
  now: number;
  selected: string | null;
  select: (id: string) => void;
  act: (k: "copy" | "wake") => void; // your agent's line: Copy attach command, Wake it
  open: (row: InflightRow) => void; // its review
  onWork: (w: Work, k: "open" | "retry") => void; // a row of Claude's work: what it's about, Try again
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
      {!compact && view.work.length > 0 && <ClaudesWork work={view.work} now={now} onWork={onWork} />}
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

// What Claude owes you, as the desk's ledger has it: what it's running and since when, what waits its turn, what failed and
// why, with Try again; and an answer of yours whoever asked hasn't read. Nothing while there's nothing.
function ClaudesWork({ work, now, onWork }: { work: Work[]; now: number; onWork: (w: Work, k: "open" | "retry") => void }) {
  return (
    <section className="group" aria-labelledby="h-work">
      <h3 id="h-work" className="group-head">
        <span>{aiName()}'s work</span>
        <span className="count">{work.length}</span>
      </h3>
      <div className="lines">
        {work.map((w) => (
          <WorkRow key={`${w.kind} ${w.key}`} w={w} now={now} onWork={onWork} />
        ))}
      </div>
    </section>
  );
}

// One line in Merging's columns: the PR's title, your ask's words or the question you answered, its ref, where it stands,
// Try again once it's failed, and since when. An answer has no Try again: only the session that asked can read it.
function WorkRow({ w, now, onWork }: { w: Work; now: number; onWork: (w: Work, k: "open" | "retry") => void }) {
  const review = w.kind === "ai_review";
  const answer = w.kind === "answer";
  const since = (answer ? null : w.state === "running" ? w.started_at : w.state === "failed" ? w.finished_at : null) ?? w.queued_at;
  const tries = w.attempts > 1 ? [`try ${w.attempts} of ${JOB_ATTEMPTS}`] : [];
  const error = withCode(w.error ?? "");
  const phrase = answer
    ? [`Your answer to ${fromName(w.from ?? "", false)} hasn't been picked up`, ...(w.error ? [error] : [])]
    : w.state === "running"
      ? [review ? `${aiName()} is reviewing it` : "Your agent has it", ...tries]
      : w.state === "failed"
        ? [
            <>
              {review && w.attempts > 1 ? `Failed ${w.attempts} times: ` : "Failed: "}
              {error}
            </>,
          ]
        : w.retry_at
          ? [
              Date.parse(w.retry_at) > now
                ? `Tries again in ${age(new Date(now).toISOString(), Date.parse(w.retry_at))}`
                : "Tries again shortly",
              error,
            ]
          : [review ? "Waiting its turn" : "Waiting for your agent"];
  const [repo, num] = (w.item ?? "").split("#");
  const ref = (
    <span className="lane-ref">
      {w.item && (
        <>
          <span className="line-ref" title={w.item}>
            {repo!.split("/")[1]}
          </span>
          <span className="line-num">#{num}</span>
        </>
      )}
    </span>
  );
  const state = answer ? "answered" : w.state === "running" ? "running since" : w.state === "failed" ? "failed" : "queued";
  return (
    <div className={cls("line", "lane-row", "work-row", w.state === "failed" && "work-failed")} data-id={`${w.kind} ${w.key}`}>
      <div className="line-main line-row">
        <button
          type="button"
          className="row-main line-btn"
          title={review ? "Open its review" : answer ? "Open the question" : "Open your chat with your agent"}
          onMouseDown={(e) => {
            e.preventDefault(); // a click opens without selecting first, as the main page's rows do
          }}
          onClick={() => {
            onWork(w, "open");
          }}
        >
          {/* Your words, quoted, so an ask reads as yours beside the PRs' titles. */}
          <span className="line-title">{review || answer ? w.title : `\u201c${w.title}\u201d`}</span>
          {ref}
          <span className="line-note">
            <Dots parts={phrase} />
          </span>
        </button>
        {w.state === "failed" && !answer && (
          <button
            type="button"
            className="act line-cta"
            onClick={() => {
              onWork(w, "retry");
            }}
          >
            Try again
          </button>
        )}
        <span className="line-age" title={`${state} ${new Date(since).toLocaleString()}`}>
          {age(since, now)}
        </span>
      </div>
    </div>
  );
}

// One quiet line: how your agent is, where to watch it, Copy attach command and Wake it.
function Coordinator({ c, act }: { c: CoordinatorView; act: (k: "copy" | "wake") => void }) {
  const wake = () => {
    act("wake");
  };
  if (!c.on) return <p className="lane-coord">{"Your agent is off in Settings → Agent."}</p>;
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
            title={attachCommand(c.id, aiName() === "Codex")}
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
