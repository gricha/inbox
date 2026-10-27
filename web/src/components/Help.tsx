import { useEffect, useRef } from "react";

const KEYS: [string[], string][] = [
  [["j", "k"], "Move down and up (or the arrow keys)"],
  [["enter"], "Open or close the selected item"],
  [["o"], "Open on GitHub"],
  [["e"], "Done: it comes back when someone else acts. On a cleared item, restore it"],
  [["s"], "Snooze, then 1 to 5 to pick how long"],
  [["m"], "Mute or unmute"],
  [["p"], "Pin or unpin"],
  [["u"], "Undo what you just did"],
  [["c"], "Copy a review prompt for Claude"],
  [["i"], "Ask Claude for a brief (30 to 90 seconds)"],
  [["w"], "Show the raw signals"],
  [["g", "l"], "Open or close Later (g f FYI, g h hidden, g x cleared)"],
  [["/"], "Filter"],
  [["esc"], "Close the item, then clear the filter"],
  [["r"], "Sync now"],
  [[","], "Settings (esc goes back)"],
  [["g", "r"], "Rules"],
  [["?"], "This list"],
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
    <div className="overlay" onClick={onClose}>
      <div ref={dialog} tabIndex={-1} className="dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h2>Keyboard shortcuts</h2>
          <button type="button" className="btn ghost" onClick={onClose}>Close<kbd>esc</kbd></button>
        </div>
        <dl className="keys">
          {KEYS.map(([ks, v]) => (
            <div key={v} className="fact">
              <dt>{ks.map((k) => <kbd key={k}>{k}</kbd>)}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
