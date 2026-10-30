import { useEffect, useRef } from "react";
import { Dots } from "./Detail.tsx";

// The keys on the cards; the rest are one line at the end.
const KEYS: [string[], string][] = [
  [["j", "k"], "Move down and up. The selected card shows its whole AI review, its facts and its keys"],
  [["enter"], "Review the PR; an issue opens in place, your PR in flight opens In flight, “n more” shows the rest"],
  [["o"], "Open on GitHub"],
  [["d"], "Your own PR: you're done, babysitters take it from here. d again takes it back"],
  [["y"], "Your PR in flight: send its drafted reply on GitHub, as you"],
  [["e"], "Done: it comes back when someone else acts"],
  [["s"], "Snooze, then 1 to 5 to pick how long"],
  [["m"], "Mute or unmute"],
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
  ["g i", "in flight"],
  ["g r", "rules"],
  [",", "settings"],
];

const LANE_KEYS: [string[], string][] = [
  [["j", "k"], "Move"],
  [["enter"], "Review the PR"],
  [["y"], "Send the drafted reply on GitHub, as you"],
  [["x"], "Dismiss the question, or discard the reply"],
  [["c"], "Copy a command that opens the babysitter's session"],
  [["d"], "Take it back"],
  [["o"], "Open on GitHub"],
  [["esc"], "Back to the queue"],
];

const REVIEW_KEYS: [string[], string][] = [
  [["n", "p"], "Next and previous file"],
  [["]", "["], "Next and previous AI note"],
  [["a"], "Approve on GitHub: press a, then a again within 3 seconds"],
  [["d"], "Your own PR: in flight, or take it back"],
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
        <div className="keys-cols">
          <section>
            <h3 className="keys-head">In the queue</h3>
            <Keys keys={KEYS} />
            <p className="keys-more">
              <Dots
                parts={MORE_KEYS.map(([k, v]) => (
                  <span key={k}>
                    <kbd>{k}</kbd> {v}
                  </span>
                ))}
              />
            </p>
          </section>
          <section>
            <h3 className="keys-head">In a PR's review</h3>
            <Keys keys={REVIEW_KEYS} />
            <h3 className="keys-head lane-keys">In flight</h3>
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
