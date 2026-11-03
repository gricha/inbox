import { useEffect, useRef, useState } from "react";
import type { Ask, AsksView } from "../../../src/types.ts";
import { api, message } from "../api.ts";
import { age, shortId } from "../format.ts";

const SHOWN = 3; // a review shows your latest asks; the older ones are a click away

// A conversation in a PR's review, the one you were last on.
export interface Thread {
  item: string;
  id: string;
  url: string;
  label: string; // "dana's thread on src/auth.ts:42"
}

// What t opened the composer about: the review's PR (and its conversation), the selected row, or nothing.
export interface About {
  item: string | null;
  thread: Thread | null;
}

// A word with the coordinator, at the window's bottom: Enter sends, Esc closes; its answers land under what you sent.
export function Composer({ about, loads, now, onClose }: { about: About; loads: number; now: number; onClose: () => void }) {
  const [text, setText] = useState("");
  const [view, setView] = useState<AsksView | null>(null);
  const [sent, setSent] = useState<string[]>([]); // what you sent since it opened
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // Focus goes back where it was on close, so the keys act on the row or review again.
  useEffect(() => {
    const before = document.activeElement;
    input.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const v = await api.asks();
        if (live) setView(v);
      } catch {
        // the next update tries again
      }
    })();
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- loads changes on every server update; that's when to refetch
  }, [loads]);

  const off = view?.on === false;

  async function send() {
    const t = text.trim();
    if (!t || busy || off) return;
    setBusy(true);
    setError(null);
    try {
      const { ask } = await api.ask({
        text: t,
        item_id: about.item ?? undefined,
        thread_id: about.thread?.id,
        thread_url: about.thread?.url,
      });
      setSent((s) => [...s, ask.id]);
      setView((v) => v && { ...v, asks: [...v.asks, ask] });
      setText("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const mine = sent.flatMap((id) => view?.asks.filter((a) => a.id === id) ?? []);
  const what = [about.item && shortId(about.item), about.thread?.label].filter(Boolean);
  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a native <dialog> is modal or needs show(); this bar sits over the page
    <div className="composer" role="dialog" aria-label="Ask the coordinator">
      {mine.length > 0 && (
        <ol className="asks">
          {mine.map((a) => (
            <AskItem key={a.id} a={a} now={now} />
          ))}
        </ol>
      )}
      <p className="composer-about">
        To your coordinator
        {what.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </p>
      <div className="composer-row">
        <input
          ref={input}
          className="composer-input"
          aria-label="Your words to the coordinator"
          placeholder={off ? "The coordinator is off" : "Tell or ask it something"}
          value={text}
          disabled={off}
          onChange={(e) => {
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.repeat && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="button"
          className="act primary"
          disabled={!text.trim() || busy || off}
          onClick={() => {
            void send();
          }}
        >
          <kbd>↵</kbd>
          {busy ? "Sending…" : "Send"}
        </button>
        <button type="button" className="act" onClick={onClose}>
          <kbd>esc</kbd>
          Close
        </button>
      </div>
      {off && <p className="composer-note">The coordinator is off in Settings → Agents, so nothing is sent.</p>}
      {error && <p className="composer-note t-bad">{error}</p>}
    </div>
  );
}

// An item's asks in its review: the latest few, the older ones behind one line.
export function Asks({ asks, now }: { asks: Ask[]; now: number }) {
  const [all, setAll] = useState(false);
  if (!asks.length) return null;
  const more = asks.length - SHOWN;
  return (
    <section className="rv-asks" aria-label="Your asks to the coordinator">
      <h2 className="d-head">You asked the coordinator</h2>
      {more > 0 && (
        <button
          type="button"
          className="rv-more"
          aria-expanded={all}
          onClick={() => {
            setAll(!all);
          }}
        >
          {all ? "Fewer" : `${more} earlier`}
        </button>
      )}
      <ol className="asks">
        {(all ? asks : asks.slice(-SHOWN)).map((a) => (
          <AskItem key={a.id} a={a} now={now} />
        ))}
      </ol>
    </section>
  );
}

function AskItem({ a, now }: { a: Ask; now: number }) {
  return (
    <li className="ask">
      <p className="ask-q">
        {a.text} <span className="ask-age">{age(a.at, now)}</span>
      </p>
      {a.answer ? <p className="ask-a">{a.answer.text}</p> : <p className="ask-a quiet">Waiting for its answer</p>}
    </li>
  );
}
