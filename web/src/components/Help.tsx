import { useEffect, useRef } from "react";

const KEYS: [string[], string][] = [
  [["j", "k"], "Move down and up (or the arrow keys)"],
  [["enter"], "Review the selected PR; an issue opens in place"],
  [["o"], "Open on GitHub"],
  [["e"], "Done: it comes back when someone else acts. On a cleared item, restore it"],
  [["s"], "Snooze, then 1 to 5 to pick how long"],
  [["m"], "Mute or unmute"],
  [["p"], "Pin or unpin"],
  [["u"], "Undo what you just did"],
  [["c"], "Copy a review prompt for Claude"],
  [["i"], "AI review: summary, concerns and notes from your agent (a minute or two)"],
  [["w"], "Show the item's rule trace and raw signals"],
  [["g", "l"], "Open or close Later (g f FYI, g h hidden, g x cleared)"],
  [["/"], "Filter"],
  [["esc"], "Close the item, then clear the filter"],
  [["r"], "Sync now"],
  [[","], "Settings (esc goes back)"],
  [["g", "r"], "Rules"],
  [["?"], "This list"],
];

const REVIEW_KEYS: [string[], string][] = [
  [["n", "p"], "Next and previous file"],
  [["]", "["], "Next and previous AI note"],
  [["a"], "Approve on GitHub: press a, then a again within 3 seconds"],
  [["i"], "Ask for the AI review again"],
  [["o"], "Open on GitHub"],
  [["c"], "Copy a review prompt for Claude"],
  [["esc"], "Back to the queue"],
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
            Close<kbd>esc</kbd>
          </button>
        </div>
        <div className="keys-cols">
          <section>
            <h3 className="keys-head">In the queue</h3>
            <Keys keys={KEYS} />
          </section>
          <section>
            <h3 className="keys-head">In a PR's review</h3>
            <Keys keys={REVIEW_KEYS} />
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
