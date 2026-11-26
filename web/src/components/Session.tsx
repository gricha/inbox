import { Effect } from "effect";
import { useEffect, useRef, useState } from "react";
import { SESSION_KIND, type SessionAction, type SessionCard, type SessionTurn, type SessionView } from "../../../src/types.ts";
import { api, runUi } from "../api.ts";
import { useKeyed, useKeyedLayout } from "../keyed.ts";
import { age, cls } from "../format.ts";
import { Prose } from "./Prose.tsx";
import { KindIcon, RowFacts } from "./RowIcons.tsx";

export interface SessionCtx {
  now: number;
  selected: string | null;
  leaving: Set<string>;
  select: (s: SessionCard) => void;
  open: (s: SessionCard) => void; // a click: its page
  act: (s: SessionCard, action: "done" | "snooze" | "mute", until?: string) => void;
  start: (s: SessionCard, action: SessionAction) => void; // Kick, Resume, Copy attach command, Open
}

// What each action's button says, and its tooltip.
export const SESSION_ACTION: Record<SessionAction, { label: string; title: string }> = {
  kick: { label: "Kick", title: "Start it again in the background, where it left off" },
  resume: { label: "Resume in background", title: "Its terminal is gone: carry on in the background, where it left off" },
  attach: { label: "Copy attach command", title: "Copy claude attach, to open it in a terminal" },
  open: { label: "Open", title: "Open it where it runs" },
};

