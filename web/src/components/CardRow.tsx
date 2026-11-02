import { useEffect, useRef } from "react";
import type { Card, ItemDetail } from "../../../src/types.ts";
import { age, clearedText, cls, SNOOZE } from "../format.ts";
import { armOf, type Variant } from "../view.ts";
import { Detail } from "./Detail.tsx";

// Everything a row needs from the app; `run` takes the same keys as the keyboard (enter o e d s m b p c w i a).
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
      {/* Focus selects (Tab and j/k are one cursor); not on mousedown, so a click opens without selecting first. */}
      <button
        type="button"
        className="row-main line-main"
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
        <span className="line-ref" title={`${card.repo}#${card.number}`}>
          {card.repo.split("/")[1]}#{card.number}
        </span>
        {note && <span className="line-note">{note}</span>}
        {card.cta === "ready" && !why && (
          <span className={cls("line-cta", armed && "armed")} title="Mark it ready for review on GitHub: press a twice">
            <kbd>a</kbd> {armed ? "again to mark ready" : "Ready for review"}
          </span>
        )}
        <span className="line-age" title={`${card.resolved_at ? "resolved" : "waiting since"} ${new Date(since).toLocaleString()}`}>
          {age(since, ctx.now)}
        </span>
      </button>
      {open && <Detail card={card} detail={ctx.details[card.id]} ctx={ctx} />}
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
