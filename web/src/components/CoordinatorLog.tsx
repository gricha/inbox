// The coordinator's recent log, opened from the top bar's line: its runs, its actions with their reasons, its notes.
import { Fragment, useCallback, useEffect, useState } from "react";
import type { CoordinatorLogEntry, CoordinatorView } from "../../../src/types.ts";
import { api, message } from "../api.ts";
import { cls, shortId, sinceText } from "../format.ts";
import { coordinatorText, logText, policyLines } from "../view.ts";
import { Dots, KeyButton } from "./Detail.tsx";
import { withCode } from "./Review.tsx";

const SHOWN = 30;

export function CoordinatorLog({
  loads,
  now,
  flash,
  onClose,
}: {
  loads: number;
  now: number;
  flash: (text: string, error?: boolean) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<CoordinatorView | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setView(await api.coordinator());
      setError("");
    } catch (e) {
      setError(message(e));
    }
  }, []);
  // It opens above the queue, which may be scrolled far down.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);
  // Re-read on every app refresh: a run may have finished.
  useEffect(() => {
    void load();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- loads only triggers a re-read
  }, [load, loads]);

  // An action by its undo seq, or a policy change by its version.
  async function undo(e: CoordinatorLogEntry) {
    try {
      if (e.kind === "policy" && e.version !== null) {
        await api.undoPolicy(e.version);
        flash("Put the policy back as it was before that change");
      } else {
        const r = await api.undo(e.undo_seq!);
        flash(`Undid ${r.action ?? "that"} on ${shortId(r.id)}`);
      }
      await load();
    } catch (err) {
      flash(message(err), true);
    }
  }

  return (
    <section className="coord-log" aria-labelledby="coord-log-h">
      <div className="cl-head">
        <h2 id="coord-log-h">Coordinator</h2>
        <span className="cl-status">{view ? withCode(coordinatorText(view.status, now)) : error || "Loading…"}</span>
        <KeyButton k="esc" label="Close" run={onClose} />
      </div>
      {view && !view.log.length && <p className="group-empty">Nothing yet.</p>}
      <ul className="cl-list">
        {view &&
          shownLog(view.log).map((e, i, all) => (
            <Fragment key={e.seq}>
              {/* Outside a run (you edited the policy with it in a terminal): its own line, not under the run before it. */}
              {e.run === 0 && all[i - 1]?.run !== 0 && (
                <li className="cl-run">
                  <span className="cl-text">In a terminal</span>
                  <span className="cl-when">{sinceText(e.at, now)}</span>
                </li>
              )}
              <Entry e={e} now={now} undo={undo} />
            </Fragment>
          ))}
      </ul>
    </section>
  );
}

// The latest entries, less a run's note that only says what its one action already says.
function shownLog(log: CoordinatorLogEntry[]): CoordinatorLogEntry[] {
  const acts = new Map<number, number>();
  for (const e of log) if (e.kind === "act" && e.run) acts.set(e.run, (acts.get(e.run) ?? 0) + 1);
  return log.slice(0, SHOWN).filter((e) => !(e.kind === "note" && acts.get(e.run) === 1));
}

function Entry({ e, now, undo }: { e: CoordinatorLogEntry; now: number; undo: (e: CoordinatorLogEntry) => Promise<void> }) {
  const diff = policyLines(e);
  const undoable = (e.kind === "act" && e.undo_seq !== null) || (e.kind === "policy" && e.version !== null);
  return (
    <li className={cls(`cl-${e.kind}`, e.undone && "undone")}>
      <span className="cl-text">
        {e.kind === "run" ? <Dots parts={logText(e).split(" · ")} /> : withCode(logText(e))}
        {diff.length > 0 && (
          <span className="cl-diff">
            {diff.map((l, i) => (
              // oxlint-disable-next-line react/no-array-index-key -- lines of one change, never reordered
              <span key={i}>{l}</span>
            ))}
          </span>
        )}
      </span>
      {undoable && !e.undone && (
        <button
          type="button"
          className="cl-undo"
          onClick={() => {
            void undo(e);
          }}
        >
          Undo
        </button>
      )}
      {e.undone && <span className="cl-undone">undone</span>}
      <span className="cl-when">{sinceText(e.at, now)}</span>
    </li>
  );
}
