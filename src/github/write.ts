// The desk's only writes to GitHub: the mutations on ALLOWED, sent when you act in the UI, each one logged.
// It doesn't go through the read client (client.ts), which keeps refusing every mutation.
import { readToken } from "./client.ts";

const ENDPOINT = "https://api.github.com/graphql";

// Every mutation the desk may send. No MCP tool or CLI command reaches this module: agents never approve or post.
// commitOID pins the approval to the commit you read, not whatever was pushed since.
// reply and comment: your reply to a conversation in a PR's review, when you press Send.
// inline_comment: your comment on a line (or lines) of a PR's diff, posted at once like GitHub's "Add single comment", pinned
// to the commit the review showed.
// ready: your own draft's "Ready for review" (a on its row or in its review); request_reviews: the reviewers you picked with
// it, added to any already asked (union).
// The rest are the More menu's (.): close, draft, mark ready, merge and reopen your own PR, request changes on someone else's, close an issue.
// expectedHeadOid pins a merge to the commit the desk judged ready, so a push since then isn't merged unseen.
export const ALLOWED = {
  approve: `mutation DeskApprove($pr: ID!, $commit: GitObjectID!, $body: String) {
  addPullRequestReview(input: { pullRequestId: $pr, commitOID: $commit, event: APPROVE, body: $body }) { pullRequestReview { url } }
}`,
  reply: `mutation DeskReply($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { url } }
}`,
  comment: `mutation DeskComment($subject: ID!, $body: String!) {
  addComment(input: { subjectId: $subject, body: $body }) { commentEdge { node { url } } }
}`,
  inline_comment: `mutation DeskInlineComment($pr: ID!, $commit: GitObjectID!, $thread: DraftPullRequestReviewThread!) {
  addPullRequestReview(input: { pullRequestId: $pr, commitOID: $commit, event: COMMENT, threads: [$thread] }) { pullRequestReview { url comments(first: 1) { nodes { url } } } }
}`,
  ready: `mutation DeskReady($pr: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $pr }) { pullRequest { isDraft } }
}`,
  request_reviews: `mutation DeskRequestReviews($pr: ID!, $users: [ID!], $teams: [ID!]) {
  requestReviews(input: { pullRequestId: $pr, userIds: $users, teamIds: $teams, union: true }) { pullRequest { id } }
}`,
  close: `mutation DeskClose($pr: ID!) {
  closePullRequest(input: { pullRequestId: $pr }) { pullRequest { state } }
}`,
  draft: `mutation DeskDraft($pr: ID!) {
  convertPullRequestToDraft(input: { pullRequestId: $pr }) { pullRequest { isDraft } }
}`,
  merge: `mutation DeskMerge($pr: ID!, $head: GitObjectID!, $method: PullRequestMergeMethod!) {
  mergePullRequest(input: { pullRequestId: $pr, expectedHeadOid: $head, mergeMethod: $method }) { pullRequest { state } }
}`,
  reopen: `mutation DeskReopen($pr: ID!) {
  reopenPullRequest(input: { pullRequestId: $pr }) { pullRequest { state } }
}`,
  request_changes: `mutation DeskRequestChanges($pr: ID!, $commit: GitObjectID!, $body: String!) {
  addPullRequestReview(input: { pullRequestId: $pr, commitOID: $commit, event: REQUEST_CHANGES, body: $body }) { pullRequestReview { url } }
}`,
  close_issue: `mutation DeskCloseIssue($issue: ID!) {
  closeIssue(input: { issueId: $issue }) { issue { state } }
}`,
} as const;

// GitHub's DraftPullRequestReviewThread: line numbers in the file on that side (LEFT: the old file), the range ending at line.
export interface InlineThread {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
  body: string;
}

