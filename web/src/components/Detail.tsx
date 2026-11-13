import { useState, type ReactNode } from "react";
import type { Bucket, Card, IssueReview, ItemDetail, Placement, ReviewDecision, Signals } from "../../../src/types.ts";
import { age, BUCKET_LABEL, cls, eventText, handoffLabel, aiName } from "../format.ts";
import { cardFacts, handsOff, judgeStepText, says } from "../view.ts";
import type { RowCtx } from "./CardRow.tsx";
import { Prose } from "./Prose.tsx";
import { SkLines } from "./Skeleton.tsx";

const PLACE: Record<Bucket, string> = { ...BUCKET_LABEL, now: "In the Inbox", today: "In the Inbox" };

export const CI = { green: "passing", red: "failing", pending: "running", none: "no checks" };
export const REVIEW: Record<ReviewDecision, string> = {
  approved: "approved",
  changes_requested: "changes requested",
  required: "review required",
  none: "no review needed",
};

// Signal hours are fractional.
const hours = (h: number) => (h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function request(s: Signals): string {
  const m = s.me;
  if (m.author) return "your PR";
  if (!m.requested) return m.assignee ? "assigned to you" : "not requested";
  const parts = [m.requested_direct ? "you, by name" : `your team @${m.requested_team}`];
  if (m.requested_by) parts.push(`by ${m.requested_by}${m.requested_by_bot ? " (bot)" : ""}`);
  if (m.requested_codeowner) parts.push("CODEOWNERS");
  if (m.requested_hours >= 0) parts.push(`${hours(m.requested_hours)} ago`);
  return parts.join(", ");
}

export function Detail({ card, detail, ctx }: { card: Card; detail: ItemDetail | string | undefined; ctx: RowCtx }) {
  if (detail === undefined)
    return (
      <div className="detail">
        <SkLines />
      </div>
    );
  if (typeof detail === "string")
    return (
      <div className="detail">
        <p className="t-bad">{detail}</p>
      </div>
    );
  const { item, signals: s } = detail;
  const pr = item.kind === "pr";
  const placements = [...detail.placements].sort((a, b) => Number(b.board === card.board) - Number(a.board === card.board));
  const [main, ...others] = placements;
  const muted = card.status === "muted";
  const mine = pr && item.state === "open" && card.by === "you"; // yours, or a bot's opened for you
  const run = (k: string) => {
    ctx.run(card, k);
  };
  const asked = request(s);
  const pre = detail.issue_ai;
  const fixable = !!pre?.fixable && !pre.injection && item.state === "open" && !detail.blocked_author;
  // Its activity, less the desk's own "first seen" and what the why already says ("assigned to you").
  const events = detail.activity.filter((e) => e.kind !== "new" && !says(card.why, eventText(e, ctx.me)));
  // The why, the board and the trace, saying only what the card's own why doesn't. Claude's bucket, or an automation's,
  // unless a hard rule's floor held.
  const claude = !!main?.judge?.bucket && main.judge.bucket === main.rule_bucket;
  const sorter = main?.judge?.by ? `automation ${main.judge.by}` : aiName();
  const why = main && (
    <div className="why-block">
      {card.resolved && (
        <p className="pl-head">
          <b>Resolved</b>: {card.resolved}. It comes back on its own if that stops being true.
        </p>
      )}
      {(!!card.resolved || main.why !== card.why || claude) && (
        <p className="pl-head">
          {card.resolved && "Otherwise "}
          <b>{PLACE[main.bucket]}</b>, from the {ctx.boardLabel(main.board)} board
          {claude && main.judge?.why && `, sorted by ${sorter}`}
          {main.why && main.why !== card.why && <>: {main.why}</>}
        </p>
      )}
      {main.demoted && (
        <p className="demote-note">
          {claude ? sorter.replace(/^a/, "A") : "The rule"} said {BUCKET_LABEL[main.rule_bucket].toLowerCase()}; it moved to{" "}
          {BUCKET_LABEL[main.bucket].toLowerCase()} because {main.demoted.charAt(0).toLowerCase() + main.demoted.slice(1)}.
        </p>
      )}
      <details className="trace-toggle">
        <summary>Rule trace{others.length > 0 && ` and ${others.length} other ${others.length === 1 ? "board" : "boards"}`}</summary>
        <PlacementView p={main} />
        {others.map((p) => (
          <div key={p.board} className="also">
            <p className="pl-head">
              Also <b>{BUCKET_LABEL[p.bucket].toLowerCase()}</b> from the {ctx.boardLabel(p.board)} board{p.why && <>: {p.why}</>}
            </p>
            <PlacementView p={p} />
          </div>
        ))}
      </details>
    </div>
  );
  const activity = events.length > 0 && (
    <div className="activity">
      <h4 className="d-head">Recent activity</h4>
      <ul className="events">
        {events.map((e) => (
          <li key={e.seq}>
            <Dots
              parts={[
                eventText(e, ctx.me),
                <span key="age" className="quiet">
                  {age(e.at, ctx.now)}
                </span>,
              ]}
            />
          </li>
        ))}
      </ul>
    </div>
  );

  // Opened in place (an issue): why it's here (its row doesn't say), one line of facts, more on why, its activity, its actions.
  const facts = [
    ...cardFacts(card, ctx.me),
    ...(says(card.why, asked) ? [] : [asked]),
    ...(item.labels.length ? [item.labels.join(", ")] : []),
    plural(item.comments_total, "comment"),
    // Recent activity below says when, and what.
    ...(events.length ? [] : [`active ${age(card.activity_at, ctx.now)} ago`]),
  ];
  return (
    <div className="more opened">
      {card.why && !card.resolved && <p className="d-why">{card.why.charAt(0).toUpperCase() + card.why.slice(1)}</p>}
      {card.handoff && (
        <p className="d-why d-handoff">
          <b>{handoffLabel(card.handoff)}</b> {card.handoff.why}
        </p>
      )}
      <p className="card-facts dots">
        {facts.map((f) => (
          <span key={f}>{f}</span>
        ))}
      </p>
      {why}
      {item.kind === "issue" && <IssuePre detail={detail} run={run} />}
      {activity}
      <div className="actions card-keys">
        {fixable && (
          <ActButton k="fix" label="Make PR with fix" className="primary" title="Your agent opens a draft PR with this fix" run={run} />
        )}
        {card.kind === "issue" && !card.resolved && <ActButton k="comment" label="Comment" run={run} />}
        {card.kind === "issue" && !card.resolved && !detail.blocked_author && <ActButton k="t" label="Ask your agent" run={run} />}
        <ActButton k="o" label="Open on GitHub" run={run} />
        {mine && <HandButton card={card} run={run} />}
        <ActButton k="e" label={card.status === "active" ? "Done" : "Back on the desk"} run={run} />
        <button
          type="button"
          className="act"
          aria-haspopup="menu"
          onClick={(e) => {
            ctx.menu(card, e.currentTarget, true);
          }}
        >
          Snooze
        </button>
        {!mine && <ActButton k="m" label={muted ? "Unmute" : "Mute"} run={run} />}
        {/* Last, so a pointer that read down to here closes it here. */}
        <ActButton k="close" label="Close" title="Close (Esc)" run={run} />
      </div>
    </div>
  );
}

function PlacementView({ p }: { p: Placement }) {
  return (
    <div className="placement">
      <ol className="trace">
        {p.trace.map((t) => (
          <li key={t.index} className={cls(t.index >= 0 && t.matched && "hit")}>
            <span className={cls("tick", t.matched ? "ok" : "no")}>{t.matched ? "✓" : "✗"}</span>
            <span className="idx">{t.index < 0 ? "filter" : `rules[${t.index}]`}</span>
            <code>{t.when}</code>
            {t.error && <span className="t-bad trace-err">{t.error}</span>}
          </li>
        ))}
        {p.rule === null && (
          <li className={cls(!p.judge?.bucket && "hit")}>
            <span className={cls("tick", !p.judge?.bucket && "ok")}>→</span>
            <span className="idx">default</span>
            <span>no rule matched, so {BUCKET_LABEL[p.hint?.bucket ?? p.rule_bucket].toLowerCase()}</span>
          </li>
        )}
        {p.hard && (
          <li className="hit">
            <span className="tick ok">→</span>
            <span className="idx">hard</span>
            <span>a hard rule: never below {BUCKET_LABEL[p.floor ?? p.rule_bucket].toLowerCase()}</span>
          </li>
        )}
        {p.judge && (
          <li className={cls(p.judge.bucket && "hit")}>
            <span className={cls("tick", p.judge.bucket ? "ok" : "no")}>{p.judge.bucket ? "→" : "…"}</span>
            <span className="idx">{p.judge.by ? "automation" : aiName()}</span>
            <span>
              {p.judge.by && `${p.judge.by}: `}
              {judgeStepText(p.judge)}
            </span>
          </li>
        )}
      </ol>
    </div>
  );
}

// Parts of one line, apart like a card's call: "pushed a fix", "4be71c2", "24m".
export function Dots({ parts }: { parts: ReactNode[] }) {
  return (
    <span className="dots">
      {parts.map((p, i) => (
        // oxlint-disable-next-line react/no-array-index-key -- parts are positional and never reorder
        <span key={i}>{p}</span>
      ))}
    </span>
  );
}

const BACK_TITLE = "Out of Merging and back on your desk; your agent leaves it alone";

// Your own open PR: Hand off for merge (green: a yes, like Approve), or Back to desk from Merging. The same on an opened
// item and a review.
export function HandButton({
  card,
  run,
  primary,
}: {
  card: Pick<Card, "inflight" | "draft" | "cta" | "review" | "review_optional">;
  run: (k: string) => void;
  primary?: boolean;
}) {
  if (card.inflight) return <ActButton k="b" label="Back to desk" title={BACK_TITLE} run={run} />;
  if (!handsOff(card)) return null; // a draft, one nobody's asked to review where review is needed, one not approved yet
  return (
    <ActButton
      k="handoff"
      label="Hand off for merge"
      title="Your agent gets it merged: it fixes CI, addresses comments and merges it"
      className={cls(primary && "primary go")}
      run={run}
    />
  );
}

export function ActButton({
  k = "",
  label,
  run,
  disabled,
  title,
  className,
}: {
  k?: string;
  label: string;
  run: (k: string) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cls("act", className)}
      title={title}
      onClick={() => {
        run(k);
      }}
      disabled={disabled}
    >
      {label}
    </button>
  );
}

