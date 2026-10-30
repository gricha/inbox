// The coordinator's recent log, opened from the top bar's line: its runs, its actions with their reasons, its notes.
import { useCallback, useEffect, useState } from "react";
import type { CoordinatorView } from "../../../src/types.ts";
import { api, message } from "../api.ts";
import { cls, shortId, sinceText } from "../format.ts";
import { coordinatorText, logText } from "../view.ts";
import { KeyButton } from "./Detail.tsx";
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

  async function undo(seq: number) {
    try {
      const r = await api.undo(seq);
      flash(`Undid ${r.action ?? "that"} on ${shortId(r.id)}`);
      await load();
    } catch (e) {
      flash(message(e), true);
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
        {view?.log.slice(0, SHOWN).map((e) => (
          <li key={e.seq} className={cls(`cl-${e.kind}`, e.undone && "undone")}>
            <span className="cl-when">{sinceText(e.at, now)}</span>
            <span className="cl-text">{withCode(logText(e))}</span>
            {e.kind === "act" && e.undo_seq !== null && !e.undone && (
              <button
                type="button"
                className="cl-undo"
                onClick={() => {
                  void undo(e.undo_seq!);
                }}
              >
                Undo
              </button>
            )}
            {e.undone && <span className="cl-undone">undone</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
