// Events from comparing two snapshots of a GitHub item. Pure: the clock comes in as `now`.
import type { ActivityKind, Item } from "../types.ts";
import type { NewEvent } from "./connector.ts";

export interface DiffContext {
  me: string;
  teams: string[]; // your team slugs
  bots: string[]; // extra bot logins (github.bots)
  now: string; // ISO; when the desk noticed
}

type Request = Item["review_requests"][number];

const lc = (s: string) => s.toLowerCase();
const latestAt = (xs: { at: string }[]) => xs.reduce((a, x) => (x.at > a ? x.at : a), "");

export function itemEvents(prev: Item | null, next: Item, ctx: DiffContext): NewEvent[] {
  const me = lc(ctx.me);
  const teams = new Set(ctx.teams.map(lc));
  const bots = new Set(ctx.bots.map(lc));
  const isMe = (login: string) => lc(login) === me;
  const isBot = (login: string, flagged = false) => flagged || bots.has(lc(login)) || login.endsWith("[bot]");
  const ev = (kind: ActivityKind, actor: string, at: string, data: NewEvent["data"] = {}): NewEvent => ({
    at,
    item_id: next.id,
    kind,
    actor,
    data,
  });
  if (!prev) return [ev("new", next.author, ctx.now, { kind: next.kind })];

  // GitHub's own times, except never in the future (commit dates are author-controlled).
  const when = (at: string | null | undefined) => (at && at < ctx.now ? at : ctx.now);
  // Something without a time of its own happened between the two fetches.
  const since = (at: string | null | undefined) => {
    const t = when(at);
    return t > prev.detail_at ? t : ctx.now;
  };
  const out: NewEvent[] = [];

  if (prev.state !== next.state) {
    if (next.state === "merged") out.push(ev("merged", next.merged_by ?? "", since(next.closed_at)));
    else if (next.state === "closed") out.push(ev("closed", "", since(next.closed_at)));
    else out.push(ev("reopened", "", ctx.now));
  }

  const reviewKey = (r: Item["reviews"][number]) => `${lc(r.author)}|${r.state}|${r.at}`;
  const seenReviews = new Set(prev.reviews.map(reviewKey));
  const lastReview = latestAt(prev.reviews);
  // A review only counts as new if it's later than the last one seen, so a shifting window can't replay old ones.
  const newReviews = next.reviews.filter((r) => !seenReviews.has(reviewKey(r)) && r.at > lastReview);
  const iReviewed = newReviews.some((r) => isMe(r.author) && r.state !== "pending");

  const mine = (r: { reviewer: string; type: Request["type"] }) => (r.type === "user" ? isMe(r.reviewer) : teams.has(lc(r.reviewer)));
  const reqKey = (r: { reviewer: string; type: Request["type"] }) => `${r.type}:${lc(r.reviewer)}`;
  const before = new Map(prev.review_requests.filter(mine).map((r) => [reqKey(r), r]));
  const after = new Map(next.review_requests.filter(mine).map((r) => [reqKey(r), r]));
  const askKey = (e: Item["request_events"][number]) => `${e.at}|${e.reviewer_type}:${lc(e.reviewer)}`;
  const seenAsks = new Set(prev.request_events.map(askKey));
  const asked = new Set<string>();
  for (const e of next.request_events) {
    const k = reqKey({ reviewer: e.reviewer, type: e.reviewer_type });
    if (seenAsks.has(askKey(e)) || !after.has(k) || e.at <= prev.detail_at) continue;
    asked.add(k);
    const r = after.get(k)!;
    out.push(ev("review_requested", e.actor, when(e.at), { reviewer: r.reviewer, type: r.type, codeowner: r.codeowner }));
  }
  for (const [k, r] of after) {
    if (before.has(k) || asked.has(k)) continue;
    const e = next.request_events.findLast((x) => reqKey({ reviewer: x.reviewer, type: x.reviewer_type }) === k);
    out.push(ev("review_requested", e?.actor ?? "", since(e?.at), { reviewer: r.reviewer, type: r.type, codeowner: r.codeowner }));
  }
  // Reviewing removes your own request, and a merge needs no "removed" on top.
  if (!iReviewed && next.state === "open") {
    for (const [k, r] of before) if (!after.has(k)) out.push(ev("request_removed", "", ctx.now, { reviewer: r.reviewer, type: r.type }));
  }

  for (const r of newReviews) {
    if (isMe(r.author) || isBot(r.author, r.author_bot) || r.state === "pending" || r.state === "dismissed") continue;
    out.push(ev("reviewed", r.author, when(r.at), { state: r.state }));
  }

  const pushed = !!prev.head_oid && !!next.head_oid && prev.head_oid !== next.head_oid;
  if (pushed) out.push(ev("pushed", next.head_author, since(next.head_committed_at), { oid: next.head_oid }));
  // A push restarts CI; "running" right after it says nothing new.
  if (next.ci !== prev.ci && next.ci !== "none" && !(pushed && next.ci === "pending"))
    out.push(ev("ci", "", ctx.now, { from: prev.ci, to: next.ci }));

  const lastComment = latestAt(prev.comments);
  for (const c of next.comments) {
    if (c.at <= lastComment || isMe(c.author) || isBot(c.author, c.author_bot)) continue;
    out.push(ev("commented", c.author, when(c.at)));
  }

  if (!prev.assignees.some(isMe) && next.assignees.some(isMe)) out.push(ev("assigned", "", ctx.now));

  return out.sort((a, b) => a.at.localeCompare(b.at));
}
