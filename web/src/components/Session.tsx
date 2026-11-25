import { Effect } from "effect";
import { useEffect, useRef, useState } from "react";
import { KICK, SESSION_KIND, type SessionAction, type SessionCard, type SessionTurn, type SessionView } from "../../../src/types.ts";
import { api, runUi } from "../api.ts";
import { useKeyed } from "../keyed.ts";
import { age, cls, MOD } from "../format.ts";
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
const SHOWN = 8; // turns shown before the rest fold
const REREAD = 3_000; // while what you sent isn't in its transcript yet

// What the page asks of the app: each write's toast, bubble and refresh are the app's.
export interface SessionPageCtx {
  reply: (v: SessionView, text: string) => Effect.Effect<boolean>; // true once the desk has it
  open: (v: SessionView) => void;
  copy: (text: string) => void;
  done: (s: SessionCard) => void;
  back: () => void;
}

// A session that needs you on its own page: what it's doing and why it waits, its last turns (yours, its words, its tool calls
// folded), what it asks with one-click answers, and your reply as its next turn; or, where the desk can't carry it on, where
// to answer it. What you send shows at once and reads back until its own transcript has it.
export function SessionPage({ id, loads, now, ctx }: { id: string; loads: number; now: number; ctx: SessionPageCtx }) {
  const [v, setV] = useState<SessionView | string | null>(null); // string: why it couldn't load
  const [text, setText] = useState("");
  const [sent, setSent] = useState<{ text: string; before: number } | null>(null); // before: such turns already there
  const [all, setAll] = useState(false);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

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
  useEffect(() => {
    const t = sent
      ? setInterval(() => {
          setTick((x) => x + 1);
        }, REREAD)
      : null;
    return () => {
      if (t) clearInterval(t);
    };
  }, [sent]);
  const view = typeof v === "object" ? v : null;
  const said = (words: string) => view?.turns.filter((t) => t.who === "you" && t.text === words).length ?? 0;
  const landed = !!sent && said(sent.text) > sent.before;
  useEffect(() => {
    if (landed) setSent(null);
  }, [landed]);

  function send(t: string) {
    const words = t.trim();
    if (!view || !words || sent) return;
    setSent({ text: words, before: said(words) });
    setText("");
    runUi(
      ctx.reply(view, words).pipe(
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

  // Esc goes back, loading or failed too; the reply box keeps its own Esc.
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

  if (v === null) return <div className="inquiry session-page" aria-busy="true" />;
  if (typeof v === "string")
    return (
      <div className="inquiry session-page">
        <p className="t-bad">{v}</p>
      </div>
    );

  const c = v.card;
  const agent = v.kind === "codex" ? "Codex" : "Claude";
  const folder = v.cwd.split(/[\\/]/).findLast(Boolean) ?? v.cwd;
  const mine: SessionTurn[] = sent && !landed ? [{ who: "you", at: "", text: sent.text }] : [];
  const turns = [...v.turns, ...mine];
  const hidden = all ? 0 : Math.max(0, turns.length - SHOWN);
  const can = v.can_reply && !sent;
  const w = sent ? null : v.waiting; // answered: what it asked is yours to see in its turns
  const pick = (answer: string) => {
    send(answer);
  };
  return (
    <div className="inquiry session-page">
      <header className="rv-head">
        <p className="rv-ref">
          <span className="inq-kind">Session</span>
          <span className="rv-by" title={v.cwd}>
            {[SESSION_KIND[v.kind], folder, ...(v.branch ? [v.branch] : [])].join(" \u00b7 ")}
          </span>
        </p>
        <h1 className="rv-title">{v.name}</h1>
        {c ? (
          <p className="d-why ses-why" title={`since ${new Date(c.since).toLocaleString()}`}>
            <b>{cap(c.reason)}</b>
            <span className="quiet"> · {age(c.since, now)}</span>
          </p>
        ) : (
          <p className="d-why ses-why quiet">{sent ? "Sent. It carries on in the background." : "It doesn\u2019t need you now."}</p>
        )}
      </header>

      <ol className="ses-turns" aria-label="Its last turns">
        {v.ask && <Turn t={v.ask} agent={agent} sending={false} />}
        {(hidden > 0 || v.earlier > 0) && (
          <li className="ses-earlier">
            {hidden > 0 ? (
              <button
                type="button"
                className="linkish"
                onClick={() => {
                  setAll(true);
                }}
              >
                {hidden} earlier {hidden === 1 ? "turn" : "turns"}
              </button>
            ) : (
              <span className="quiet">Earlier turns are in the session itself.</span>
            )}
          </li>
        )}
        {turns.slice(hidden).map((t, i) => (
          // oxlint-disable-next-line react/no-array-index-key -- a transcript's turns only grow at the end
          <Turn key={hidden + i} t={t} agent={agent} sending={t === mine[0]} />
        ))}
      </ol>

      {w?.kind === "plan" && (
        <details className="ses-wait ses-plan" open>
          <summary>Its plan</summary>
          <Prose text={w.plan} />
        </details>
      )}
      {w?.kind === "permission" && (
        <section className="ses-wait" aria-label="What it asks to do">
          <p className="ses-ask">Wants to use {w.tool}</p>
          {w.detail && <pre className="inq-code">{w.detail}</pre>}
        </section>
      )}

      <section className="inq-answer" aria-label="Your answer">
        {w?.kind === "question" && (
          <>
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
                        pick(o.label);
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
          </>
        )}
        {c?.state === "stalled" && can && (
          <ol className="inq-options">
            <li>
              <button
                type="button"
                className="inq-option"
                aria-label="Continue where it left off"
                disabled={!can}
                onClick={() => {
                  pick(KICK);
                }}
              >
                <span className="inq-option-text">
                  <span className="inq-option-answer">Continue where it left off</span>
                </span>
              </button>
            </li>
          </ol>
        )}
        {v.why_not && c && <p className="ses-note">{v.why_not}</p>}
        <div className="rv-changes inq-write">
          {can && (
            <textarea
              className="cv-reply"
              aria-label={`Your reply to ${v.name}`}
              placeholder={w?.kind === "question" && w.options.length ? "Or write your own answer" : `Reply to ${agent}`}
              value={text}
              maxLength={8000}
              onChange={(e) => {
                setText(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.repeat) return;
                if (e.key === "Escape") e.currentTarget.blur();
                else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  send(text);
                }
              }}
            />
          )}
          <div className="actions">
            {can && (
              <button
                type="button"
                className="act primary"
                title={`Send it as its next turn: it carries on in the background (${MOD}\u21b5)`}
                disabled={!text.trim()}
                onClick={() => {
                  send(text);
                }}
              >
                Send
              </button>
            )}
            {v.open && (
              <button
                type="button"
                className={cls("act", !v.can_reply && "primary")}
                title={v.open.url}
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
                title={v.command}
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
                title="Off your Inbox until it moves on"
                onClick={() => {
                  ctx.done(c);
                }}
              >
                Done
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

// One turn: yours as you wrote it, the agent's as prose, a run of tool calls as one quiet line (folded past one).
function Turn({ t, agent, sending }: { t: SessionTurn; agent: string; sending: boolean }) {
  if (t.who === "tools") {
    if (t.lines.length === 1) return <li className="ses-turn ses-tools">{t.lines[0]}</li>;
    const names = [...new Set(t.lines.map((l) => l.split(":")[0]))].join(", ");
    return (
      <li className="ses-turn ses-tools">
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
      </li>
    );
  }
  return (
    <li className={cls("ses-turn", t.who === "you" ? "ses-you" : "ses-agent")}>
      <span className="ses-who">
        {t.who === "you" ? "You" : agent}
        {sending && <span className="busy" aria-label="sending" />}
      </span>
      {t.who === "you" ? <p className="ses-said">{t.text}</p> : <Prose text={t.text} />}
    </li>
  );
}
