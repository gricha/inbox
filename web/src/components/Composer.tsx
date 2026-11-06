import { useEffect, useRef, useState } from "react";
import type { Ask, AsksView, CoordinatorView } from "../../../src/types.ts";
import { api, message } from "../api.ts";
import { age, shortId } from "../format.ts";

const SHOWN = 3; // your latest asks about what the composer is on

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
      setView((v) => v && { ...v, asks: [...v.asks, ask] });
      setText("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  // Your latest about the same item (or about nothing), so an answer is still here after a close.
  const mine = (view?.asks ?? []).filter((a) => a.item_id === about.item).slice(-SHOWN);
  const what = [about.item && shortId(about.item), about.thread?.label].filter(Boolean);
  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a native <dialog> is modal or needs show(); this bar sits over the page
    <div className="composer" role="dialog" aria-label="Ask the coordinator">
      {mine.length > 0 && (
        <ol className="asks">
          {mine.map((a) => (
            <AskItem key={a.id} a={a} now={now} live={view?.coordinator} />
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

function AskItem({ a, now, live }: { a: Ask; now: number; live?: CoordinatorView | undefined }) {
  return (
    <li className="ask">
      <p className="ask-q">
        {a.text} <span className="ask-age">{age(a.at, now)}</span>
      </p>
      {a.answer ? <p className="ask-a">{a.answer.text}</p> : <Waiting key={live?.status ?? "none"} ask={a.id} live={live} />}
    </li>
  );
}

// What the coordinator is doing about an ask it hasn't answered: on it, queued behind what it's on, stuck on a permission,
// or stopped without answering, with a way to see it or wake it.
function Waiting({ ask, live }: { ask: string; live?: CoordinatorView | undefined }) {
  const [woke, setWoke] = useState<string | null>(null);
  const watch = live?.url && (
    <a href={live.url} target="_blank" rel="noreferrer">
      Watch it on claude.ai
    </a>
  );
  if (!live) return <p className="ask-a quiet">Waiting for its answer</p>;
  if (live.error) return <p className="ask-a quiet t-bad">It can't run: {live.error}</p>;
  if (live.status === "waiting")
    return (
      <p className="ask-a quiet ask-live">
        Waiting on a permission prompt{" "}
        {live.url && (
          <a href={live.url} target="_blank" rel="noreferrer">
            Answer it on claude.ai
          </a>
        )}
      </p>
    );
  if (live.queued.includes(ask))
    return (
      <p className="ask-a quiet ask-live">
        <span className="busy" aria-hidden="true" />
        Queued: it gets this when it's done with what it's on {watch}
      </p>
    );
  if (live.status === "busy" || live.status === "shell")
    return (
      <p className="ask-a quiet ask-live">
        <span className="busy" aria-hidden="true" />
        On it {watch}
      </p>
    );
  return (
    <p className="ask-a quiet ask-live">
      {woke ?? "It stopped without answering"}{" "}
      <button
        type="button"
        className="act ask-wake"
        onClick={() => {
          void (async () => {
            try {
              await api.wakeCoordinator(ask);
              setWoke("Asked it again");
            } catch (e) {
              setWoke(message(e));
            }
          })();
        }}
      >
        Wake it
      </button>{" "}
      {watch}
    </p>
  );
}