// A Claude Code or Codex session that needs you, a row like a PR's: its icon (its kind in the tip), its name, quietly its
// folder, why it's here where a PR's why goes, its call to action, its age. A click opens its page.
export function SessionRow({ s, ctx }: { s: SessionCard; ctx: SessionCtx }) {
  const folder = s.cwd.split(/[\\/]/).findLast(Boolean) ?? s.cwd;
  const [first] = s.actions;
  const ask = s.reason.startsWith("asked a question")
    ? "Answer"
    : /^needs (permission|sandbox access)/.test(s.reason)
      ? "Review"
      : s.reason.startsWith("waiting on plan")
        ? "Review plan"
        : null;
  return (
    <div className={cls("line session", ctx.selected === s.id && "sel", ctx.leaving.has(s.id) && "leaving")} data-id={s.id}>
      <div className="line-main line-row">
        <button
          type="button"
          className="row-main line-btn"
          onMouseDown={(e) => {
            e.preventDefault();
          }}
          onClick={() => {
            ctx.open(s);
          }}
          onFocus={() => {
            ctx.select(s);
          }}
        >
          <KindIcon kind="session" tip={`${SESSION_KIND[s.kind]} session`} />
          <span className="line-title">{s.name}</span>
          <span className="line-ref" data-tip={s.cwd}>
            {folder}
          </span>
          {/* Why it's here, where a PR's why goes. */}
          <span className="line-note line-stage" data-tip={s.reason}>
            {s.reason}
          </span>
        </button>
        {/* What it asks of you opens its page, where you answer it; otherwise its own way on. */}
        {ask ? (
          <button
            type="button"
            className="act line-cta"
            onClick={() => {
              ctx.open(s);
            }}
          >
            {ask}
          </button>
        ) : (
          first &&
          first !== "attach" && (
            <button
              type="button"
              className="act line-cta"
              data-tip={SESSION_ACTION[first].title}
              onClick={() => {
                ctx.start(s, first);
              }}
            >
              {SESSION_ACTION[first].label}
            </button>
          )
        )}
        <RowFacts />
        <span className="line-by line-face">
          <span className="sr">{SESSION_KIND[s.kind]}</span>
        </span>
        <span className="line-age" data-tip={`since ${new Date(s.since).toLocaleString()}`}>
          {age(s.since, ctx.now)}
        </span>
      </div>
    </div>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const SHOWN = 14; // turns shown before the rest fold
const BUSY = 800; // re-read while it works or what you sent isn't in its transcript yet
const IDLE = 3_000; // while the desk runs it and it waits on you

// Where it runs now, said in the head: the desk takes it over when you write here, Open in Claude gives it back.
const RUNS: Record<SessionView["runs"], string> = {
  inbox: "Running in Inbox",
  app: "In the Claude app",
  terminal: "Running in a terminal",
  background: "Running in the background",
  codex: "In Codex",
  none: "Not running",
};

type Answer = { allow: boolean; answers?: Record<string, string>; message?: string };
type Reply = { allow: boolean; call: string };

// What the page asks of the app: each write's toast, bubble and refresh are the app's.
export interface SessionPageCtx {
  send: (v: SessionView, text: string, answer?: Reply) => Effect.Effect<boolean>; // true once the desk has it
  answer: (v: SessionView, ask: string, a: Answer) => Effect.Effect<boolean>;
  open: (v: SessionView) => void;
  copy: (text: string) => void;
  done: (s: SessionCard) => void;
  back: () => void;
}

const imageUrl = (id: string, src: string) => `/api/sessions/${encodeURIComponent(id)}/image?src=${encodeURIComponent(src)}`;
const yours = (turns: SessionTurn[]) => turns.filter((t) => t.who === "you");

// A session that needs you, decision first: its head (what it is, where it runs, one status), then what it asks with the
// words it said before asking, its answers and a box of its own; the conversation under it, folded. With nothing asked it's
// a chat: the turns, then the box. The desk runs it while you talk (src/connectors/session-host.ts), so its turn streams in;
// what you send shows at once and reads back until its transcript has one more turn of yours.
export function SessionPage({ id, loads, now, ctx }: { id: string; loads: number; now: number; ctx: SessionPageCtx }) {
  const [v, setV] = useState<SessionView | string | null>(null); // string: why it couldn't load
  const [stale, setStale] = useState<string | null>(null); // a read that failed after one worked: the page says so
  const [text, setText] = useState("");
  const [sent, setSent] = useState<{ text: string; before: number } | null>(null); // before: your turns already there
  const [answered, setAnswered] = useState<Set<string>>(new Set()); // asks you answered, until the desk's read drops them
  const [all, setAll] = useState(false);
  const [convo, setConvo] = useState(false); // the conversation under an ask, opened
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const box = useRef<HTMLTextAreaElement>(null);

  useKeyed(`${id} ${loads} ${tick}`, (signal) => {
    const n = ++seq.current;
    runUi(
      api.sessionView(id).pipe(
        Effect.match({
          onSuccess: (r) => {
            if (n !== seq.current) return;
            setV(r);
            setStale(null);
          },
          onFailure: (e) => {
            if (n !== seq.current) return;
            setV((cur) => (cur && typeof cur === "object" ? cur : e.message));
            setStale(e.message);
          },
        }),
      ),
      { signal },
    );
  });
  const view = typeof v === "object" ? v : null;
  const live = view?.live ?? null;
  const every = live?.busy || sent ? BUSY : live ? IDLE : null;
  useEffect(() => {
    const t = every
      ? setInterval(() => {
          setTick((x) => x + 1);
        }, every)
      : null;
    return () => {
      if (t) clearInterval(t);
    };
  }, [every]);
  // Landed once its transcript has one more turn of yours, or its last turn of yours carries it: a long message is cut to a
  // turn's length, and two sent together read as one.
  const mineNow = yours(view?.turns ?? []);
  const last = mineNow.at(-1);
  const landed =
    !!sent && (mineNow.length > sent.before || (!!last && last.who !== "tools" && last.text.includes(sent.text.slice(0, 200))));
  useEffect(() => {
    if (landed) setSent(null);
  }, [landed]);

  const w0 = view?.waiting ?? null;
  const asking = !!w0 && !sent && !(w0.ask && answered.has(w0.ask));
  // A chat keeps its newest turn in view, at first and as it grows while you're at the bottom; an ask is read from the top.
  const grown = `${view?.turns.length ?? 0} ${live?.saying.length ?? 0} ${sent ? 1 : 0}`;
  const first = useRef(true);
  useKeyedLayout(view ? `${grown} ${asking ? 1 : 0}` : null, () => {
    if (asking) {
      if (first.current) window.scrollTo(0, 0);
    } else {
      const atEnd = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
      if (first.current || atEnd) window.scrollTo(0, document.body.scrollHeight);
    }
    first.current = false;
  });

  function send(t: string, reply?: Reply) {
    const words = t.trim();
    if (!view || !words || sent) return;
    setSent({ text: words, before: yours(view.turns).length });
    setText("");
    runUi(
      ctx.send(view, words, reply).pipe(
        Effect.tap((ok) =>
          Effect.sync(() => {
            if (ok) return;
            setSent(null);
            setText((cur) => cur || t); // a refusal keeps your words
          }),
        ),
      ),
    );
  }

  function answer(ask: string, a: Answer) {
    if (!view) return;
    setAnswered((x) => new Set(x).add(ask));
    if (a.message) setText("");
    runUi(
      ctx.answer(view, ask, a).pipe(
        Effect.tap((ok) =>
          Effect.sync(() => {
            if (ok) return;
            setAnswered((x) => {
              const next = new Set(x);
              next.delete(ask);
              return next;
            });
            if (a.message) setText((cur) => cur || a.message!);
          }),
        ),
      ),
    );
  }

  // Esc goes back, loading or failed too; the box keeps its own Esc.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    const el = e.target instanceof HTMLElement ? e.target : document.body;
    if (el.closest("input, textarea, select, [contenteditable='true']")) return;
    ctx.back();
  };
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      keyRef.current(e);
    };
    window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("keydown", h);
    };
  }, [keyRef]);

  if (v === null) return <div className="session-page" aria-busy="true" />;
  if (typeof v === "string")
    return (
      <div className="session-page">
        <p className="t-bad">{v}</p>
      </div>
    );

  const c = v.card;
  const agent = v.kind === "codex" ? "Codex" : "Claude";
  const folder = v.cwd.split(/[\\/]/).findLast(Boolean) ?? v.cwd;
  const mine: SessionTurn[] = sent && !landed ? [{ who: "you", at: "", text: sent.text }] : [];
  const turns = [...v.turns, ...mine];
  const hidden = all ? 0 : Math.max(0, turns.length - SHOWN);
  const w = asking ? v.waiting : null;
  const can = v.can_reply && !sent;
  const working = !!live?.busy || !!sent || (!!v.waiting?.ask && answered.has(v.waiting.ask));
  // One status, the page's only one: what it needs from you, or what it's doing.
  const state = sent
    ? "Sending your message"
    : working
      ? "Working"
      : w
        ? c
          ? cap(c.reason)
          : "Waits on you"
        : c
          ? cap(c.reason)
          : live
            ? "Its turn ended: nothing asked"
            : "Doesn’t need you now";
  const write = () => {
    send(text);
  };
  const conversation = (
    <ol className="ses-turns" aria-label="The conversation">
      {v.ask && <Turn id={v.id} t={v.ask} agent={agent} />}
      {(hidden > 0 || v.earlier > 0) && (
        <li className="ses-earlier">
          {hidden > 0 ? (
            <button
              type="button"
              onClick={() => {
                setAll(true);
              }}
            >
              {hidden} earlier {hidden === 1 ? "turn" : "turns"}
            </button>
          ) : (
            <span>Earlier turns are in the session itself.</span>
          )}
        </li>
      )}
      {turns.slice(hidden).map((t, i) => (
        // oxlint-disable-next-line react/no-array-index-key -- a transcript's turns only grow at the end
        <Turn key={hidden + i} id={v.id} t={t} agent={agent} />
      ))}
      {live?.saying && !sent && (
        <li className="ses-turn ses-agent ses-streaming">
          <Prose text={live.saying} />
        </li>
      )}
      {working && !live?.saying && (
        <li className="ses-turn ses-tools ses-busy">
          <span className="busy" aria-hidden="true" />
          {sent ? "Sending" : "Working"}
        </li>
      )}
      {(live?.error ?? v.notice) && <li className="ses-turn t-bad">{live?.error ?? v.notice}</li>}
    </ol>
  );
  return (
    <div className="session-page">
      <header className="ses-head">
        <div className="ses-top">
          <span className="ses-where" title={v.cwd}>
            {[SESSION_KIND[v.kind], folder, ...(v.branch ? [v.branch] : [])].join(" · ")}
          </span>
          <span className={cls("ses-runs", v.runs === "inbox" && "ses-runs-here")}>{RUNS[v.runs]}</span>
        </div>
        <h1 className="ses-title">{v.name}</h1>
        <div className="ses-status">
          <p className={cls("ses-state", working && "ses-working")}>
            {state}
            {c && !working && <span className="quiet"> · {age(c.since, now)}</span>}
          </p>
          <span className="ses-acts">
            {v.open && (
              <button
                type="button"
                className="link-btn"
                disabled={!!live?.busy}
                data-tip={
                  live?.busy
                    ? "It's working: open it there once its turn ends"
                    : live
                      ? "Inbox lets go of it, and Claude carries it on"
                      : "Carry it on there"
                }
                onClick={() => {
                  ctx.open(v);
                }}
              >
                {v.open.label}
              </button>
            )}
            {v.command && (
              <button
                type="button"
                className="link-btn"
                data-tip={v.command}
                onClick={() => {
                  ctx.copy(v.command!);
                }}
              >
                {v.command.startsWith("claude attach") ? "Copy attach command" : "Copy resume command"}
              </button>
            )}
            {c && (
              <button
                type="button"
                className="link-btn"
                data-tip="Off your Inbox until it asks for you again; it isn't stopped"
                onClick={() => {
                  ctx.done(c);
                }}
              >
                Dismiss
              </button>
            )}
          </span>
        </div>
        {stale && <p className="ses-note">Couldn’t read it again: {stale}. What’s here may be out of date.</p>}
      </header>

      {w ? (
        <>
          <Waiting w={w} v={v} can={can} text={text} setText={setText} send={send} answer={answer} agent={agent} box={box} />
          <details
            className="ses-convo"
            open={convo}
            onToggle={(e) => {
              setConvo(e.currentTarget.open);
            }}
          >
            <summary>
              Conversation · {turns.length} {turns.length === 1 ? "turn" : "turns"}
            </summary>
            {conversation}
          </details>
        </>
      ) : (
        <>
          {conversation}
          {v.can_reply ? (
            <Compose
              box={box}
              text={text}
              setText={setText}
              placeholder={`Message ${agent}`}
              label={`Your message to ${v.name}`}
              disabled={!text.trim() || !can}
              go={write}
            />
          ) : (
            <p className="ses-note">{v.why_not}</p>
          )}
        </>
      )}
      {!w && v.can_reply && v.runs !== "inbox" && v.runs !== "none" && (
        <p className="ses-note">Writing here moves it into Inbox; {v.open ? `${v.open.label} gives it back` : "it carries on here"}.</p>
      )}
    </div>
  );
}

