import { useEffect, useRef, useState } from "react";
import type { Conversation as Convo, ReviewView } from "../../../src/types.ts";
import { api, message } from "../api.ts";
import { age, cls } from "../format.ts";
import type { Thread } from "./Composer.tsx";

const ARM_MS = 3000;
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

const where = (c: Convo) => (c.path ? `${c.path}${c.line ? `:${c.line}` : ""}${c.outdated ? ", outdated" : ""}` : "on the PR");
const firstLine = (s: string) => {
  const line = s.trim().split("\n")[0] ?? "";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
};

// What reviewers said: each one waiting on you with Claude's read first and a reply box; the rest fold into one line.
export function Conversation({
  view,
  now,
  flash,
  onThread,
  onAsk,
}: {
  view: ReviewView;
  now: number;
  flash: (text: string, error?: boolean, ms?: number) => void;
  onThread: (t: Thread) => void;
  onAsk: (t: Thread) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({}); // what you typed, over Claude's suggestion
  const [sent, setSent] = useState<Record<string, string>>({}); // until the sync shows your reply: its url
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const replied = useRef(""); // the PR whose reply box was focused for its Reply row

  useEffect(() => {
    const t = armed
      ? setTimeout(() => {
          setArmed(null);
        }, ARM_MS)
      : undefined;
    return () => {
      clearTimeout(t);
    };
  }, [armed]);

  // Opened from a Reply row: the first reply box is ready to type in (⌘↩ twice sends it, Esc leaves it).
  useEffect(() => {
    if (view.card.cta !== "reply" || replied.current === view.card.id) return;
    const box = document.querySelector<HTMLTextAreaElement>(".cv-reply");
    if (!box) return;
    replied.current = view.card.id;
    box.focus();
  }, [view]);

  const waiting = view.conversation.filter((c) => c.waiting_on_you && !(c.id in sent));
  // What an ask to the coordinator is about: "dana's thread on src/auth.ts:42".
  const threadOf = (c: Convo): Thread => ({
    item: view.card.id,
    id: c.id,
    url: c.url,
    label: `${c.comments[0]?.author ?? "their"}'s ${c.kind}${c.path ? ` on ${where(c)}` : ""}`,
  });
  const on = (c: Convo) => {
    onThread(threadOf(c));
  };
  const rest = view.conversation.filter((c) => !c.waiting_on_you);
  if (view.conversation_error) return <p className="rv-convo">Couldn't load what reviewers said: {view.conversation_error}</p>;
  if (!view.conversation.length)
    return (
      <section className="rv-convo" aria-label="Conversation">
        <p className="quiet">Nothing from reviewers yet.</p>
      </section>
    );

  // Sending is yours: Send (or ⌘↩) twice.
  async function send(c: Convo, text: string) {
    const to = c.comments.at(-1)?.author ?? "them";
    if (!text.trim() || busy) return;
    if (armed !== c.id) {
      setArmed(c.id);
      flash(`Press Send again to post your reply to ${to}`, false, ARM_MS);
      return;
    }
    setArmed(null);
    setBusy(c.id);
    try {
      const { url } = await api.reply(view.card.id, c.id, text);
      setSent((s) => ({ ...s, [c.id]: url }));
      flash(`Sent your reply to ${to}`);
    } catch (e) {
      flash(message(e), true);
    } finally {
      setBusy(null);
    }
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
        const text = drafts[c.id] ?? c.take?.reply ?? "";
        const [call = "", why] = (c.take?.take ?? "").split(/: (.*)/s);
        return (
          <article key={c.id} className="cv">
            <p className="cv-who">
              <span className="cv-author">{last.author}</span>
              <span>{where(c)}</span>
              <span>{age(last.at, now)}</span>
            </p>
            <p className="cv-gist">{c.take?.gist ?? firstLine(last.body)}</p>
            {c.take && (
              <p className="cv-take">
                {why === undefined ? (
                  call
                ) : (
                  <>
                    <b>{call}:</b> {why}
                  </>
                )}
              </p>
            )}
            {!c.take && view.reading && <p className="quiet">Claude is reading it.</p>}
            {!c.take && view.reading_error && <p className="cv-take">Claude couldn't read it: {view.reading_error}</p>}
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
                if (armed === c.id) setArmed(null);
              }}
              onKeyDown={(e) => {
                if (e.repeat) return; // a held ⌘↩ would arm and send
                if (e.key === "Escape") e.currentTarget.blur();
                else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send(c, text);
                }
              }}
            />
            <div className="actions">
              <button
                type="button"
                className={cls("act primary", armed === c.id && "armed")}
                title={`Post this reply on GitHub, as you: Send twice, or ${MOD}↵ twice`}
                disabled={!text.trim() || busy === c.id}
                onClick={() => {
                  void send(c, text);
                }}
              >
                <kbd>{MOD}↵</kbd>
                {busy === c.id ? "Sending…" : armed === c.id ? "Send again to post" : "Send"}
              </button>
              <a className="act" href={c.url} target="_blank" rel="noreferrer">
                Open on GitHub
              </a>
              <button
                type="button"
                className="act"
                title="Tell or ask your coordinator something about this conversation (t)"
                onClick={() => {
                  on(c);
                  onAsk(threadOf(c));
                }}
              >
                Ask coordinator
              </button>
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
                <span className="cv-author">{first.author}</span>
                <span>{where(c)}</span>
                {c.resolved && <span>resolved</span>}
                <span className="cv-line">{firstLine(last.body)}</span>
              </summary>
              <Said c={c} now={now} />
            </details>
          );
        })}
    </section>
  );
}

// The original words: plain text, as GitHub has them.
function Said({ c, label, now }: { c: Convo; label?: string; now: number }) {
  const body = (
    <ol className="cv-comments">
      {c.comments.map((x) => (
        <li key={x.id}>
          <p className="cv-who">
            <span className="cv-author">{x.author}</span>
            <span>{age(x.at, now)}</span>
          </p>
          <p className="cv-body">{x.body.trim()}</p>
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
