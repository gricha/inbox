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
        {first && first !== "attach" && (
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

type Answer = { allow: boolean; answer?: string; message?: string };

// What the page asks of the app: each write's toast, bubble and refresh are the app's.
export interface SessionPageCtx {
  send: (v: SessionView, text: string, allow?: boolean) => Effect.Effect<boolean>; // true once the desk has it
  answer: (v: SessionView, ask: string, a: Answer) => Effect.Effect<boolean>;
  open: (v: SessionView) => void;
  copy: (text: string) => void;
  done: (s: SessionCard) => void;
  back: () => void;
}

const imageUrl = (id: string, src: string) => `/api/sessions/${encodeURIComponent(id)}/image?src=${encodeURIComponent(src)}`;

// A session as a chat: its turns (yours, its words, its tool calls a line a run, the images it shows), what it waits on with
// its answers a click each, and a box to write to it. The desk runs it while you talk (src/connectors/session-host.ts), so its
// turn streams in; what you send shows at once and reads back until its transcript has it. One the Claude app or a terminal
// holds says so, with Open in Claude.
export function SessionPage({ id, loads, now, ctx }: { id: string; loads: number; now: number; ctx: SessionPageCtx }) {
  const [v, setV] = useState<SessionView | string | null>(null); // string: why it couldn't load
  const [text, setText] = useState("");
  const [sent, setSent] = useState<{ text: string; before: number } | null>(null); // before: such turns already there
  const [answered, setAnswered] = useState<Set<string>>(new Set()); // asks you answered, until the desk's read drops them
  const [all, setAll] = useState(false);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const box = useRef<HTMLTextAreaElement>(null);

  useKeyed(`${id} ${loads} ${tick}`, (signal) => {
    const n = ++seq.current;
    runUi(
      api.sessionView(id).pipe(
        Effect.match({
          onSuccess: (r) => {
            if (n === seq.current) setV(r);
          },
          onFailure: (e) => {
            if (n === seq.current) setV((cur) => (cur && typeof cur === "object" ? cur : e.message));
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
  const said = (words: string) => view?.turns.filter((t) => t.who === "you" && t.text === words).length ?? 0;
  const landed = !!sent && said(sent.text) > sent.before;
  useEffect(() => {
    if (landed) setSent(null);
  }, [landed]);

  // The newest turn in view, as a chat keeps it: at first, and as it grows while you're at the bottom.
  const grown = `${view?.turns.length ?? 0} ${live?.saying.length ?? 0} ${sent ? 1 : 0} ${view?.waiting ? 1 : 0}`;
  const first = useRef(true);
  useKeyedLayout(view ? grown : null, () => {
    const atEnd = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
    if (first.current || atEnd) window.scrollTo(0, document.body.scrollHeight);
    first.current = false;
  });

  function send(t: string, allow = false) {
    const words = t.trim();
    if (!view || !words || sent) return;
    setSent({ text: words, before: said(words) });
    setText("");
    runUi(
      ctx.send(view, words, allow).pipe(
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
  const w = sent || (v.waiting?.ask && answered.has(v.waiting.ask)) ? null : v.waiting;
  const can = v.can_reply && !sent;
  const working = !!live?.busy || !!sent || (!!v.waiting?.ask && answered.has(v.waiting.ask));
  const state = w
    ? c
      ? cap(c.reason)
      : "Waits on you"
    : working
      ? "Working"
      : c
        ? cap(c.reason)
        : live
          ? "Your turn"
          : "Doesn’t need you now";
  // A pending question takes what you write as your answer; otherwise it's a message.
  const write = () => {
    if (w?.kind === "question" && w.ask) answer(w.ask, { allow: true, answer: text.trim() });
    else send(text);
  };
  return (
    <div className="session-page">
      <header className="ses-head">
        <div className="ses-top">
          <span className="inq-kind">Session</span>
          <span className="ses-where" title={v.cwd}>
            {[SESSION_KIND[v.kind], folder, ...(v.branch ? [v.branch] : [])].join(" · ")}
          </span>
          <span className="ses-acts">
            {v.open && (
              <button
                type="button"
                className={cls("act", !v.can_reply && "primary")}
                data-tip={live ? "The desk lets go of it, and Claude carries it on" : "Carry it on there"}
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
                className="act"
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
                className="act"
                data-tip="Off your Inbox until it moves on"
                onClick={() => {
                  ctx.done(c);
                }}
              >
                Done
              </button>
            )}
          </span>
        </div>
        <h1 className="ses-title">{v.name}</h1>
        <p className={cls("ses-state", working && !w && "ses-working")}>
          {state}
          {c && !working && <span className="quiet"> · {age(c.since, now)}</span>}
        </p>
      </header>

      <ol className="ses-turns" aria-label="The conversation">
        {v.ask && <Turn id={v.id} t={v.ask} agent={agent} sending={false} />}
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
          <Turn key={hidden + i} id={v.id} t={t} agent={agent} sending={t === mine[0]} />
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
        {live?.error && <li className="ses-turn t-bad">{live.error}</li>}
      </ol>

      {w && <Waiting w={w} can={can} text={text} send={send} answer={answer} />}

      {v.can_reply ? (
        <div className="ses-compose">
          <textarea
            ref={box}
            className="chat-input ses-input"
            rows={1}
            aria-label={`Your message to ${v.name}`}
            placeholder={w?.kind === "question" ? "Or answer in your own words" : `Message ${agent}`}
            value={text}
            maxLength={8000}
            onChange={(e) => {
              setText(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.repeat && !e.nativeEvent.isComposing) {
                e.preventDefault(); // Cmd+Enter sends too, as every other box in the desk does
                write();
              } else if (e.key === "Escape") e.currentTarget.blur();
            }}
          />
          <button
            type="button"
            className="chat-go"
            aria-label="Send"
            data-tip="Send (Enter; Shift+Enter for a new line)"
            disabled={!text.trim() || !can}
            onClick={write}
          >
            <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M14 2 7.25 8.75M14 2 9.75 14l-2.5-5.25L2 6.25z" />
            </svg>
          </button>
        </div>
      ) : (
        <p className="ses-note">{v.why_not}</p>
      )}
    </div>
  );
}

// What it waits on, at the conversation's end: a permission to allow or deny, a question's answers, a plan to approve. While
// the desk runs it each answer goes to the request; after its process went, it's a message that carries it on.
function Waiting({
  w,
  can,
  text,
  send,
  answer,
}: {
  w: NonNullable<SessionView["waiting"]>;
  can: boolean;
  text: string;
  send: (t: string, allow?: boolean) => void;
  answer: (ask: string, a: Answer) => void;
}) {
  const yes = (go: string) => {
    if (w.ask) answer(w.ask, { allow: true });
    else send(go, true);
  };
  const no = (fallback: string) => {
    const why = text.trim() || fallback;
    if (w.ask) answer(w.ask, { allow: false, message: why });
    else send(why);
  };
  if (w.kind === "question")
    return (
      <section className="ses-wait" aria-label="Its question">
        <p className="ses-ask">{w.question}</p>
        {w.options.length > 0 && (
          <ol className="inq-options">
            {w.options.map((o) => (
              <li key={o.label}>
                <button
                  type="button"
                  className="inq-option"
                  disabled={!can}
                  onClick={() => {
                    if (w.ask) answer(w.ask, { allow: true, answer: o.label });
                    else send(o.label);
                  }}
                >
                  <span className="inq-option-text">
                    <span className="inq-option-answer">{o.label}</span>
                    {o.description && <span className="inq-next">{o.description}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
    );
  const plan = w.kind === "plan";
  return (
    <section className="ses-wait" aria-label={plan ? "Its plan" : "What it asks to do"}>
      {plan ? (
        <details className="ses-plan" open>
          <summary>Its plan</summary>
          <Prose text={w.plan} />
        </details>
      ) : (
        <>
          <p className="ses-ask">Wants to use {w.tool}</p>
          {w.detail && <pre className="inq-code">{w.detail}</pre>}
        </>
      )}
      {can && (
        <div className="actions">
          <button
            type="button"
            className="act primary"
            onClick={() => {
              yes(plan ? "Go ahead with the plan." : "Go ahead.");
            }}
          >
            {plan ? "Approve" : "Allow"}
          </button>
          <button
            type="button"
            className="act"
            data-tip={plan ? "What you've written goes with it" : "What you've written says why"}
            onClick={() => {
              no(plan ? "Keep planning." : "No, don't do that.");
            }}
          >
            {plan ? "Keep planning" : "Deny"}
          </button>
        </div>
      )}
    </section>
  );
}

// One turn: yours set off on a sheet, the agent's as prose, a run of tool calls as one quiet line (folded past one); the
// images it shows under it, each opening at full size.
function Turn({ id, t, agent, sending }: { id: string; t: SessionTurn; agent: string; sending: boolean }) {
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
    const names = [...new Set(t.lines.map((l) => l.split(":")[0]))].join(", ");
    return (
      <li className="ses-turn ses-tools">
        {t.lines.length === 1 ? (
          <span className="ses-step">{t.lines[0]}</span>
        ) : t.lines.length > 1 ? (
          <details>
            <summary>
              {t.lines.length} steps · {names}
            </summary>
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
      {t.who === "you" ? (
        <p className="ses-said">
          {t.text}
          {sending && <span className="busy" aria-label="sending" />}
        </p>
      ) : (
        t.text && <Prose text={t.text} />
      )}
      {images}
    </li>
  );
}
