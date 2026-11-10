import { SESSION_KIND, type SessionAction, type SessionCard } from "../../../src/types.ts";
import { age, cls } from "../format.ts";

export interface SessionCtx {
  now: number;
  selected: string | null;
  expanded: string | null;
  leaving: Set<string>;
  select: (s: SessionCard) => void;
  toggle: (s: SessionCard) => void; // a click: its detail in place, or closed again
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

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// A Claude Code or Codex session that needs you, a row like a PR's: Session, its name, quietly its folder, its call to
// action, its kind where who it's from goes, why it's here where a PR's stage goes, its age. A click opens it in place.
export function SessionRow({ s, ctx }: { s: SessionCard; ctx: SessionCtx }) {
  const open = ctx.expanded === s.id;
  const folder = s.cwd.split(/[\\/]/).findLast(Boolean) ?? s.cwd;
  const [first] = s.actions;
  return (
    <div className={cls("line session", ctx.selected === s.id && "sel", open && "open", ctx.leaving.has(s.id) && "leaving")} data-id={s.id}>
      <div className="line-main line-row">
        <button
          type="button"
          className="row-main line-btn"
          aria-expanded={open}
          onMouseDown={(e) => {
            e.preventDefault();
          }}
          onClick={() => {
            ctx.toggle(s);
          }}
          onFocus={() => {
            ctx.select(s);
          }}
        >
          <span className="line-kind">Session</span>
          <span className="line-title">{s.name}</span>
          <span className="line-ref" title={s.cwd}>
            {folder}
          </span>
        </button>
        {first && first !== "attach" && (
          <button
            type="button"
            className="act line-cta"
            title={SESSION_ACTION[first].title}
            onClick={() => {
              ctx.start(s, first);
            }}
          >
            {SESSION_ACTION[first].label}
          </button>
        )}
        <span className="line-by">{SESSION_KIND[s.kind]}</span>
        <span className="line-stage" title={s.reason}>
          {s.reason}
        </span>
        <span className="line-age" title={`since ${new Date(s.since).toLocaleString()}`}>
          {age(s.since, ctx.now)}
        </span>
      </div>
      {open && <SessionDetail s={s} ctx={ctx} />}
    </div>
  );
}

// Opened in place: why it's here and what it last said, where it runs, and what you can do with it.
function SessionDetail({ s, ctx }: { s: SessionCard; ctx: SessionCtx }) {
  const facts = [
    SESSION_KIND[s.kind],
    s.cwd,
    ...(s.branch ? [s.branch] : []),
    s.kind === "codex" ? null : s.alive ? "running" : "no process",
  ].filter((f): f is string => !!f);
  const where =
    s.kind === "cli" && s.alive
      ? "It runs in a terminal: go back to it there."
      : s.resets_at && Date.parse(s.resets_at) > ctx.now
        ? "Kick it once its rate limit resets."
        : null;
  return (
    <div className="more opened session-more">
      <p className="d-why">
        <b>{cap(s.reason)}</b> for {age(s.since, ctx.now)}.
      </p>
      {s.excerpt && <p className="session-said">{s.excerpt}</p>}
      <p className="card-facts dots">
        {facts.map((f) => (
          <span key={f}>{f}</span>
        ))}
      </p>
      {where && <p className="session-note">{where}</p>}
      <div className="actions card-keys">
        {s.actions.map((a, i) => (
          <button
            key={a}
            type="button"
            className={cls("act", i === 0 && "primary")}
            title={a === "attach" && s.attach ? s.attach : SESSION_ACTION[a].title}
            onClick={() => {
              ctx.start(s, a);
            }}
          >
            {SESSION_ACTION[a].label}
          </button>
        ))}
        <button
          type="button"
          className="act"
          onClick={() => {
            ctx.act(s, "done");
          }}
        >
          Done
        </button>
        <button
          type="button"
          className="act"
          title="Until tomorrow at 9"
          onClick={() => {
            ctx.act(s, "snooze");
          }}
        >
          Snooze
        </button>
        <button
          type="button"
          className="act"
          onClick={() => {
            ctx.act(s, "mute");
          }}
        >
          Mute
        </button>
        <button
          type="button"
          className="act"
          title="Close (Esc)"
          onClick={() => {
            ctx.toggle(s);
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
}
