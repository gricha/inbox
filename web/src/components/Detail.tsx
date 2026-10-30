import type { ReactNode } from "react";
import type { Card, ItemDetail, Placement, ReviewDecision, Signals } from "../../../src/types.ts";
import { age, BUCKET_LABEL, cls, eventText, when } from "../format.ts";
import type { RowCtx } from "./CardRow.tsx";

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
  const facts: [string, ReactNode][] = [];
  if (pr) {
    facts.push(
      // oxlint-disable-next-line react/jsx-key -- a [label, value] pair rendered on its own, not a list
      ["CI", <span className={`t-ci-${item.ci}`}>{CI[item.ci]}</span>],
      ["Review", `${REVIEW[item.review_decision]}${s.pr.approvals ? `, ${plural(s.pr.approvals, "approval")}` : ""}`],
      ["Size", `+${item.additions} −${item.deletions} in ${plural(item.changed_files, "file")}`],
    );
    if (item.mergeable !== "unknown")
      // oxlint-disable-next-line react/jsx-key -- a [label, value] pair rendered on its own, not a list
      facts.push(["Merge", item.mergeable === "conflict" ? <span className="t-warn">conflicts with {item.base}</span> : "clean"]);
  }
  if (item.labels.length) facts.push(["Labels", item.labels.join(", ")]);
  facts.push(["Asked", request(s)]);
  if (s.me.reviewed)
    facts.push([
      "You",
      `${s.me.review_state.replace("_", " ")} ${hours(s.me.reviewed_hours)} ago${s.me.pushed_since_review ? ", new commits since" : ""}`,
    ]);
  if (pr)
    facts.push([
      "Reviews",
      item.reviews.length
        ? item.reviews.map((r) => `${r.author} ${r.state.replace("_", " ")} ${age(r.at, ctx.now)} ago`).join(", ")
        : "none yet",
    ]);
  if (item.threads_total) facts.push(["Threads", `${item.threads_unresolved} of ${item.threads_total} unresolved`]);
  facts.push(["Activity", `${age(card.activity_at, ctx.now)} ago, ${plural(item.comments_total, "comment")}`]);

  const placements = [...detail.placements].sort((a, b) => Number(b.board === card.board) - Number(a.board === card.board));
  const [main, ...others] = placements;
  const muted = card.status === "muted";
  const mine = pr && item.state === "open" && card.author.toLowerCase() === ctx.me.toLowerCase();
  const run = (k: string) => {
    ctx.run(card, k);
  };

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
      {main && (
        <div className="why-block">
          <h4 className="d-head">Why it's here</h4>
          {card.resolved && (
            <p className="pl-head">
              <b>Resolved</b>: {card.resolved}. It comes back on its own if that stops being true.
            </p>
          )}
          <p className="pl-head">
            {card.resolved && "Otherwise "}
            <b>{BUCKET_LABEL[main.bucket]}</b>, from the {ctx.boardLabel(main.board)} board{main.why && <>: {main.why}</>}
          </p>
          {main.demoted && (
            <p className="demote-note">
              The rule said {BUCKET_LABEL[main.rule_bucket].toLowerCase()}; it moved to {BUCKET_LABEL[main.bucket].toLowerCase()} because{" "}
              {main.demoted.charAt(0).toLowerCase() + main.demoted.slice(1)}.
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
      )}
      {detail.activity.length > 0 && (
        <div className="activity">
          <h4 className="d-head">Recent activity</h4>
          <ul className="events">
            {detail.activity.map((e) => (
              <li key={e.seq}>
                {eventText(e, ctx.me)} <span className="quiet">· {age(e.at, ctx.now)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {pr && detail.ai && (
        <div className="brief">
          <h4 className="d-head">
            AI review{" "}
            <span className="quiet">
              from {detail.ai.model}, {when(detail.ai.at)}
              {detail.ai_stale ? ", before the latest commits" : ""}
            </span>
          </h4>
          <p>
            <span className={`verdict v-${detail.ai.verdict}`}>{detail.ai.verdict}</span>. {detail.ai.summary}
          </p>
        </div>
      )}
      <div className="actions">
        {pr && <KeyButton k="enter" label={card.inflight ? "Show in flight" : "Review"} run={run} />}
        <KeyButton k="o" label="Open on GitHub" run={run} />
        {mine && <KeyButton k="d" label={card.inflight ? "Take back" : "In flight"} run={run} />}
        <KeyButton k="e" label={card.status === "active" ? "Done" : "Restore"} run={run} />
        <KeyButton k="s" label="Snooze" run={run} />
        <KeyButton k="m" label={muted ? "Unmute" : "Mute"} run={run} />
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
          <li className="hit">
            <span className="tick ok">→</span>
            <span className="idx">default</span>
            <span>no rule matched, so {BUCKET_LABEL[p.rule_bucket].toLowerCase()}</span>
          </li>
        )}
      </ol>
    </div>
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
