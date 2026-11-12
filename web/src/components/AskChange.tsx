import { Effect } from "effect";
import { useEffect, useRef, useState } from "react";
import { api, runUi } from "../api.ts";
import { MOD } from "../format.ts";

// Under an automation or a criterion: what you want changed, in your words, sent to your agent with what it needs to do it;
// the chat opens to follow it. ⌘↵ sends, Esc closes.
export function AskChange({
  ask,
  onSent,
  onClose,
  flash,
}: {
  ask: (words: string) => string;
  onSent: () => void;
  onClose: () => void;
  flash: (text: string, error?: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);

  function send() {
    if (!text.trim() || busy) return;
    setBusy(true);
    runUi(
      api.ask({ text: ask(text.trim()) }).pipe(
        Effect.match({
          onSuccess: () => {
            onSent();
            onClose();
          },
          onFailure: (e) => {
            flash(e.message, true);
          },
        }),
        Effect.ensuring(
          Effect.sync(() => {
            setBusy(false);
          }),
        ),
      ),
    );
  }

  return (
    <div className="ask-change">
      <textarea
        ref={box}
        className="input ask-change-text"
        aria-label="What should change"
        placeholder="What should change? Your agent does it and says what it changed."
        rows={2}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.repeat) {
            e.preventDefault();
            send();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <div className="actions">
        <button type="button" className="act primary" title={`Send to your agent (${MOD}↵)`} disabled={!text.trim() || busy} onClick={send}>
          {busy ? "Sending…" : "Ask your agent"}
        </button>
        <button type="button" className="act" title="Close (Esc)" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
