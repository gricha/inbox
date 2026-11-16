import { Effect } from "effect";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
const STATE: Partial<Record<NonNullable<Convo["state"]>, { said: string; tone: string }>> = {
  approved: { said: "Approved", tone: "t-good" },
  changes_requested: { said: "Changes requested", tone: "t-warn" },
};

// A box you write in, as a row: your picture, words that grow the box as you write, and a round button that sends them
// (or Cmd+Enter). Esc leaves it with the words kept.
export function Composer({
  me,
  kind,
  label,
  value,
  onChange,
  onSend,
  busy,
  title,
  onFocus,
}: {
  me: string; // your login, for your picture
  kind: "cv-reply" | "rv-comment-input"; // a reply to a conversation, or your comment on the PR
  label: string; // its placeholder and name
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  busy: boolean;
  title: string; // the send button's
  onFocus?: () => void;
}) {
  return (
    <div className="cv-compose">
      {me && <Avatar login={me} />}
      <textarea
        className={kind}
        aria-label={label}
        placeholder={label}
        rows={1}
        value={value}
        onFocus={onFocus}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.repeat) return; // a held Cmd+Enter would send it again
          if (e.key === "Escape") e.currentTarget.blur();
          else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSend();
          }
        }}
      />
      <button
        type="button"
        className={cls("cv-send", busy && "sending")}
        data-key={`${MOD}\u21b5`}
        title={title}
        aria-label={title}
        disabled={!value.trim() || busy}
        onClick={onSend}
      >
        <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" />
        </svg>
      </button>
    </div>
  );
}

