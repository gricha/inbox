import { Effect } from "effect";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Inquiry, InquiryView, Recommendation } from "../../../src/types.ts";
import { api, runUi } from "../api.ts";
import { useKeyed } from "../keyed.ts";
import { age, ago, cls, fromName, issueUrl, MOD } from "../format.ts";
import { shownUrl, urlPlace } from "../../../src/prose.ts";
import { inquiryOf, routeHash } from "../view.ts";
import { AgentIcon, KindIcon, RowFacts } from "./RowIcons.tsx";
import { Grip, press, type RowDrag } from "./Reorder.tsx";

const URL_IN_TEXT = /(https:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]])/;

// What an agent's row needs from the app.
export interface InquiryCtx {
  now: number;
  selected: string | null;
  select: (q: Inquiry) => void;
  open: (q: Inquiry) => void; // a click: its page
  agree: (q: Inquiry) => void; // a recommendation's call to action
  compact?: boolean; // the list beside a review: two lines a row
}

// An agent session's question for you, a row in the table like a PR's or an issue's: Question, the question, its call to
// action (Answer), who asks, its age; a click opens its page. Beside a review, two lines: the question, then the rest.
export function InquiryRow({ q, ctx, drag }: { q: Inquiry; ctx: InquiryCtx; drag?: RowDrag | undefined }) {
  const id = inquiryOf(q.id);
  const sel = ctx.selected === id;
  const kindIcon = <KindIcon kind="question" tip={q.fix ? `${q.from}'s recommendation` : "A question from an agent"} />;
  const title = <span className="line-title">{q.question}</span>;
  const by = (
    <span className="line-by" title={q.from}>
      by {fromName(q.from, false)}
    </span>
  );
  const face = (
    <span className="line-by line-face" data-tip={`Asked by ${fromName(q.from, false)}`}>
      <AgentIcon />
      <span className="sr">by {fromName(q.from, false)}</span>
    </span>
  );
  const ageEl = (
    <span className="line-age" data-tip={`asked ${new Date(q.at).toLocaleString()}`}>
      {age(q.at, ctx.now)}
    </span>
  );
  return (
    <div className={cls("line inq", ctx.compact && "c-line", sel && "sel")} data-id={id} {...drag}>
      <div className={cls("line-main line-row", ctx.compact && "c-row")}>
        {drag && <Grip />}
        <button
          type="button"
          className="row-main line-btn"
          {...press(drag, () => {
            ctx.select(q);
          })}
          onClick={() => {
            ctx.open(q);
          }}
        >
          {ctx.compact ? (
            <>
              <span className="c-top">
                {kindIcon}
                {title}
              </span>
              <span className="c-meta">
                {by}
                <span className="c-gap" />
                {ageEl}
              </span>
            </>
          ) : (
            <>
              {kindIcon}
              {title}
            </>
          )}
        </button>
        <button
          type="button"
          className={ctx.compact ? "c-cta" : "act line-cta line-reply"}
          onClick={() => {
            if (q.fix) ctx.agree(q);
            else ctx.open(q);
          }}
        >
          {q.fix ? "Agree" : "Answer"}
        </button>
        {!ctx.compact && (
          <>
            <RowFacts />
            {face}
            {ageEl}
          </>
        )}
      </div>
    </div>
  );
}

// The agent's words as text: `code` spans, and its https URLs as links, each shown as the URL it opens. Never markup.
function rich(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let n = 0;
  for (const [i, part] of text.split("`").entries()) {
    if (i % 2) out.push(<code key={n++}>{part}</code>);
    else
      for (const [j, bit] of part.split(URL_IN_TEXT).entries())
        out.push(
          j % 2 ? (
            <a key={n++} href={bit} target="_blank" rel="noreferrer">
              {shownUrl(bit)}
            </a>
          ) : (
            bit
          ),
        );
  }
  return out;
}

