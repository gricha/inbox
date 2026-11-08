import { Effect } from "effect";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AskLines, AsksView, CoordinatorView, Inquiry } from "../../../src/types.ts";
import { api, runUi } from "../api.ts";
import { shortId, sinceText } from "../format.ts";
import { linesLabel } from "../view.ts";
import { Prose } from "./Prose.tsx";

const kept = new Map<string, string>(); // what you'd typed to it, per item, in this window
let seen: AsksView | null = null; // the last asks fetched, so a reopen draws at once
const OFF = "Your agent is off in Settings \u2192 Claude, so nothing is sent.";

export interface Thread {
  kind: "thread";
  item: string;
  id: string;
  url: string;
  label: string; // "dana's thread on src/auth.ts:42"
}
interface Lines {
  kind: "lines";
  item: string;
  lines: AskLines;
  label: string; // "plan.ts:20-23", as linesLabel says it
}
export type Spot = Thread | Lines; // where in a PR's review you last were, for what Ask your agent asks about

// What Ask your agent opened the chat about: the review's PR (and the spot you were last on in it), the selected row, or nothing.
export interface About {
  item: string | null;
  spot: Spot | null;
}

// Your chat with the coordinator on the window's right: every ask about the item, oldest first, each with its answer.
export function Chat({
  about,
  review,
  questions,
  loads,
  now,
  onWiden,
  onClose,
}: {
  about: About;
  review: boolean; // about the open review's PR: its x widens to the whole PR, never to nothing
  questions: Inquiry[]; // your agent's open ones about the item
  loads: number;
  now: number;
  onWiden: () => void; // an x: one step wider
  onClose: () => void;
}) {
  const key = about.item ?? "";
  const [text, setText] = useState(() => kept.get(key) ?? "");
  const [view, setView] = useState(seen);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const log = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const stop = new AbortController();
    void runUi(
      api.asks().pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            seen = v;
            setView(v);
          }),
        ),
        Effect.ignore, // the next update tries again
      ),
      { signal: stop.signal },
    );
    return () => {
      stop.abort();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- loads changes on every server update; that's when to refetch
  }, [loads]);

  const off = view?.on === false;

  function send() {
    const t = text.trim();
    if (!t || busy || off) return;
    setBusy(true);
    setError(null);
    // Emptied now, so Esc closes at once and a chat reopened before the reply never offers the words again.
    kept.delete(key);
    setText("");
    const s = about.spot;
    void runUi(
      api
        .ask({
          text: t,
          item_id: about.item ?? undefined,
          ...(s?.kind === "thread" && { thread_id: s.id, thread_url: s.url }),
          ...(s?.kind === "lines" && { lines: s.lines }),
        })
        .pipe(
          Effect.match({
            onSuccess: ({ ask }) => {
              // An update can land first and bring the ask already.
              seen = seen && (seen.asks.some((x) => x.id === ask.id) ? seen : { ...seen, asks: [...seen.asks, ask] });
              setView(seen);
            },
            onFailure: (e) => {
              if (!kept.get(key)) kept.set(key, t);
              setText((cur) => cur || t);
              setError(e.message);
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

  const mine = (view?.asks ?? []).filter((a) => a.item_id === about.item);
  const answered = mine.filter((a) => a.answer).length;
  // The newest turn's top: your words and the answer's lead, not the end of a long answer.
  useLayoutEffect(() => {
    const l = log.current;
    const last = l?.lastElementChild;
    if (l && last instanceof HTMLElement) l.scrollTop = last.offsetTop - 16;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a new turn or a new answer is when to scroll
  }, [mine.length, answered]);

  return (
    <aside className="chat" aria-label="Your chat with your agent">
      <div className="chat-head">
        <h2 className="chat-title">Your agent</h2>
        <p className="chat-about" title={about.item ?? undefined}>
          {about.item && shortId(about.item)}
        </p>
        {about.item && !review && (
          <button
            type="button"
            className="chat-drop"
            aria-label="Ask about nothing in particular"
            title="Ask about nothing in particular"
            onClick={() => {
              // The chat is drawn again for no item: what you'd typed goes with you.
              if (text) kept.set("", text);
              kept.delete(key);
              onWiden();
            }}
          >
            {"\u00d7"}
          </button>
        )}
        <button type="button" className="act" title="Close (Esc)" onClick={onClose}>
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
                {a.lines && (
                  <>
                    {" \u00b7 "}
                    <span title={`${a.lines.path} at ${a.lines.head.slice(0, 7)}`}>on {linesLabel(a.lines)}</span>
                  </>
                )}
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
      ) : off ? (
        <p className="chat-empty">{OFF}</p>
      ) : (
        view && (
          <p className="chat-empty">
            {about.item
              ? `Ask or tell it something about ${shortId(about.item)}: it answers here.`
              : "Ask or tell it something: it answers here."}
          </p>
        )
      )}
      <div className="chat-box">
        {questions.map((q) => (
          <p key={q.id} className="chat-hint chat-q">
            <span title={q.question}>Your agent asks: {q.question}</span>
            {" \u00b7 "}
            <a href={`#/inquiry/${q.id}`}>Answer</a>
          </p>
        ))}
        {about.spot && (
          <p className="chat-hint chat-on">
            <span
              title={about.spot.kind === "thread" ? about.spot.label : `${about.spot.lines.path} at ${about.spot.lines.head.slice(0, 7)}`}
            >
              On {about.spot.label}
            </span>
            <button
              type="button"
              className="chat-drop"
              aria-label="Ask about the whole PR instead"
              title="Ask about the whole PR instead"
              onClick={onWiden}
            >
              {"\u00d7"}
            </button>
          </p>
        )}
        <textarea
          className="chat-input"
          rows={2}
          aria-label="Your words to your agent"
          placeholder={off ? "Your agent is off" : "Ask or tell it something"}
          value={text}
          disabled={off}
          onChange={(e) => {
            setText(e.target.value);
            kept.set(key, e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.repeat && !e.nativeEvent.isComposing) {
              e.preventDefault(); // Cmd+Enter sends too, as every other box in the desk does
              send();
            } else if (e.key === "Escape" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (text.trim()) e.currentTarget.blur();
              else onClose();
            }
          }}
        />
        {off ? (
          mine.length > 0 && <p className="chat-note">{OFF}</p>
        ) : (
          <div className="chat-send">
            <button
              type="button"
              className="act primary"
              title="Send (Enter; Shift+Enter for a new line)"
              disabled={!text.trim() || busy}
              onClick={() => {
                send();
              }}
            >
              {busy ? "Sending\u2026" : "Send"}
            </button>
          </div>
        )}
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
          void runUi(
            api.wakeCoordinator(ask).pipe(
              Effect.match({
                onSuccess: () => {
                  setWoke("Asked it again");
                },
                onFailure: (e) => {
                  setWoke(e.message);
                },
              }),
            ),
          );
        }}
      >
        Wake it
      </button>{" "}
      {watch}
    </p>
  );
}
