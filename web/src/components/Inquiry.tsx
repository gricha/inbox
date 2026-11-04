import type { Inquiry } from "../../../src/types.ts";
import { age, cls } from "../format.ts";
import { inquiryOf } from "../view.ts";

// What an agent's row needs from the app.
export interface InquiryCtx {
  now: number;
  selected: string | null;
  expanded: string | null;
  select: (q: Inquiry) => void;
  open: (q: Inquiry) => void; // Enter: opens it in place to answer, or closes it
  draft: (q: Inquiry) => string; // what you're writing to it, kept by the app so a failed send keeps it
  write: (q: Inquiry, text: string) => void;
  answer: (q: Inquiry, text: string) => void;
  dismiss: (q: Inquiry) => void;
}

// An agent session's question for you, a row like a PR's labeled Agent: Enter opens it in place, 1–6 picks an offered
// answer, or you write your own; d dismisses it. Its text is the agent's: shown as text, never as markup.
export function InquiryRow({ q, ctx }: { q: Inquiry; ctx: InquiryCtx }) {
  const id = inquiryOf(q.id);
  const sel = ctx.selected === id;
  const open = ctx.expanded === id;
  const text = ctx.draft(q);
  return (
    <div className={cls("line inq", sel && "sel", open && "open")} data-id={id}>
      <div className="line-main line-row">
        <button
          type="button"
          className="row-main line-btn"
          aria-expanded={open}
          onMouseDown={(e) => {
            e.preventDefault();
          }}
          onClick={() => {
            ctx.open(q);
          }}
          onFocus={() => {
            ctx.select(q);
          }}
        >
          <span className="line-kind">Agent</span>
          <span className="line-title">{q.question}</span>
          <span className="line-ref inq-from" title={q.from}>
            {q.from}
          </span>
        </button>
        {!open && (
          <button
            type="button"
            className={cls("act line-cta line-reply", sel && "primary")}
            onClick={() => {
              ctx.open(q);
            }}
          >
            {sel && <kbd>enter</kbd>}
            Answer
          </button>
        )}
        <span className="line-age" title={`asked ${new Date(q.at).toLocaleString()}`}>
          {age(q.at, ctx.now)}
        </span>
      </div>
      {open && (
        <div className="inq-open">
          {q.context && <p className="inq-context">{q.context}</p>}
          {q.options.length > 0 && (
            <div className="actions inq-options">
              {q.options.map((o, i) => (
                <button
                  key={o}
                  type="button"
                  className={cls("act", i === 0 && "primary")}
                  onClick={() => {
                    ctx.answer(q, o);
                  }}
                >
                  <kbd>{i + 1}</kbd>
                  {o}
                </button>
              ))}
            </div>
          )}
          <div className="inq-write">
            <input
              className="inq-input"
              aria-label={`Your answer to ${q.from}`}
              placeholder={q.options.length ? "Or write your own answer" : "Your answer"}
              value={text}
              maxLength={2000}
              onChange={(e) => {
                ctx.write(q, e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.repeat && !e.nativeEvent.isComposing && text.trim()) {
                  e.preventDefault();
                  ctx.answer(q, text);
                } else if (e.key === "Escape") e.currentTarget.blur();
              }}
            />
            <button
              type="button"
              className="act"
              disabled={!text.trim()}
              onClick={() => {
                ctx.answer(q, text);
              }}
            >
              <kbd>↵</kbd>
              Send
            </button>
            <button
              type="button"
              className="act"
              title="Leave it unanswered: the agent decides itself"
              onClick={() => {
                ctx.dismiss(q);
              }}
            >
              <kbd>d</kbd>
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
