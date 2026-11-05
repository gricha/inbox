import { useEffect, useRef } from "react";
import { Dots } from "./Detail.tsx";

// The keys on the queue's and Later's rows; the rest are one line at the top.
const KEYS: [string[], string][] = [
  [["j", "k"], "Move down and up"],
  [["enter"], "Review the PR; an agent's question opens its page; an issue opens in place; “n more” shows the rest"],
  [["o"], "Open on GitHub"],
  [["a"], "The row's call to action: your draft, ready for review on GitHub"],
  [["m"], "Your own PR: hand it off for merge. The coordinator gets it merged"],
  [["e", "d"], "Done: it comes back when someone else acts"],
  [["s"], "Snooze: 1 to 5 for how long, 6 on until CI passes, new commits, an approval…"],
  [["m"], "Someone else's: mute or unmute"],
  [["."], "More on GitHub: close, draft, reopen, or merge now without the coordinator"],
  [["/"], "Filter"],
  [["esc"], "Close the item, then clear the filter; on Later, back to the queue"],
  [["?"], "This list"],
  [["right-click"], "The row's actions in a menu"],
];

const MORE_KEYS: [string, string][] = [
  ["p", "pin"],
  ["u", "undo"],
  ["t", "ask the coordinator"],
  ["c", "copy a prompt"],
  ["i", "AI review"],
  ["w", "rule trace"],
  ["r", "sync"],
  ["g l", "later"],
  ["g f", "FYI"],
  ["g a", "archive"],
  ["g m", "merging"],
  ["g r", "rules"],
  [",", "settings"],
];

const LANE_KEYS: [string[], string][] = [
  [["j", "k"], "Move"],
  [["enter"], "Review the PR"],
  [["b"], "Back to desk: the coordinator leaves it alone"],
  [["o"], "Open on GitHub"],
  [["c"], "Copy the command that opens the coordinator in a terminal"],
  [["w"], "Wake the coordinator: it starts, or looks at Merging now"],
  [["esc"], "Back to the queue"],
];

const REVIEW_KEYS: [string[], string][] = [
  [["n", "p"], "Next and previous change, in the AI review's reading order"],
  [["]", "["], "Next and previous AI note"],
  [["N", "P"], "Next and previous PR in the stack"],
  [["f"], "Show or hide the sidebar: the stack, the files and recent activity"],
  [["a"], "Approve on GitHub, or your draft ready for review, asking the reviewers you picked"],
  [["@"], "Your draft: add a reviewer, from GitHub's suggestions or by name"],
  [["w"], "Comment on the PR"],
  [["m", "b"], "Your own PR: hand it off for merge, or back to desk"],
  [["d"], "Done"],
  [["."], "More on GitHub: close, draft, reopen or merge now without the coordinator; request changes on someone else's"],
  [["i"], "Ask for the AI review again"],
  [["o"], "Open on GitHub"],
  [["c"], "Copy a review prompt for Claude"],
  [["esc"], "Back to where you opened it"],
];

const INQUIRY_KEYS: [string[], string][] = [
  [["1", "6"], "Pick an answer, its pick first"],
  [["w"], "Write your own answer; ⌘↵ sends it"],
  [["d"], "Dismiss it: the agent decides itself"],
  [["o"], "Open what it's about on GitHub"],
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
            <h3 className="keys-head">In the queue and Later</h3>
            <Keys keys={KEYS} />
            <h3 className="keys-head lane-keys">On an agent's question</h3>
            <Keys keys={INQUIRY_KEYS} />
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
              <kbd key={k} className={k === "." ? "dot-key" : undefined}>
                {k}
              </kbd>
            ))}
          </dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
