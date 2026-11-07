// Turns a GitHub item plus facts about you into the signals rules can test.
import { areaFiles } from "./areas.ts";
import { approved, owesReply, waitsOf } from "./stage.ts";
import type { Config, Context, FieldDoc, Item, ReviewState, Signals, Until } from "./types.ts";

export const FIELDS: FieldDoc[] = [
  { path: "item.kind", type: "string", doc: '"pr" or "issue"' },
  { path: "item.id", type: "string", doc: 'e.g. "getsentry/seer#123"' },
  { path: "item.repo", type: "string", doc: 'owner/name, e.g. "getsentry/seer"' },
  { path: "item.owner", type: "string", doc: "repo owner (org or user)" },
  { path: "item.name", type: "string", doc: "repo name without owner" },
  { path: "item.number", type: "number", doc: "PR or issue number" },
  { path: "item.title", type: "string", doc: "title (untrusted text)" },
  { path: "item.url", type: "string", doc: "GitHub URL" },
  { path: "item.author", type: "string", doc: "author login" },
  { path: "item.state", type: "string", doc: '"open", "closed" or "merged"' },
  { path: "item.draft", type: "boolean", doc: "PR is a draft" },
  { path: "item.labels", type: "string[]", doc: "label names" },
  { path: "item.created_hours", type: "number", doc: "hours since it was opened" },
  { path: "item.updated_hours", type: "number", doc: "hours since GitHub's updatedAt (includes bots and CI)" },
  { path: "item.activity_hours", type: "number", doc: "hours since the last human activity by someone other than you" },
  { path: "item.comments", type: "number", doc: "total conversation comments" },
  { path: "pr.size", type: "number", doc: "lines added + deleted" },
  { path: "pr.additions", type: "number", doc: "lines added" },
  { path: "pr.deletions", type: "number", doc: "lines deleted" },
  { path: "pr.files", type: "number", doc: "files changed" },
  { path: "pr.ci", type: "string", doc: '"green", "red", "pending" or "none"' },
  { path: "pr.review", type: "string", doc: 'review decision: "approved", "changes_requested", "required" or "none"' },
  { path: "pr.mergeable", type: "string", doc: '"clean", "conflict" or "unknown" (only checked for your PRs)' },
  { path: "pr.approvals", type: "number", doc: "people whose latest review approves" },
  { path: "pr.unresolved_threads", type: "number", doc: "unresolved review threads" },
  { path: "pr.base", type: "string", doc: "base branch" },
  { path: "pr.stacked", type: "boolean", doc: "its base isn't the repo's default branch: it's stacked on another PR" },
  {
    path: "pr.requires",
    type: "string[]",
    doc: 'PRs it needs merged first, as repo#number, in any state: the PR below it in its stack, and those its description names ("Requires", "Depends on", "Stacked on", "Builds on", "Blocked by", "Needs" or "Merge this after", then a link or ref)',
  },
  {
    path: "pr.blocked",
    type: "boolean",
    doc: "a PR it needs, or one that PR needs in turn, is still open (only PRs in its own org count; issues never block)",
  },
  { path: "pr.blocked_by", type: "string[]", doc: "the open PRs it needs directly, as repo#number" },
  {
    path: "pr.blocker",
    type: "string",
    doc: 'the open PR at the end of the chain, as repo#number, with "(through repo#number)" when it isn\'t one it needs directly; "" when not blocked',
  },
  {
    path: "pr.blocker_waits",
    type: "string",
    doc: 'what that PR waits on, as its pr.waits says it, or "is in Merging"; "" when not blocked',
  },
  { path: "pr.blocks", type: "string[]", doc: "open PRs that need this one merged first, directly or through others, as repo#number" },
  { path: "pr.requires_closed", type: "string[]", doc: "PRs it needs that were closed without merging" },
  {
    path: "pr.waiting_on",
    type: "string[]",
    doc: "who is asked to review it and hasn't approved: logins and @teams, you and bots left out; empty once it's approved",
  },
  {
    path: "pr.waits",
    type: "string",
    doc: 'what it waits on next, in words: "is your draft", "waits on a CI fix", "has changes requested by kofi", "waits on your reply to markstory, then a review from sam", "waits on a review from sam, @backend and 1 more", "waits on CI", "is ready to merge"; "" once merged or closed',
  },
  {
    path: "pr.unasked",
    type: "boolean",
    doc: "open and ready for review, but nobody's asked to review it (bots aside) and only bots or its author have reviewed it",
  },
  { path: "pr.pushed_hours", type: "number", doc: "hours since the latest commit (-1 if unknown)" },
  {
    path: "pr.my_area_files",
    type: "number",
    doc: "how many of its changed files (the first 50) are in directories you work in, from your PRs and reviews there in 90 days (-1 if not known yet)",
  },
  { path: "pr.my_area", type: "boolean", doc: "it changes code you work in (my_area_files >= 1)" },
  { path: "me.login", type: "string", doc: "your login" },
  { path: "me.author", type: "boolean", doc: "you opened it, or a bot opened it for you (author.via)" },
  { path: "me.assignee", type: "boolean", doc: "you are assigned" },
  { path: "me.requested", type: "boolean", doc: "a review is requested from you or one of your teams" },
  { path: "me.requested_direct", type: "boolean", doc: "a review is requested from you by name" },
  { path: "me.requested_team", type: "string", doc: 'your team behind the request, "" if none' },
  { path: "me.requested_codeowner", type: "boolean", doc: "the request came from CODEOWNERS" },
  { path: "me.requested_by", type: "string", doc: 'who added the request, "" if unknown' },
  { path: "me.requested_by_bot", type: "boolean", doc: "a bot added the request" },
  { path: "me.requested_hours", type: "number", doc: "hours since the request (-1 if none)" },
  { path: "me.reviewed", type: "boolean", doc: "you submitted a review" },
  {
    path: "me.review_state",
    type: "string",
    doc: 'your latest review: "approved", "changes_requested", "commented", "dismissed" or "none"',
  },
  { path: "me.reviewed_hours", type: "number", doc: "hours since your latest review (-1 if none)" },
  { path: "me.pushed_since_review", type: "boolean", doc: "someone pushed after your latest review" },
  { path: "me.commented", type: "boolean", doc: "you commented or reviewed" },
  { path: "me.last_action_hours", type: "number", doc: "hours since your latest comment, review or push (-1 if none)" },
  { path: "me.new_activity", type: "boolean", doc: "someone else acted after your latest action" },
  {
    path: "me.owes_reply",
    type: "boolean",
    doc: "your PR has an open thread or a comment where someone other than you (bots aside) spoke last, threads your push outdated after their last word aside: its row's Reply; false on others' PRs",
  },
  { path: "author.login", type: "string", doc: "author login" },
  { path: "author.bot", type: "boolean", doc: "author is a bot (GitHub App or listed in signals.bots)" },
  {
    path: "author.via",
    type: "string",
    doc: 'who a bot\'s PR says it was opened for (its "via …" line, "@login" or a name; untrusted), "" if none',
  },
  { path: "author.me", type: "boolean", doc: "you are the author, or a bot opened it for you" },
  { path: "author.engaged_90d", type: "number", doc: "this author's PRs you reviewed or commented on in the last 90 days" },
  { path: "author.close", type: "boolean", doc: "engaged_90d >= signals.close_collaborator_min" },
  { path: "repo.name", type: "string", doc: "owner/name" },
  { path: "repo.mine", type: "boolean", doc: "you own the repo or it is in signals.my_repos" },
  { path: "repo.my_prs_90d", type: "number", doc: "PRs you opened in this repo in the last 90 days" },
];