// What reviewers said, a card each: who, where and their words, your agent's read of one waiting on you, and a row to reply
// in. Those waiting on you come first. With nothing said yet, it says so; `foot` (your comment on the PR) closes it.
export function Conversation({
  view,
  me,
  now,
  flash,
  agent,
  onSpot,
  onAsk,
  foot,
}: {
  view: ReviewView;
  me: string; // your login: your picture by each box
  now: number;
  flash: (text: string, error?: boolean) => void;
  agent: boolean; // your agent is on: each card offers Ask your agent
  onSpot: (s: Spot) => void; // the conversation you're on, for what Ask your agent asks about
  onAsk: (s: Spot) => void;
  foot: ReactNode;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({}); // what you typed
  const [sent, setSent] = useState<Record<string, string>>({}); // replied to: its latest comment then, so anything newer (yours or theirs) shows it again
  const [busy, setBusy] = useState<string | null>(null);
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set()); // resolved ones you opened: each starts as one line
  const replied = useRef(""); // the PR whose reply box was focused for its Reply row

  // Opened from a Reply row: the first reply box is ready to type in (Cmd+Enter sends it, Esc leaves it).
  useEffect(() => {
    if (view.card.cta !== "reply" || replied.current === view.card.id) return;
    const box = document.querySelector<HTMLTextAreaElement>(".rv-convo .cv-reply");
    if (!box) return;
    replied.current = view.card.id;
    // Ask your agent opened while the review loaded has your typing: it never moves into a box that posts on GitHub.
    if (document.activeElement?.closest("input, textarea, [contenteditable='true']")) return;
    box.focus();
  }, [view]);

  const answered = (c: Convo) => sent[c.id] === c.comments.at(-1)?.id;
  const waits = (c: Convo) => c.waiting_on_you && !answered(c);
  const waiting = view.conversation.filter(waits);
  const list = [...waiting, ...view.conversation.filter((c) => !waits(c))];
  const open = view.item.state === "open"; // GitHub takes a reply only on an open PR

  // Posting is yours: the send button (or Cmd+Enter).
  function send(c: Convo, text: string) {
    const to = c.comments.at(-1)?.author ?? "them";
    if (!text.trim() || busy) return;
    setBusy(c.id);
    runUi(
      api.reply(view.card.id, c.id, text).pipe(
        Effect.match({
          onSuccess: () => {
            setSent((s) => ({ ...s, [c.id]: c.comments.at(-1)?.id ?? "" }));
            setDrafts((d) => ({ ...d, [c.id]: "" }));
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
      {view.conversation_error && <p className="cv-error">Couldn't load what reviewers said: {view.conversation_error}</p>}
      {!view.conversation_error && !list.length && (
        <div className="cv-empty">
          <p className="cv-empty-head">No conversation yet</p>
          <p className="quiet">Comments and review threads on this PR show here.</p>
        </div>
      )}
      {waiting.length > 0 && (
        <h2 className="d-head">
          Waiting on your reply <span className="quiet">{waiting.length}</span>
        </h2>
      )}
      {list.map((c) => {
        const last = c.comments.at(-1)!;
        const text = drafts[c.id] ?? "";
        const [call = "", why] = (c.take?.take ?? "").split(/: (.*)/s);
        const state = c.state ? STATE[c.state] : undefined;
        const first = c.comments[0]!;
        // A resolved one is one line until you open it: who, where, and how it began.
        if (c.resolved && !waits(c) && !shown.has(c.id))
          return (
            <button
              key={c.id}
              type="button"
              className="cv cv-resolved"
              aria-expanded="false"
              title="Show this resolved conversation"
              onClick={() => {
                setShown((cur) => new Set([...cur, c.id]));
              }}
            >
              <span className="cv-author">
                {!first.bot && <Avatar login={first.author} />}
                {first.author}
              </span>
              {c.path && <span>{where(c)}</span>}
              <span>resolved</span>
              <span className="cv-line">{saidLine(first.body)}</span>
            </button>
          );
        return (
          <article key={c.id} className={cls("cv", waits(c) && "cv-waiting")}>
            <ol className="cv-comments">
              {c.comments.map((x, i) => (
                <li key={x.id}>
                  <p className="cv-who">
                    <span className="cv-author">
                      {!x.bot && <Avatar login={x.author} />}
                      {x.author}
                    </span>
                    <span>{age(x.at, now)}</span>
                    {i === 0 && c.path && <span>{where(c)}</span>}
                    {i === 0 && c.resolved && <span>resolved</span>}
                    {i === 0 && state && <span className={state.tone}>{state.said}</span>}
                  </p>
                  <div className="cv-body">
                    <SaidText text={x.body} />
                  </div>
                </li>
              ))}
            </ol>
            {/* Your agent's read of one waiting on you: its call in semibold, then why. */}
            {waits(c) && c.take && (
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
            {waits(c) && !c.take && view.reading && <p className="cv-take quiet">{aiName()} is reading it.</p>}
            {waits(c) && !c.take && view.reading_error && (
              <p className="cv-take">
                {aiName()} couldn't read it: {view.reading_error}
              </p>
            )}
            <p className="cv-links">
              {answered(c) && <span className="quiet">Reply sent.</span>}
              <a href={c.url} target="_blank" rel="noreferrer">
                Open on GitHub
              </a>
              {agent && (
                <button
                  type="button"
                  className="link-btn"
                  title="Your chat with your agent about this conversation; your reply here stays here, unsent"
                  onClick={() => {
                    onAsk(threadOf(view.card.id, c));
                  }}
                >
                  Ask your agent
                </button>
              )}
            </p>
            {open && (
              <Composer
                me={me}
                kind="cv-reply"
                label={`Reply to ${last.author}\u2026`}
                value={text}
                busy={busy === c.id}
                title={`Post this reply on GitHub, as you (${MOD}\u21b5)`}
                onFocus={() => {
                  onSpot(threadOf(view.card.id, c));
                }}
                onChange={(t) => {
                  setDrafts((d) => ({ ...d, [c.id]: t }));
                }}
                onSend={() => {
                  send(c, text);
                }}
              />
            )}
          </article>
        );
      })}
      {foot}
    </section>
  );
}
