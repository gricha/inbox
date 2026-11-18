import type { Card, ItemDetail } from "../../../src/types.ts";
import { age, byOf, clearedText, cls } from "../format.ts";
import type { Guide, Variant } from "../view.ts";
import { Avatar } from "./Avatar.tsx";
import { Detail } from "./Detail.tsx";
import { AgentIcon, KindIcon, RowFacts } from "./RowIcons.tsx";

// Everything a row needs from the app; `run` takes an action id, as App's run() reads it.
export interface RowCtx {
  now: number;
  me: string; // your login, so events can say "you"
  selected: string | null;
  expanded: string | null;
  leaving: Set<string>;
  details: Record<string, ItemDetail | string>; // string = load error
  boardLabel: (id: string) => string;
  click: (c: Card) => void;
  select: (c: Card) => void;
  run: (c: Card, key: string) => void;
  menu: (c: Card, at: HTMLElement, snooze?: boolean) => void; // its row's menu, at a button
  compact?: boolean; // the list beside a review: two lines a row
}

const TREE_STEP = 20; // px a level, as .tree's steps are wide

// A row's one call to action: what it says, and its tooltip.
const CTA = {
  ready: { label: "Ready for review", title: "Mark it ready for review on GitHub" },
  reviewers: { label: "Add reviewers", title: "Nobody's asked to review it: opens its review to pick reviewers" },
  reply: { label: "Reply", title: "Someone waits on your answer: opens its review at their conversation" },
  handoff: { label: "Hand off for merge", title: "Approved, green and mergeable: your agent gets it merged (More merges it now)" },
};

// What a row on Blocked or in the Archive says after its ref: why it's there. The Inbox's rows say their `reason`.
function noteOf(card: Card, variant: Variant): string {
  if (variant === "cleared") return clearedText(card);
  if (variant === "hidden") return card.why || "hidden by your rules";
  if (variant === "archive") return card.resolved ?? "done: back when someone else acts";
  if (variant === "blocked") return card.why;
  return card.demoted ?? card.why;
}

// One line: an icon for a PR or an issue, the title, quietly its repo#number, its one call to action, then its facts as
// icons (risk, size, CI, stage), who it's from as their picture, and its age, in columns on the right. Each icon says
// itself in a tip. Beside a review (compact), the same on two lines: icon, title and call to action, then the rest.
// A click opens an issue in place under it. On Blocked, `tree` indents it under the PR it needs, with a quiet guide.
export function CardRow({ card, variant, ctx, why, tree }: { card: Card; variant: Variant; ctx: RowCtx; why?: boolean; tree?: Guide[] }) {
  const open = ctx.expanded === card.id;
  const sel = ctx.selected === card.id;
  const reason = card.reason ?? "";
  const note = why ? noteOf(card, variant) : reason.charAt(0).toUpperCase() + reason.slice(1);
  // A resolved item isn't waiting any more: its time is when it resolved.
  const since = variant === "blocked" ? card.waiting_since : (card.resolved_at ?? card.done_at ?? card.waiting_since);
  const kindIcon = <KindIcon kind={card.kind} tip={card.kind === "pr" ? "Pull request" : "Issue"} />;
  const title = <span className="line-title">{card.title}</span>;
  // A long repo name gives way before the title; the number never does.
  const ref = (
    <>
      <span className="line-ref" data-tip={`${card.repo}#${card.number}`}>
        {card.repo.split("/")[1]}
      </span>
      <span className="line-num">#{card.number}</span>
      {/* One line stands for its stack: where it sits in what's still to land. */}
      {card.stack && (
        <span className="line-stack" data-tip={`${card.stack.pos} of ${card.stack.size} open PRs in its stack`}>
          {card.stack.pos}/{card.stack.size}
        </span>
      )}
    </>
  );
  const noteEl = note && (
    <span className={cls("line-note", !why && "line-reason")} data-tip={note}>
      {note}
    </span>
  );
  // Who it's from is their picture alone: yours for "you", the person a bot opened it for, a mark for a bot or a name alone.
  const by = byOf(card, ctx.me);
  const face = (
    <span className={cls("line-by line-face", card.by === "you" && "mine")} data-tip={`By ${by.who}`}>
      {card.by === "you" ? ctx.me && <Avatar login={ctx.me} /> : by.face ? <Avatar login={by.face} /> : <AgentIcon />}
      <span className="sr">by {by.who}</span>
    </span>
  );
  const ageEl = (
    <span
      className="line-age"
      data-tip={`${variant === "blocked" ? "blocked since" : card.resolved_at ? "resolved" : card.done_at ? "done" : "waiting since"} ${new Date(since).toLocaleString()}`}
    >
      {age(since, ctx.now)}
    </span>
  );
  const cta = card.cta && !why && (
    // Tinted, and filled under the pointer; beside a review, accent text.
    <button
      type="button"
      className={ctx.compact ? "c-cta" : cls("act line-cta", card.cta === "reply" && "line-reply")}
      data-tip={CTA[card.cta].title}
      onClick={() => {
        if (card.cta === "reply") ctx.click(card);
        else ctx.run(card, "a");
      }}
    >
      {CTA[card.cta].label}
    </button>
  );
  return (
    <div
      className={cls(
        "line",
        ctx.compact && "c-line",
        sel && "sel",
        open && "open",
        ctx.leaving.has(card.id) && "leaving",
        variant !== "active" && variant !== "blocked" && "dim",
        variant === "blocked" && "blocked-row",
      )}
      data-id={card.id}
    >
      {/* The row's button reaches over the whole line (CSS), so its call to action can be a button of its own. */}
      <div
        className={cls("line-main line-row", ctx.compact && "c-row")}
        style={tree?.length ? { paddingLeft: `calc(var(--pad, 14px) + ${tree.length * TREE_STEP}px)` } : undefined}
      >
        {!!tree?.length && (
          <span className="tree" aria-hidden="true">
            {tree.map((g, i) => (
              // oxlint-disable-next-line react/no-array-index-key -- a step is its level: its place is all that tells it apart
              <span key={i} className={`tree-${g}`} />
            ))}
          </span>
        )}
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
          {ctx.compact ? (
            <>
              <span className="c-top">
                {kindIcon}
                {title}
              </span>
              <span className="c-meta">
                <span className="c-ref">{ref}</span>
                {noteEl}
                <span className="c-gap" />
                <RowFacts card={card} stage={!why} />
                {face}
                {ageEl}
              </span>
            </>
          ) : (
            <>
              {kindIcon}
              {title}
              {ref}
              {noteEl}
            </>
          )}
        </button>
        {cta}
        {/* Columns on the right, so who and what stage line up from row to row. */}
        {!ctx.compact && (
          <>
            <RowFacts card={card} stage={!why} />
            {face}
            {ageEl}
          </>
        )}
      </div>
      {open && <Detail card={card} detail={ctx.details[card.id]} ctx={ctx} />}
    </div>
  );
}
