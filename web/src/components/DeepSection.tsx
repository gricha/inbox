import { useState, type ReactNode } from "react";
import type { DeepReview, ReviewFile } from "../../../src/types.ts";
import { ago, cls } from "../format.ts";
import { Diagram } from "./Diagram.tsx";
import { withCode } from "./Prose.tsx";

// A deep review (src/deep.ts), leading the Review tab: its lean, the intent, one picture of how the change works and where
// it breaks, then a line per thing it proved wrong, per premise that doesn't hold and per question only you can answer.
// Evidence, the premises that hold and the author's small fixes fold away. A `path:line` opens that line of the diff.
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
  const [open, setOpen] = useState<string | null>(null); // the fold that's open: an item's evidence, the premises, the fixes
  const toggle = (k: string) => {
    setOpen(open === k ? null : k);
  };
  // A path:line in its text: a link to the diff when the PR changed that file, else to the file on GitHub.
  const linked = (s: string): ReactNode => {
    const m = /([\w./@-]+\.\w+):(\d+)/.exec(s);
    if (!m) return withCode(s);
    const [all, p = "", n = "0"] = m;
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
        {withCode(s.slice(0, m.index))}
        {link}
        {withCode(s.slice(m.index + all.length))}
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
              <span className="dp-meta">Reads the repo, runs the tests and checks what the PR assumes</span>
              {run(error ? "Try again" : "Run deep review")}
            </>
          )}
        </div>
        {error && !running && <p className="dp-error">{withCode(error)}</p>}
      </section>
    );

  const fails = deep.premises.filter((p) => p.verdict !== "holds");
  const holds = deep.premises.length - fails.length;
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
        {deep.intent_from === "inferred" && <span className="dp-meta"> · inferred</span>}
      </p>

      {deep.picture && <Diagram graph={deep.picture.graph} title={deep.picture.title} caption={deep.picture.caption} />}

      {(deep.wrong.length > 0 || deep.ask.length > 0 || fails.length > 0) && (
        <ul className="dp-lines">
          {deep.wrong.map((w, i) => (
            <li key={w.what} className={cls("dp-line", w.severity === "blocker" ? "dp-blocker" : "dp-fix")}>
              <span className="dp-mark" aria-hidden="true" />
              <div>
                <div className="dp-what">{withCode(w.what)}</div>
                <div className="dp-why">
                  {withCode(w.why)}
                  {w.evidence.length > 0 && (
                    <>
                      {" · "}
                      <button
                        type="button"
                        className="dp-fold"
                        aria-expanded={open === `w${i}`}
                        onClick={() => {
                          toggle(`w${i}`);
                        }}
                      >
                        Evidence
                      </button>
                    </>
                  )}
                </div>
                {open === `w${i}` &&
                  w.evidence.map((e) => (
                    <div key={e} className="dp-ev">
                      {linked(e)}
                    </div>
                  ))}
              </div>
            </li>
          ))}
          {fails.map((p) => (
            <li key={p.premise} className={cls("dp-line", p.verdict === "fails" ? "dp-fails" : "dp-unknown")}>
              <span className="dp-mark" aria-hidden="true" />
              <div>
                <div className="dp-what">
                  {p.verdict === "fails" ? "Doesn't hold: " : "Unverified: "}
                  {withCode(p.premise)}
                </div>
                <div className="dp-ev">{linked(p.evidence)}</div>
              </div>
            </li>
          ))}
          {deep.ask.map((a) => (
            <li key={a.question} className="dp-line dp-ask">
              <span className="dp-mark" aria-hidden="true" />
              <div>
                <div className="dp-what">{withCode(a.question)}</div>
                <div className="dp-why">{withCode(a.why)}</div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="dp-foot">
        {deep.checked.tests && <span>Tests: {withCode(deep.checked.tests)}</span>}
        {holds > 0 && (
          <button
            type="button"
            className="dp-fold"
            aria-expanded={open === "holds"}
            onClick={() => {
              toggle("holds");
            }}
          >
            {holds === 1 ? "1 premise holds" : `${holds} premises hold`}
          </button>
        )}
        {deep.author_fixes.length > 0 && (
          <button
            type="button"
            className="dp-fold"
            aria-expanded={open === "fixes"}
            onClick={() => {
              toggle("fixes");
            }}
          >
            {deep.author_fixes.length === 1 ? "1 small fix for the author" : `${deep.author_fixes.length} small fixes for the author`}
          </button>
        )}
      </div>
      {open === "holds" && (
        <ul className="dp-list">
          {deep.premises
            .filter((p) => p.verdict === "holds")
            .map((p) => (
              <li key={p.premise}>
                <div className="dp-what">{withCode(p.premise)}</div>
                <div className="dp-ev">{linked(p.evidence)}</div>
              </li>
            ))}
        </ul>
      )}
      {open === "fixes" && (
        <ul className="dp-list">
          {deep.author_fixes.map((f) => (
            <li key={f}>{linked(f)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