export interface Analysis {
  signals: Signals;
  activity_at: string; // latest activity by someone else, else created_at
  others_at: string | null; // latest activity by someone else, if any
  waiting_since: string;
}

const lc = (s: string) => s.toLowerCase();
// "greg.pstrucha", "@gricha" and "Greg Pstrucha" compare by their letters.
const letters = (s: string) => lc(s).replaceAll(/[^\p{L}]/gu, "");
const latest = (times: (string | null | undefined)[]): string | null =>
  times.reduce<string | null>((a, t) => (t && (!a || t > a) ? t : a), null);
export const botCheck = (listed: string[]) => {
  const set = new Set(listed.map(lc));
  return (login: string, flagged = false) => flagged || set.has(lc(login)) || login.endsWith("[bot]");
};

// A why in plain words for the Rules page: a field reads as "someone" or "some", and the blocked rules' as what they stand for.
const WORDS: Record<string, string> = {
  "pr.blocker": "another PR",
  "pr.blocker_waits": "waits on something",
  "pr.waits": "waits on something",
};
export function plainWhy(why: string): string {
  return why.replaceAll(/\{([a-z_]+(?:\.[a-z_0-9]+)+)\}/g, (whole, field: string) => {
    const type = FIELDS.find((f) => f.path === field)?.type;
    return WORDS[field] ?? (type === "number" ? "some" : type === "string" ? "someone" : whole);
  });
}

