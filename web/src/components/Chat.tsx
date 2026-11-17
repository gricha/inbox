import { Effect } from "effect";
import { useEffect, useRef, useState } from "react";
import { Splitter, type Width } from "./Splitter.tsx";
import type { AgentOptions, AskLines, AsksView, CoordinatorView, Inquiry, SetupAgent } from "../../../src/types.ts";
import { api, runUi } from "../api.ts";
import { useKeyed, useKeyedLayout } from "../keyed.ts";
import { cls, copyText, shortId, sinceText } from "../format.ts";
import { linesLabel } from "../view.ts";
import { Prose } from "./Prose.tsx";

const kept = new Map<string, string>(); // what you'd typed to it, per item, in this window
let seen: AsksView | null = null; // the last asks fetched, so a reopen draws at once
const OFF = "Your agent is off in Settings → Agent, so nothing is sent.";

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

// Your chat with the coordinator on the window's right: one conversation, every ask oldest first, each with what it was about and its answer.
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
  const [tall, setTall] = useState(false); // the box over the log, to write at length
  const [starting, setStarting] = useState(false); // a new chat, on its way
  const [setup, setSetup] = useState<SetupAgent | null>(null); // the agent picked for a new chat, not installed or logged in
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLOListElement>(null);
  const aside = useRef<HTMLElement>(null);

  useKeyed(loads, (signal) => {
    runUi(
      api.asks().pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            seen = v;
            setView(v);
          }),
        ),
        Effect.ignore, // the next update tries again
      ),
      { signal },
    );
  });

  const off = view?.on === false;

  function send() {
    const t = text.trim();
    if (!t || busy || off) return;
    setBusy(true);
    setError(null);
    // Emptied now, so Esc closes at once and a chat reopened before the reply never offers the words again.
    kept.delete(key);
    setText("");
    setTall(false);
    const s = about.spot;
    runUi(
      api
        .ask({
          text: t,
          ...(about.item !== null && { item_id: about.item }),
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

  // New chat, about the same thing: with your agent, or with another one once it's installed and logged in (`again` asks afresh).
  function fresh(agent?: AgentId, again = false) {
    if (starting || off || !view) return;
    setStarting(true);
    setError(null);
    type Got = { view: AsksView } | { wants: SetupAgent };
    const start = Effect.map(api.newChat(agent), (v): Got => ({ view: v }));
    const ready =
      agent && agent !== view.options.agent
        ? Effect.flatMap(again ? api.checkSetup() : api.setup(), (s) => {
            const a = s.agents.find((x) => x.id === agent);
            return a?.fix ? Effect.succeed<Got>({ wants: a }) : start;
          })
        : start;
    runUi(
      ready.pipe(
        Effect.match({
          onSuccess: (r) => {
            if ("wants" in r) {
              setSetup(r.wants);
              return;
            }
            seen = r.view;
            setView(r.view);
            setSetup(null);
            setTall(false);
            input.current?.focus();
          },
          onFailure: (e) => {
            setError(e.message);
          },
        }),
        Effect.ensuring(
          Effect.sync(() => {
            setStarting(false);
          }),
        ),
      ),
    );
  }

  const mine = view?.asks ?? [];
  const answered = mine.filter((a) => a.answer).length;
  const saying = view?.coordinator.saying ?? "";
  // The newest turn's top: your words and the answer's lead, not the end of a long answer.
  useKeyedLayout(`${mine.length} ${answered} ${tall}`, () => {
    const l = log.current;
    const last = l?.lastElementChild;
    if (l && last instanceof HTMLElement) l.scrollTop = last.offsetTop - 16;
  });
  // While it writes, its newest words stay in view, unless you've scrolled up to read.
  const near = useRef(true);
  useKeyedLayout(saying, () => {
    const l = log.current;
    if (l && near.current) l.scrollTop = l.scrollHeight;
  });
  const empty = mine.length === 0;
  const fill = empty || tall; // the box takes the pane: you write at its top, its controls at the foot

  return (
    <aside ref={aside} className="chat" aria-label="Your chat with your agent">
      <Splitter width={CHAT} edge="left" column={() => aside.current} label="the chat" />
      <div className="chat-head">
        <h2 className="chat-title">
          {view ? (
            <>
              <AgentMark agent={view.options.agent} />
              {AGENT[view.options.agent].name}
            </>
          ) : (
            "Your agent"
          )}
        </h2>
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
        {view && !off && (
          <NewChat
            agent={view.options.agent}
            busy={starting}
            onNew={(agent) => {
              fresh(agent);
            }}
          />
        )}
        <button type="button" className="chat-close" aria-label="Close the chat" data-tip="Close the chat (Esc)" onClick={onClose}>
          <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.5 3.5h11v9h-11zM10 3.5v9" />
          </svg>
        </button>
      </div>
      {setup && (
        <NotReady
          agent={setup}
          back={view ? AGENT[view.options.agent].name : "your agent"}
          busy={starting}
          error={error}
          onCheck={() => {
            fresh(setup.id, true);
          }}
          onBack={() => {
            setError(null);
            setSetup(null);
          }}
        />
      )}
      {!setup && !fill && (
        <ol
          ref={log}
          className="chat-log"
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling log must be reachable by keyboard: Shift+Tab from the box, then arrows
          tabIndex={0}
          aria-label="Your asks and its answers"
          onScroll={(e) => {
            const l = e.currentTarget;
            near.current = l.scrollHeight - l.scrollTop - l.clientHeight < 80;
          }}
        >
          {mine.map((a, i) => (
            <li key={a.id} className="chat-turn">
              <p className="chat-you">{a.text}</p>
              <p className="chat-meta mine">
                {sinceText(a.at, now)}
                {a.item_id && (
                  <>
                    {" \u00b7 "}
                    <a href={`#/review/${encodeURIComponent(a.item_id)}`} title={a.item_id}>
                      {shortId(a.item_id)}
                    </a>
                  </>
                )}
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
                  <p className="chat-meta chat-foot">
                    <span>{sinceText(a.answer.at, now)}</span>
                    <AnswerTools text={a.answer.text} log={log} />
                  </p>
                </>
              ) : (
                i === mine.length - 1 && (
                  <>
                    {/* What it's said so far, a message at a time, until its answer takes its place. */}
                    {saying && (
                      <div className="chat-saying" aria-live="polite">
                        <Prose text={saying} />
                      </div>
                    )}
                    <Waiting key={view?.coordinator?.status ?? "none"} ask={a.id} live={view?.coordinator} quiet={!!saying} />
                  </>
                )
              )}
            </li>
          ))}
        </ol>
      )}
      <div className={cls("chat-box", fill && "fill")} hidden={!!setup}>
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
        <div className="chat-field">
          {!empty && (
            <button
              type="button"
              className="chat-tall"
              aria-pressed={tall}
              aria-label={tall ? "Shrink the box" : "Expand the box"}
              data-tip={tall ? "Shrink the box, back to the conversation" : "Expand the box, to write at length"}
              onClick={() => {
                setTall(!tall);
              }}
            >
              <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
                {tall ? (
                  <path d="M13.5 2.5 9.5 6.5M9.5 3.5v3h3M2.5 13.5l4-4M6.5 12.5v-3h-3" />
                ) : (
                  <path d="M9.5 6.5l4-4M10.5 2.5h3v3M6.5 9.5l-4 4M5.5 13.5h-3v-3" />
                )}
              </svg>
            </button>
          )}
          <textarea
            ref={input}
            className="chat-input"
            rows={2}
            aria-label="Your words to your agent"
            placeholder={
              off ? "Your agent is off" : about.item ? `Ask or tell it something about ${shortId(about.item)}` : "Ask or tell it something"
            }
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
        </div>
        {empty && !text && !off && (
          <Examples
            item={about.item !== null}
            onPick={(t) => {
              setText(t);
              kept.set(key, t);
              input.current?.focus();
            }}
          />
        )}
        {error && <p className="chat-note t-bad">{error}</p>}
        {off ? (
          <p className="chat-note">{OFF}</p>
        ) : (
          <div className="chat-send">
            {view && <Options options={view.options} />}
            <button
              type="button"
              className="chat-go"
              aria-label={busy ? "Sending" : "Send"}
              data-tip="Send (Enter; Shift+Enter for a new line)"
              disabled={!text.trim() || busy}
              onClick={() => {
                send();
              }}
            >
              {busy ? (
                <span className="busy" aria-hidden="true" />
              ) : (
                <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M14 2 7.25 8.75M14 2 9.75 14l-2.5-5.25L2 6.25z" />
                </svg>
              )}
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

// What the coordinator is doing about an ask it hasn't answered: on it, queued behind what it's on, stuck on a permission,
// or stopped without answering, with a way to see it or wake it.
function Waiting({ ask, live, quiet }: { ask: string; live?: CoordinatorView | undefined; quiet?: boolean }) {
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
  // Its latest step in place of "On it", each new one swapping in for the last, as Claude Code's spinner line does.
  // Its words are on screen above: the step line says only a tool it's using, never the same words again.
  const now = live.activity.at(-1);
  if (
    (live.status === "busy" || live.status === "shell") &&
    now &&
    !(quiet && live.saying.replaceAll(/\s+/g, " ").includes(now.replace(/…$/, "")))
  )
    return (
      <p className="chat-wait chat-step" aria-live="polite">
        <span className="busy" aria-hidden="true" />
        <span key={now} className="chat-step-text">
          {now}
        </span>{" "}
        {watch}
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
          runUi(
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

// An answer's tools, at its foot: copy it, go back to what you asked, go to the conversation's top.
function AnswerTools({ text, log }: { text: string; log: React.RefObject<HTMLOListElement | null> }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="chat-tools">
      <button
        type="button"
        className="chat-tool"
        aria-label="Copy this answer"
        data-tip={copied ? "Copied" : "Copy this answer"}
        onClick={() => {
          runUi(
            copyText(text).pipe(
              Effect.match({
                onSuccess: () => {
                  setCopied(true);
                  window.setTimeout(() => {
                    setCopied(false);
                  }, 1500);
                },
                onFailure: () => {
                  setCopied(false);
                },
              }),
            ),
          );
        }}
      >
        <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
          {copied ? (
            <path d="M3.5 8.5l3 3 6-7" />
          ) : (
            <path d="M5.5 5.5v-2a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M3.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" />
          )}
        </svg>
      </button>
      <button
        type="button"
        className="chat-tool"
        aria-label="Go to what you asked"
        data-tip="Go to what you asked"
        onClick={(e) => {
          e.currentTarget.closest(".chat-turn")?.scrollIntoView({ block: "start", behavior: "smooth" });
        }}
      >
        <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="6" cy="5" r="2.25" />
          <path d="M2 13c.4-2.4 2-3.75 4-3.75 1 0 1.9.3 2.6.9M12 13.5v-6M9.75 9.75 12 7.5l2.25 2.25" />
        </svg>
      </button>
      <button
        type="button"
        className="chat-tool"
        aria-label="Go to the top of the conversation"
        data-tip="Go to the top of the conversation"
        onClick={() => {
          log.current?.scrollTo({ top: 0, behavior: "smooth" });
        }}
      >
        <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 13.5v-10M3.75 7.5 8 3.25l4.25 4.25" />
        </svg>
      </button>
    </span>
  );
}

// What each agent's own command takes, as the chat offers it: how freely it runs, in its words, and its levels of effort.
const AGENT = {
  "claude-code": {
    name: "Claude Code",
    run: ["Ask first", "Bypass permissions"],
    models: ["fable", "opus", "sonnet", "haiku"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  codex: { name: "Codex", run: ["Workspace only", "Full access"], models: [], efforts: ["low", "medium", "high", "xhigh"] },
  opencode: { name: "OpenCode", run: ["Refuse what asks", "Approve what asks"], models: [], efforts: [] },
} as const;

type AgentId = AgentOptions["agent"];
const AGENTS: AgentId[] = ["claude-code", "codex", "opencode"];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// The agent's own mark, from Lobe Icons (lobehub/lobe-icons, MIT), drawn in the words' colour.
const MARK = {
  "claude-code":
    "M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z",
  codex:
    "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z",
  opencode: "M16 6H8v12h8V6zm4 16H4V2h16v20z",
};
function AgentMark({ agent }: { agent: AgentId }) {
  return (
    <svg className="chat-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fillRule="evenodd" clipRule="evenodd" d={MARK[agent]} />
    </svg>
  );
}

// Esc closes an open menu in the capture phase, so the chat's own Esc never sees the one the menu took.
function useEscCloses(open: boolean, close: () => void) {
  const now = useRef({ open, close });
  now.current = { open, close };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !now.current.open) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      now.current.close();
    };
    window.addEventListener("keydown", h, { capture: true });
    return () => {
      window.removeEventListener("keydown", h, { capture: true });
    };
  }, []);
}

// New chat, in the head: the plus starts one with your agent, the arrow beside it picks which agent it's with.
function NewChat({ agent, busy, onNew }: { agent: AgentId; busy: boolean; onNew: (agent?: AgentId) => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEscCloses(open, close);
  const name = AGENT[agent].name;
  return (
    <span className="chat-split">
      <button
        type="button"
        className="chat-new"
        aria-label={`New chat with ${name}`}
        data-tip={`New chat with ${name}, about the same thing`}
        disabled={busy}
        onClick={() => {
          onNew();
        }}
      >
        {busy ? (
          <span className="busy" aria-hidden="true" />
        ) : (
          <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3.5v9M3.5 8h9" />
          </svg>
        )}
      </button>
      <button
        ref={trigger}
        type="button"
        className="chat-new-with"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="New chat with another agent"
        data-tip={open ? undefined : "New chat with another agent"}
        disabled={busy}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <svg className="i chat-chev" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.5 6.5 8 10l3.5-3.5" />
        </svg>
      </button>
      {open && (
        <>
          <div className="scrim-clear" role="presentation" onClick={close} />
          <div className="popover chat-new-pop" role="menu" aria-label="New chat with">
            <p className="chat-new-head">New chat with</p>
            {AGENTS.map((id) => (
              <button
                key={id}
                type="button"
                role="menuitem"
                className="pop-item"
                onClick={() => {
                  close();
                  onNew(id);
                }}
              >
                <AgentMark agent={id} />
                {AGENT[id].name}
                {id === agent && <span className="chat-new-yours">Your agent</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

// The agent picked for a new chat isn't installed or logged in: what to run, its own page, and a way on or back.
function NotReady({
  agent,
  back,
  busy,
  error,
  onCheck,
  onBack,
}: {
  agent: SetupAgent;
  back: string;
  busy: boolean;
  error: string | null;
  onCheck: () => void;
  onBack: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const fix = agent.fix ?? "";
  return (
    <div className="chat-setup">
      <h3 className="chat-setup-title">
        <AgentMark agent={agent.id} />
        {agent.name} {agent.installed ? "isn't logged in" : "isn't installed"}
      </h3>
      <p className="chat-setup-step">{agent.installed ? "Log in to it in a terminal:" : "Install it and log in, in a terminal:"}</p>
      <pre className="chat-setup-run">
        <code>{fix}</code>
      </pre>
      <p className="chat-setup-step">
        <button
          type="button"
          className="act"
          onClick={() => {
            runUi(
              copyText(fix).pipe(
                Effect.match({
                  onSuccess: () => {
                    setCopied(true);
                    window.setTimeout(() => {
                      setCopied(false);
                    }, 1500);
                  },
                  onFailure: () => {
                    setCopied(false);
                  },
                }),
              ),
            );
          }}
        >
          {copied ? "Copied" : "Copy the command"}
        </button>{" "}
        <a href={agent.url} target="_blank" rel="noreferrer">
          {agent.installed ? `${agent.name}'s own page` : `How to install ${agent.name}`}
        </a>
      </p>
      <p className="chat-setup-step">Then check again: your new chat opens with it, and it becomes your agent.</p>
      {error && <p className="chat-note t-bad">{error}</p>}
      <p className="chat-setup-acts">
        <button type="button" className="act primary" disabled={busy} onClick={onCheck}>
          {busy ? "Checking…" : "Check again"}
        </button>
        <button type="button" className="act" onClick={onBack}>
          Back to {back}
        </button>
      </p>
    </div>
  );
}

// A fresh chat's examples, in the pane's middle until you type: two things to ask and two rules to have it add. A click puts one in the box.
const EXAMPLES = {
  desk: [
    "What should I look at first?",
    "What's keeping my PRs from merging?",
    "Add a rule: PRs labelled security are urgent",
    "Add a rule: a bot's PR goes to FYI unless its CI fails",
  ],
  item: [
    "Summarize this for me",
    "What's the riskiest part of this?",
    "Why is this on my Inbox?",
    "Add a rule so ones like this go to FYI",
  ],
};
function Examples({ item, onPick }: { item: boolean; onPick: (text: string) => void }) {
  return (
    <ul className="chat-examples" aria-label="Examples">
      {EXAMPLES[item ? "item" : "desk"].map((t) => (
        <li key={t}>
          <button
            type="button"
            className="chat-example"
            onClick={() => {
              onPick(t);
            }}
          >
            {t}
          </button>
        </li>
      ))}
    </ul>
  );
}

// One of the box's choices: its words open a menu over it, the one in force ticked; Esc or a click away closes it. `free`
// adds a field to type a value the menu doesn't list (a model, as the agent's own command takes it).
function Pick({
  label,
  tip,
  value,
  said,
  choices,
  free,
  onPick,
}: {
  label: string;
  tip: string;
  value: string;
  said: string; // what's in force, as its trigger says it
  choices: { value: string; label: string }[];
  free?: string;
  onPick: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [end, setEnd] = useState(false); // near the chat's right edge: the menu opens leftward
  const [typed, setTyped] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEscCloses(open, close);
  const pick = (v: string) => {
    if (v !== value) onPick(v);
    close();
  };
  return (
    <span className="chat-pick">
      <button
        ref={trigger}
        type="button"
        className="chat-opt"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${said}`}
        // No tip while its menu is open: the menu says it.
        data-tip={open ? undefined : tip}
        onClick={(e) => {
          const pane = e.currentTarget.closest(".chat")?.getBoundingClientRect();
          setEnd(!!pane && e.currentTarget.getBoundingClientRect().left + 220 > pane.right);
          setTyped("");
          setOpen(!open);
        }}
      >
        {said}
        <svg className="i chat-chev" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.5 6.5 8 10l3.5-3.5" />
        </svg>
      </button>
      {open && (
        <>
          <div className="scrim-clear" role="presentation" onClick={close} />
          <div className={cls("popover chat-pop", end && "end")} role="menu" aria-label={label}>
            {choices.map((c) => (
              <button
                key={c.value}
                type="button"
                role="menuitemradio"
                aria-checked={c.value === value}
                className="pop-item"
                onClick={() => {
                  pick(c.value);
                }}
              >
                <svg className="i chat-tick" viewBox="0 0 16 16" aria-hidden="true">
                  {c.value === value && <path d="M3.5 8.5l3 3 6-7" />}
                </svg>
                {c.label}
              </button>
            ))}
            {free && (
              <input
                className="chat-free"
                aria-label={free}
                placeholder={free}
                value={typed}
                spellCheck={false}
                onChange={(e) => {
                  setTyped(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && typed.trim()) pick(typed.trim());
                }}
              />
            )}
          </div>
        </>
      )}
    </span>
  );
}

// How your agent runs, by the box: the same settings as Settings → Agent, each saved as you pick it.
function Options({ options }: { options: AgentOptions }) {
  const [mine, setMine] = useState<Partial<AgentOptions>>({}); // picked, until the desk says the same
  const [error, setError] = useState<string | null>(null);
  const now = { ...options, ...mine };
  const kind = AGENT[options.agent];
  const drop = (field: "bypass" | "model" | "effort") => {
    setMine((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== field)));
  };
  const save = (key: string, field: "bypass" | "model" | "effort", value: string | boolean) => {
    setMine((m) => ({ ...m, [field]: value }));
    setError(null);
    runUi(
      api.saveSettings({ set: { [key]: value } }).pipe(
        Effect.match({
          onSuccess: (r) => {
            if (r.ok) return;
            drop(field);
            setError(r.errors[0]?.message ?? "Not saved");
          },
          onFailure: (e) => {
            drop(field);
            setError(e.message);
          },
        }),
      ),
    );
  };
  const listed = (known: readonly string[], current: string, none: string) => [
    { value: "", label: none },
    ...[...known, ...(current && !known.includes(current) ? [current] : [])].map((v) => ({
      value: v,
      label: known.includes(v) ? cap(v) : v,
    })),
  ];
  const models = listed(kind.models, now.model, "Default model");
  const efforts = listed(kind.efforts, now.effort, "Default effort");
  // Its own default is said in a word, so the three fit one line of a narrow chat; the menu says it whole.
  const said = (list: typeof models, value: string, none: string) => (value ? (list.find((m) => m.value === value)?.label ?? value) : none);
  return (
    <span className="chat-opts">
      <Pick
        label={`How freely ${kind.name} runs`}
        tip={`How freely ${kind.name} runs; it can't post as you either way`}
        value={now.bypass ? "1" : "0"}
        said={kind.run[now.bypass ? 1 : 0]}
        choices={[
          { value: "0", label: kind.run[0] },
          { value: "1", label: kind.run[1] },
        ]}
        onPick={(v) => {
          save("agent.coordinator_bypass", "bypass", v === "1");
        }}
      />
      <Pick
        label={`${kind.name}'s model`}
        tip={`${kind.name}'s model`}
        value={now.model}
        said={said(models, now.model, "Model")}
        choices={models}
        free="Another model"
        onPick={(v) => {
          save("agent.coordinator_model", "model", v);
        }}
      />
      {kind.efforts.length > 0 && (
        <Pick
          label={`${kind.name}'s effort`}
          tip={`How hard ${kind.name} thinks`}
          value={now.effort}
          said={said(efforts, now.effort, "Effort")}
          choices={efforts}
          onPick={(v) => {
            save("agent.coordinator_effort", "effort", v);
          }}
        />
      )}
      {error && <span className="chat-note t-bad">{error}</span>}
    </span>
  );
}

const CHAT: Width = { key: "desk.chat.width", cssVar: "--chat-w-user", min: 300, max: 0.5 };
