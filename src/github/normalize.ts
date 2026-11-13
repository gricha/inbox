// GraphQL nodes -> Item / SearchHit.

import { Schema } from "effect";
import { requiresOf } from "../deps.ts";
import { oneOf } from "../narrow.ts";
import { requesterOf } from "./behalf.ts";
import type { Check, Ci, Item, Mergeable, ReviewDecision, ReviewState } from "../types.ts";
import type { SearchHit } from "./index.ts";

// The GraphQL nodes the queries ask for, as schemas: a node that isn't that shape fails its read, never a crash later.
const conn = <T extends Schema.Top>(node: T) => Schema.Struct({ totalCount: Schema.optionalKey(Schema.Number), nodes: Schema.Array(node) });

export const ACTOR = Schema.Struct({ __typename: Schema.optionalKey(Schema.String), login: Schema.String });
export type Actor = typeof ACTOR.Type;
const REVIEWER = Schema.Struct({
  __typename: Schema.String,
  login: Schema.optionalKey(Schema.String),
  slug: Schema.optionalKey(Schema.String),
});
type Reviewer = typeof REVIEWER.Type;
export const REVIEW_STATE = Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]);
export const REVIEW_STATES: Record<typeof REVIEW_STATE.Type, ReviewState> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
  PENDING: "pending",
};
const OID = Schema.NullOr(Schema.Struct({ oid: Schema.String }));
const RAW_REVIEW = Schema.Struct({
  author: Schema.NullOr(ACTOR),
  authorAssociation: Schema.optionalKey(Schema.String),
  state: REVIEW_STATE,
  submittedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  commit: Schema.optionalKey(OID),
});
const RAW_COMMENT = Schema.Struct({
  author: Schema.NullOr(ACTOR),
  authorAssociation: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  commit: Schema.optionalKey(OID),
});
export const COMMIT_AUTHOR = Schema.NullOr(Schema.Struct({ user: Schema.NullOr(Schema.Struct({ login: Schema.String })) }));
const RAW_COMMIT = { oid: Schema.String, committedDate: Schema.String, author: COMMIT_AUTHOR };

// Has a say on the repo. Anyone else can comment on a public PR.
const COLLABORATORS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const collaborator = (association: string | undefined) => COLLABORATORS.has(association ?? "");

const HIT = {
  __typename: Schema.Literals(["PullRequest", "Issue"]),
  id: Schema.String,
  number: Schema.Number,
  title: Schema.optionalKey(Schema.String),
  updatedAt: Schema.String,
  repository: Schema.Struct({ nameWithOwner: Schema.String }),
  author: Schema.NullOr(ACTOR),
};
export const RAW_HIT = Schema.Struct(HIT);
export type RawHit = typeof RAW_HIT.Type;

// A check run or a commit status, as the statusCheckRollup lists them.
export const RAW_CHECK = Schema.Struct({
  __typename: Schema.String,
  name: Schema.optionalKey(Schema.String),
  conclusion: Schema.optionalKey(Schema.NullOr(Schema.String)),
  context: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String), // a check run's: QUEUED, IN_PROGRESS, COMPLETED, …
  isRequired: Schema.optionalKey(Schema.Boolean), // for this PR's base branch; only asked of your own PRs, and of the PR whose review lists its checks
  permalink: Schema.optionalKey(Schema.String), // a check run's page on GitHub; only asked for a review's list
  targetUrl: Schema.optionalKey(Schema.NullOr(Schema.String)), // where a commit status points, which is its sender's to choose; only asked for a review's list
});
export type RawCheck = typeof RAW_CHECK.Type;

