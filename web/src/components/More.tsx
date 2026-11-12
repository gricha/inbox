import { useEffect, useRef, useState } from "react";
import type { Card, GitHubAction } from "../../../src/types.ts";
import { MOD } from "../format.ts";

// The More menu's writes, by label. One press does it; the toast's Undo undoes a close or a draft; Request changes only
// opens the box to write in.
export const MORE: Record<GitHubAction, string> = {
  close: "Close",
  draft: "Convert to draft",
  ready: "Ready for review",
  merge: "Merge now",
  reopen: "Reopen",
  request_changes: "Request changes",
  rerequest: "Re-request review",
};

// A row has no room to write in: requesting changes is in the PR's review.
export const rowActions = (c: Card) => (c.actions ?? []).filter((a) => a !== "request_changes");

// The quiet button that opens it.
export function MoreButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button type="button" className="act" title="More actions" aria-label="More actions" aria-expanded={open} onClick={onClick}>
      More
    </button>
  );
}

export function MoreMenu({
  card,
  actions,
  links,
  pick,
  onClose,
}: {
  card: Card;
  actions: GitHubAction[];
  links?: { label: string; run: () => void }[]; // what isn't a write, above them: Done, Open on GitHub
  pick: (a: GitHubAction) => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.scrollIntoView({ block: "nearest" });
  }, []);

  function choose(a: GitHubAction) {
    onClose();
    pick(a);
  }

  // Esc closes it, before the review reads it as "back"; Tab, Enter and Space are its buttons'.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.isComposing) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    onClose();
  };
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  // Capture phase, so the page's own Esc never sees the one the menu took.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      keyRef.current(e);
    };
    window.addEventListener("keydown", h, { capture: true });
    return () => {
      window.removeEventListener("keydown", h, { capture: true });
    };
  }, []);

  return (
    <>
      <div className="scrim-clear" role="presentation" onClick={onClose} />
      <div ref={menu} className="popover more-pop" role="menu" aria-label="More">
        {links?.map((l) => (
          <button
            key={l.label}
            type="button"
            role="menuitem"
            className="pop-item"
            onClick={() => {
              onClose();
              l.run();
            }}
          >
            <span>{l.label}</span>
          </button>
        ))}
        {actions.length > 0 && <div className="pop-title">On GitHub</div>}
        {actions.map((a) => (
          <button
            key={a}
            type="button"
            role="menuitem"
            className="pop-item"
            onClick={() => {
              choose(a);
            }}
          >
            <span>{a === "close" && card.kind === "issue" ? "Close issue" : MORE[a]}</span>
          </button>
        ))}
      </div>
    </>
  );
}

// What you write on a PR in its review, a comment or Request changes' body, sent with the button (or ⌘↵).
export function WriteBox({
  label,
  placeholder,
  onSend,
  onClose,
}: {
  label: string;
  placeholder: string;
  onSend: (body: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView({ block: "nearest" }); // at 900px and below it opens under the fold
  }, []);

  function send() {
    if (text.trim()) onSend(text);
  }

  return (
    <div ref={box} className="rv-changes">
      <textarea
        className="cv-reply"
        aria-label={placeholder}
        placeholder={placeholder}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- you picked it to write this
        autoFocus
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.repeat) return;
          if (e.key === "Escape") e.currentTarget.blur();
          else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="actions">
        <button
          type="button"
          className="act primary"
          title={`${label} on GitHub, as you (${MOD}\u21b5)`}
          disabled={!text.trim()}
          onClick={send}
        >
          {label}
        </button>
        <button type="button" className="act" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
