import { useEffect, useRef } from "react";
import type { Card, GitHubAction, ItemDetail } from "../../../src/types.ts";
import { age, clearedText, cls, SNOOZE } from "../format.ts";
import { armOf, type Variant } from "../view.ts";
import { Detail } from "./Detail.tsx";
import { MoreButton, MoreMenu, rowActions } from "./More.tsx";

// Everything a row needs from the app; `run` takes the same keys as the keyboard (enter o e d s m b p c w i a t .).
export interface RowCtx {
  now: number;
  me: string; // your login, so events can say "you"
  selected: string | null;
  expanded: string | null;
  armed: string | null; // what a first m or a armed (armOf): a second one hands it off, or marks it ready
  leaving: Set<string>;
  snoozeFor: string | null;
  showSignals: boolean;
  details: Record<string, ItemDetail | string>; // string = load error
  boardLabel: (id: string) => string;
  click: (c: Card) => void;
  select: (c: Card) => void;
  run: (c: Card, key: string) => void;
  snooze: (c: Card, until: string) => void;
  closeSnooze: () => void;
  moreFor: string | null; // the row whose More menu (.) is open
  closeMore: () => void;
  github: (c: Card, action: GitHubAction) => void; // a More menu write, after its second press where it takes one
  flash: (text: string) => void;
}

// Your own PR's why is what you owe ("handed back: …"): a real "label:" leads in ink, the rest is regular, and the
// problem it names takes its colour.
export function Owed({ why, tone }: { why: string; tone?: string | undefined }) {
  const [head = "", tail] = why.split(/: (.*)/s);
  const t = cls("owed-text", tone && `t-${tone}`);
  return (
    <span className="why owed">
      {tail === undefined ? (
        <span className={t}>{why.charAt(0).toUpperCase() + why.slice(1)}</span>
      ) : (
        <>
          <b>{head.charAt(0).toUpperCase() + head.slice(1)}:</b> <span className={t}>{tail}</span>
        </>
      )}
    </span>
  );
}

// What a row under Later says after its ref: why it's there. The queue's rows say nothing more: being there is the why.
function noteOf(card: Card, variant: Variant): string {
  if (variant === "cleared") return clearedText(card);
  if (variant === "hidden") return card.why || "hidden by your rules";
  if (variant === "resolved") return card.resolved ?? card.why;
  return card.demoted ?? card.why;
}

// One line: the title, quietly its repo#number, its one call to action, its age on the right. Enter opens an issue (or `w`
// any item) in place under it.
export function CardRow({ card, variant, ctx, why }: { card: Card; variant: Variant; ctx: RowCtx; why?: boolean }) {
  const open = ctx.expanded === card.id;
  const sel = ctx.selected === card.id;
  const note = why ? noteOf(card, variant) : "";
  const armed = ctx.armed === armOf("a", card.id);
  // A resolved item isn't waiting any more: its time is when it resolved.
  const since = card.resolved_at ?? card.waiting_since;
  return (
    <div
      className={cls("line", sel && "sel", open && "open", ctx.leaving.has(card.id) && "leaving", variant !== "active" && "dim")}
      data-id={card.id}
    >
      {/* The row's button reaches over the whole line (CSS), so its call to action can be a button of its own. */}
      <div className="line-main line-row">
        {/* Focus selects (Tab and j/k are one cursor); not on mousedown, so a click opens without selecting first. */}
        <button
          type="button"
          className="row-main line-btn"
          aria-expanded={open}
          onMouseDown={(e) => {
            e.preventDefault();
          }}
          onClick={() => {
            ctx.click(card);
          }}
          onFocus={() => {
            ctx.select(card);
          }}
        >
          <span className="line-title">{card.title}</span>
          {/* A long repo name gives way before the title; the number never does. */}
          <span className="line-ref" title={`${card.repo}#${card.number}`}>
            {card.repo.split("/")[1]}
          </span>
          <span className="line-num">#{card.number}</span>
          {/* One line stands for its stack: where it sits in what's still to land. */}
          {card.stack && (
            <span className="line-stack" title={`${card.stack.pos} of ${card.stack.size} open PRs in its stack`}>
              {card.stack.pos}/{card.stack.size}
            </span>
          )}
          {note && <span className="line-note">{note}</span>}
        </button>
        {/* Under the cursor only: the quiet way to tell the coordinator something about it. */}
        {sel && !why && (
          <button
            type="button"
            className="act line-ask"
            title="Tell or ask your coordinator something about it"
            onClick={() => {
              ctx.run(card, "t");
            }}
          >
            <kbd>t</kbd>
            Ask
          </button>
        )}
        {/* Only where no call to action shows: the row keeps room for its title, and . still opens it. */}
        {sel && (!card.cta || !!why) && rowActions(card).length > 0 && (
          <MoreButton
            className="line-more"
            onClick={() => {
              ctx.run(card, ".");
            }}
          />
        )}
        {/* Filled and with its key only under the cursor, since that's the row the key acts on. */}
        {card.cta === "ready" && !why && (
          <button
            type="button"
            className={cls("act line-cta", sel && "primary", armed && "armed")}
            title="Mark it ready for review on GitHub: press a twice"
            onClick={() => {
              ctx.run(card, "a");
            }}
          >
            {sel && <kbd>a</kbd>}
            {armed ? "again to mark ready" : "Ready for review"}
          </button>
        )}
        {card.cta === "reply" && !why && (
          <button
            type="button"
            className={cls("act line-cta", sel && "primary")}
            title="Someone waits on your answer: Enter opens the review, with a reply ready"
            onClick={() => {
              ctx.click(card);
            }}
          >
            {sel && <kbd>enter</kbd>}
            Reply
          </button>
        )}
        <span className="line-age" title={`${card.resolved_at ? "resolved" : "waiting since"} ${new Date(since).toLocaleString()}`}>
          {age(since, ctx.now)}
        </span>
      </div>
      {open && <Detail card={card} detail={ctx.details[card.id]} ctx={ctx} />}
      {ctx.moreFor === card.id && (
        <MoreMenu
          card={card}
          actions={rowActions(card)}
          pick={(a) => {
            ctx.github(card, a);
          }}
          onClose={ctx.closeMore}
          flash={ctx.flash}
        />
      )}
      {/* Under the row, so it never covers the row itself. */}
      {ctx.snoozeFor === card.id && (
        <SnoozeMenu
          onPick={(until) => {
            ctx.snooze(card, until);
          }}
          onClose={ctx.closeSnooze}
        />
      )}
    </div>
  );
}

function SnoozeMenu({ onPick, onClose }: { onPick: (until: string) => void; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <>
      <div className="scrim-clear" role="presentation" onClick={onClose} />
      <div ref={menu} className="popover" role="menu" aria-label="Snooze">
        <div className="pop-title">Snooze</div>
        {SNOOZE.map((o) => (
          <button
            key={o.key}
            type="button"
            role="menuitem"
            className="pop-item"
            onClick={() => {
              onPick(o.until);
            }}
          >
            <kbd>{o.key}</kbd>
            <span>{o.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}