export const RAW_NODE = Schema.Struct({
  ...HIT,
  repository: Schema.Struct({ nameWithOwner: Schema.String, viewerDefaultMergeMethod: Schema.optionalKey(Schema.String) }),
  title: Schema.String,
  url: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  createdAt: Schema.String,
  closedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  bodyText: Schema.String,
  labels: conn(Schema.Struct({ name: Schema.String })),
  assignees: conn(Schema.Struct({ login: Schema.String })),
  comments: conn(RAW_COMMENT),
  // PullRequest only
  isDraft: Schema.optionalKey(Schema.Boolean),
  body: Schema.optionalKey(Schema.String), // markdown
  additions: Schema.optionalKey(Schema.Number),
  deletions: Schema.optionalKey(Schema.Number),
  changedFiles: Schema.optionalKey(Schema.Number),
  baseRefName: Schema.optionalKey(Schema.String),
  baseRepository: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ defaultBranchRef: Schema.NullOr(Schema.Struct({ name: Schema.String })) })),
  ),
  headRefName: Schema.optionalKey(Schema.String),
  headRepository: Schema.optionalKey(Schema.NullOr(Schema.Struct({ nameWithOwner: Schema.String }))),
  reviewDecision: Schema.optionalKey(Schema.NullOr(Schema.String)),
  mergedBy: Schema.optionalKey(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
  files: Schema.optionalKey(Schema.NullOr(conn(Schema.Struct({ path: Schema.String })))),
  mergeable: Schema.optionalKey(Schema.String),
  checks: Schema.optionalKey(
    conn(
      Schema.Struct({
        commit: Schema.Struct({ statusCheckRollup: Schema.NullOr(Schema.Struct({ contexts: conn(Schema.NullOr(RAW_CHECK)) })) }),
      }),
    ),
  ),
  reviewRequests: Schema.optionalKey(conn(Schema.Struct({ asCodeOwner: Schema.Boolean, requestedReviewer: Schema.NullOr(REVIEWER) }))),
  timelineItems: Schema.optionalKey(
    conn(Schema.Struct({ createdAt: Schema.String, actor: Schema.NullOr(ACTOR), requestedReviewer: Schema.NullOr(REVIEWER) })),
  ),
  baseChanges: Schema.optionalKey(
    conn(
      Schema.Struct({
        previousRefName: Schema.optionalKey(Schema.String),
        oldBase: Schema.optionalKey(Schema.String),
        createdAt: Schema.String,
      }),
    ),
  ),
  readied: Schema.optionalKey(conn(Schema.Struct({ createdAt: Schema.String }))),
  latestReviews: Schema.optionalKey(conn(RAW_REVIEW)),
  latestOpinionatedReviews: Schema.optionalKey(conn(RAW_REVIEW)),
  reviews: Schema.optionalKey(conn(RAW_REVIEW)),
  reviewThreads: Schema.optionalKey(
    conn(
      Schema.Struct({
        isResolved: Schema.Boolean,
        isOutdated: Schema.optionalKey(Schema.Boolean),
        comments: Schema.optionalKey(conn(RAW_COMMENT)),
      }),
    ),
  ),
  commits: Schema.optionalKey(
    conn(
      Schema.Struct({
        commit: Schema.Struct({ ...RAW_COMMIT, statusCheckRollup: Schema.NullOr(Schema.Struct({ state: Schema.String })) }),
      }),
    ),
  ),
  recent: Schema.optionalKey(conn(Schema.Struct({ commit: Schema.Struct(RAW_COMMIT) }))),
});
export type RawNode = typeof RAW_NODE.Type;

const ITEM_STATES: Record<RawNode["state"], Item["state"]> = { OPEN: "open", CLOSED: "closed", MERGED: "merged" };

const CI: Record<string, Ci> = { SUCCESS: "green", FAILURE: "red", ERROR: "red", PENDING: "pending", EXPECTED: "pending" };
const DECISION: Record<string, ReviewDecision> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  REVIEW_REQUIRED: "required",
};
const MERGEABLE: Record<string, Mergeable> = { MERGEABLE: "clean", CONFLICTING: "conflict" };
const MERGE_METHODS = ["MERGE", "SQUASH", "REBASE"] as const;

// Cancelled and skipped runs aren't the code's fault, so they don't count.
const FAILED = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "ERROR"]);
const checkFailed = (c: RawCheck) => FAILED.has((c.__typename === "CheckRun" ? c.conclusion : c.state) ?? "");
const checkName = (c: RawCheck) => (c.__typename === "CheckRun" ? c.name : c.context) ?? "";
const checkRunning = (c: RawCheck) =>
  c.__typename === "CheckRun" ? c.status !== undefined && c.status !== "COMPLETED" : c.state === "PENDING" || c.state === "EXPECTED";

