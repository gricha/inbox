import type { MailCard } from "../../../src/types.ts";
import { age, cls } from "../format.ts";

export interface MailCtx {
  now: number;
  selected: string | null;
  expanded: string | null;
  leaving: Set<string>;
  select: (m: MailCard) => void;
  toggle: (m: MailCard) => void; // a click: its detail in place, or closed again
  act: (m: MailCard, action: "done" | "snooze" | "mute", until?: string) => void;
}

export const openMail = (m: MailCard) => {
  window.open(m.url, "_blank", "noopener,noreferrer");
};

// An urgent email, a row like a PR's: Email, its subject, quietly your agent's why, Open in Gmail, its sender where "by" goes,
// how many messages where the stage goes, its age. A click opens it in place.
export function MailRow({ m, ctx }: { m: MailCard; ctx: MailCtx }) {
  const open = ctx.expanded === m.id;
  return (
    <div
      className={cls("line session mail", ctx.selected === m.id && "sel", open && "open", ctx.leaving.has(m.id) && "leaving")}
      data-id={m.id}
    >
      <div className="line-main line-row">
        <button
          type="button"
          className="row-main line-btn"
          aria-expanded={open}
          onMouseDown={(e) => {
            e.preventDefault();
          }}
          onClick={() => {
            ctx.toggle(m);
          }}
          onFocus={() => {
            ctx.select(m);
          }}
        >
          <span className="line-kind">Email</span>
          <span className="line-title">{m.subject}</span>
          {m.why && (
            <span className="line-note" title={m.why}>
              {m.why}
            </span>
          )}
        </button>
        <button
          type="button"
          className="act line-cta"
          title="Open the thread in Gmail"
          onClick={() => {
            openMail(m);
          }}
        >
          Open
        </button>
        <span className="line-by" title={m.from_email}>
          {m.from}
        </span>
        <span className="line-stage">{m.messages > 1 ? `${m.messages} messages` : "unread"}</span>
        <span className="line-age" title={`latest ${new Date(m.since).toLocaleString()}`}>
          {age(m.since, ctx.now)}
        </span>
      </div>
      {open && <MailDetail m={m} ctx={ctx} />}
    </div>
  );
}

// Opened in place: why your agent raised it, its latest message's start, and what you can do with it.
function MailDetail({ m, ctx }: { m: MailCard; ctx: MailCtx }) {
  return (
    <div className="more opened session-more">
      {m.why && (
        <p className="d-why">
          <b>{m.why}</b>
        </p>
      )}
      {m.snippet && <p className="session-said">{m.snippet}</p>}
      <p className="card-facts dots">
        <span>
          {m.from} &lt;{m.from_email}&gt;
        </span>
        <span>{new Date(m.since).toLocaleString()}</span>
        <span>It leaves once you read or archive it in Gmail.</span>
      </p>
      <div className="actions card-keys">
        <button
          type="button"
          className="act primary"
          onClick={() => {
            openMail(m);
          }}
        >
          Open in Gmail
        </button>
        <button
          type="button"
          className="act"
          title="Until a new message in the thread"
          onClick={() => {
            ctx.act(m, "done");
          }}
        >
          Done
        </button>
        <button
          type="button"
          className="act"
          title="Until tomorrow at 9"
          onClick={() => {
            ctx.act(m, "snooze");
          }}
        >
          Snooze
        </button>
        <button
          type="button"
          className="act"
          title="Never raise this thread again"
          onClick={() => {
            ctx.act(m, "mute");
          }}
        >
          Mute
        </button>
        <button
          type="button"
          className="act"
          title="Close (Esc)"
          onClick={() => {
            ctx.toggle(m);
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
}