const KIND: Record<IssueReview["kind"], string> = { bug: "A bug", feature: "A feature request", question: "A question", other: "An issue" };

// An issue's pre-review: what's actually wrong and what we'd do, from the code in your clone when it read it; a walk
// through it when it isn't simple; or the screen's flag, with nothing else read.
function IssuePre({ detail, run }: { detail: ItemDetail; run: (k: string) => void }) {
  const r = detail.issue_ai ?? null;
  const st = detail.issue_ai_state ?? null;
  const author = detail.item.author;
  const [at, setAt] = useState(0);
  if (detail.blocked_author)
    return (
      <div className="pre">
        <h4 className="d-head">Pre-review</h4>
        <p className="quiet">
          @{author} is blocked on your desk: their items are muted and no agent reads them.{" "}
          <ActButton k="unblock" label={`Unblock @${author}`} run={run} />
        </p>
      </div>
    );
  const stale = !!r && r.updated_at !== detail.item.updated_at;
  const status =
    st === "running" ? (
      <p className="pre-state">
        <span className="busy" aria-hidden="true" />
        {r ? "Reading it again since its latest activity" : "Your agent is reading it"}
      </p>
    ) : st === "failed" ? (
      <p className="pre-state t-bad">
        The pre-review failed: {detail.issue_ai_error} <ActButton k="analyze" label="Try again" run={run} />
      </p>
    ) : stale && st !== "off" ? (
      <p className="pre-state quiet">
        Written before its latest activity. <ActButton k="analyze" label="Read it again" run={run} />
      </p>
    ) : null;
  if (!r)
    return status || st !== "off" ? (
      <div className="pre">
        <h4 className="d-head">Pre-review</h4>
        {status ?? (
          <p className="pre-state quiet">
            None yet. <ActButton k="analyze" label="Analyze it" run={run} />
          </p>
        )}
      </div>
    ) : null;
  if (r.injection)
    return (
      <div className="pre">
        <h4 className="d-head">Pre-review</h4>
        <p className="pre-flag t-bad">
          <b>Possible prompt injection from @{r.injection.who}.</b> {r.injection.why} No agent read it further.
        </p>
        <p className="actions">
          <ActButton
            k="block"
            label={`Block @${r.injection.who}`}
            className="primary"
            title="Mutes their items on your desk; nothing on GitHub"
            run={run}
          />
          <ActButton k="trust" label="Not an injection: analyze it" run={run} />
        </p>
      </div>
    );
  const steps = r.steps;
  const step = steps[Math.min(at, steps.length - 1)];
  return (
    <div className="pre">
      <h4 className="d-head">Pre-review</h4>
      {status}
      <p className="pre-sum">
        <b>{KIND[r.kind]}.</b> {r.summary}
      </p>
      <p className="pre-from quiet">{r.code ? "From the code in your clone" : "From the issue's text alone: no local clone to read"}</p>
      <PreField label="What's wrong" text={r.problem} />
      <PreField label="Cause" text={r.cause} />
      {r.evidence.length > 0 && (
        <ul className="pre-where">
          {r.evidence.map((e) => (
            <li key={`${e.path}:${e.line}`}>
              <code>
                {e.path}:{e.line}
              </code>{" "}
              <span className="quiet">{e.why}</span>
            </li>
          ))}
        </ul>
      )}
      <PreField label={r.fixable ? "The fix" : "What we'd do"} text={r.fix} />
      {step && (
        <div className="pre-walk">
          <p className="pre-step-head">
            <b>{step.title}</b>{" "}
            <span className="quiet">
              Step {Math.min(at, steps.length - 1) + 1} of {steps.length}
            </span>
          </p>
          <Prose text={step.body} />
          <p className="actions">
            <button
              type="button"
              className="act"
              disabled={at <= 0}
              onClick={() => {
                setAt((n) => Math.max(0, n - 1));
              }}
            >
              Back
            </button>
            <button
              type="button"
              className="act"
              disabled={at >= steps.length - 1}
              onClick={() => {
                setAt((n) => Math.min(steps.length - 1, n + 1));
              }}
            >
              Next
            </button>
          </p>
        </div>
      )}
    </div>
  );
}

function PreField({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <div className="pre-field">
      <p className="pre-label">{label}</p>
      <Prose text={text} />
    </div>
  );
}