// Only an https link is one, as its parsed href and with no userinfo: a status's target is whatever its sender set.
function httpsOnly(url: string | null | undefined): string {
  const u = URL.parse(url ?? "");
  return u?.protocol === "https:" && !u.username && !u.password ? u.href : "";
}

// A PR's checks as its review lists them, in GitHub's order. Cancelled says so: it didn't fail, and it didn't pass either.
export function toChecks(checks: RawCheck[]): Check[] {
  const some = checks.some((c) => c.isRequired);
  return checks.map((c) => {
    const said = (c.__typename === "CheckRun" ? c.conclusion : c.state) ?? "";
    return {
      name: checkName(c),
      state: checkFailed(c)
        ? "failing"
        : checkRunning(c)
          ? "running"
          : said === "SUCCESS"
            ? "passing"
            : said === "CANCELLED"
              ? "cancelled"
              : "skipped",
      optional: some && !c.isRequired,
      url: httpsOnly(c.__typename === "CheckRun" ? c.permalink : c.targetUrl),
    };
  });
}

// CI as the merge sees it: in a repo that marks some checks required, failing checks that aren't don't make it red.
function ciOf(rollup: string | undefined, checks: RawCheck[] | null): { ci: Ci; optional: string[] } {
  const ci = CI[rollup ?? ""] ?? "none";
  if (!checks?.some((c) => c.isRequired)) return { ci, optional: [] };
  const failed = checks.filter(checkFailed);
  const optional = failed.filter((c) => c.isRequired === false).map(checkName);
  if (ci !== "red" || !failed.length || optional.length < failed.length) return { ci, optional };
  return { ci: checks.some(checkRunning) ? "pending" : "green", optional };
}

export const login = (a: Actor | null) => a?.login ?? "ghost";
// GraphQL drops the [bot] suffix for apps, so __typename is the reliable signal.
export const isBot = (a: Actor | null) => a?.__typename === "Bot" || !!a?.login.endsWith("[bot]");
const byAt = <T extends { at: string }>(xs: T[]) => xs.sort((a, b) => a.at.localeCompare(b.at));
// An agent that opens PRs for people (Junior) ends its description with "via @login." or "via Some Name.": the last such line.
const viaOf = (text: string) => [...text.matchAll(/^via (@?[^\n]{1,60}?)\.?[ \t]*$/gm)].at(-1)?.[1]?.trim() ?? "";
const reviewer = (r: Reviewer) =>
  r.__typename === "Team"
    ? { reviewer: r.slug!, type: "team" as const }
    : { reviewer: r.login ?? "ghost", type: "user" as const, ...(r.__typename === "Bot" && { bot: true }) };

export function toHit(n: RawHit): SearchHit {
  return {
    node_id: n.id,
    id: `${n.repository.nameWithOwner}#${n.number}`,
    kind: n.__typename === "PullRequest" ? "pr" : "issue",
    updated_at: n.updatedAt,
    author: login(n.author),
    author_bot: isBot(n.author),
    ...(n.title !== undefined && { title: n.title }),
  };
}

