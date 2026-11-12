import type { Item, Stage, Standing, Standings } from "./types.ts";

// Only a collaborator's approval counts (the coordinator merges on it); anyone's change request holds the PR.
export function verdicts(it: Item, self: string): { approved_by: string[]; changes_by: string[] } {
  const me = self.toLowerCase();
  const latest = new Map<string, Item["reviews"][number]>();
  for (const r of it.reviews)
    if (
      !r.author_bot &&
      r.author.toLowerCase() !== me &&
      (r.state === "changes_requested" || r.state === "dismissed" || (r.state === "approved" && r.trusted))
    )
      latest.set(r.author.toLowerCase(), r);
  const by = (state: string) => [...latest.values()].filter((r) => r.state === state).map((r) => r.author);
  return { approved_by: by("approved"), changes_by: by("changes_requested") };
}

// Approved as the desk says it: a collaborator approved, nobody asks for changes, and GitHub wants no other approval.
export function approved(it: Item, self: string): boolean {
  const v = verdicts(it, self);
  return !v.changes_by.length && v.approved_by.length > 0 && it.review_decision !== "required";
}

// Its repo needs no review to merge it: GitHub gives no review decision then. A stacked PR's base is another PR's branch,
// which never requires one, while where it lands may, so only a PR on the default branch counts.
export const reviewOptional = (it: Item): boolean =>
  it.kind === "pr" && it.review_decision === "none" && !!it.default_branch && it.base === it.default_branch;

// `self` is the person whose own review doesn't count: the PR's author, or you on yours.
export function stage(it: Item, self: string): Stage | undefined {
  if (it.kind !== "pr") return undefined;
  if (it.state !== "open") return it.state;
  if (it.draft) return "draft";
  if (verdicts(it, self).changes_by.length) return "changes requested";
  // GitHub says "required" while the branch still wants another approval or a code owner's.
  return approved(it, self) ? "approved" : "waiting for review";
}

// "a", "a and b", or "a, b and N more", where N counts `extra` too (requests GitHub hides); "" for none.
export function andMore(xs: string[], extra = 0): string {
  const shown = xs.slice(0, 2);
  const more = xs.length - shown.length + extra;
  return more > 0 && shown.length ? `${shown.join(", ")} and ${more} more` : shown.join(" and ");
}

const lc = (s: string) => s.toLowerCase();

const STANDING: Standing["state"][] = ["changes requested", "asked", "approved", "commented"];

// Who reviews a PR and where each stands, for its review's sidebar, bots and its author left out. verdicts() says who
// approved and who asks for changes, as the stage does; who's still asked waits; anyone else who reviewed commented.
export function standings(it: Item, me: string): Standings {
  const { approved_by, changes_by } = verdicts(it, it.author);
  const asked = it.review_requests.filter((r) => !r.bot).map((r) => (r.type === "team" ? `@${r.reviewer}` : r.reviewer));
  const spoke = it.reviews.filter((r) => !r.author_bot && r.state !== "pending" && lc(r.author) !== lc(it.author)).map((r) => r.author);
  const by = new Map<string, Standing>();
  const add = (who: string[], state: Standing["state"]) => {
    for (const w of who) if (!by.has(lc(w))) by.set(lc(w), { who: lc(w) === lc(me) ? "you" : w, state });
  };
  add(changes_by, "changes requested");
  add(approved_by, "approved");
  add(asked, "asked");
  add(spoke, "commented");
  const list = [...by.values()].toSorted((a, b) => STANDING.indexOf(a.state) - STANDING.indexOf(b.state));
  const who = (state: Standing["state"]) => list.filter((s) => s.state === state).map((s) => s.who);
  const hidden = it.review_requests_hidden ?? 0;
  const parts = [
    who("changes requested").length ? `changes requested by ${andMore(who("changes requested"))}` : "",
    who("approved").length ? `approved by ${andMore(who("approved"))}` : "",
    who("asked").length || hidden ? `waiting on ${andMore(who("asked"), hidden) || "a team GitHub doesn't show you"}` : "",
  ].filter(Boolean);
  const line = parts.join(" · ") || (list.length ? `comments from ${andMore(who("commented"))}` : "nobody's asked");
  return { line: line.charAt(0).toUpperCase() + line.slice(1), changes: changes_by.length > 0, list };
}

// Who GitHub's re-request would ask again: people other than its author who reviewed it, not bots, not asked now.
// Everyone an item involves, for the filter's involves:: its author, who it was opened for, assignees, who was asked, who
// reviewed, commented or answered a thread; bots aside, first seen first.
export function peopleOf(it: Item): string[] {
  const out = new Set<string>();
  const add = (login: string | undefined, bot = false) => {
    const l = login?.replace(/^@/, "");
    if (l && !bot && l !== "ghost" && !/\s/.test(l)) out.add(l);
  };
  add(it.author, it.author_bot);
  add(it.via);
  add(it.requester);
  for (const a of it.assignees) add(a);
  for (const r of it.review_requests) add(r.reviewer, r.type === "team" || r.bot);
  for (const r of it.reviews) add(r.author, r.author_bot);
  for (const c of it.comments) add(c.author, c.author_bot);
  for (const t of it.thread_last) add(t.author, t.author_bot);
  return [...out];
}

export function rerequestable(it: Item): string[] {
  const asked = new Set(it.review_requests.map((r) => lc(r.reviewer)));
  const seen = new Map<string, string>();
  for (const r of it.reviews)
    if (!r.author_bot && r.state !== "pending" && lc(r.author) !== lc(it.author) && !asked.has(lc(r.author)))
      seen.set(lc(r.author), r.author);
  return [...seen.values()];
}