export interface GitHubWriter {
  approve(prNodeId: string, commit: string, body?: string): Promise<{ url: string }>;
  reply(threadId: string, body: string): Promise<{ url: string }>; // to a review thread
  comment(prNodeId: string, body: string): Promise<{ url: string }>; // on the PR
  inlineComment(prNodeId: string, commit: string, thread: InlineThread): Promise<{ url: string }>; // on a line of its diff
  ready(prNodeId: string): Promise<void>; // a draft, ready for review
  requestReviews(prNodeId: string, users: string[], teams: string[]): Promise<void>; // node ids
  close(prNodeId: string): Promise<void>;
  draft(prNodeId: string): Promise<void>; // back to draft
  merge(prNodeId: string, head: string, method: "MERGE" | "SQUASH" | "REBASE"): Promise<void>;
  reopen(prNodeId: string): Promise<void>;
  requestChanges(prNodeId: string, commit: string, body: string): Promise<{ url: string }>;
  closeIssue(issueNodeId: string): Promise<void>;
}

export function createWriter(opts: { token?: string; fetch?: typeof fetch; log?: (msg: string) => void } = {}): GitHubWriter {
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? (() => {});

  // No retries: a write that timed out may have landed.
  async function send(name: keyof typeof ALLOWED, target: string, variables: Record<string, unknown>): Promise<unknown> {
    const at = variables.commit ?? variables.head;
    log(`github write: ${name} ${target}${typeof at === "string" ? ` at ${at}` : ""}`);
    const res = await doFetch(ENDPOINT, {
      method: "POST",
      // Read fresh for every write rather than shared with the read client.
      headers: { authorization: `bearer ${await readToken(opts.token)}`, "content-type": "application/json", "user-agent": "review-desk" },
      body: JSON.stringify({ query: ALLOWED[name], variables }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text) as { data?: unknown; errors?: { message: string }[] };
    if (json.errors?.length) throw new Error(`GitHub: ${json.errors.map((e) => e.message).join("; ")}`);
    return json.data;
  }

  return {
    approve: async (pr, commit, body) => {
      const data = (await send("approve", pr, { pr, commit, body: body ?? null })) as {
        addPullRequestReview?: { pullRequestReview?: { url?: string } | null } | null;
      } | null;
      return { url: data?.addPullRequestReview?.pullRequestReview?.url ?? "" };
    },
    reply: async (thread, body) => {
      const data = (await send("reply", thread, { thread, body })) as {
        addPullRequestReviewThreadReply?: { comment?: { url?: string } | null } | null;
      } | null;
      return { url: data?.addPullRequestReviewThreadReply?.comment?.url ?? "" };
    },
    comment: async (subject, body) => {
      const data = (await send("comment", subject, { subject, body })) as {
        addComment?: { commentEdge?: { node?: { url?: string } | null } | null } | null;
      } | null;
      return { url: data?.addComment?.commentEdge?.node?.url ?? "" };
    },
    inlineComment: async (pr, commit, thread) => {
      const data = (await send("inline_comment", pr, { pr, commit, thread })) as {
        addPullRequestReview?: { pullRequestReview?: { url?: string; comments?: { nodes?: { url?: string }[] } | null } | null } | null;
      } | null;
      const review = data?.addPullRequestReview?.pullRequestReview;
      // GitHub has answered with no review and no error; better to keep your words than to say it landed.
      if (!review) throw new Error("GitHub answered without the comment: check the PR before you send it again");
      return { url: review.comments?.nodes?.[0]?.url ?? review.url ?? "" };
    },
    ready: async (pr) => {
      await send("ready", pr, { pr });
    },
    requestReviews: async (pr, users, teams) => {
      await send("request_reviews", pr, { pr, users, teams });
    },
    close: async (pr) => {
      await send("close", pr, { pr });
    },
    draft: async (pr) => {
      await send("draft", pr, { pr });
    },
    merge: async (pr, head, method) => {
      await send("merge", pr, { pr, head, method });
    },
    reopen: async (pr) => {
      await send("reopen", pr, { pr });
    },
    requestChanges: async (pr, commit, body) => {
      const data = (await send("request_changes", pr, { pr, commit, body })) as {
        addPullRequestReview?: { pullRequestReview?: { url?: string } | null } | null;
      } | null;
      return { url: data?.addPullRequestReview?.pullRequestReview?.url ?? "" };
    },
    closeIssue: async (issue) => {
      await send("close_issue", issue, { issue });
    },
  };
}