export function normalize(n: RawNode, now = new Date().toISOString()): Item {
  const head = n.commits?.nodes[0]?.commit;
  const threads = n.reviewThreads?.nodes ?? [];
  const checks = n.checks ? (n.checks.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).filter((c) => c !== null) : null;
  const { ci, optional } = ciOf(head?.statusCheckRollup?.state, checks);
  const moved = n.baseChanges?.nodes[0];
  const mergeMethod = oneOf(MERGE_METHODS, n.repository.viewerDefaultMergeMethod);
  // reviews(last: 20) can be flooded by bot comments; the latest* lists keep each reviewer's verdict.
  const reviews = new Map<string, Item["reviews"][number]>();
  for (const r of [...(n.reviews?.nodes ?? []), ...(n.latestReviews?.nodes ?? []), ...(n.latestOpinionatedReviews?.nodes ?? [])]) {
    const at = r.submittedAt ?? r.createdAt;
    reviews.set(`${login(r.author)}|${r.state}|${at}`, {
      author: login(r.author),
      author_bot: isBot(r.author),
      trusted: collaborator(r.authorAssociation),
      state: REVIEW_STATES[r.state],
      at,
      commit: r.commit?.oid ?? "",
    });
  }

  return {
    ...toHit(n),
    title: n.title,
    url: n.url,
    repo: n.repository.nameWithOwner,
    number: n.number,
    author_bot: isBot(n.author),
    via: isBot(n.author) ? viaOf(n.bodyText) : "",
    state: ITEM_STATES[n.state],
    draft: n.isDraft ?? false,
    labels: n.labels.nodes.map((l) => l.name),
    assignees: n.assignees.nodes.map((a) => a.login),
    created_at: n.createdAt,
    closed_at: n.closedAt ?? null,
    body: n.bodyText
      .replaceAll(/\s*\n\s*/g, "\n")
      .replaceAll(/[^\S\n]+/g, " ")
      .trim()
      .slice(0, 600),
    ...(n.__typename === "PullRequest" && {
      requires: requiresOf(n.body ?? "", n.repository.nameWithOwner, n.number),
      requester: requesterOf(n.body ?? ""),
    }),
    merged_by: n.mergedBy?.login ?? "",
    additions: n.additions ?? 0,
    deletions: n.deletions ?? 0,
    changed_files: n.changedFiles ?? 0,
    base: n.baseRefName ?? "",
    default_branch: n.baseRepository?.defaultBranchRef?.name ?? "",
    ci,
    review_decision: DECISION[n.reviewDecision ?? ""] ?? "none",
    mergeable: MERGEABLE[n.mergeable ?? ""] ?? "unknown",
    head_oid: head?.oid ?? "",
    head_committed_at: head?.committedDate ?? null,
    head_author: head?.author?.user?.login ?? "",
    ...(n.recent && {
      commits: n.recent.nodes.map(({ commit: c }) => ({ oid: c.oid, at: c.committedDate, author: c.author?.user?.login ?? "" })),
    }),
    head_ref: n.headRefName ?? "",
    head_repo: n.headRepository?.nameWithOwner ?? "",
    ...(n.baseChanges && { retargeted: moved ? { from: moved.previousRefName ?? moved.oldBase ?? "", at: moved.createdAt } : null }),
    ...(n.readied && { ready_at: n.readied.nodes[0]?.createdAt ?? null }),
    ...(n.files && { paths: n.files.nodes.map((f) => f.path) }),
    ...(checks && { checks_failed: checks.filter(checkFailed).map(checkName) }),
    ...(optional.length > 0 && { checks_optional: optional }),
    ...(mergeMethod && { merge_method: mergeMethod }),
    review_requests: (n.reviewRequests?.nodes ?? [])
      .filter((r) => r.requestedReviewer)
      .map((r) => Object.assign(reviewer(r.requestedReviewer!), { codeowner: r.asCodeOwner })),
    ...(n.reviewRequests?.nodes.some((r) => !r.requestedReviewer) && {
      review_requests_hidden: n.reviewRequests.nodes.filter((r) => !r.requestedReviewer).length,
    }),
    request_events: byAt(
      (n.timelineItems?.nodes ?? [])
        .filter((e) => e.requestedReviewer)
        .map((e) => {
          const rv = reviewer(e.requestedReviewer!);
          return { at: e.createdAt, actor: login(e.actor), actor_bot: isBot(e.actor), reviewer: rv.reviewer, reviewer_type: rv.type };
        }),
    ),
    reviews: byAt([...reviews.values()]),
    comments: byAt(
      n.comments.nodes.map((c) => ({
        author: login(c.author),
        author_bot: isBot(c.author),
        trusted: collaborator(c.authorAssociation),
        at: c.createdAt,
      })),
    ),
    comments_total: n.comments.totalCount ?? 0,
    threads_total: n.reviewThreads?.totalCount ?? 0,
    threads_unresolved: threads.filter((t) => !t.isResolved).length,
    thread_last: byAt(
      threads.flatMap((t) =>
        (t.comments?.nodes ?? []).map((c) => ({
          author: login(c.author),
          author_bot: isBot(c.author),
          trusted: collaborator(c.authorAssociation),
          at: c.createdAt,
          resolved: t.isResolved,
          outdated: !!t.isOutdated,
          commit: c.commit?.oid ?? "",
        })),
      ),
    ),
    detail_at: now,
  };
}
