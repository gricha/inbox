import { useEffect, useRef, useState } from "react";
import type { Card, GitHubAction } from "../../../src/types.ts";
import { cls } from "../format.ts";

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

// The More menu's keys, read only while it's open (. first, so a slipped key on the page writes nothing). One press does
// it; u undoes a close or a draft. x only opens the box to write in.
const MORE: Record<GitHubAction, { key: string; label: string }> = {
  close: { key: "c", label: "Close" },
  draft: { key: "d", label: "Convert to draft" },
  merge: { key: "m", label: "Merge now" },
  reopen: { key: "r", label: "Reopen" },
  request_changes: { key: "x", label: "Request changes" },
};

// A row has no room to write in: requesting changes is in the PR's review.
export const rowActions = (c: Card) => (c.actions ?? []).filter((a) => a !== "request_changes");

// The quiet button that opens it, with its key; a row below 1000px says "…", so selecting it never cuts its title shorter.
export function MoreButton({ className, open, onClick }: { className?: string; open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cls("act", className)}
      title="More on GitHub: close, convert to draft, merge now, …"
      aria-label="More on GitHub"
      aria-expanded={open}
      onClick={onClick}
    >
      <kbd className="dot-key">.</kbd>
      <span className="more-word">More</span>
      <span className="more-dots">…</span>
    </button>
  );
}

// While open it has the keyboard, as the snooze menu does: its keys act, Esc or . closes it, anything else does nothing.
export function MoreMenu({
  card,
  actions,
  pick,
  onClose,
  className,
}: {
  card: Card;
  actions: GitHubAction[];
  pick: (a: GitHubAction) => void;
  onClose: () => void;
  className?: string;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.scrollIntoView({ block: "nearest" });
  }, []);

  function choose(a: GitHubAction) {
    onClose();
    pick(a);
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || ["Shift", "Meta", "Control", "Alt"].includes(e.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    const a = actions.find((x) => MORE[x].key === e.key);
    if (a) choose(a);
    else if (e.key === "Escape" || e.key === ".") onClose();
  };
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  // Capture phase, so the page's own keys (r sync, u undo, Esc back) never see what the menu took.
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
      <div ref={menu} className={cls("popover more-pop", className)} role="menu" aria-label="More">
        <div className="pop-title">On GitHub</div>
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
            <kbd>{MORE[a].key}</kbd>
            <span>{a === "close" && card.kind === "issue" ? "Close issue" : MORE[a].label}</span>
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
          title={`${label} on GitHub, as you: the button or ${MOD}↵`}
          disabled={!text.trim()}
          onClick={send}
        >
          <kbd>{MOD}↵</kbd>
          {label}
        </button>
        <button type="button" className="act" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
