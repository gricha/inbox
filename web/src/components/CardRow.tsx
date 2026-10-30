import { Fragment, useEffect, useRef } from "react";
import type { Card, ItemDetail } from "../../../src/types.ts";
import { age, clearedText, cls, eventText, shortRef, SNOOZE } from "../format.ts";
import {
  aiWord,
  cardFacts,
  checkNames,
  firstClause,
  keepUnits,
  keyParts,
  nextText,
  opening,
  problems,
  says,
  sizeOf,
  type Variant,
} from "../view.ts";
import { Detail, Dots, KeyButton } from "./Detail.tsx";
import { VERDICT } from "./Review.tsx";

// Everything a row needs from the app; `run` takes the same keys as the keyboard (enter o e s m p c w i y).
export interface RowCtx {
  now: number;
  me: string; // your login, so events can say "you"
  selected: string | null;
  expanded: string | null;
  armed: string | null; // the draft a first y armed: a second y sends it
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

function PinGlyph() {
  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- inline SVG needs role="img" to be announced; <img> can't hold it
    <svg className="pin" viewBox="0 0 16 16" role="img" aria-label="pinned">
      <path d="M10.3 1.2a.7.7 0 0 1 1 0l3.5 3.5a.7.7 0 0 1 0 1l-.9.9a.7.7 0 0 1-.8.1l-2.3 2.3.2 2.6a.7.7 0 0 1-.2.5l-.8.8a.7.7 0 0 1-1 0L6.5 10.4 2.6 14.3a.5.5 0 0 1-.7-.7L5.8 9.7 3.4 7.2a.7.7 0 0 1 0-1l.8-.8a.7.7 0 0 1 .5-.2l2.6.2 2.3-2.3a.7.7 0 0 1 .1-.8Z" />
    </svg>
  );
}

// Your own PR's why is what you owe ("babysitter asks: …"): a real "label:" leads in ink, the rest is regular, and the
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

// Keys in a line of text ("d hands it to a babysitter") set apart.
export const withKeys = (text: string) => keyParts(text).map((part, i) => (i % 2 ? <b key={part}>{part}</b> : part));

// A card: its title; ref, why, problems, size and the AI's call; the AI's gist (or your PR's next step, or an issue's latest
// event); a close look's concern. Compact (your PRs in a stack): the title and the ref line only.
// A babysitter's question needs you, not its PR's problems (its babysitter has those): they stay in the lane.
const asks = (why: string) => /^(babysitter|your agent) asks: /.test(why);
// An issue's why that only says something happened: its latest event says what.
const onlyNews = (why: string) => /^new (activity|replies|comments)\b/i.test(why);