// The box to write in, with its send button: Enter sends, Shift+Enter is a new line.
function Compose({
  box,
  text,
  setText,
  placeholder,
  label,
  disabled,
  go,
  button,
}: {
  box: React.RefObject<HTMLTextAreaElement | null>;
  text: string;
  setText: (t: string) => void;
  placeholder: string;
  label: string;
  disabled: boolean;
  go: () => void;
  button?: string; // a named button in place of the arrow
}) {
  return (
    <div className={cls("ses-compose", button && "ses-compose-in")}>
      <textarea
        ref={box}
        className="chat-input ses-input"
        rows={1}
        aria-label={label}
        placeholder={placeholder}
        value={text}
        maxLength={8000}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.repeat && !e.nativeEvent.isComposing) {
            e.preventDefault(); // Cmd+Enter sends too, as every other box in the desk does
            if (!disabled) go();
          } else if (e.key === "Escape") e.currentTarget.blur();
        }}
      />
      {button ? (
        <button type="button" className="act" disabled={disabled} onClick={go}>
          {button}
        </button>
      ) : (
        <button
          type="button"
          className="chat-go"
          aria-label="Send"
          data-tip="Send (Enter; Shift+Enter for a new line)"
          disabled={disabled}
          onClick={go}
        >
          <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M14 2 7.25 8.75M14 2 9.75 14l-2.5-5.25L2 6.25z" />
          </svg>
        </button>
      )}
    </div>
  );
}

