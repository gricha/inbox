import { useEffect, useRef } from "react";
import type { Card, ItemDetail } from "../../../src/types.ts";
import { age, clearedText, cls, shortRef, SNOOZE } from "../format.ts";
import { aiWord, cardFacts, keyParts, nextText, opening, problems, sizeOf, type Variant } from "../view.ts";
import { Detail, KeyButton } from "./Detail.tsx";
import { VERDICT } from "./Review.tsx";

// Everything a row needs from the app; `run` takes the same keys as the keyboard (enter o e s m p c w i).
export interface RowCtx {
  now: number;
  me: string; // your login, so events can say "you"
  selected: string | null;
  expanded: string | null;
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

// A card: its title; ref, why, problems, size and the AI's call; the AI's gist (or your PR's next step); a close look's concern.
export function CardRow({
  card,
  variant,
  ctx,
  inRun,
  away,
}: {
  card: Card;
  variant: Variant;
  ctx: RowCtx;
  inRun?: boolean;
  away?: boolean;
}) {
  const open = ctx.expanded === card.id;
  const sel = ctx.selected === card.id;
  const p = card.preflight;
  const ai = variant === "resolved" ? null : p ? aiWord(p) : card.verdict && { verdict: card.verdict, note: "" };
  const mine = card.kind === "pr" && !card.resolved && card.author.toLowerCase() === ctx.me.toLowerCase();
  const next = nextText(card);
  const older = !!p && p.state !== "ready";
  const summary = p?.summary && (sel ? p.summary : opening(p.summary));
  const concerns = p?.concerns ?? [];
  const shown = sel ? concerns : p?.verdict === "look" || p?.risk === "high" ? concerns.slice(0, 1).map((c) => opening(c, 0)) : [];
  // A problem the why already says colours the why instead of showing twice.
  const why = card.why.toLowerCase();
  const said = (f: { text: string }) => why.includes(f.text.toLowerCase());
  const extra = problems(card).filter((f) => !said(f));
  const tone = p && variant === "active" ? problems(card).find(said)?.tone : undefined;
  // Your own PR's why is what you owe ("babysitter asks: …"), so its label leads in ink.
  const [head = "", tail] = card.why.split(/: (.*)/s);
  const size = p && card.kind === "pr" ? sizeOf(card) : undefined;
  // A resolved item isn't waiting any more: its time is when it resolved.
  const since = card.resolved_at ?? card.waiting_since;
  return (
    <div
      className={cls(
        "row",
        "card",
        `b-${card.bucket}`,
        sel && "sel",
        open && "open",
        ctx.leaving.has(card.id) && "leaving",
        variant !== "active" && "dim",
      )}
      data-id={card.id}
    >
      <div className="row-line">
        {/* Focus selects (Tab and j/k are one cursor); not on mousedown, as the selected card grows and would shift this one. */}
        <button
          type="button"
          className="row-main"
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
          <span className="title-line">
            <span className="title">{card.title}</span>
            {card.new && (
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a CSS-drawn dot with no image file behind it
              <span className="new-dot" role="img" aria-label="new activity" title="New activity since you looked" />
            )}
            {card.pinned && <PinGlyph />}
          </span>
          <span className="age" title={`${card.resolved_at ? "resolved" : "waiting since"} ${new Date(since).toLocaleString()}`}>
            {age(since, ctx.now)}
          </span>
          {/* Refs read down the left edge and the AI's calls down the right. */}
          <span className="card-line">
            <span className="meta">
              <span className="ref" title={`${card.repo}#${card.number}`} aria-label={shortRef(card)}>
                <span className="ref-ink">
                  <span className="ref-repo">{card.repo.split("/")[1]}</span>#{card.number}
                </span>
              </span>
              {variant === "cleared" ? (
                <span>{clearedText(card)}</span>
              ) : variant === "hidden" ? (
                <span>Hidden by a rule. Open it to see which.</span>
              ) : (
                (!inRun || variant === "resolved") &&
                card.why &&
                (mine && p ? (
                  <span className="why owed">
                    <b className={tone && `t-${tone}`}>
                      {head.charAt(0).toUpperCase() + head.slice(1)}
                      {tail !== undefined && ":"}
                    </b>
                    {tail && ` ${tail}`}
                  </span>
                ) : (
                  <span className={cls("why", tone && `t-${tone}`)}>{card.why}</span>
                ))
              )}
              {variant !== "resolved" &&
                extra.map((f) => (
                  <span key={f.text} className={`fact-word t-${f.tone}`}>
                    {f.text}
                  </span>
                ))}
              {away && card.demoted && <span>{card.demoted}</span>}
            </span>
            {(size !== undefined || ai) && (
              <span className="ai-word">
                {size && <span className="size">{size}</span>}
                {ai?.verdict && p?.risk === "high" && <span className="t-bad">high risk</span>}
                {ai?.verdict && <span className={`verdict v-${ai.verdict}`}>{VERDICT[ai.verdict]}</span>}
                {ai?.note && <span>{ai.note}</span>}
              </span>
            )}
          </span>
          {summary ? (
            <span className={cls("gist", older && "older", !sel && "clip")}>{summary}</span>
          ) : (
            next && <span className="gist">{keyParts(next).map((part, i) => (i % 2 ? <b key={part}>{part}</b> : part))}</span>
          )}
          {shown.map((c) => (
            <span key={c} className={cls("concern", older && "older", !sel && "clip")}>
              {c}
            </span>
          ))}
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
      </div>
      {sel && !open && <More card={card} ctx={ctx} mine={mine} />}
      {open && <Detail card={card} detail={ctx.details[card.id]} ctx={ctx} />}
      {/* Under the card, so it never covers the card's own keys. */}
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

// The selected card's rest: its facts and its keys.
function More({ card, ctx, mine }: { card: Card; ctx: RowCtx; mine: boolean }) {
  const run = (k: string) => {
    ctx.run(card, k);
  };
  const facts = cardFacts(card, ctx.me);
  return (
    <div className="more">
      {facts.length > 0 && (
        <p className="card-facts">
          {facts.map((f) => (
            <span key={f}>{f}</span>
          ))}
        </p>
      )}
      <div className="actions card-keys">
        <KeyButton k="enter" label={card.kind !== "pr" ? "Open" : card.inflight ? "Show in flight" : "Review"} run={run} />
        <KeyButton k="o" label="Open on GitHub" run={run} />
        {mine && <KeyButton k="d" label={card.inflight ? "Take back" : "In flight"} run={run} />}
        {/* A PR in flight is its babysitter's: d takes it back first. */}
        {!card.inflight && (
          <>
            <KeyButton k="e" label={card.status === "active" ? "Done" : "Restore"} run={run} />
            <KeyButton k="s" label="Snooze" run={run} />
            <KeyButton k="m" label={card.status === "muted" ? "Unmute" : "Mute"} run={run} />
          </>
        )}
      </div>
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
