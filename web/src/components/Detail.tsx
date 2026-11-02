import type { ReactNode } from "react";
import type { Bucket, Card, ItemDetail, Placement, ReviewDecision, Signals } from "../../../src/types.ts";
import { age, BUCKET_LABEL, cls, eventText } from "../format.ts";
import { cardFacts, handArm, judgeStepText, says } from "../view.ts";
import type { RowCtx } from "./CardRow.tsx";

const PLACE: Record<Bucket, string> = { ...BUCKET_LABEL, now: "Urgent", today: "In the queue" };

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
        <p className="quiet">Loading…</p>
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
  const mine = pr && item.state === "open" && card.author.toLowerCase() === ctx.me.toLowerCase();
  const run = (k: string) => {
    ctx.run(card, k);
  };
  const asked = request(s);
  // Its activity, less the desk's own "first seen" and what the why already says ("assigned to you").
  const events = detail.activity.filter((e) => e.kind !== "new" && !says(card.why, eventText(e, ctx.me)));
  // The why, the board and the trace, saying only what the card's own why doesn't. Claude's bucket, unless a hard rule's floor held.
  const claude = !!main?.judge?.bucket && main.judge.bucket === main.rule_bucket;
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
          {claude && main.judge?.why && ", sorted by Claude"}
          {main.why && main.why !== card.why && <>: {main.why}</>}
        </p>
      )}
      {main.demoted && (
        <p className="demote-note">
          {claude ? "Claude" : "The rule"} said {BUCKET_LABEL[main.rule_bucket].toLowerCase()}; it moved to{" "}
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

  // Opened in place (an issue), it's the selected card's shape: one line of facts, what's new about why, its activity, its keys.
  if (!ctx.showSignals) {
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
        <p className="card-facts">
          {facts.map((f) => (
            <span key={f}>{f}</span>
          ))}
        </p>
        {why}
        {activity}
        <div className="actions card-keys">
          <KeyButton k="esc" label="Close" run={run} />
          <KeyButton k="o" label="Open on GitHub" run={run} />
          {mine && <HandKey card={card} run={run} armed={ctx.armed} />}
          <KeyButton k="e" label={card.status === "active" ? "Done" : "Restore"} run={run} />
          <KeyButton k="s" label="Snooze" run={run} />
          {!mine && <KeyButton k="m" label={muted ? "Unmute" : "Mute"} run={run} />}
        </div>
      </div>
    );
  }

  const facts: [string, ReactNode][] = [];
  if (pr) {
    facts.push(
      // oxlint-disable-next-line react/jsx-key -- a [label, value] pair rendered on its own, not a list
      ["CI", <span className={`t-ci-${item.ci}`}>{CI[item.ci]}</span>],
      ["Size", `+${item.additions} −${item.deletions} in ${plural(item.changed_files, "file")}`],
    );
    if (item.mergeable !== "unknown")
      // oxlint-disable-next-line react/jsx-key -- a [label, value] pair rendered on its own, not a list
      facts.push(["Merge", item.mergeable === "conflict" ? <span className="t-warn">conflicts with {item.base}</span> : "clean"]);
  }
  if (item.labels.length) facts.push(["Labels", item.labels.join(", ")]);
  if (!says(card.why, asked)) facts.push(["Asked", asked]);
  if (s.me.reviewed)
    facts.push([
      "You",
      `${s.me.review_state.replace("_", " ")} ${hours(s.me.reviewed_hours)} ago${s.me.pushed_since_review ? ", new commits since" : ""}`,
    ]);
  if (pr)
    facts.push([
      "Review",
      `${REVIEW[item.review_decision].replace(/^review /, "")}${
        item.reviews.length
          ? `: ${item.reviews.map((r) => `${r.author} ${r.state.replace("_", " ")} ${age(r.at, ctx.now)} ago`).join(", ")}`
          : ", none yet"
      }`,
    ]);
  if (item.threads_total)
    facts.push([
      "Threads",
      item.threads_unresolved
        ? `${item.threads_unresolved} of ${item.threads_total} unresolved`
        : `${plural(item.threads_total, "thread")}, none unresolved`,
    ]);
  facts.push(["Activity", `${age(card.activity_at, ctx.now)} ago, ${plural(item.comments_total, "comment")}`]);

  // `w`: the item's signals in full, its rule trace and its raw signals.
  return (
    <div className="detail">
      <dl className="facts">
        {facts.map(([k, v]) => (
          <div key={k} className="fact">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {why}
      {activity}
      <div className="actions card-keys">
        {pr && <KeyButton k="enter" label={card.inflight ? "Show in Merging" : "Review"} run={run} />}
        <KeyButton k="o" label="Open on GitHub" run={run} />
        {mine && <HandKey card={card} run={run} armed={ctx.armed} />}
        <KeyButton k="e" label={card.status === "active" ? "Done" : "Restore"} run={run} />
        <KeyButton k="s" label="Snooze" run={run} />
        {!mine && <KeyButton k="m" label={muted ? "Unmute" : "Mute"} run={run} />}
        <KeyButton k="p" label={card.pinned ? "Unpin" : "Pin"} run={run} />
        <KeyButton k="c" label="Copy prompt" run={run} />
        <KeyButton k="w" label={ctx.showSignals ? "Hide signals" : "Signals"} run={run} />
      </div>
      {ctx.showSignals && <pre className="signals">{JSON.stringify(s, null, 2)}</pre>}
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
            <span className="idx">Claude</span>
            <span>{judgeStepText(p.judge)}</span>
          </li>
        )}
      </ol>
    </div>
  );
}

// Parts of one line, apart like a card's call: "pushed a fix", "4be71c2", "24m".
export function Dots({ parts, className }: { parts: ReactNode[]; className?: string }) {
  return (
    <span className={cls("dots", className)}>
      {parts.map((p, i) => (
        // oxlint-disable-next-line react/no-array-index-key -- parts are positional and never reorder
        <span key={i}>{p}</span>
      ))}
    </span>
  );
}

export const BACK_TITLE = "Claude stops, and auto-merge goes off if the desk turned it on; a draft stays ready for review";

// Your own open PR: m twice hands it off for merge, b brings it back from Merging, or turns off the auto-merge m turned on
// once it's out. The same on a card, an opened item and a review.
export function HandKey({
  card,
  run,
  armed,
}: {
  card: Pick<Card, "id" | "inflight" | "draft" | "desk_auto_merge">;
  run: (k: string) => void;
  armed: string | null;
}) {
  if (card.inflight) return <KeyButton k="b" label="Back to desk" title={BACK_TITLE} run={run} />;
  const on = armed === handArm(card.id);
  return (
    <>
      <KeyButton
        k="m"
        label={on ? "again to hand off" : "Hand off for merge"}
        title={`Press m twice. Claude gets it merged, and GitHub's auto-merge goes on where the repo allows it${card.draft ? ", the draft marked ready for review first" : ""}`}
        className={cls(on && "armed")}
        run={run}
      />
      {card.desk_auto_merge && (
        <KeyButton k="b" label="Turn off auto-merge" title="m turned it on, so GitHub would still merge it" run={run} />
      )}
    </>
  );
}

export function KeyButton({
  k,
  label,
  run,
  disabled,
  title,
  className,
}: {
  k: string;
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
      {k && <kbd>{k}</kbd>}
      {label}
    </button>
  );
}
