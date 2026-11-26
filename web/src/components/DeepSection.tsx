import type { DeepReview } from "../../../src/types.ts";
import { ago, cls } from "../format.ts";
import { withCode } from "./Prose.tsx";

const LEAN = { ship: "Ship", "fix first": "Fix first", rethink: "Rethink" } as const;

// The review's top (src/deep.ts): the intent under its heading and how the PR fits it; the lean, the line that decides it
// and a link to its step; then how behaviour changes, its blast radius and what it couldn't settle. Findings are in the steps.
export function DeepSection({
  deep,
  running,
  error,
  stale,
  now,
  onRun,
  onStep,
}: {
  deep: DeepReview | null;
  running: string | null; // when the one running now started
  error: string | null;
  stale: boolean; // it read an older commit
  now: number;
  onRun: () => void;
  onStep: (k: number) => void;
}) {
  const run = (label: string) => (
    <button type="button" className="dp-run" onClick={onRun}>
      {label}
    </button>
  );

  if (!deep)
    return (
      <section className="dp" aria-label="Review">
        <div className="dp-head">
          {running ? (
            <span className="dp-meta">Reviewing · started {ago(running, now)}</span>
          ) : (
            <>
              <span className="dp-meta">Reads the repo, weighs what the PR risks in production and whether it's the right change</span>
              {run(error ? "Try again" : "Review it")}
            </>
          )}
        </div>
        {error && !running && <p className="dp-error">{withCode(error)}</p>}
      </section>
    );

  const kinds = deep.steps.map((s) => new Set(s.notes.map((n) => n.kind)));
  const blocker = kinds.findIndex((k) => k.has("blocker"));
  const deciding = blocker >= 0 ? blocker : kinds.findIndex((k) => k.has("issue"));
  return (
    <section className={cls("dp", running && "dp-busy")} aria-label="Review">
      <h2 className="dp-h">
        Intent
        {deep.intent_from === "missing" && <span className="dp-missing"> · not stated</span>}
        {deep.intent_from === "inferred" && <span className="dp-meta"> · inferred from the code</span>}
      </h2>
      <p className="dp-goal">{withCode(deep.goal)}</p>
      <p className="dp-fit">{withCode(deep.fit)}</p>
      <div className={cls("dp-verdict", `dp-${deep.lean.replace(" ", "-")}`)}>
        <b className="dp-lean">{LEAN[deep.lean]}</b>
        <span>
          {withCode(deep.lean_why)}
          {deep.lean !== "ship" && deciding >= 0 && (
            <>
              {" "}
              <button
                type="button"
                className="dp-run"
                onClick={() => {
                  onStep(deciding);
                }}
              >
                See step {deciding + 1}
              </button>
            </>
          )}
        </span>
      </div>
      <dl className="dp-facts">
        <dt>Change</dt>
        <dd>{withCode(deep.change)}</dd>
        <dt>Blast radius</dt>
        <dd>{withCode(deep.risk)}</dd>
        {deep.caveat && (
          <>
            <dt>Not settled</dt>
            <dd>{withCode(deep.caveat)}</dd>
          </>
        )}
      </dl>
      <div className="dp-head">
        <span className="dp-meta">
          {running ? `Reviewing again · started ${ago(running, now)}` : stale ? "Of an earlier commit" : `Reviewed ${ago(deep.at, now)}`}
        </span>
        {!running && run(stale ? "Review this commit" : "Review again")}
      </div>
      {error && !running && <p className="dp-error">The last run failed: {withCode(error)}</p>}
    </section>
  );
}
