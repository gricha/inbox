import { useEffect, useRef } from "react";
import { Dots } from "./Detail.tsx";

// The keys on the cards; the rest are one line at the end.
const KEYS: [string[], string][] = [
  [["j", "k"], "Move down and up. The selected card shows its whole AI review, its facts and its keys"],
  [["enter"], "Review the PR; an issue opens in place, your PR in Merging opens Merging, “n more” shows the rest"],
  [["o"], "Open on GitHub"],
  [["m"], "Your own PR: hand it off for merge. Claude gets it merged, and GitHub's auto-merge goes on where the repo allows it"],
  [["b"], "Your PR in Merging: back to desk. Claude stops, and auto-merge goes off again"],
  [["y"], "Your PR in Merging: send its drafted reply on GitHub, as you. Press y, then y again within 3 seconds"],
  [["x"], "Your PR in Merging with a question: dismiss it (c copies the command to answer it)"],
  [["e", "d"], "Done: it comes back when someone else acts"],
  [["s"], "Snooze, then 1 to 5 to pick how long"],
  [["m"], "Someone else's: mute or unmute"],
  [["/"], "Filter"],
  [["esc"], "Close the item, then clear the filter"],
  [["?"], "This list"],
];

const MORE_KEYS: [string, string][] = [
  ["p", "pin"],
  ["u", "undo"],
  ["c", "copy a prompt"],
  ["i", "AI review"],
  ["w", "rule trace"],
  ["r", "sync"],
  ["g l", "later"],
  ["g d", "resolved"],
  ["g m", "merging"],
  ["g r", "rules"],
  [",", "settings"],
];

const LANE_KEYS: [string[], string][] = [
  [["j", "k"], "Move"],
  [["enter"], "Review the PR"],
  [["y"], "Send the drafted reply on GitHub, as you: y, then y again"],
  [["x"], "Dismiss the question, or discard the reply"],
  [["c"], "Copy a command that opens Claude's session"],
  [["b"], "Back to desk: Claude stops, and auto-merge goes off again"],
  [["o"], "Open on GitHub"],
  [["esc"], "Back to the queue"],
];

const REVIEW_KEYS: [string[], string][] = [
  [["n", "p"], "Next and previous file"],
  [["]", "["], "Next and previous AI note"],
  [["a"], "Approve on GitHub: press a, then a again within 3 seconds"],
  [["m", "b"], "Your own PR: hand it off for merge, or back to desk"],
  [["d"], "Done"],
  [["y"], "Your PR in Merging: send its drafted reply, y twice"],
  [["x"], "Your PR in Merging: discard its drafted reply"],
  [["i"], "Ask for the AI review again"],
  [["o"], "Open on GitHub"],
  [["c"], "Copy a review prompt for Claude"],
  [["esc"], "Back to where you opened it"],
];

export function Help({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  // Focus the sheet itself (no ring on a button you didn't pick), and give focus back on close.
  useEffect(() => {
    const before = document.activeElement;
    dialog.current?.focus();
    return () => {
      if (before instanceof HTMLElement) before.focus();
    };
  }, []);
  return (
    <div
      className="overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a native <dialog> needs showModal() and top-layer styling; this sheet manages focus itself */}
      <div ref={dialog} tabIndex={-1} className="dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div className="dialog-head">
          <h2>Keyboard shortcuts</h2>
          <button type="button" className="btn ghost" onClick={onClose}>
            <kbd>esc</kbd>Close
          </button>
        </div>
        {/* The quick keys first: at a short window's bottom edge they'd be cut off with nothing saying more scrolls below. */}
        <p className="keys-more">
          <Dots
            parts={MORE_KEYS.map(([k, v]) => (
              <span key={k}>
                <kbd>{k}</kbd> {v}
              </span>
            ))}
          />
        </p>
        <div className="keys-cols">
          <section>
            <h3 className="keys-head">In the queue</h3>
            <Keys keys={KEYS} />
          </section>
          <section>
            <h3 className="keys-head">In a PR's review</h3>
            <Keys keys={REVIEW_KEYS} />
            <h3 className="keys-head lane-keys">In Merging</h3>
            <Keys keys={LANE_KEYS} />
          </section>
        </div>
      </div>
    </div>
  );
}

function Keys({ keys }: { keys: [string[], string][] }) {
  return (
    <dl className="keys">
      {keys.map(([ks, v]) => (
        <div key={v} className="fact">
          <dt>
            {ks.map((k) => (
              <kbd key={k}>{k}</kbd>
            ))}
          </dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