// What it waits on, first on the page: its words before it asked, then the ask itself with its answers, and a box of its own.
// While the desk runs it each answer goes to the request; after its process went, it's a message that carries it on, naming
// the call shown so the desk answers that one only.
function Waiting({
  w,
  v,
  can,
  text,
  setText,
  send,
  answer,
  agent,
  box,
}: {
  w: NonNullable<SessionView["waiting"]>;
  v: SessionView;
  can: boolean;
  text: string;
  setText: (t: string) => void;
  send: (t: string, answer?: Reply) => void;
  answer: (ask: string, a: Answer) => void;
  agent: string;
  box: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const context = w.context && (
    <div className="ses-context">
      <span className="ses-context-who">{agent} said</span>
      <Prose text={w.context} />
    </div>
  );
  if (w.kind === "question") {
    const one = w.questions.length === 1 && !w.questions[0]!.multi;
    const reply = (answers: Record<string, string>) => {
      if (w.ask) answer(w.ask, { allow: true, answers });
      else
        send(
          Object.entries(answers).length === 1
            ? Object.values(answers)[0]!
            : Object.entries(answers)
                .map(([q, a]) => `${q} ${a}`)
                .join("\n"),
        );
    };
    const ready = w.questions.every((q) => (picks[q.question]?.length ?? 0) > 0);
    return (
      <section className="ses-wait" aria-label="What it asks">
        {context}
        {w.questions.map((q) => (
          <div key={q.question} className="ses-q">
            <p className="ses-ask">{q.question}</p>
            {q.multi && <p className="ses-hint">Pick any that apply</p>}
            {q.options.length > 0 && (
              <ol className="inq-options">
                {[...q.options]
                  .sort((a, b) => Number(b.label === q.pick) - Number(a.label === q.pick))
                  .map((o) => {
                    const on = picks[q.question]?.includes(o.label) ?? false;
                    return (
                      <li key={o.label}>
                        <button
                          type="button"
                          className={cls("inq-option", on && "on")}
                          aria-pressed={one ? undefined : on}
                          disabled={!can}
                          onClick={() => {
                            if (one) reply({ [q.question]: o.label });
                            else
                              setPicks((x) => {
                                const was = x[q.question] ?? [];
                                const next = q.multi
                                  ? was.includes(o.label)
                                    ? was.filter((l) => l !== o.label)
                                    : [...was, o.label]
                                  : [o.label];
                                return { ...x, [q.question]: next };
                              });
                          }}
                        >
                          <span className="inq-option-text">
                            <span className="inq-option-answer">
                              {one ? `Use “${o.label}”` : o.label}
                              {o.label === q.pick && <span className="inq-pick">Recommended</span>}
                            </span>
                            {o.description && <span className="inq-next">{o.description}</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
              </ol>
            )}
          </div>
        ))}
        {!one && (
          <div className="actions">
            <button
              type="button"
              className="act primary"
              disabled={!can || !ready}
              onClick={() => {
                reply(Object.fromEntries(w.questions.map((q) => [q.question, (picks[q.question] ?? []).join(", ")])));
              }}
            >
              Send answers
            </button>
          </div>
        )}
        {v.can_reply && (
          <Compose
            box={box}
            text={text}
            setText={setText}
            placeholder="Or answer in your own words"
            label={`Your answer to ${v.name}`}
            disabled={!text.trim() || !can}
            button="Send answer"
            go={() => {
              if (w.ask) answer(w.ask, { allow: true, answers: { [w.questions[0]!.question]: text.trim() } });
              else send(text);
            }}
          />
        )}
      </section>
    );
  }
  const plan = w.kind === "plan";
  const yes = () => {
    if (w.ask) answer(w.ask, { allow: true });
    else send(plan ? "Go ahead with the plan." : "Go ahead.", { allow: true, call: w.call });
  };
  const no = () => {
    const why = text.trim() || (plan ? "Keep planning." : "No, don't do that.");
    if (w.ask) answer(w.ask, { allow: false, message: why });
    else send(why, { allow: false, call: w.call });
  };
  return (
    <section className="ses-wait" aria-label={plan ? "Its plan" : "What it asks to do"}>
      {context}
      {plan ? (
        <details className="ses-plan" open>
          <summary>Its plan</summary>
          <Prose text={w.plan} />
        </details>
      ) : (
        <>
          <p className="ses-ask">Wants to run {w.tool}</p>
          {w.detail && <pre className="inq-code">{w.detail}</pre>}
        </>
      )}
      {v.can_reply && (
        <textarea
          ref={box}
          className="chat-input ses-why"
          rows={1}
          aria-label={plan ? "What it should change" : "Why not"}
          placeholder={plan ? "What to change (goes with Keep planning)" : "Why not (goes with Deny)"}
          value={text}
          maxLength={8000}
          onChange={(e) => {
            setText(e.target.value);
          }}
        />
      )}
      {can && (
        <div className="actions">
          <button type="button" className="act primary" onClick={yes}>
            {plan ? "Approve the plan" : "Allow once"}
          </button>
          <button type="button" className="act" onClick={no}>
            {plan ? "Keep planning" : "Deny"}
          </button>
        </div>
      )}
      {!v.can_reply && <p className="ses-note">{v.why_not}</p>}
    </section>
  );
}

// A run of tool calls said by what it did first, the rest folded: "Edit: docs/releases/4.2.md and 2 more".
const stepsLine = (lines: string[]) => (lines.length > 1 ? `${lines[0]} and ${lines.length - 1} more` : (lines[0] ?? ""));

// One turn: yours set off on a sheet, the agent's as prose, a run of tool calls as one quiet line (folded past one); the
// images it shows under it, small, each opening at full size.
function Turn({ id, t, agent }: { id: string; t: SessionTurn; agent: string }) {
  const images = t.images?.length ? (
    <span className="ses-images">
      {t.images.map((im) => (
        <a key={im.src} href={imageUrl(id, im.src)} target="_blank" rel="noreferrer" data-tip={im.alt || "Open it at full size"}>
          <img src={imageUrl(id, im.src)} alt={im.alt} loading="lazy" />
        </a>
      ))}
    </span>
  ) : null;
  if (t.who === "tools") {
    return (
      <li className="ses-turn ses-tools">
        {t.lines.length === 1 ? (
          <span className="ses-step">{t.lines[0]}</span>
        ) : t.lines.length > 1 ? (
          <details>
            <summary>{stepsLine(t.lines)}</summary>
            <ul>
              {t.lines.map((l, i) => (
                // oxlint-disable-next-line react/no-array-index-key -- the same call twice is two lines
                <li key={i}>{l}</li>
              ))}
            </ul>
          </details>
        ) : null}
        {images}
      </li>
    );
  }
  return (
    <li className={cls("ses-turn", t.who === "you" ? "ses-you" : "ses-agent")} aria-label={t.who === "you" ? "You" : agent}>
      {t.who === "you" ? <p className="ses-said">{t.text}</p> : t.text && <Prose text={t.text} />}
      {images}
    </li>
  );
}
