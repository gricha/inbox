import type { Card, ItemDetail } from "../../../src/types.ts";
import { age, clearedText, cls } from "../format.ts";
import type { Variant } from "../view.ts";
import { Detail } from "./Detail.tsx";

// Everything a row needs from the app; `run` takes an action id (enter close o e d m b p why comment a t).
export interface RowCtx {
  now: number;
  me: string; // your login, so events can say "you"
  selected: string | null;
  expanded: string | null;
  leaving: Set<string>;
  showSignals: boolean;
  details: Record<string, ItemDetail | string>; // string = load error
  boardLabel: (id: string) => string;
  click: (c: Card) => void;
  select: (c: Card) => void;
  run: (c: Card, key: string) => void;
  menu: (c: Card, at: HTMLElement, snooze?: boolean) => void; // its row's menu, at a button
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

// What a row under Later or in the Archive says after its ref: why it's there. The queue's rows say nothing more: being
// there is the why.
function noteOf(card: Card, variant: Variant): string {
  if (variant === "cleared") return clearedText(card);
  if (variant === "hidden") return card.why || "hidden by your rules";
  if (variant === "archive") return card.resolved ?? "done: back when someone else acts";
  if (variant === "blocked") return card.why;
  return card.demoted ?? card.why;
}

// One line: whether it's a PR or an issue, the title, quietly its repo#number, its one call to action, then who it's from,
// a PR's stage and its age in columns on the right. A click opens an issue in place under it.
export function CardRow({ card, variant, ctx, why }: { card: Card; variant: Variant; ctx: RowCtx; why?: boolean }) {
  const open = ctx.expanded === card.id;
  const sel = ctx.selected === card.id;
  const note = why ? noteOf(card, variant) : "";
  // A resolved item isn't waiting any more: its time is when it resolved.
  const since = variant === "blocked" ? card.waiting_since : (card.resolved_at ?? card.done_at ?? card.waiting_since);
  return (
    <div
      className={cls(
        "line",
        sel && "sel",
        open && "open",
        ctx.leaving.has(card.id) && "leaving",
        variant !== "active" && variant !== "blocked" && "dim",
        variant === "blocked" && "blocked-row",
      )}
      data-id={card.id}
    >
      {/* The row's button reaches over the whole line (CSS), so its call to action can be a button of its own. */}
      <div className="line-main line-row">
        {/* Focus selects (Tab); not on mousedown, so a click opens without selecting first. */}
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
          <span className="line-kind">{card.kind === "pr" ? "PR" : "Issue"}</span>
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
          {note && (
            <span className="line-note" title={note}>
              {note}
            </span>
          )}
        </button>
        {/* Tinted, and filled under the pointer. */}
        {card.cta === "ready" && !why && (
          <button
            type="button"
            className="act line-cta"
            title="Mark it ready for review on GitHub"
            onClick={() => {
              ctx.run(card, "a");
            }}
          >
            Ready for review
          </button>
        )}
        {card.cta === "reviewers" && !why && (
          <button
            type="button"
            className="act line-cta"
            title="Nobody's asked to review it: opens its review to pick reviewers"
            onClick={() => {
              ctx.run(card, "a");
            }}
          >
            Add reviewers
          </button>
        )}
        {card.cta === "reply" && !why && (
          <button
            type="button"
            className="act line-cta line-reply"
            title="Someone waits on your answer: opens its review with a reply ready"
            onClick={() => {
              ctx.click(card);
            }}
          >
            Reply
          </button>
        )}
        {/* Columns on the right, so who and what stage line up from row to row; amber only on yours, where it's work for you. */}
        <span className={cls("line-by", card.by === "you" && "mine")}>by {card.by}</span>
        {!why && (
          <span className={cls("line-stage", card.stage === "changes requested" && card.by === "you" && "t-warn")}>{card.stage}</span>
        )}
        <span
          className="line-age"
          title={`${variant === "blocked" ? "blocked since" : card.resolved_at ? "resolved" : card.done_at ? "done" : "waiting since"} ${new Date(since).toLocaleString()}`}
        >
          {age(since, ctx.now)}
        </span>
      </div>
      {open && <Detail card={card} detail={ctx.details[card.id]} ctx={ctx} />}
    </div>
  );
}
