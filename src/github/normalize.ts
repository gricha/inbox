// GraphQL nodes -> Item / SearchHit.

import type { Ci, Item, Mergeable, ReviewDecision, ReviewState } from "../types.ts";
import type { SearchHit } from "./index.ts";

interface Actor {
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
  state: string;
  submittedAt: string | null;
  createdAt: string;
  commit?: { oid: string } | null;
}
interface RawComment {
  author: Actor | null;
  createdAt: string;
}

export interface RawHit {
  __typename: "PullRequest" | "Issue";
  id: string;
  number: number;
  updatedAt: string;
  repository: { nameWithOwner: string };
  author: Actor | null;
}

export interface RawNode extends RawHit {
  title: string;
  url: string;
  state: string;
  createdAt: string;
  labels: Conn<{ name: string }>;
  assignees: Conn<{ login: string }>;
  comments: Conn<RawComment>;
  // PullRequest only
  isDraft?: boolean;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  baseRefName?: string;
  reviewDecision?: string | null;
  mergeable?: string;
  reviewRequests?: Conn<{ asCodeOwner: boolean; requestedReviewer: Reviewer | null }>;
  timelineItems?: Conn<{ createdAt: string; actor: Actor | null; requestedReviewer: Reviewer | null }>;
  latestReviews?: Conn<RawReview>;
  latestOpinionatedReviews?: Conn<RawReview>;
  reviews?: Conn<RawReview>;
  reviewThreads?: Conn<{ isResolved: boolean; comments?: Conn<RawComment> }>;
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

const login = (a: Actor | null) => a?.login ?? "ghost";
// GraphQL drops the [bot] suffix for apps, so __typename is the reliable signal.
const isBot = (a: Actor | null) => a?.__typename === "Bot" || !!a?.login.endsWith("[bot]");
const byAt = <T extends { at: string }>(xs: T[]) => xs.sort((a, b) => a.at.localeCompare(b.at));
const reviewer = (r: Reviewer) =>
  r.__typename === "Team" ? { reviewer: r.slug!, type: "team" as const } : { reviewer: r.login ?? "ghost", type: "user" as const };

export function toHit(n: RawHit): SearchHit {
  return {
    node_id: n.id,
    id: `${n.repository.nameWithOwner}#${n.number}`,
    kind: n.__typename === "PullRequest" ? "pr" : "issue",
    updated_at: n.updatedAt,
    author: login(n.author),
    author_bot: isBot(n.author),
  };
}

export function normalize(n: RawNode, now = new Date().toISOString()): Item {
  const head = n.commits?.nodes[0]?.commit;
  const threads = n.reviewThreads?.nodes ?? [];
  // reviews(last: 20) can be flooded by bot comments; the latest* lists keep each reviewer's verdict.
  const reviews = new Map<string, Item["reviews"][number]>();
  for (const r of [...(n.reviews?.nodes ?? []), ...(n.latestReviews?.nodes ?? []), ...(n.latestOpinionatedReviews?.nodes ?? [])]) {
    const at = r.submittedAt ?? r.createdAt;
    reviews.set(`${login(r.author)}|${r.state}|${at}`, {
      author: login(r.author),
      author_bot: isBot(r.author),
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
    state: n.state.toLowerCase() as Item["state"],
    draft: n.isDraft ?? false,
    labels: n.labels.nodes.map((l) => l.name),
    assignees: n.assignees.nodes.map((a) => a.login),
    created_at: n.createdAt,
    additions: n.additions ?? 0,
    deletions: n.deletions ?? 0,
    changed_files: n.changedFiles ?? 0,
    base: n.baseRefName ?? "",
    ci: CI[head?.statusCheckRollup?.state ?? ""] ?? "none",
    review_decision: DECISION[n.reviewDecision ?? ""] ?? "none",
    mergeable: MERGEABLE[n.mergeable ?? ""] ?? "unknown",
    head_oid: head?.oid ?? "",
    head_committed_at: head?.committedDate ?? null,
    head_author: head?.author?.user?.login ?? "",
    review_requests: (n.reviewRequests?.nodes ?? [])
      .filter((r) => r.requestedReviewer)
      .map((r) => Object.assign(reviewer(r.requestedReviewer!), { codeowner: r.asCodeOwner })),
    request_events: byAt(
      (n.timelineItems?.nodes ?? [])
        .filter((e) => e.requestedReviewer)
        .map((e) => {
          const rv = reviewer(e.requestedReviewer!);
          return { at: e.createdAt, actor: login(e.actor), actor_bot: isBot(e.actor), reviewer: rv.reviewer, reviewer_type: rv.type };
        }),
    ),
    reviews: byAt([...reviews.values()]),
    comments: byAt(n.comments.nodes.map((c) => ({ author: login(c.author), author_bot: isBot(c.author), at: c.createdAt }))),
    comments_total: n.comments.totalCount ?? 0,
    threads_total: n.reviewThreads?.totalCount ?? 0,
    threads_unresolved: threads.filter((t) => !t.isResolved).length,
    thread_last: byAt(
      threads.flatMap((t) =>
        (t.comments?.nodes ?? []).map((c) => ({ author: login(c.author), author_bot: isBot(c.author), at: c.createdAt })),
      ),
    ),
    detail_at: now,
  };
}
