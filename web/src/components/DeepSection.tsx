import { useState, type ReactNode } from "react";
import type { DeepReview, ReviewFile } from "../../../src/types.ts";
import { ago, cls } from "../format.ts";
import { withCode } from "./Prose.tsx";

// A deep review (src/deep.ts) at the top of a PR's review: what it proved wrong, what only you can answer, the premises
// that don't hold, then what it ran. Every `path:line` in it opens that line of the diff, or the file on GitHub.
export function DeepSection({
  deep,
  running,
  error,
  stale,
  files,
  repo,
  head,
  now,
  onRun,
  onLine,
}: {
  deep: DeepReview | null;
  running: string | null; // when the one running now started
  error: string | null;
  stale: boolean; // it read an older commit
  files: ReviewFile[];
  repo: string;
  head: string;
  now: number;
  onRun: () => void;
  onLine: (path: string, side: "new" | "old", line: number) => void;
}) {
  const [fixes, setFixes] = useState(false);
  const [holds, setHolds] = useState(false);
  // A path:line in its text: a link to the diff when the PR changed that file, else to the file on GitHub.
  const linked = (s: string): ReactNode => {
    const m = /([\w./@-]+\.\w+):(\d+)/.exec(s);
    if (!m) return withCode(s);
    const [all, p = "", n = "0"] = m;
    const at = m.index;
    const file = files.find((f) => f.path === p || f.path.endsWith(`/${p}`));
    const line = Number(n);
    const link = file ? (
      <button
        type="button"
        className="dp-at"
        onClick={() => {
          onLine(file.path, "new", line);
        }}
      >
        {all}
      </button>
    ) : p.includes("/") ? (
      <a className="dp-at" href={`https://github.com/${repo}/blob/${head}/${p}#L${line}`}>
        {all}
      </a>
    ) : (
      all
    );
    return (
      <>
        {withCode(s.slice(0, at))}
        {link}
        {withCode(s.slice(at + all.length))}
      </>
    );
  };
  const run = (label: string) => (
    <button type="button" className="dp-run" onClick={onRun}>
      {label}
    </button>
  );

  if (!deep)
    return (
      <section className="dp" aria-label="Deep review">
        <div className="dp-head">
          <span className="dp-name">Deep review</span>
          {running ? (
            <span className="dp-meta">Running · started {ago(running, now)}</span>
          ) : (
            <>
              <span className="dp-meta">Reads the repo, runs the tests and checks what the PR assumes. About five minutes.</span>
              {run(error ? "Try again" : "Run deep review")}
            </>
          )}
        </div>
        {error && !running && <p className="dp-error">{withCode(error)}</p>}
      </section>
    );

  const shaky = deep.premises.filter((p) => p.verdict !== "holds");
  const fine = deep.premises.filter((p) => p.verdict === "holds");
  return (
    <section className={cls("dp", running && "dp-busy")} aria-label="Deep review">
      <div className="dp-head">
        <span className="dp-name">Deep review</span>
        <span className={cls("dp-lean", `dp-${deep.lean.replace(" ", "-")}`)}>
          {deep.lean === "ship" ? "Ship" : deep.lean === "fix first" ? "Fix first" : "Rethink"}
        </span>
        <span className="dp-meta">
          {running ? `Running again · started ${ago(running, now)}` : stale ? "Of an earlier commit" : ago(deep.at, now)}
        </span>
        {!running && run(stale ? "Run on this commit" : "Run again")}
      </div>
      {error && !running && <p className="dp-error">The last run failed: {withCode(error)}</p>}

      <p className="dp-intent">
        {deep.intent_from === "missing" && <b className="dp-missing">Intent not stated · </b>}
        {withCode(deep.intent)}
        {deep.intent_from === "inferred" && <span className="dp-faint"> · inferred</span>}
      </p>

      {deep.wrong.length > 0 && (
        <div className="dp-part">
          <h3>Wrong</h3>
          <ul>
            {deep.wrong.map((w) => (
              <li key={w.what} className={cls("dp-wrong", w.severity === "blocker" && "dp-blocker")}>
                <div className="dp-what">{withCode(w.what)}</div>
                <div className="dp-why">{withCode(w.why)}</div>
                {w.evidence.map((e) => (
                  <div key={e} className="dp-ev">
                    {linked(e)}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}

      {deep.ask.length > 0 && (
        <div className="dp-part">
          <h3>Only you can answer</h3>
          <ul>
            {deep.ask.map((a) => (
              <li key={a.question}>
                <div className="dp-what">{withCode(a.question)}</div>
                <div className="dp-why">{withCode(a.why)}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {shaky.length > 0 && (
        <div className="dp-part">
          <h3>Premises that don't hold</h3>
          <ul>
            {shaky.map((p) => (
              <li key={p.premise}>
                <div className="dp-what">
                  <span className={p.verdict === "fails" ? "dp-fails" : "dp-unknown"}>{p.verdict === "fails" ? "Fails" : "Unknown"}</span>{" "}
                  {withCode(p.premise)}
                </div>
                <div className="dp-ev">{linked(p.evidence)}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(fine.length > 0 || deep.author_fixes.length > 0) && (
        <div className="dp-folds">
          {fine.length > 0 && (
            <button
              type="button"
              className="dp-fold"
              aria-expanded={holds}
              onClick={() => {
                setHolds(!holds);
              }}
            >
              {fine.length === 1 ? "1 premise holds" : `${fine.length} premises hold`}
            </button>
          )}
          {deep.author_fixes.length > 0 && (
            <button
              type="button"
              className="dp-fold"
              aria-expanded={fixes}
              onClick={() => {
                setFixes(!fixes);
              }}
            >
              {deep.author_fixes.length} small fix{deep.author_fixes.length > 1 ? "es" : ""} for the author
            </button>
          )}
        </div>
      )}
      {holds && (
        <ul className="dp-list">
          {fine.map((p) => (
            <li key={p.premise}>
              <div className="dp-what">{withCode(p.premise)}</div>
              <div className="dp-ev">{linked(p.evidence)}</div>
            </li>
          ))}
        </ul>
      )}
      {fixes && (
        <ul className="dp-list">
          {deep.author_fixes.map((f) => (
            <li key={f}>{linked(f)}</li>
          ))}
        </ul>
      )}

      <p className="dp-foot">
        {withCode(deep.checked.summary)} · Tests: {withCode(deep.checked.tests)}
        {deep.checked.probes > 0 && ` · ${deep.checked.probes} probe${deep.checked.probes > 1 ? "s" : ""}`} ·{" "}
        {Math.max(1, Math.round(deep.seconds / 60))} min
      </p>
    </section>
  );
}
