import { useEffect, useRef } from "react";
import type { Card, ItemDetail } from "../../../src/types.ts";
import { age, clearedText, cls, shortRef, SNOOZE } from "../format.ts";
import type { Variant } from "../view.ts";
import { Detail } from "./Detail.tsx";

// Everything a row needs from the app; `run` takes the same keys as the keyboard (o e s m p c w i).
export interface RowCtx {
  now: number;
  selected: string | null;
  expanded: string | null;
  leaving: Set<string>;
  snoozeFor: string | null;
  showSignals: boolean;
  details: Record<string, ItemDetail | string>; // string = load error
  analyzing: Set<string>;
  briefErrors: Record<string, string>; // last failed brief per card, until the next try
  boardLabel: (id: string) => string;
  click: (c: Card) => void;
  select: (c: Card) => void;
  run: (c: Card, key: string) => void;
  snooze: (c: Card, until: string) => void;
  closeSnooze: () => void;
  restore: (c: Card) => void;
}

function PinGlyph() {
  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- inline SVG needs role="img" to be announced; <img> can't hold it
    <svg className="pin" viewBox="0 0 16 16" role="img" aria-label="pinned">
      <path d="M10.3 1.2a.7.7 0 0 1 1 0l3.5 3.5a.7.7 0 0 1 0 1l-.9.9a.7.7 0 0 1-.8.1l-2.3 2.3.2 2.6a.7.7 0 0 1-.2.5l-.8.8a.7.7 0 0 1-1 0L6.5 10.4 2.6 14.3a.5.5 0 0 1-.7-.7L5.8 9.7 3.4 7.2a.7.7 0 0 1 0-1l.8-.8a.7.7 0 0 1 .5-.2l2.6.2 2.3-2.3a.7.7 0 0 1 .1-.8Z" />
    </svg>
  );
}

// Chips from the server become plain words; only problems get a colour.
function word(chip: string): { text: string; tone?: "bad" | "warn" | "good" } {
  if (chip === "CI red") return { text: "CI failing", tone: "bad" };
  if (chip === "conflict") return { text: "merge conflict", tone: "warn" };
  if (chip === "changes requested") return { text: chip, tone: "warn" };
  if (chip === "approved") return { text: chip, tone: "good" };
  return { text: chip };
}

export function CardRow({ card, variant, ctx, inRun }: { card: Card; variant: Variant; ctx: RowCtx; inRun?: boolean }) {
  const open = ctx.expanded === card.id;
  // Skip facts the reason already says ("merge conflict" twice reads as noise).
  const facts = card.chips.map(word).filter((f) => !card.why.toLowerCase().includes(f.text.toLowerCase()));
  const words = (
    <>
      {facts.map((f) => (
        <span key={f.text} className={cls("fact-word", f.tone && `t-${f.tone}`)}>
          {f.text}
        </span>
      ))}
      {card.verdict && (
        <span className={`fact-word verdict v-${card.verdict}`} title="Claude's brief">
          brief says {card.verdict}
        </span>
      )}
      {card.demoted && <span className="fact-word demoted">{card.demoted}</span>}
    </>
  );
  const compact = !!inRun && variant === "active";
  return (
    <div
      className={cls(
        "row",
        `b-${card.bucket}`,
        ctx.selected === card.id && "sel",
        open && "open",
        ctx.leaving.has(card.id) && "leaving",
        variant !== "active" && "dim",
      )}
      data-id={card.id}
    >
      <div className="row-line">
        {/* Tab focus and the j/k cursor are the same thing. */}
        <button
          type="button"
          className="row-main"
          aria-expanded={open}
          onClick={() => {
            ctx.click(card);
          }}
          onFocus={() => {
            ctx.select(card);
          }}
        >
          <span className="ref" title={`${card.repo}#${card.number}`} aria-label={shortRef(card)}>
            <span className="ref-ink">
              <span className="ref-repo">{card.repo.split("/")[1]}</span>#{card.number}
            </span>
          </span>
          <span className="row-body">
            <span className="title-line">
              <span className="title" title={card.title}>
                {card.title}
              </span>
              {card.new && (
                // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a CSS-drawn dot with no image file behind it
                <span className="new-dot" role="img" aria-label="new activity" title="New activity since you looked" />
              )}
              {card.pinned && <PinGlyph />}
              {/* In a run the header already says who and why, so the facts fit on the title line. */}
              {compact && <span className="meta inline">{words}</span>}
            </span>
            {!compact && (
              <span className="meta">
                {variant === "cleared" ? (
                  <span>{clearedText(card)}</span>
                ) : variant === "hidden" ? (
                  <span>Hidden by a rule. Open it to see which.</span>
                ) : (
                  <>
                    {!inRun && !card.why.startsWith(card.author) && <span className="who">{card.author}</span>}
                    {!inRun && card.why && <span className="why">{card.why}</span>}
                  </>
                )}
                {words}
              </span>
            )}
          </span>
          <span className="age" title={`waiting since ${new Date(card.waiting_since).toLocaleString()}`}>
            {age(card.waiting_since, ctx.now)}
          </span>
        </button>
        {variant === "cleared" && (
          <button
            type="button"
            className="btn ghost restore"
            onClick={() => {
              ctx.restore(card);
            }}
          >
            Restore
          </button>
        )}
        {ctx.snoozeFor === card.id && (
          <SnoozeMenu
            onPick={(until) => {
              ctx.snooze(card, until);
            }}
            onClose={ctx.closeSnooze}
          />
        )}
      </div>
      {open && <Detail card={card} detail={ctx.details[card.id]} ctx={ctx} />}
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
            <span>{o.label}</span>
            <kbd>{o.key}</kbd>
          </button>
        ))}
      </div>
    </>
  );
}