// What stands in an open PR's merge, in one line; null when nothing does, or the desk doesn't know (it asks only of your own PRs).
export const mergeLine = (it: Item): string | null =>
  it.kind === "pr" && it.state === "open" && it.mergeable === "conflict" ? `Merge conflict with ${it.base}` : null;

// The rule: a person other than you had the last word, so they wait on your reply.
export const waitsOnYou = (last: { author: string; bot: boolean } | undefined, me: string) =>
  !!last && !last.bot && lc(last.author) !== lc(me);

// When you last pushed, as a sync knows it: the head commit's time if it's yours, never after GitHub's updatedAt; "" if not.
export function pushedAt(it: Item, me: string): string {
  if (!it.head_committed_at || lc(it.head_author) !== lc(me)) return "";
  return it.head_committed_at < it.updated_at ? it.head_committed_at : it.updated_at;
}

// A PR's latest commits, oldest first, and when you last pushed (pushedAt()'s).
interface Pushes {
  commits: { oid: string; at: string; author: string }[];
  pushed: string;
}
export const pushesOf = (it: Item, me: string): Pushes => ({ commits: it.commits ?? [], pushed: pushedAt(it, me) });

// Answered when the push that outdated it (the commit after the thread's) is yours, after their last word; that one gone (force-pushed), your latest.
export function pushAnswered(last: { at: string; commit?: string }, outdated: boolean, p: Pushes, me: string): boolean {
  if (!outdated) return false;
  const i = last.commit ? p.commits.findIndex((c) => c.oid === last.commit) : -1;
  if (i < 0) return last.at < p.pushed;
  const by = p.commits[i + 1];
  return !!by && lc(by.author) === lc(me) && last.at < by.at;
}

// The rule on an open thread: someone else had the last word, and no push of yours answered it.
export const threadWaitsOnYou = (
  last: { author: string; bot: boolean; at: string; commit?: string },
  outdated: boolean,
  p: Pushes,
  me: string,
) => waitsOnYou(last, me) && !pushAnswered(last, outdated, p, me);

// Who waits on your reply, from what a sync knows of your PR: the last word on its open threads (latest first), then on its comments.
function owedTo(it: Item, me: string): string[] {
  const p = pushesOf(it, me);
  const open = it.thread_last
    .filter((t) => t.resolved === false && threadWaitsOnYou({ ...t, bot: t.author_bot }, !!t.outdated, p, me))
    .toSorted((a, b) => b.at.localeCompare(a.at));
  const last = it.comments.findLast((c) => !c.author_bot);
  const who = [...open.map((t) => ({ author: t.author, bot: t.author_bot })), ...(last ? [{ author: last.author, bot: false }] : [])];
  const out = new Map<string, string>();
  for (const w of who) if (waitsOnYou(w, me) && !out.has(lc(w.author))) out.set(lc(w.author), w.author);
  return [...out.values()];
}

// The rule on what a sync knows of your PR, for its row: an open thread not answered by a push, or its comments, where someone else spoke last.
export const owesReply = (it: Item, me: string): boolean => owedTo(it, me).length > 0;

// Since the latest ask of those still asked (you aside): a re-request starts the wait again; else since it was opened.
export function askedAt(it: Item, me: string): string {
  const still = new Set(it.review_requests.filter((r) => r.type === "team" || lc(r.reviewer) !== lc(me)).map((r) => lc(r.reviewer)));
  return it.request_events.filter((r) => still.has(lc(r.reviewer))).reduce((a, r) => (r.at > a ? r.at : a), it.created_at);
}

// What an open PR waits on next, in words: the first that applies of draft, CI, conflict, changes, a reply you owe, reviews;
// your PR's conflict before its review is said with the review. Yours in a repo that needs no review waits on none.
export function waitsOf(
  it: Item,
  me: string,
  o: { mine: boolean; unasked: boolean; askedYou: boolean; waitingOn: string[]; optional?: boolean },
): string {
  if (it.kind !== "pr" || it.state !== "open") return "";
  const self = o.mine ? me : it.author;
  if (it.draft) return o.mine ? "is your draft" : "is a draft";
  if (it.ci === "red") return o.mine ? "waits on a CI fix" : "has CI failing";
  const changes = verdicts(it, self).changes_by;
  const through = approved(it, self) || (o.mine && !!o.optional);
  // Yours, short of its review with a conflict: the review is what holds it, so both are said (your agent rebases an approved one).
  const conflict = it.mergeable === "conflict";
  if (conflict && !(o.mine && !changes.length && !through && o.waitingOn.length)) return "waits on a merge conflict fix";
  if (changes.length) return `has changes requested by ${andMore(changes)}`;
  const review = through
    ? ""
    : !o.mine && o.askedYou
      ? "your review"
      : o.waitingOn.length
        ? `a review from ${andMore(o.waitingOn, it.review_requests_hidden ?? 0)}`
        : "a review";
  const owed = o.mine ? owedTo(it, me) : [];
  if (owed.length) return `waits on your reply to ${andMore(owed)}${review ? `, then ${review}` : ""}`;
  if (o.unasked && !through) return "has nobody asked to review it";
  if (review) return `waits on ${review}${conflict ? ", and a merge conflict fix" : ""}`;
  if (it.ci === "pending") return "waits on CI";
  return o.mine ? "is ready to merge" : `is approved, for ${it.author} to merge`;
}
