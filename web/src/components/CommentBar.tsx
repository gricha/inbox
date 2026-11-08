import { Effect } from "effect";
import { useEffect, useRef, useState } from "react";
import type { Card } from "../../../src/types.ts";
import { runUi } from "../api.ts";
import { MOD, shortRef } from "../format.ts";

// Comment on an issue opened in place: your comment, at the window's bottom, so a refresh that
// moves the issue's row never takes what you're writing. ⌘↵ sends, Esc closes; GitHub refusing it keeps your words here.
export function CommentBar({
  card,
  onSend,
  onClose,
}: {
  card: Card;
  onSend: (body: string) => Effect.Effect<boolean>;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  // Focus goes back to the issue's row on close (a click selects a row without focusing it, so where focus was may be
  // another row, which focusing would select), so Tab goes on from it.
  useEffect(() => {
    box.current?.focus();
    return () => {
      const row = document.querySelector(`[data-id="${CSS.escape(card.id)}"] .row-main`);
      if (row instanceof HTMLElement) row.focus({ preventScroll: true });
    };
  }, [card.id]);

  function send() {
    if (!text.trim() || busy) return;
    setBusy(true);
    void runUi(
      onSend(text).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            setBusy(false);
          }),
        ),
        Effect.tap((ok) =>
          Effect.sync(() => {
            if (ok) onClose();
          }),
        ),
      ),
    );
  }

  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a native <dialog> is modal or needs show(); this bar sits over the page
    <div className="composer" role="dialog" aria-label={`Comment on ${shortRef(card)}`}>
      <p className="composer-about">
        Comment on GitHub<span>{shortRef(card)}</span>
      </p>
      <div className="composer-row">
        <textarea
          ref={box}
          className="composer-input composer-text"
          aria-label={`Your comment on ${shortRef(card)}`}
          placeholder={`Comment on ${card.title}`}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.repeat) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          type="button"
          className="act primary"
          title={`Comment on GitHub, as you (${MOD}\u21b5)`}
          disabled={!text.trim() || busy}
          onClick={() => {
            send();
          }}
        >
          {busy ? "Commenting\u2026" : "Comment"}
        </button>
        <button type="button" className="act" title="Close (Esc)" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