export function CardRow({
  card,
  variant,
  ctx,
  inRun,
  away,
  compact,
}: {
  card: Card;
  variant: Variant;
  ctx: RowCtx;
  inRun?: boolean;
  away?: boolean;
  compact?: boolean;
}) {
  const open = ctx.expanded === card.id;
  const sel = ctx.selected === card.id;
  const p = card.preflight;
  const ai = variant === "resolved" ? null : p ? aiWord(p) : card.verdict && { verdict: card.verdict, note: "" };
  const mine = card.kind === "pr" && !card.resolved && card.author.toLowerCase() === ctx.me.toLowerCase();
  const next = nextText(card);
  const older = !!p && p.state !== "ready";
  // The gist is as long as the call is heavy: up to three lines to look closely, two to skim, one to skip.
  const lines = p?.verdict === "skip" ? 1 : p?.verdict === "skim" ? 2 : 3;
  // Selected, about four lines of it: Enter opens the review with the rest.
  const gist =
    p?.summary && (sel ? opening(p.summary, 320) : lines === 1 ? firstClause(p.summary) : opening(p.summary, lines === 2 ? 140 : 200));
  const summary = gist && keepUnits(gist);
  const concerns = (p?.concerns ?? []).map(keepUnits);
  const shown = sel ? concerns : p?.verdict === "look" || p?.risk === "high" ? concerns.slice(0, 1).map((c) => opening(c, 0, false)) : [];
  // Your red PR says what failed; a check its base branch doesn't require is only a fact.
  const required = (card.checks_failed ?? []).filter((n) => !card.checks_optional?.includes(n));
  // In flight, what failed goes with the problem word, as in the lane ("CI failing: node 22, lint"); otherwise the third line
  // says it with the key that deals with it.
  const named = mine && card.inflight && card.ci === "red" && required.length ? `CI failing: ${checkNames(required)}` : "";
  const failing = mine && !card.inflight && card.ci === "red" && required.length ? `${checkNames(required)} failing` : "";
  const optional = mine && card.ci !== "red" && card.checks_optional?.length ? "optional check failing" : "";
  const event = card.kind === "issue" && variant === "active" ? card.last_event : undefined;
  const why =
    event && onlyNews(card.why)
      ? (card.involved ?? "")
      : named && card.why.endsWith("CI failing")
        ? `${card.why}: ${checkNames(required)}`
        : card.why;
  // A problem the why already says colours the why instead of showing twice.
  const said = (f: { text: string }) => says(why, f.text);
  const all = problems(card);
  const ci = all.find((f) => f.text === "CI failing");
  if (named && ci) ci.text = named;
  const extra = asks(card.why) ? [] : all.filter((f) => !said(f));
  const tone = p && variant === "active" ? all.find(said)?.tone : undefined;
  // Your own PR's size tells you nothing.
  const size = p && card.kind === "pr" && !mine ? sizeOf(card) : undefined;
  const reply = mine && card.inflight ? card.reply : undefined;
  // In flight with no clone to work in: where to set one up.
  const noClone = mine && card.inflight ? /no local clone of (\S+?),/.exec(card.why)?.[1] : undefined;
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
            {card.new && !event && (
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
                why &&
                (mine && p ? <Owed why={why} tone={tone} /> : <span className={cls("why", tone && `t-${tone}`)}>{why}</span>)
              )}
              {variant !== "resolved" &&
                extra.map((f) => (
                  <span key={f.text} className={`fact-word t-${f.tone}`}>
                    {atCommas(f.text)}
                  </span>
                ))}
              {compact && failing && <span className="fact-word">{atCommas(failing)}</span>}
              {optional && <span className="fact-word nowrap">{optional}</span>}
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
          {compact ? null : summary ? (
            <span className={cls("gist", older && "older", !sel && `clip clip-${lines}`)}>{summary}</span>
          ) : reply ? (
            // The reply you'd send with y, as the lane shows it: a margin note.
            <span className={cls("concern", "reply", !sel && "clip")}>{sel ? reply.body : opening(reply.body, 0, false)}</span>
          ) : failing || (next && !sel) ? (
            // Selected, the keys say what d does.
            <Dots className="gist" parts={[failing, !sel && next && withKeys(next)].filter(Boolean)} />
          ) : (
            // Opened, its activity is listed below.
            event && !open && <Dots className="gist event" parts={[eventText(event, ctx.me), age(event.at, ctx.now)]} />
          )}
          {shown.map((c) => (
            <span key={c} className={cls("concern", older && "older", !sel && "clip")}>
              {c}
            </span>
          ))}
        </button>
      </div>
      {noClone && (
        <p className="lane-link">
          <a href="#/settings/inflight">Set up a local clone of {noClone} so a babysitter can take it</a>
        </p>
      )}
      {sel && !open && <More card={card} ctx={ctx} mine={mine} away={!!away} inRun={!!inRun} />}
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

// Facts with a list in them ("CI failing: node 22, lint") wrap only between its items.
// A piece too long for a narrow card (a long check name) may still wrap inside.
export const atCommas = (text: string) =>
  text.split(", ").map((part, i, all) => (
    <Fragment key={part}>
      {i > 0 && " "}
      <span className={cls(part.length <= 32 && "nowrap")}>
        {part}
        {i < all.length - 1 && ","}
      </span>
    </Fragment>
  ));

// The selected card's rest: its facts and its keys.
function More({ card, ctx, mine, away, inRun }: { card: Card; ctx: RowCtx; mine: boolean; away: boolean; inRun: boolean }) {
  const run = (k: string) => {
    ctx.run(card, k);
  };
  const facts = cardFacts(card, ctx.me, away, inRun);
  const hand = card.next?.includes("hands it to a babysitter") ? "Hand to a babysitter" : "In flight";
  const armed = !!card.reply && ctx.armed === card.reply.id;
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
        {mine && card.inflight && card.reply && (
          <KeyButton
            k="y"
            label={armed ? "Press y again to send" : "Send"}
            title="Post this reply on GitHub, as you: press y twice"
            className={cls(armed && "armed")}
            run={run}
          />
        )}
        {mine && card.inflight && card.escalated && (
          <>
            {card.resume && <KeyButton k="c" label="Answer in a terminal" title={`Copies ${card.resume}`} run={run} />}
            <KeyButton k="x" label="Dismiss" title="Dismiss the question" run={run} />
          </>
        )}
        {mine && <KeyButton k="d" label={card.inflight ? "Take back" : hand} run={run} />}
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
            <kbd>{o.key}</kbd>
            <span>{o.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}