export function analyze(item: Item, ctx: Context, cfg: Config, now: Date): Analysis {
  const me = lc(ctx.me);
  const teams = new Set(ctx.teams.map(lc));
  const isMe = (login: string) => lc(login) === me;
  const isBot = botCheck(cfg.signals.bots);
  const hours = (iso: string | null) => (iso ? Math.max(0, (now.getTime() - Date.parse(iso)) / 3_600_000) : -1);
  // Git commit dates are author-controlled: never later than GitHub's own updatedAt, or now.
  const nowIso = now.toISOString();
  const headAt = item.head_committed_at ? ([item.head_committed_at, item.updated_at, nowIso].sort()[0] ?? null) : null;

  const mine = (r: { reviewer: string; type: "user" | "team" }) => (r.type === "user" ? isMe(r.reviewer) : teams.has(lc(r.reviewer)));
  const myRequests = item.review_requests.filter(mine);
  const direct = myRequests.some((r) => r.type === "user");
  const team = myRequests.find((r) => r.type === "team")?.reviewer ?? "";
  const requestEvents = item.request_events.filter((e) => mine({ reviewer: e.reviewer, type: e.reviewer_type }));
  const requestEvent = requestEvents.findLast((e) => (direct ? e.reviewer_type === "user" : true)) ?? null;
  const requested = myRequests.length > 0;

  const myReviews = item.reviews.filter((r) => isMe(r.author) && r.state !== "pending");
  // Thread replies create COMMENTED reviews; they shouldn't hide an approval or a changes request.
  const myReview = myReviews.findLast((r) => r.state !== "commented") ?? myReviews.at(-1) ?? null;
  const othersCommit = headAt && item.head_author && !isMe(item.head_author) ? headAt : null;
  const pushedSinceReview = Boolean(
    myReview &&
    (myReview.commit && item.head_oid
      ? myReview.commit !== item.head_oid && !isMe(item.head_author)
      : othersCommit && othersCommit > myReview.at),
  );
  const author = item.author;

  const lastAction = latest([
    ...item.comments.filter((c) => isMe(c.author)).map((c) => c.at),
    ...myReviews.map((r) => r.at),
    ...item.thread_last.filter((t) => isMe(t.author)).map((t) => t.at),
    item.head_author && isMe(item.head_author) ? headAt : null,
    isMe(author) ? item.created_at : null,
  ]);
  const others = latest(
    [
      ...item.comments.filter((c) => !isMe(c.author) && !isBot(c.author, c.author_bot)).map((c) => c.at),
      ...item.reviews.filter((r) => !isMe(r.author) && !isBot(r.author, r.author_bot) && r.state !== "pending").map((r) => r.at),
      ...item.thread_last.filter((t) => !isMe(t.author) && !isBot(t.author, t.author_bot)).map((t) => t.at),
      othersCommit,
      ...requestEvents.filter((e) => !isMe(e.actor)).map((e) => e.at),
    ].filter((t) => t && t <= nowIso),
  );
  const activity = others ?? item.created_at;

  const latestByReviewer = new Map<string, ReviewState>();
  for (const r of item.reviews) if (r.state !== "commented" && r.state !== "pending") latestByReviewer.set(lc(r.author), r.state);
  const approvals = [...latestByReviewer.values()].filter((s) => s === "approved").length;

  const [owner = "", name = ""] = item.repo.split("/");
  const engaged = Object.entries(ctx.affinity).find(([k]) => lc(k) === lc(author))?.[1] ?? 0;
  const authorBot = isBot(author, item.author_bot);
  const via = authorBot ? (item.via ?? "") : "";
  const viaMe = !!letters(via) && [ctx.me, ctx.name ?? ""].some((n) => letters(n) === letters(via));
  const yours = isMe(author) || viaMe;
  const repoPrs = Object.entries(ctx.repo_prs).find(([k]) => lc(k) === lc(item.repo))?.[1] ?? 0;
  const myAreaFiles = areaFiles(item, ctx);
  const waitingOn =
    item.kind !== "pr" || approved(item, yours ? ctx.me : author)
      ? []
      : item.review_requests
          .filter((r) => !isBot(r.reviewer, r.bot) && (r.type === "team" || !isMe(r.reviewer)))
          .map((r) => (r.type === "team" ? `@${r.reviewer}` : r.reviewer));

  const signals: Signals = {
    item: {
      kind: item.kind,
      id: item.id,
      repo: item.repo,
      owner,
      name,
      number: item.number,
      title: item.title,
      url: item.url,
      author,
      state: item.state,
      draft: item.draft,
      labels: item.labels,
      created_hours: hours(item.created_at),
      updated_hours: hours(item.updated_at),
      activity_hours: hours(activity),
      comments: item.comments_total,
    },
    pr: {
      size: item.additions + item.deletions,
      additions: item.additions,
      deletions: item.deletions,
      files: item.changed_files,
      ci: item.ci,
      review: item.review_decision,
      mergeable: item.mergeable,
      approvals,
      unresolved_threads: item.threads_unresolved,
      base: item.base,
      stacked: !!item.default_branch && !!item.base && item.base !== item.default_branch,
      unasked:
        item.kind === "pr" &&
        item.state === "open" &&
        !item.draft &&
        !item.review_requests_hidden &&
        !item.review_requests.some((r) => !isBot(r.reviewer, r.bot)) &&
        !item.reviews.some((r) => lc(r.author) !== lc(item.author) && !isMe(r.author) && !isBot(r.author, r.author_bot)),
      pushed_hours: hours(headAt),
      my_area_files: myAreaFiles,
      my_area: myAreaFiles >= 1,
      requires: [],
      blocked: false,
      blocked_by: [],
      blocker: "",
      blocker_waits: "",
      blocks: [],
      requires_closed: [],
      waiting_on: waitingOn,
      waits: "",
    },
    me: {
      login: ctx.me,
      author: yours,
      assignee: item.assignees.some(isMe),
      requested,
      requested_direct: direct,
      requested_team: team,
      requested_codeowner: myRequests.some((r) => r.codeowner),
      requested_by: requestEvent?.actor ?? "",
      requested_by_bot: requestEvent ? isBot(requestEvent.actor, requestEvent.actor_bot) : false,
      requested_hours: requested ? hours(requestEvent?.at ?? null) : -1,
      reviewed: myReview !== null,
      review_state: myReview?.state ?? "none",
      reviewed_hours: hours(myReview?.at ?? null),
      pushed_since_review: pushedSinceReview,
      commented: item.comments.some((c) => isMe(c.author)) || myReviews.length > 0,
      last_action_hours: hours(lastAction),
      new_activity: Boolean(lastAction && others && others > lastAction),
      owes_reply: yours && item.kind === "pr" && owesReply(item, ctx.me),
    },
    author: {
      login: author,
      bot: authorBot,
      via,
      me: yours,
      engaged_90d: engaged,
      close: !authorBot && !yours && engaged >= cfg.signals.close_collaborator_min,
    },
    repo: {
      name: item.repo,
      mine: lc(owner) === me || cfg.signals.my_repos.some((r) => lc(r) === lc(item.repo)),
      my_prs_90d: repoPrs,
    },
  };
  signals.pr.waits = waitsOf(item, ctx.me, { mine: yours, unasked: signals.pr.unasked, askedYou: requested, waitingOn });
  return {
    signals,
    activity_at: activity,
    others_at: others,
    waiting_since: requested && requestEvent ? requestEvent.at : item.created_at,
  };
}

// What a snooze can wait on for this item now: only what hasn't happened yet. `me`: you, whose own review doesn't approve.
export function waitable(s: Signals, item: Item, me: string): Until[] {
  if (s.item.kind !== "pr" || s.item.state !== "open") return [];
  const out: Until[] = [];
  if (s.pr.ci === "red" || s.pr.ci === "pending") out.push("ci");
  if (!s.me.author && item.head_oid) out.push("push");
  if (s.me.author && !approved(item, me)) out.push("approved");
  if (!s.me.author && s.item.draft) out.push("ready");
  if (s.pr.mergeable === "conflict") out.push("conflict");
  return out;
}

// Whether what a snooze waits on has happened. Not while it's closed: it's in the Archive then, and reopened it still waits.
export function happened(when: string, s: Signals, item: Item, me: string): boolean {
  if (s.item.state !== "open") return false;
  const [k, sha] = when.split(":");
  if (k === "ci") return s.pr.ci === "green";
  if (k === "push") return item.head_oid !== sha;
  if (k === "approved") return approved(item, me);
  if (k === "ready") return !s.item.draft;
  if (k === "conflict") return s.pr.mergeable === "clean";
  return true;
}
