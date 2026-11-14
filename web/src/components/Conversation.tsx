import { Effect } from "effect";
import { useEffect, useRef, useState } from "react";
import type { Conversation as Convo, ReviewView } from "../../../src/types.ts";
import { api, runUi } from "../api.ts";
import { age, cls, MOD, aiName } from "../format.ts";
import type { Spot, Thread } from "./Chat.tsx";
import { Avatar } from "./Avatar.tsx";
import { SaidText, Words } from "./Prose.tsx";
import { saidLine } from "../../../src/prose.ts";

const where = (c: Convo) => (c.path ? `${c.path}${c.line ? `:${c.line}` : ""}${c.outdated ? ", outdated" : ""}` : "on the PR");
// What an ask to your agent is about: "dana's thread on src/auth.ts:42".
export const threadOf = (item: string, c: Convo): Thread => ({
  kind: "thread",
  item,
  id: c.id,
  url: c.url,
  label: `${c.comments[0]?.author ?? "their"}'s ${c.kind}${c.path ? ` on ${where(c)}` : ""}`,
});
const firstLine = (s: string) => {
  const line = saidLine(s);
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
};

// What reviewers said: each one waiting on you with Claude's read first and a reply box; the rest fold into one line.
export function Conversation({
  view,
  now,
  flash,
  agent,
  onSpot,
  onAsk,
}: {
  view: ReviewView;
  now: number;
  flash: (text: string, error?: boolean) => void;
  agent: boolean; // your agent is on: each reply box offers Ask your agent
  onSpot: (s: Spot) => void; // the conversation you're on, for what Ask your agent asks about
  onAsk: (s: Spot) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({}); // what you typed, over Claude's suggestion
  const [sent, setSent] = useState<Record<string, string>>({}); // replied to: its latest comment then, so anything newer (yours or theirs) shows it again
  const [busy, setBusy] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [at, setAt] = useState<string | null>(null); // the conversation whose reply box you were last in
  const replied = useRef(""); // the PR whose reply box was focused for its Reply row

  // Opened from a Reply row: the first reply box is ready to type in (⌘↩ sends it, Esc leaves it).
  useEffect(() => {
    if (view.card.cta !== "reply" || replied.current === view.card.id) return;
    const box = document.querySelector<HTMLTextAreaElement>(".cv-reply");
    if (!box) return;
    replied.current = view.card.id;
    // Ask your agent opened while the review loaded has your typing: it never moves into a box that posts on GitHub.
    if (document.activeElement?.closest("input, textarea, [contenteditable='true']")) return;
    box.focus();
  }, [view]);

  const waiting = view.conversation.filter((c) => c.waiting_on_you && sent[c.id] !== c.comments.at(-1)?.id);
  const on = (c: Convo) => {
    setAt(c.id);
    onSpot(threadOf(view.card.id, c));
  };
  // One filled Reply on the page: the one you're answering (the first, until you're in another's box); the rest tinted.
  const lead = waiting.find((c) => c.id === at)?.id ?? waiting[0]?.id;
  const rest = view.conversation.filter((c) => !c.waiting_on_you);
  if (view.conversation_error) return <p className="rv-convo">Couldn't load what reviewers said: {view.conversation_error}</p>;
  if (!view.conversation.length) return null;

  // Posting is yours: Reply (or Cmd+Enter).
  function send(c: Convo, text: string) {
    const to = c.comments.at(-1)?.author ?? "them";
    if (!text.trim() || busy) return;
    setBusy(c.id);
    runUi(
      api.reply(view.card.id, c.id, text).pipe(
        Effect.match({
          onSuccess: () => {
            setSent((s) => ({ ...s, [c.id]: c.comments.at(-1)?.id ?? "" }));
            flash(`Sent your reply to ${to}`);
          },
          onFailure: (e) => {
            flash(e.message, true);
          },
        }),
        Effect.ensuring(
          Effect.sync(() => {
            setBusy(null);
          }),
        ),
      ),
    );
  }

  return (
    <section className="rv-convo" aria-label="Conversation">
      {waiting.length > 0 && (
        <h2 className="d-head">
          Waiting on your reply <span className="quiet">{waiting.length}</span>
        </h2>
      )}
      {waiting.map((c) => {
        const last = c.comments.at(-1)!;
        const text = drafts[c.id] ?? "";
        const [call = "", why] = (c.take?.take ?? "").split(/: (.*)/s);
        return (
          <article key={c.id} className="cv">
            <p className="cv-who">
              <span className="cv-author">
                {!last.bot && <Avatar login={last.author} />}
                {last.author}
              </span>
              <span>{where(c)}</span>
              <span>{age(last.at, now)}</span>
            </p>
            <p className="cv-gist">
              <Words text={c.take?.gist ?? firstLine(last.body)} />
            </p>
            {c.take && (
              <p className="cv-take">
                {why === undefined ? (
                  <Words text={call} />
                ) : (
                  <>
                    <b>{call}:</b> <Words text={why} />
                  </>
                )}
              </p>
            )}
            {!c.take && view.reading && <p className="quiet">{aiName()} is reading it.</p>}
            {!c.take && view.reading_error && (
              <p className="cv-take">
                {aiName()} couldn't read it: {view.reading_error}
              </p>
            )}
            <Said c={c} label={`What ${c.comments.length > 1 ? "was said" : `${last.author} wrote`}`} now={now} />
            <textarea
              className="cv-reply"
              aria-label={`Reply to ${last.author}`}
              placeholder={`Reply to ${last.author}`}
              value={text}
              onFocus={() => {
                on(c);
              }}
              onChange={(e) => {
                setDrafts((d) => ({ ...d, [c.id]: e.target.value }));
              }}
              onKeyDown={(e) => {
                if (e.repeat) return; // a held ⌘↩ would send it again
                if (e.key === "Escape") e.currentTarget.blur();
                else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  send(c, text);
                }
              }}
            />
            <div className="actions">
              <button
                type="button"
                className={cls("act", c.id === lead ? "primary" : "s-cta")}
                title={`Post this reply on GitHub, as you (${MOD}\u21b5)`}
                disabled={!text.trim() || busy === c.id}
                onClick={() => {
                  send(c, text);
                }}
              >
                {busy === c.id ? "Replying\u2026" : "Reply"}
              </button>
              <a className="act" href={c.url} target="_blank" rel="noreferrer">
                Open on GitHub
              </a>
              {agent && (
                <button
                  type="button"
                  className="act"
                  title="Your chat with your agent about this conversation; your reply here stays here, unsent"
                  onClick={() => {
                    onAsk(threadOf(view.card.id, c));
                  }}
                >
                  Ask your agent
                </button>
              )}
            </div>
          </article>
        );
      })}
      {Object.entries(sent).map(([id, url]) => (
        <p key={id} className="quiet">
          Sent your reply. <a href={url || view.card.url}>View it on GitHub</a>
        </p>
      ))}
      {rest.length > 0 && (
        <button
          type="button"
          className="rv-more"
          aria-expanded={more}
          onClick={() => {
            setMore(!more);
          }}
        >
          {rest.length} {waiting.length ? "more " : ""}
          {rest.length === 1 ? "conversation" : "conversations"} not waiting on you
        </button>
      )}
      {more &&
        rest.map((c) => {
          const [first, last] = [c.comments[0]!, c.comments.at(-1)!];
          return (
            <details
              key={c.id}
              className="cv-quiet"
              onToggle={(e) => {
                if (e.currentTarget.open) on(c);
              }}
            >
              <summary>
                <span className="cv-author">
                  {!first.bot && <Avatar login={first.author} />}
                  {first.author}
                </span>
                <span>{where(c)}</span>
                {c.resolved && <span>resolved</span>}
                <span className="cv-line">
                  <Words text={firstLine(last.body)} />
                </span>
              </summary>
              <Said c={c} now={now} />
            </details>
          );
        })}
    </section>
  );
}

// The original words as GitHub has them, code as code.
function Said({ c, label, now }: { c: Convo; label?: string; now: number }) {
  const body = (
    <ol className="cv-comments">
      {c.comments.map((x) => (
        <li key={x.id}>
          <p className="cv-who">
            <span className="cv-author">
              {!x.bot && <Avatar login={x.author} />}
              {x.author}
            </span>
            <span>{age(x.at, now)}</span>
          </p>
          <div className="cv-body">
            <SaidText text={x.body} />
          </div>
        </li>
      ))}
    </ol>
  );
  if (!label) return body;
  return (
    <details className="cv-said">
      <summary>{label}</summary>
      {body}
    </details>
  );
}
