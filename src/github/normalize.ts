// GraphQL nodes -> Item / SearchHit.

import { requiresOf } from "../deps.ts";
import type { Ci, Item, Mergeable, ReviewDecision, ReviewState } from "../types.ts";
import type { SearchHit } from "./index.ts";

export interface Actor {
  __typename?: string;
  login: string;
}
interface Reviewer {
  __typename: string;
  login?: string;
  slug?: string;
}
interface Conn<T> {
  totalCount?: number;
  nodes: T[];
}
interface RawReview {
  author: Actor | null;
  authorAssociation?: string;
  state: string;
  submittedAt: string | null;
  createdAt: string;
  commit?: { oid: string } | null;
}
interface RawComment {
  author: Actor | null;
  authorAssociation?: string;
  createdAt: string;
}

// Has a say on the repo. Anyone else can comment on a public PR.
const COLLABORATORS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const collaborator = (association: string | undefined) => COLLABORATORS.has(association ?? "");

export interface RawHit {
  __typename: "PullRequest" | "Issue";
  id: string;
  number: number;
  title?: string;
  updatedAt: string;
  repository: { nameWithOwner: string };
  author: Actor | null;
}

export interface RawNode extends RawHit {
  repository: { nameWithOwner: string; viewerDefaultMergeMethod?: string };
  title: string;
  url: string;
  state: string;
  createdAt: string;
  closedAt?: string | null;
  bodyText: string;
  labels: Conn<{ name: string }>;
  assignees: Conn<{ login: string }>;
  comments: Conn<RawComment>;
  // PullRequest only
  isDraft?: boolean;
  body?: string; // markdown
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  baseRefName?: string;
  baseRepository?: { defaultBranchRef: { name: string } | null } | null;
  headRefName?: string;
  headRepository?: { nameWithOwner: string } | null;
  reviewDecision?: string | null;
  mergedBy?: { login: string } | null;
  files?: Conn<{ path: string }> | null;
  mergeable?: string;
  checks?: Conn<{ commit: { statusCheckRollup: { contexts: Conn<RawCheck | null> } | null } }>;
  reviewRequests?: Conn<{ asCodeOwner: boolean; requestedReviewer: Reviewer | null }>;
  timelineItems?: Conn<{ createdAt: string; actor: Actor | null; requestedReviewer: Reviewer | null }>;
  baseChanges?: Conn<{ previousRefName?: string; oldBase?: string; createdAt: string }>;
  latestReviews?: Conn<RawReview>;
  latestOpinionatedReviews?: Conn<RawReview>;
  reviews?: Conn<RawReview>;
  reviewThreads?: Conn<{ isResolved: boolean; isOutdated?: boolean; comments?: Conn<RawComment> }>;
  commits?: Conn<{
    commit: {
      oid: string;
      committedDate: string;
      author: { user: { login: string } | null } | null;
      statusCheckRollup: { state: string } | null;
    };
  }>;
}

const CI: Record<string, Ci> = { SUCCESS: "green", FAILURE: "red", ERROR: "red", PENDING: "pending", EXPECTED: "pending" };
const DECISION: Record<string, ReviewDecision> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  REVIEW_REQUIRED: "required",
};
const MERGEABLE: Record<string, Mergeable> = { MERGEABLE: "clean", CONFLICTING: "conflict" };
const MERGE_METHODS = new Set(["MERGE", "SQUASH", "REBASE"]);

// A check run or a commit status, as the statusCheckRollup lists them.
export interface RawCheck {
  __typename: string;
  name?: string;
  conclusion?: string | null;
  context?: string;
  state?: string;
  status?: string; // a check run's: QUEUED, IN_PROGRESS, COMPLETED, …
  isRequired?: boolean; // for this PR's base branch; only asked of your own PRs
}
// Cancelled and skipped runs aren't the code's fault, so they don't count.
const FAILED = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "ERROR"]);
const checkFailed = (c: RawCheck) => FAILED.has((c.__typename === "CheckRun" ? c.conclusion : c.state) ?? "");
const checkName = (c: RawCheck) => (c.__typename === "CheckRun" ? c.name : c.context) ?? "";
const checkRunning = (c: RawCheck) =>
  c.__typename === "CheckRun" ? c.status !== undefined && c.status !== "COMPLETED" : c.state === "PENDING" || c.state === "EXPECTED";

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
  // reviews(last: 20) can be flooded by bot comments; the latest* lists keep each reviewer's verdict.
  const reviews = new Map<string, Item["reviews"][number]>();
  for (const r of [...(n.reviews?.nodes ?? []), ...(n.latestReviews?.nodes ?? []), ...(n.latestOpinionatedReviews?.nodes ?? [])]) {
    const at = r.submittedAt ?? r.createdAt;
    reviews.set(`${login(r.author)}|${r.state}|${at}`, {
      author: login(r.author),
      author_bot: isBot(r.author),
      trusted: collaborator(r.authorAssociation),
      state: r.state.toLowerCase() as ReviewState,
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
    state: n.state.toLowerCase() as Item["state"],
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
    ...(n.__typename === "PullRequest" && { requires: requiresOf(n.body ?? "", n.repository.nameWithOwner, n.number) }),
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
    head_ref: n.headRefName ?? "",
    head_repo: n.headRepository?.nameWithOwner ?? "",
    ...(n.baseChanges && { retargeted: moved ? { from: moved.previousRefName ?? moved.oldBase ?? "", at: moved.createdAt } : null }),
    ...(n.files && { paths: n.files.nodes.map((f) => f.path) }),
    ...(checks && { checks_failed: checks.filter(checkFailed).map(checkName) }),
    ...(optional.length > 0 && { checks_optional: optional }),
    ...(MERGE_METHODS.has(n.repository.viewerDefaultMergeMethod ?? "") && {
      merge_method: n.repository.viewerDefaultMergeMethod as NonNullable<Item["merge_method"]>,
    }),
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
        })),
      ),
    ),
    detail_at: now,
  };
}
