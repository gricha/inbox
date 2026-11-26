import type { DeepReview } from "../../../src/types.ts";
import { ago, cls } from "../format.ts";
import { withCode } from "./Prose.tsx";

const LEAN = { ship: "Ship", "fix first": "Fix first", rethink: "Rethink" } as const;

// The review's top (src/deep.ts): the author's goal, the lean and the line that decides it with a link to its step, how
// behaviour changes, and the one thing about the whole change it couldn't settle. Its findings are in the steps below.
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
              <span className="dp-meta">Reads the repo, runs the tests and checks what the PR assumes</span>
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
      <p className="dp-goal">
        {deep.intent_from === "missing" && <b className="dp-missing">Intent not stated · </b>}
        {withCode(deep.goal)}
        {deep.intent_from === "inferred" && <span className="dp-meta"> · inferred from the code</span>}
      </p>
      <p className="dp-lean-line">
        <b className={cls("dp-lean", `dp-${deep.lean.replace(" ", "-")}`)}>{LEAN[deep.lean]}</b> {withCode(deep.lean_why)}
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
              Step {deciding + 1}
            </button>
          </>
        )}
      </p>
      <p className="dp-change">{withCode(deep.change)}</p>
      {deep.caveat && (
        <p className="dp-caveat">
          <span className="dp-meta">Not settled:</span> {withCode(deep.caveat)}
        </p>
      )}
      <div className="dp-head">
        <span className="dp-meta">
          {running ? `Reviewing again · started ${ago(running, now)}` : stale ? "Of an earlier commit" : `Reviewed ${ago(deep.at, now)}`}
          {deep.checked.tests && ` · Tests: ${deep.checked.tests}`}
        </span>
        {!running && run(stale ? "Review this commit" : "Review again")}
      </div>
      {error && !running && <p className="dp-error">The last run failed: {withCode(error)}</p>}
    </section>
  );
}
