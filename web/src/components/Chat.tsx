import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AsksView, CoordinatorView } from "../../../src/types.ts";
import { api, message } from "../api.ts";
import { shortId, sinceText } from "../format.ts";
import { Prose } from "./Prose.tsx";

const kept = new Map<string, string>(); // what you'd typed to it, per item, in this window
let seen: AsksView | null = null; // the last asks fetched, so a reopen draws at once

// A conversation in a PR's review, the one you were last on.
export interface Thread {
  item: string;
  id: string;
  url: string;
  label: string; // "dana's thread on src/auth.ts:42"
}

// What t opened the chat about: the review's PR (and its conversation), the selected row, or nothing.
export interface About {
  item: string | null;
  thread: Thread | null;
}

// Your chat with the coordinator on the window's right: every ask about the item, oldest first, each with its answer.
export function Chat({
  about,
  loads,
  now,
  inert,
  onClose,
}: {
  about: About;
  loads: number;
  now: number;
  inert: boolean;
  onClose: () => void;
}) {
  const key = about.item ?? "";
  const [text, setText] = useState(() => kept.get(key) ?? "");
  const [view, setView] = useState(seen);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const log = useRef<HTMLOListElement>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const v = await api.asks();
        if (!live) return;
        seen = v;
        setView(v);
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
    // Emptied now, so Esc closes at once and a chat reopened before the reply never offers the words again.
    kept.delete(key);
    setText("");
    try {
      const { ask } = await api.ask({
        text: t,
        item_id: about.item ?? undefined,
        thread_id: about.thread?.id,
        thread_url: about.thread?.url,
      });
      seen = seen && { ...seen, asks: [...seen.asks, ask] };
      setView(seen);
    } catch (e) {
      if (!kept.get(key)) kept.set(key, t);
      setText((cur) => cur || t);
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const mine = (view?.asks ?? []).filter((a) => a.item_id === about.item);
  const answered = mine.filter((a) => a.answer).length;
  // The newest turn's top: your words and the answer's lead, not the end of a long answer.
  useLayoutEffect(() => {
    const l = log.current;
    const last = l?.lastElementChild;
    if (l && last instanceof HTMLElement) l.scrollTop = last.offsetTop - 16;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a new turn or a new answer is when to scroll
  }, [mine.length, answered]);

  const what = [about.item && shortId(about.item), about.thread?.label].filter((w): w is string => !!w);
  return (
    <aside className="chat" aria-label="Your chat with the coordinator" inert={inert}>
      <div className="chat-head">
        <h2 className="chat-title">Coordinator</h2>
        <p className="chat-about" title={what.join(" \u00b7 ")}>
          {what.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </p>
        <button type="button" className="act" onClick={onClose}>
          <kbd>esc</kbd>
          Close
        </button>
      </div>
      {mine.length ? (
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling log must be reachable by keyboard: Shift+Tab from the box, then arrows
        <ol ref={log} className="chat-log" tabIndex={0} aria-label="Your asks and its answers">
          {mine.map((a, i) => (
            <li key={a.id} className="chat-turn">
              <p className="chat-you">{a.text}</p>
              <p className="chat-meta mine">
                {sinceText(a.at, now)}
                {a.thread_url && (
                  <>
                    {" \u00b7 "}
                    <a href={a.thread_url} target="_blank" rel="noreferrer">
                      on a thread
                    </a>
                  </>
                )}
              </p>
              {a.answer ? (
                <>
                  <Prose text={a.answer.text} />
                  <p className="chat-meta">{sinceText(a.answer.at, now)}</p>
                </>
              ) : (
                i === mine.length - 1 && <Waiting key={view?.coordinator?.status ?? "none"} ask={a.id} live={view?.coordinator} />
              )}
            </li>
          ))}
        </ol>
      ) : (
        view &&
        !off && (
          <p className="chat-empty">
            {about.item
              ? `Ask or tell it something about ${shortId(about.item)}: it answers here.`
              : "Ask or tell it something: it answers here."}
          </p>
        )
      )}
      <div className="chat-box">
        <textarea
          className="chat-input"
          rows={2}
          aria-label="Your words to the coordinator"
          placeholder={off ? "The coordinator is off" : "Ask or tell it something"}
          value={text}
          disabled={off}
          onChange={(e) => {
            setText(e.target.value);
            kept.set(key, e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.repeat && !e.nativeEvent.isComposing) {
              e.preventDefault(); // Cmd+Enter sends too, as every other box in the desk does
              void send();
            } else if (e.key === "Escape" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (text.trim()) e.currentTarget.blur();
              else onClose();
            }
          }}
        />
        <div className="chat-send">
          <span className="chat-hint">{"\u21e7\u21b5 new line"}</span>
          <button
            type="button"
            className="act primary"
            disabled={!text.trim() || busy || off}
            onClick={() => {
              void send();
            }}
          >
            <kbd>{"\u21b5"}</kbd>
            {busy ? "Sending\u2026" : "Send"}
          </button>
        </div>
        {off && <p className="chat-note">{"The coordinator is off in Settings \u2192 Agents, so nothing is sent."}</p>}
        {error && <p className="chat-note t-bad">{error}</p>}
      </div>
    </aside>
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
  if (!live) return <p className="chat-wait">Waiting for its answer</p>;
  if (live.error) return <p className="chat-wait t-bad">It can't run: {live.error}</p>;
  if (live.status === "waiting")
    return (
      <p className="chat-wait">
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
      <p className="chat-wait">
        <span className="busy" aria-hidden="true" />
        Queued: it gets this when it's done with what it's on {watch}
      </p>
    );
  if (live.status === "busy" || live.status === "shell")
    return (
      <p className="chat-wait">
        <span className="busy" aria-hidden="true" />
        On it {watch}
      </p>
    );
  return (
    <p className="chat-wait">
      {woke ?? "It stopped without answering"}{" "}
      <button
        type="button"
        className="act"
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
