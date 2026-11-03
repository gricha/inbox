import { useEffect, useRef, useState } from "react";
import type { Card, GitHubAction } from "../../../src/types.ts";
import { api, message } from "../api.ts";
import { cls, shortRef } from "../format.ts";

const ARM_MS = 3000;
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

// The More menu's keys, read only while it's open. Each write takes a second press, so a slipped d (Done) writes nothing;
// x only opens the box to write in. `verb`: what the second press does to % (the item).
const MORE: Record<GitHubAction, { key: string; label: string; verb?: string }> = {
  close: { key: "c", label: "Close", verb: "close %" },
  draft: { key: "d", label: "Convert to draft", verb: "convert % to a draft" },
  merge: { key: "m", label: "Merge now", verb: "merge % now" },
  reopen: { key: "r", label: "Reopen", verb: "reopen %" },
  request_changes: { key: "x", label: "Request changes" },
};

// A row has no room to write in: requesting changes is in the PR's review.
export const rowActions = (c: Card) => (c.actions ?? []).filter((a) => a !== "request_changes");

// The quiet button that opens it, with its key.
export function MoreButton({ className, onClick }: { className?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cls("act", className)}
      title="More on GitHub: close, convert to draft, merge now, …"
      aria-label="More on GitHub"
      onClick={onClick}
    >
      <kbd className="dot-key">.</kbd>…
    </button>
  );
}

// While open it has the keyboard, as the snooze menu does: its keys act, Esc or . closes it, anything else does nothing.
export function MoreMenu({
  card,
  actions,
  pick,
  onClose,
  flash,
  className,
}: {
  card: Card;
  actions: GitHubAction[];
  pick: (a: GitHubAction) => void;
  onClose: () => void;
  flash: (text: string) => void;
  className?: string;
}) {
  const [armed, setArmed] = useState<GitHubAction | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.scrollIntoView({ block: "nearest" });
  }, []);
  useEffect(() => {
    const t = armed
      ? setTimeout(() => {
          setArmed(null);
        }, ARM_MS)
      : undefined;
    return () => {
      clearTimeout(t);
    };
  }, [armed]);

  function choose(a: GitHubAction) {
    const m = MORE[a];
    if (m.verb && armed !== a) {
      setArmed(a);
      flash(`Press ${m.key} again to ${m.verb.replace("%", shortRef(card))} on GitHub`);
      return;
    }
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
    else if (e.key === "Escape" && armed) setArmed(null);
    else if (e.key === "Escape" || e.key === ".") onClose();
    else setArmed(null);
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
            className={cls("pop-item", armed === a && "armed")}
            onClick={() => {
              choose(a);
            }}
          >
            <kbd>{MORE[a].key}</kbd>
            <span>
              {armed === a
                ? `again to ${MORE[a].verb!.replace(" %", "")}`
                : a === "close" && card.kind === "issue"
                  ? "Close issue"
                  : MORE[a].label}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

// Request changes, in a PR's review: what you write is the review's body, sent with the button (or ⌘↵) twice.
export function RequestChanges({
  card,
  head,
  flash,
  onClose,
}: {
  card: Card;
  head: string;
  flash: (text: string, error?: boolean, ms?: number) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = armed
      ? setTimeout(() => {
          setArmed(false);
        }, ARM_MS)
      : undefined;
    return () => {
      clearTimeout(t);
    };
  }, [armed]);

  async function send() {
    if (!text.trim() || busy) return;
    if (!armed) {
      setArmed(true);
      flash(`Press Request changes again to post it on ${shortRef(card)}`, false, ARM_MS);
      return;
    }
    setArmed(false);
    setBusy(true);
    try {
      await api.github(card.id, "request_changes", { head_oid: head, body: text });
      flash(`Requested changes on GitHub: ${shortRef(card)}`);
      onClose();
    } catch (e) {
      flash(message(e), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rv-changes">
      <textarea
        className="cv-reply"
        aria-label="What needs to change"
        placeholder="What needs to change"
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- you picked Request changes to write this
        autoFocus
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setArmed(false);
        }}
        onKeyDown={(e) => {
          if (e.repeat) return;
          if (e.key === "Escape") e.currentTarget.blur();
          else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="actions">
        <button
          type="button"
          className={cls("act primary", armed && "armed")}
          title={`Request changes on GitHub, as you: press it twice, or ${MOD}↵ twice`}
          disabled={!text.trim() || busy}
          onClick={() => {
            void send();
          }}
        >
          <kbd>{MOD}↵</kbd>
          {busy ? "Requesting…" : armed ? "again to request" : "Request changes"}
        </button>
        <button type="button" className="act" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