// What a recommendation would change, and the held note it's about with how it doesn't fit: as text, never markup.
function FixParts({ fix }: { fix: Recommendation }) {
  const change =
    fix.do === "fix"
      ? { head: "Its fields would be", text: JSON.stringify(fix.fields, null, 2) }
      : fix.do === "type"
        ? { head: "The type would be", text: fix.type, was: fix.was }
        : fix.do === "prompt"
          ? { head: "The instruction would be", text: fix.prompt, was: fix.was }
          : null;
  return (
    <section className="inq-fix" aria-label="What it would change">
      {change && (
        <>
          <h2 className="d-head">{change.head}</h2>
          <pre className="inq-code">{change.text}</pre>
        </>
      )}
      {change?.was !== undefined && (
        <details className="inq-was">
          <summary>What it replaces</summary>
          <pre className="inq-code">{change.was}</pre>
        </details>
      )}
      <h2 className="d-head">The held note</h2>
      <p className="inq-held">{fix.item.text}</p>
      <pre className="inq-code">{JSON.stringify(fix.item.fields, null, 2)}</pre>
      <h2 className="d-head">How it doesn&rsquo;t fit</h2>
      <pre className="inq-code t-bad">{fix.error}</pre>
    </section>
  );
}

// An agent's question on its own page: what it's about, everything it said, its links, and each answer with what it leads
// to. A click picks one, or write your own, or Dismiss; answered, it stays here saying so. Its text is the agent's: text only.
export function InquiryPage({
  id,
  loads,
  now,
  flash,
  onAnswer,
  onBack,
  onLink,
  onLoad,
}: {
  id: string;
  loads: number; // bumped on every refresh: an answer from elsewhere shows
  now: number;
  flash: (text: string, error?: boolean) => void;
  onAnswer: (q: Inquiry, text: string, dismiss?: boolean) => Effect.Effect<boolean>; // true once the desk has it
  onBack: () => void;
  onLink: (q: Inquiry) => void; // Copy link
  onLoad: (q: Inquiry) => void; // the queue's view drops a question once it's answered; this page's copy stays
}) {
  const [q, setQ] = useState<InquiryView | string | null>(null); // string: why it couldn't load
  const [text, setText] = useState("");
  const [sent, setSent] = useState<Inquiry["answer"]>(null); // yours, until the desk's copy says so
  const seq = useRef(0);

  useKeyed(`${id} ${loads}`, (signal) => {
    const n = ++seq.current;
    runUi(
      api.inquiry(id).pipe(
        Effect.match({
          onSuccess: (r) => {
            if (n === seq.current) setQ(r);
          },
          onFailure: (e) => {
            if (n === seq.current) setQ((cur) => (cur && typeof cur === "object" ? cur : e.message));
          },
        }),
      ),
      { signal },
    );
  });

  const v = typeof q === "object" ? q : null;
  useEffect(() => {
    if (v) onLoad(v);
  }, [v, onLoad]);
  const answer = v?.answer ?? sent;
  const card = v?.card ?? null;

  function send(t: string, dismiss = false) {
    if (!v) return;
    if (answer) {
      flash(answer.dismissed ? "You dismissed it" : "You answered it already");
      return;
    }
    if (!dismiss && !t.trim()) return;
    const mine = { text: dismiss ? "" : t.trim(), at: "", dismissed: dismiss }; // the desk stamps it
    setSent(mine);
    if (v.fix) onBack(); // acted on, a recommendation is gone
    runUi(
      onAnswer(v, t, dismiss).pipe(
        Effect.tap((ok) =>
          Effect.sync(() => {
            if (ok) setText("");
            else setSent(null);
          }),
        ),
      ),
    );
  }

  // Esc goes back, loading or failed too; the answer box keeps its own Esc.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    const t = e.target instanceof HTMLElement ? e.target : document.body;
    if (t.closest("input, textarea, select, [contenteditable='true']")) return;
    onBack();
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

  if (q === null) return <div className="inquiry" aria-busy="true" />;
  if (typeof q === "string")
    return (
      <div className="inquiry">
        <p className="t-bad">{q}</p>
      </div>
    );

  const paragraphs = q.context.split(/\n\s*\n/).filter((p) => p.trim());
  return (
    <div className="inquiry">
      <header className="rv-head">
        <p className="rv-ref">
          <span className="inq-kind">{q.fix ? "Recommendation" : "Agent"}</span>
          <span className="rv-by" title={`asked ${new Date(q.at).toLocaleString()}`}>
            {fromName(q.from)}
            {" \u00b7 "}
            {age(q.at, now)}
          </span>
        </p>
        <h1 className="rv-title">{q.question}</h1>
      </header>

      {q.item_id && (
        <section className="inq-about" aria-label="What it's about">
          <a className="ref" href={card?.url ?? issueUrl(q.item_id)} target="_blank" rel="noreferrer" title="On GitHub">
            <span className="ref-ink">
              <span className="ref-repo">{q.item_id.split("/")[1]?.split("#")[0]}</span>#{q.item_id.split("#")[1]}
            </span>
          </a>
          {card && <span className="inq-about-title">{card.title}</span>}
          {card && (
            <span className="inq-about-by">
              by {card.by}
              {card.stage ? ` · ${card.stage}` : ""}
              {card.resolved ? ` · ${card.resolved}` : ""}
            </span>
          )}
          {card?.kind === "pr" && (
            <a className="inq-about-open" href={routeHash({ name: "review", id: card.id })}>
              Open its review
            </a>
          )}
        </section>
      )}

      <section className="inq-context" aria-label="Context">
        {paragraphs.map((p) => (
          <p key={p}>{rich(p.trim())}</p>
        ))}
      </section>

      {q.fix && <FixParts fix={q.fix} />}

      {q.links.length > 0 && (
        <section className="inq-links" aria-label="Links">
          <h2 className="d-head">Links</h2>
          <ul>
            {q.links.map((l) => (
              <li key={l.url}>
                <a href={l.url} target="_blank" rel="noreferrer">
                  {l.label}
                </a>
                <span className="inq-link-where">{urlPlace(l.url)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {answer ? (
        <p className="rv-acted inq-answered">
          <span className="rv-acted-what">{answer.dismissed ? "✓ Dismissed: it decides itself" : `✓ Answered: ${answer.text}`}</span>
          {!q.answer && <span className="busy" aria-label="sending" />}
          {q.answer?.read_at !== undefined && (
            <span className="quiet inq-pickup" title={q.answer.read_at ? new Date(q.answer.read_at).toLocaleString() : undefined}>
              {q.answer.read_at ? `Picked up ${ago(q.answer.read_at, now)}` : "Not picked up yet"}
            </span>
          )}
        </p>
      ) : (
        <section className="inq-answer" aria-label="Your answer">
          {q.options.length > 0 && (
            <ol className="inq-options">
              {q.options.map((o, i) => (
                <li key={o.answer}>
                  <button
                    type="button"
                    className={cls("inq-option", i === 0 && "pick")}
                    onClick={() => {
                      send(o.answer);
                    }}
                  >
                    <span className="inq-option-text">
                      <span className="inq-option-answer">
                        {o.answer}
                        {i === 0 && !q.fix && <span className="inq-pick">its pick</span>}
                      </span>
                      {o.next && <span className="inq-next">{rich(o.next)}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div className="rv-changes inq-write">
            <textarea
              className="cv-reply"
              aria-label={`Your answer to ${fromName(q.from, false)}`}
              placeholder={
                q.fix ? `Or approve with a comment: ${q.from} revises it` : q.options.length ? "Or write your own answer" : "Your answer"
              }
              value={text}
              maxLength={2000}
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- with nothing to pick, writing is the one thing to do here
              autoFocus={!q.options.length}
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
            <div className="actions">
              <button
                type="button"
                className={cls("act", !q.options.length && "primary")}
                title={
                  q.fix
                    ? `Send it to ${q.from}, who recommends again with it (${MOD}\u21b5)`
                    : `Send it to ${fromName(q.from, false)} (${MOD}\u21b5)`
                }
                disabled={!text.trim()}
                onClick={() => {
                  send(text);
                }}
              >
                {q.fix ? "Approve with comment" : "Send"}
              </button>
              {!q.fix && (
                <button
                  type="button"
                  className="act"
                  title="Leave it unanswered: the agent decides itself"
                  onClick={() => {
                    send("", true);
                  }}
                >
                  Dismiss
                </button>
              )}
              <button
                type="button"
                className="act"
                title="Copy this question's link, to paste to an agent or open it here again"
                onClick={() => {
                  onLink(q);
                }}
              >
                Copy link
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
